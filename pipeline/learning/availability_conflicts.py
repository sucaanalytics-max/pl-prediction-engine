"""
Deciding which availability claim to believe, and saying so out loud.

The store records everything anyone asserted. This decides what the projection
uses. Kept separate from the store because they answer different questions and
have different failure modes: a store bug loses history, a resolution bug produces
a confidently wrong projection.

**The governing asymmetry.** FPL is slow to flag a player and fast to clear one.
So the dangerous error is fielding someone who is out, not benching someone who is
fit — and the rules are deliberately asymmetric about it. But the deeper asymmetry
is in evidence quality: a manager saying "he's out" is near-certain, while "he's in
contention" is a probability a third party cannot calibrate. That is why a
lower-tier source may push availability DOWN but never up.

**Nothing is ever silently dropped.** Every resolution names every claim that lost,
and the whole resolution set rides into the sealed record. In an unattended pipeline
that is the only kind of "we did not quietly pick a side" that survives — a comment
saying so would not.

**A predicted lineup is not an availability claim.** It says "he is in the eleven",
which is information about ``p_start`` *conditional on* availability. Conflating the
two is how a rotation call becomes an injury flag, so ``predicted_start`` is a
separate claim type that never reaches the availability number at all.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from pipeline.config import PARAM_REGISTRY
from pipeline.learning.availability_evidence import (
    SOURCE_FPL_FIELDS,
    SOURCE_FPL_NEWS,
    AvailabilityClaim,
    effective_claim_time,
)

logger = logging.getLogger(__name__)

# Two claims of the same type from equally fresh, equally authoritative sources
# disagree MATERIALLY when they differ by at least this much. Below it, taking
# either is defensible and escalating would cry wolf.
CHANCE_CONFLICT_POINTS = 25
RETURN_DATE_CONFLICT_DAYS = 7

# Rule names, so a resolution says which rule decided it and a test can assert on
# the rule rather than on the value it happened to produce.
RULE_ONLY_CLAIM = "only_claim"
RULE_RECENCY = "recency_within_source"
RULE_TIER = "tier_precedence"
RULE_ASYMMETRIC = "asymmetric_override"
RULE_ASYMMETRIC_REFUSED = "asymmetric_override_refused"
RULE_PERMANENCE = "permanence_beats_gradation"
RULE_UNRESOLVED = "unresolved_conservative"
RULE_STALE = "fresher_claim_beats_stale"

# Claim types that assert something about whether he can play at all. Anything
# outside this set — notably `predicted_start` — never touches availability.
AVAILABILITY_TYPES = (
    "status", "chance_of_playing", "return_date", "unavailable_until",
    "permanent_exit",
)


def _param(name: str) -> float:
    return float(PARAM_REGISTRY[name]["value"])


def _parse(stamp: Optional[str]) -> Optional[datetime]:
    if not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


@dataclass(frozen=True)
class Resolution:
    """Which claim the projection used, and what it beat."""

    element_id: int
    claim_type: str
    value: Any
    rule: str
    winning_claim_id: Optional[str] = None
    # Every claim that lost, by id. This is what makes "never silently pick a
    # side" a property of the record rather than a promise in a docstring.
    conflicts: Tuple[str, ...] = ()
    # Dropped as invalid, with the reason. Separate from `conflicts` because a
    # malformed claim did not lose an argument, it never entered one.
    dropped: Tuple[str, ...] = ()
    unresolved: bool = False
    escalation: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "element_id": self.element_id,
            "claim_type": self.claim_type,
            "value": self.value,
            "rule": self.rule,
            "winning_claim_id": self.winning_claim_id,
            "conflicts": list(self.conflicts),
            "dropped": list(self.dropped),
            "unresolved": self.unresolved,
            "escalation": self.escalation,
        }


def _is_valid(claim: AvailabilityClaim) -> Optional[str]:
    """Why this claim cannot be used, or None if it can. Rule R0."""
    claimed = _parse(claim.claimed_at)
    observed = _parse(claim.observed_at)
    if observed is None:
        return "no observation timestamp"
    if claimed is not None and claimed > observed:
        # Impossible, and the check that stops an old article outranking a newer
        # club update: a source cannot have published after we read it.
        return "claimed after it was observed"

    if claim.source_tier >= 2 and not claim.provenance_digest:
        # A lower-tier claim without provenance cannot be audited, and an
        # unauditable claim that can move a projection is worse than no claim.
        return "tier 2+ claim has no provenance digest"

    value = claim.value
    if claim.claim_type == "chance_of_playing":
        if not isinstance(value, (int, float)) or not 0 <= float(value) <= 100:
            return f"chance_of_playing out of domain: {value!r}"
    elif claim.claim_type == "predicted_start":
        if not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
            return f"predicted_start out of domain: {value!r}"
    elif claim.claim_type in ("return_date", "unavailable_until"):
        if _parse(value) is None:
            return f"{claim.claim_type} is not a date: {value!r}"
    elif claim.claim_type == "permanent_exit":
        if not isinstance(value, Mapping) or "kind" not in value:
            return f"permanent_exit has no kind: {value!r}"
    return None


def _is_stale(claim: AvailabilityClaim, now: datetime) -> bool:
    """
    Rule R1. Older than the staleness horizon.

    Reuses ``minutes.news_staleness_days``, the parameter that already governs
    un-suppression, so the system has ONE staleness concept rather than two that
    can drift apart.
    """
    stamp = _parse(effective_claim_time(claim))
    if stamp is None:
        return False
    return (now - stamp).days > _param("minutes.news_staleness_days")


def _optimism(claim_type: str, value: Any) -> Optional[float]:
    """
    How available this claim says he is, on [0, 1], or None if it does not say.

    Needed by rule R4 to decide DIRECTION, which is the whole content of the
    asymmetric override.
    """
    if claim_type == "chance_of_playing":
        return float(value) / 100.0
    if claim_type == "permanent_exit":
        return 0.0
    if claim_type == "status":
        return {"a": 1.0, "d": 0.75, "i": 0.1, "s": 0.1, "u": 0.0, "n": 0.0}.get(
            str(value).strip().lower()
        )
    if claim_type == "unavailable_until":
        return 0.0
    return None


def _materially_disagree(left: AvailabilityClaim, right: AvailabilityClaim) -> bool:
    """Rule R7's test. Same type, and far enough apart to matter."""
    if left.claim_type != right.claim_type:
        return False

    if left.claim_type == "chance_of_playing":
        return abs(float(left.value) - float(right.value)) >= CHANCE_CONFLICT_POINTS

    if left.claim_type in ("return_date", "unavailable_until"):
        one, other = _parse(left.value), _parse(right.value)
        if one is None or other is None:
            return True
        return abs((one - other).days) > RETURN_DATE_CONFLICT_DAYS

    if left.claim_type == "status":
        left_optimism = _optimism("status", left.value)
        right_optimism = _optimism("status", right.value)
        if left_optimism is None or right_optimism is None:
            return True
        # One says he can play and the other says he cannot.
        return (left_optimism > 0.5) != (right_optimism > 0.5)

    return left.value != right.value


def resolve_claims(
    claims: Sequence[AvailabilityClaim],
    now: Optional[datetime] = None,
) -> Tuple[Dict[Tuple[int, str], Resolution], List[Resolution]]:
    """
    Decide, per (player, claim type), which claim the projection uses.

    Returns ``(resolutions, escalations)``. Escalations are the subset needing a
    human — they are also present in ``resolutions``, because the projection still
    has to be made and it is made conservatively.

    The rules, applied in this order:

    * **R0 validity** — impossible timestamps, out-of-domain values and
      unauditable tier-2+ claims are dropped, counted and named.
    * **R1 staleness** — a claim past the staleness horizon loses to any fresher
      one regardless of tier.
    * **R2 recency within a source** — latest ``claimed_at`` wins. Ties break on
      ``observed_at`` then ``claim_id``, because the resolution rides into the seal
      and must be deterministic.
    * **R3 tier precedence** — lower tier number wins.
    * **R4 the asymmetric override** — a lower-tier source may override FPL ONLY
      in the direction that makes us less likely to field an absent player, and
      only when strictly fresher. An optimistic lower-tier claim is recorded,
      loses, and is surfaced at info rather than dropped.
    * **R6 permanence beats gradation** — a live ``permanent_exit`` outranks any
      percentage, because FPL sometimes leaves a stale chance on a departed player.
    * **R7 unresolvable escalates** — same tier, both fresh, different sources,
      materially disagreeing: the CONSERVATIVE value is used, the resolution is
      labelled unresolved, and it is escalated.
    * **R8 never silently pick a side** — every resolution names every loser.

    (R5 lives in the model layer, not here: ``predicted_start`` is resolved like
    any other claim type but is excluded from ``AVAILABILITY_TYPES``, so it can
    never reach the availability number.)
    """
    now = now or datetime.now(timezone.utc)

    grouped: Dict[Tuple[int, str], List[AvailabilityClaim]] = {}
    dropped: Dict[Tuple[int, str], List[str]] = {}
    for claim in claims:
        key = (claim.element_id, claim.claim_type)
        reason = _is_valid(claim)
        if reason is not None:
            dropped.setdefault(key, []).append(f"{claim.claim_id}: {reason}")
            logger.debug("dropped claim %s (%s)", claim.claim_id, reason)
            continue
        grouped.setdefault(key, []).append(claim)

    resolutions: Dict[Tuple[int, str], Resolution] = {}
    escalations: List[Resolution] = []

    # Keys with only invalid claims still produce a record, so "everything this
    # source sent was malformed" is visible rather than looking like silence.
    for key, reasons in dropped.items():
        if key not in grouped:
            resolutions[key] = Resolution(
                element_id=key[0], claim_type=key[1], value=None,
                rule="all_claims_invalid", dropped=tuple(reasons),
            )

    for key, candidates in grouped.items():
        element_id, claim_type = key
        resolution = _resolve_one(
            element_id, claim_type, candidates, now, tuple(dropped.get(key, ()))
        )
        resolutions[key] = resolution
        if resolution.escalation:
            escalations.append(resolution)

    # R6 is cross-type, so it runs after the per-type resolutions exist.
    _apply_permanence(resolutions)

    return resolutions, escalations


def _sort_key(claim: AvailabilityClaim) -> Tuple[str, str, str]:
    """
    Recency ordering, fully deterministic.

    The claim id is the final tie-break because two sources can publish in the
    same second and the resolution rides into a sealed record — a run that
    resolved differently on a re-run would make the seal unreproducible.
    """
    return (
        effective_claim_time(claim) or "",
        claim.observed_at or "",
        claim.claim_id,
    )


def _resolve_one(
    element_id: int,
    claim_type: str,
    candidates: List[AvailabilityClaim],
    now: datetime,
    dropped: Tuple[str, ...],
) -> Resolution:
    ordered = sorted(candidates, key=_sort_key, reverse=True)
    if len(ordered) == 1:
        return Resolution(
            element_id=element_id, claim_type=claim_type, value=ordered[0].value,
            rule=RULE_ONLY_CLAIM, winning_claim_id=ordered[0].claim_id,
            dropped=dropped,
        )

    # R1: fresh claims outrank stale ones outright. If everything is stale, fall
    # through and let the ordinary rules pick — a stale answer beats no answer.
    fresh = [c for c in ordered if not _is_stale(c, now)]
    stale_losers = tuple(c.claim_id for c in ordered if _is_stale(c, now))
    pool = fresh or ordered
    rule = RULE_STALE if (fresh and stale_losers) else RULE_RECENCY

    # R2: latest per source.
    latest_by_source: Dict[str, AvailabilityClaim] = {}
    superseded: List[str] = []
    for claim in pool:
        current = latest_by_source.get(claim.source)
        if current is None:
            latest_by_source[claim.source] = claim
        else:
            superseded.append(claim.claim_id)

    contenders = sorted(latest_by_source.values(), key=_sort_key, reverse=True)
    if len(contenders) == 1:
        winner = contenders[0]
        return Resolution(
            element_id=element_id, claim_type=claim_type, value=winner.value,
            rule=rule, winning_claim_id=winner.claim_id,
            conflicts=tuple(superseded) + stale_losers, dropped=dropped,
        )

    # R3: lowest tier wins, freshest within it.
    best_tier = min(c.source_tier for c in contenders)
    top = [c for c in contenders if c.source_tier == best_tier]
    winner = top[0]
    losers = [c for c in contenders if c.claim_id != winner.claim_id]

    # R7: two equally authoritative, equally fresh sources that materially
    # disagree cannot be resolved by rule. Use the conservative value and say so.
    rivals = [c for c in top[1:] if _materially_disagree(winner, c)]
    if rivals:
        conservative = min(
            [winner] + rivals,
            key=lambda c: (
                _optimism(claim_type, c.value)
                if _optimism(claim_type, c.value) is not None else 1.0
            ),
        )
        escalation = (
            f"{claim_type}: {winner.source} says {winner.value!r} "
            f"({effective_claim_time(winner)}) while "
            + ", ".join(
                f"{c.source} says {c.value!r} ({effective_claim_time(c)})"
                for c in rivals
            )
            + f". Used the more conservative {conservative.value!r}."
        )
        return Resolution(
            element_id=element_id, claim_type=claim_type,
            value=conservative.value, rule=RULE_UNRESOLVED,
            winning_claim_id=conservative.claim_id,
            conflicts=tuple(
                c.claim_id for c in [winner] + rivals
                if c.claim_id != conservative.claim_id
            ) + tuple(superseded) + stale_losers,
            dropped=dropped, unresolved=True, escalation=escalation,
        )

    # R4: may a fresher lower-tier claim override the tier-1 winner? Only
    # downward, and only if strictly fresher.
    lower = [
        c for c in contenders
        if c.source_tier > best_tier and _sort_key(c) > _sort_key(winner)
    ]
    for challenger in sorted(lower, key=_sort_key, reverse=True):
        winner_optimism = _optimism(claim_type, winner.value)
        challenger_optimism = _optimism(claim_type, challenger.value)
        if winner_optimism is None or challenger_optimism is None:
            continue
        if challenger_optimism < winner_optimism:
            # "He's out" from a fresher unofficial source is near-certain, and the
            # asymmetric risk is fielding an absent player.
            return Resolution(
                element_id=element_id, claim_type=claim_type,
                value=challenger.value, rule=RULE_ASYMMETRIC,
                winning_claim_id=challenger.claim_id,
                conflicts=tuple(
                    c.claim_id for c in contenders
                    if c.claim_id != challenger.claim_id
                ) + tuple(superseded) + stale_losers,
                dropped=dropped,
            )
        # Optimistic and unofficial: recorded, loses, and surfaced — because "he's
        # in contention" is a probability a third party cannot calibrate, while
        # silently discarding it would hide a real disagreement.
        return Resolution(
            element_id=element_id, claim_type=claim_type, value=winner.value,
            rule=RULE_ASYMMETRIC_REFUSED, winning_claim_id=winner.claim_id,
            conflicts=tuple(c.claim_id for c in losers) + tuple(superseded)
            + stale_losers,
            dropped=dropped,
            escalation=(
                f"{claim_type}: {challenger.source} (tier {challenger.source_tier}) "
                f"is more optimistic than {winner.source} — {challenger.value!r} "
                f"against {winner.value!r}. FPL's value was used; an unofficial "
                f"source may lower availability but never raise it."
            ),
        )

    return Resolution(
        element_id=element_id, claim_type=claim_type, value=winner.value,
        rule=rule if len(contenders) == 1 else RULE_TIER,
        winning_claim_id=winner.claim_id,
        conflicts=tuple(c.claim_id for c in losers) + tuple(superseded)
        + stale_losers,
        dropped=dropped,
    )


def _apply_permanence(resolutions: Dict[Tuple[int, str], Resolution]) -> None:
    """
    R6. A live ``permanent_exit`` outranks a percentage, in place.

    Cross-type, so it cannot be decided inside a single (player, type) group. FPL
    sometimes leaves a stale ``chance_of_playing`` on a player who has left, and a
    departed player at 75% would be bought.
    """
    exits = {
        element_id for (element_id, claim_type), resolution in resolutions.items()
        if claim_type == "permanent_exit" and resolution.value is not None
    }
    for (element_id, claim_type), resolution in list(resolutions.items()):
        if element_id not in exits or claim_type != "chance_of_playing":
            continue
        resolutions[(element_id, claim_type)] = Resolution(
            element_id=element_id, claim_type=claim_type, value=0,
            rule=RULE_PERMANENCE,
            winning_claim_id=resolution.winning_claim_id,
            conflicts=resolution.conflicts, dropped=resolution.dropped,
        )


def availability_view(
    resolutions: Mapping[Tuple[int, str], Resolution]
) -> Dict[int, Dict[str, Resolution]]:
    """
    Regroup by player, keeping only claims that bear on availability.

    ``predicted_start`` is deliberately excluded — rule R5. It says "he is in the
    eleven", which is information about ``p_start`` conditional on availability,
    and letting it through here is how a rotation call becomes an injury flag.
    """
    view: Dict[int, Dict[str, Resolution]] = {}
    for (element_id, claim_type), resolution in resolutions.items():
        if claim_type not in AVAILABILITY_TYPES:
            continue
        view.setdefault(element_id, {})[claim_type] = resolution
    return view


def summarise(
    resolutions: Mapping[Tuple[int, str], Resolution],
    escalations: Sequence[Resolution],
) -> Dict[str, Any]:
    """Counts for the run log and the sealed record."""
    by_rule: Dict[str, int] = {}
    for resolution in resolutions.values():
        by_rule[resolution.rule] = by_rule.get(resolution.rule, 0) + 1
    return {
        "n_resolutions": len(resolutions),
        "n_players": len({element_id for element_id, _ in resolutions}),
        "n_unresolved": sum(1 for r in resolutions.values() if r.unresolved),
        "n_escalations": len(escalations),
        "n_dropped": sum(len(r.dropped) for r in resolutions.values()),
        "by_rule": by_rule,
    }
