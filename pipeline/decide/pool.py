"""
Build the candidate pool the optimiser chooses from.

The pool is where a decision engine quietly goes wrong, because everything it
excludes is invisible downstream: the artifact reports the best plan over the
pool, and a player filtered out here simply never appears in any counterfactual.
So the default is to include everyone and let the objective do the ranking.

That is affordable. The H=1 formulation solves the full ~780-player league in
well under a second, so a value filter would buy nothing and risk excluding the
right answer. The only players removed are those who cannot be selected at all.

Two rules hold regardless of any filter:

* **A held player is always in the pool.** Otherwise the MILP cannot represent
  the squad it is starting from, and the transfer arithmetic silently treats him
  as already sold.
* **Selling price is not the current price.** FPL keeps half of any rise and
  rounds against the manager. Using ``now_cost`` for a held player overstates
  the bank on every sale, and the error compounds across a season.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from pipeline.data.team_mapping import normalize_team_name
from pipeline.decide.milp import Candidate
from pipeline.fpl.rules import Rules, is_retired_position, normalise_position, selling_price

logger = logging.getLogger(__name__)

# FPL availability codes. 'a' available, 'd' doubtful, 'i' injured, 's' suspended,
# 'u' unavailable (usually left the league), 'n' on loan / not in squad.
#
# Only 'u' and 'n' are hard exclusions: those players cannot be picked at all.
# Injured and suspended players stay in, because the minutes model already prices
# their availability and a filter here would double-count it — and because a
# player injured this week is often the correct buy for the week after.
UNSELECTABLE_STATUS = frozenset({"u", "n"})


@dataclass
class PoolReport:
    """What the pool contains, and what it left out. Attached to the artifact."""

    n_candidates: int
    n_excluded: int
    excluded_by_reason: Dict[str, int] = field(default_factory=dict)
    held_missing_purchase_price: List[int] = field(default_factory=list)
    price_uncertain: bool = False
    n_zero_xp: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n_candidates": self.n_candidates,
            "n_excluded": self.n_excluded,
            "excluded_by_reason": dict(self.excluded_by_reason),
            "held_missing_purchase_price": sorted(self.held_missing_purchase_price),
            "price_uncertain": self.price_uncertain,
            "n_zero_xp": self.n_zero_xp,
        }


def build_pool(
    xp_rows: Sequence[Mapping[str, Any]],
    bootstrap: Mapping[str, Any],
    rules: Rules,
    held: Sequence[int] = (),
    purchase_prices: Optional[Mapping[int, int]] = None,
    exclude_unselectable: bool = True,
) -> Tuple[List[Candidate], PoolReport]:
    """
    Turn an expected-points artifact plus a bootstrap into MILP candidates.

    ``xp_rows`` are the artifact's player rows (``element_id`` and ``xp``).
    ``purchase_prices`` maps a held player to what was actually paid for him,
    which is the only way selling price can be computed; it comes from replaying
    the entry's transfer history. A held player missing from it is priced at
    ``now_cost`` and flagged, because refusing to solve is not safer than solving
    with a declared uncertainty — it just means no decision at all.
    """
    held_set: Set[int] = {int(p) for p in held}
    purchase_prices = {int(k): int(v) for k, v in (purchase_prices or {}).items()}

    xp_by_id = {
        int(row["element_id"]): float(row.get("xp", 0.0) or 0.0) for row in xp_rows
    }
    teams = {
        int(t["id"]): normalize_team_name(t.get("name", "")) or str(t["id"])
        for t in bootstrap.get("teams", [])
    }
    element_types = {
        int(t["id"]): t.get("singular_name_short", "")
        for t in bootstrap.get("element_types", [])
    }

    candidates: List[Candidate] = []
    excluded: Dict[str, int] = {}
    report = PoolReport(n_candidates=0, n_excluded=0)

    def drop(reason: str) -> None:
        excluded[reason] = excluded.get(reason, 0) + 1

    for element in bootstrap.get("elements", []):
        element_id = int(element["id"])
        is_held = element_id in held_set

        raw_position = element_types.get(int(element.get("element_type", 0)), "")
        position = normalise_position(raw_position)

        # A retired position (the 2025-26 'AM' experiment) has no quota, so a
        # player carrying one cannot be placed in a legal squad at all.
        if is_retired_position(raw_position) or position not in rules.quotas:
            if is_held:
                raise ValueError(
                    f"held player {element_id} has unusable position {raw_position!r}"
                )
            drop("unusable_position")
            continue

        status = str(element.get("status", "a"))
        if exclude_unselectable and status in UNSELECTABLE_STATUS and not is_held:
            drop(f"status_{status}")
            continue

        now_cost = int(element.get("now_cost", 0))
        if now_cost <= 0:
            if is_held:
                raise ValueError(f"held player {element_id} has no price")
            drop("no_price")
            continue

        # Selling price applies only to what we already own. For anyone else the
        # field is unused by the budget row, and setting it to now_cost keeps it
        # meaningful rather than zero if it is ever read.
        if is_held:
            paid = purchase_prices.get(element_id)
            if paid is None:
                report.held_missing_purchase_price.append(element_id)
                sell = now_cost
            else:
                sell = selling_price(paid, now_cost, rules.sell_on_fee)
                # Guardrail: a violation means the transfer history was replayed
                # wrongly, and the budget would be wrong in a direction that lets
                # the solver overspend.
                #
                # Stated as "selling lies between purchase and now_cost", NOT the
                # plan's "purchase <= selling <= now_cost". That form is only
                # right for a RISE: FPL passes a fall on in full, so a player
                # bought at 6.0 and now worth 5.5 sells for 5.5, below purchase.
                if not min(paid, now_cost) <= sell <= max(paid, now_cost):
                    raise ValueError(
                        f"selling price {sell} for {element_id} is outside "
                        f"[purchase {paid}, now_cost {now_cost}]"
                    )
        else:
            sell = now_cost

        xp = xp_by_id.get(element_id, 0.0)
        if xp == 0.0:
            report.n_zero_xp += 1

        candidates.append(
            Candidate(
                element_id=element_id,
                position=position,
                team=teams.get(int(element.get("team", 0)), "unknown"),
                buy_price=now_cost,
                sell_price=sell,
                xp=xp,
                owned=is_held,
            )
        )

    present = {c.element_id for c in candidates}
    missing = held_set - present
    if missing:
        # Not recoverable here: a held player absent from bootstrap means the
        # squad cannot be represented, and every downstream number would be
        # computed for a fourteen-man team.
        raise ValueError(f"held players absent from bootstrap: {sorted(missing)}")

    report.n_candidates = len(candidates)
    report.n_excluded = sum(excluded.values())
    report.excluded_by_reason = excluded
    report.price_uncertain = bool(report.held_missing_purchase_price)

    if report.price_uncertain:
        logger.warning(
            "%d held players have no recorded purchase price and are valued at "
            "now_cost; the bank may be overstated",
            len(report.held_missing_purchase_price),
        )
    logger.info(
        "pool: %d candidates, %d excluded (%s), %d with zero xp",
        report.n_candidates, report.n_excluded, excluded or "none", report.n_zero_xp,
    )
    return candidates, report


def positions_of(candidates: Sequence[Candidate]) -> Dict[int, str]:
    """Position lookup for the simulator adjudication stage."""
    return {c.element_id: c.position for c in candidates}


def xp_of(candidates: Sequence[Candidate]) -> Dict[int, float]:
    """Expected-points lookup, used to order the bench."""
    return {c.element_id: c.xp for c in candidates}
