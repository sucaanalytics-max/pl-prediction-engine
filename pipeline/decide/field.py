"""
The field: what everyone else scores, and therefore what it takes to win a week.

The season team maximises expected points. The weekly team maximises the
probability of beating the field's right tail, and those are different problems
because of one algebraic fact. Writing your margin over the field as
``D = sum_j (m_j - EO_j) * P_j``, where ``m_j`` is your multiplier on player j
and ``EO_j`` his effective ownership, the term ``sum_j EO_j * P_j`` is common to
everyone and cannot be influenced. **Effective ownership therefore cannot change
the EV-optimal pick** — it only changes ``Var[D]``, through the weights
``w_j = m_j - EO_j``. The corollary worth internalising: owning a 110%-EO player
WITHOUT the armband gives ``w_j = -0.10``, so you lose rank when he returns.

So the season team can ignore ownership entirely, and the weekly team is
entirely about it.

**This model is not calibrated, and by default it is not used.** Calibrating it
needs historical ``(average_entry_score, highest_score)`` pairs — the only direct
observable of the field's right tail — and those are published per gameweek on
the live bootstrap, not in the archive. Until six consecutive gameweeks land
inside the band, :func:`field_is_usable` returns False and the weekly team falls
back to the EV-optimal plan. That is the honest outcome the plan pre-registered,
not a failure being hidden: a tail number presented as measured when it is
merely modelled would be worse than no weekly team at all.

Two things are real rather than assumed:

* **Ownership.** The archive records ``selected`` per player per gameweek. Every
  manager picks exactly fifteen, so ``sum(selected) / 15`` recovers the manager
  count exactly and ownership share follows without a guess.
* **Legality.** Synthetic rivals are budget- and club-legal squads, not
  independent coin flips per player. A field of illegal teams has the wrong
  tail, which is the only thing this module is for.

Captaincy share is the genuine gap. Effective ownership is ownership plus
captaincy, and the API publishes only ``most_captained`` — one name, not a
distribution. It is modelled here as concentrating on the highest-projected
owned players, which is an assumption, is flagged as one, and is a large part of
why the gate starts closed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field as dataclass_field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from pipeline.fpl.rules import POSITIONS, Rules, load_rules

logger = logging.getLogger(__name__)

# Consecutive gameweeks inside the calibration band before the field model may
# drive a recommendation. Six because a single gameweek's average and highest
# are one draw each, and three would be cheap to pass by luck.
REQUIRED_CALIBRATED_GAMEWEEKS = 6

# Tolerance on the field's mean and right tail, as a fraction of the observed
# value. Wide, because the target is "not badly wrong" rather than precise —
# a tighter band would never open and the weekly team would be dead code.
MEAN_BAND = 0.10
TAIL_BAND = 0.20

# Share of managers assumed to captain the single most-captained player. The API
# publishes the name but not the share, so this is a stated assumption and one
# of the main reasons the gate starts closed.
TOP_CAPTAIN_SHARE = 0.40


@dataclass
class FieldReport:
    """A simulated field, with its calibration status attached."""

    n_rivals: int
    mean: float
    p90: float
    p99: float
    best: float
    calibrated: bool = False
    consecutive_passes: int = 0
    reason: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n_rivals": self.n_rivals,
            "mean": round(self.mean, 3),
            "p90": round(self.p90, 3),
            "p99": round(self.p99, 3),
            "best": round(self.best, 3),
            # The load-bearing field. Anything reading this must branch on it,
            # not on the numbers above.
            "calibrated": self.calibrated,
            "consecutive_passes": self.consecutive_passes,
            "status": "usable" if self.calibrated else "uncalibrated",
            "reason": self.reason,
        }


def ownership_share(selected: Mapping[int, float]) -> Dict[int, float]:
    """
    Ownership as a fraction of managers, derived exactly rather than guessed.

    Every manager picks exactly fifteen players, so the total of ``selected``
    across all players is fifteen times the number of managers. That identity
    gives the denominator without needing to know the entrant count.
    """
    total = float(sum(selected.values()))
    if total <= 0:
        return {int(k): 0.0 for k in selected}
    managers = total / 15.0
    return {int(k): min(1.0, float(v) / managers) for k, v in selected.items()}


def effective_ownership(
    ownership: Mapping[int, float],
    xp: Mapping[int, float],
    top_captain_share: float = TOP_CAPTAIN_SHARE,
) -> Dict[int, float]:
    """
    Ownership plus captaincy share — the quantity the weekly margin depends on.

    Captaincy is MODELLED, not observed: the API publishes only the name of the
    most-captained player. The assumption here is that the armband concentrates
    on the highest-projected owned player, with the remainder spread over the
    next few by projected points. It is deliberately crude, because a crude
    assumption that is declared is safer than a subtle one that is not.
    """
    owned = [p for p, share in ownership.items() if share > 0]
    if not owned:
        return {int(p): 0.0 for p in ownership}

    ranked = sorted(owned, key=lambda p: -float(xp.get(p, 0.0)))
    captain_share = {int(p): 0.0 for p in ownership}

    # The top pick takes the stated share; the rest decays geometrically over
    # the next few, so the total captaincy mass is exactly 1.0 (one armband per
    # manager) rather than an arbitrary number.
    remaining = 1.0 - top_captain_share
    if ranked:
        captain_share[int(ranked[0])] = top_captain_share
    for i, player in enumerate(ranked[1:6], start=1):
        take = remaining * 0.5
        captain_share[int(player)] = take
        remaining -= take
    if len(ranked) > 1 and remaining > 0:
        captain_share[int(ranked[1])] += remaining

    return {
        int(p): float(ownership.get(p, 0.0)) + captain_share.get(int(p), 0.0)
        for p in ownership
    }


def sample_rivals(
    ownership: Mapping[int, float],
    positions: Mapping[int, str],
    teams: Mapping[int, str],
    prices: Mapping[int, int],
    rules: Rules,
    n_rivals: int,
    rng: np.random.Generator,
    max_attempts: int = 60,
) -> List[List[int]]:
    """
    Draw budget- and club-legal squads with inclusion probability from ownership.

    Rejection sampling against the real legality rules rather than independent
    per-player coin flips. An independent-Bernoulli field contains squads with
    six forwards and no keeper, and its tail is wrong — which is the only
    property this module is built to get right.

    Squads that cannot be completed within ``max_attempts`` are skipped rather
    than patched with arbitrary players, so a thin pool yields fewer rivals
    rather than a field of implausible teams.
    """
    players = [p for p in ownership if p in positions and p in prices]
    by_position: Dict[str, List[int]] = {pos: [] for pos in POSITIONS}
    for player in players:
        if positions[player] in by_position:
            by_position[positions[player]].append(player)

    squads: List[List[int]] = []
    for _ in range(n_rivals):
        squad = _one_rival(
            by_position, ownership, teams, prices, rules, rng, max_attempts
        )
        if squad is not None:
            squads.append(squad)

    if len(squads) < n_rivals:
        logger.warning(
            "sampled %d of %d rivals; the pool may be too thin for a legal field",
            len(squads), n_rivals,
        )
    return squads


def _one_rival(by_position, ownership, teams, prices, rules, rng, max_attempts):
    """One legal squad, or None if the pool cannot supply it."""
    for _ in range(max_attempts):
        squad: List[int] = []
        per_club: Dict[str, int] = {}
        spend = 0
        ok = True

        for position in POSITIONS:
            pool = by_position.get(position, [])
            quota = rules.quotas[position]
            if len(pool) < quota:
                return None
            weights = np.array([max(ownership.get(p, 0.0), 1e-6) for p in pool])
            order = rng.choice(
                len(pool), size=len(pool), replace=False, p=weights / weights.sum()
            )
            taken = 0
            for index in order:
                player = pool[index]
                club = teams.get(player, "")
                if per_club.get(club, 0) >= rules.club_limit:
                    continue
                squad.append(player)
                per_club[club] = per_club.get(club, 0) + 1
                spend += int(prices.get(player, 0))
                taken += 1
                if taken == quota:
                    break
            if taken < quota:
                ok = False
                break

        if ok and spend <= rules.budget_tenths:
            return squad
    return None


def score_field(
    squads: Sequence[Sequence[int]],
    draws: Any,
    positions: Mapping[int, str],
    xp: Mapping[int, float],
    rules: Optional[Rules] = None,
) -> np.ndarray:
    """
    Score every rival on the SAME draws our own plans are scored on.

    Common random numbers again, and for the same reason: the quantity that
    matters is our score MINUS the field's in the same world. Scoring rivals on
    independent draws would destroy the correlation that makes a differential a
    differential.
    """
    from pipeline.decide.milp import Plan
    from pipeline.decide.plan_eval import evaluate_plan

    rules = rules or load_rules()
    scores = []
    for squad in squads:
        ranked = sorted(squad, key=lambda p: -float(xp.get(p, 0.0)))
        xi = _legal_xi(ranked, positions, rules)
        if xi is None:
            continue
        plan = Plan(
            squad=list(squad), xi=xi, captain=xi[0], vice=xi[1],
            transfers_in=[], transfers_out=[], hits=0, bank_after=0,
            objective=0.0, free_transfers_banked=0, free_transfers_after=1,
        )
        scores.append(
            evaluate_plan(plan, draws, positions, rules=rules, xp=xp)
        )
    # One expected score per rival. That is the cross-section the calibration
    # check needs, since average_entry_score and highest_score are themselves
    # cross-sectional statistics over managers rather than over draws.
    return np.array([s.mean_points for s in scores], dtype=float)


def _legal_xi(ranked: Sequence[int], positions: Mapping[int, str], rules: Rules):
    """Best legal eleven from a squad, greedily by projected points."""
    counts = {pos: 0 for pos in POSITIONS}
    xi: List[int] = []
    for player in ranked:
        position = positions.get(player)
        if position not in counts:
            continue
        low, high = rules.play_bounds[position]
        if counts[position] >= high or len(xi) >= rules.lineup_size:
            continue
        xi.append(player)
        counts[position] += 1
    # Backfill any position still under its minimum.
    for position, (low, _) in rules.play_bounds.items():
        while counts[position] < low:
            spare = next(
                (p for p in ranked if positions.get(p) == position and p not in xi), None
            )
            if spare is None:
                return None
            if len(xi) >= rules.lineup_size:
                drop = next(
                    (p for p in reversed(xi)
                     if counts[positions[p]] > rules.play_bounds[positions[p]][0]),
                    None,
                )
                if drop is None:
                    return None
                xi.remove(drop)
                counts[positions[drop]] -= 1
            xi.append(spare)
            counts[position] += 1
    return xi if len(xi) == rules.lineup_size else None


def check_calibration(
    field_scores: Sequence[float],
    observed_average: Optional[float],
    observed_highest: Optional[float],
    mean_band: float = MEAN_BAND,
    tail_band: float = TAIL_BAND,
) -> Tuple[bool, str]:
    """
    Does the simulated field reproduce the gameweek's real average and best?

    ``highest_score`` is the only direct observable of the field's right tail,
    which is exactly the quantity the weekly objective maximises against — so it
    is checked separately and with its own tolerance rather than folded into a
    single score.
    """
    if observed_average is None or observed_highest is None:
        return False, "no observed average_entry_score / highest_score to check against"
    scores = np.asarray(field_scores, dtype=float)
    if scores.size == 0:
        return False, "no rivals simulated"

    mean_error = abs(float(scores.mean()) - observed_average) / max(observed_average, 1.0)
    tail_error = abs(float(scores.max()) - observed_highest) / max(observed_highest, 1.0)

    if mean_error > mean_band:
        return False, f"field mean off by {mean_error:.1%} (band {mean_band:.0%})"
    if tail_error > tail_band:
        return False, f"field tail off by {tail_error:.1%} (band {tail_band:.0%})"
    return True, ""


def field_is_usable(consecutive_passes: int) -> bool:
    """
    Whether the field model may drive a recommendation.

    False until six consecutive gameweeks land inside the band. Presenting a
    modelled tail as a measured one would be worse than having no weekly team,
    because the number would be acted on with confidence it has not earned.
    """
    return int(consecutive_passes) >= REQUIRED_CALIBRATED_GAMEWEEKS
