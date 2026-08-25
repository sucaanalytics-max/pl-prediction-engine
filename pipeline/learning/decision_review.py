"""
Were *you* right, and was a call wrong or merely unlucky.

Everything else in this package scores the model. This scores the manager, and it
is only honest because of one asset nothing else in the category has: a forecast
sealed before the deadline. `predictions/fpl/ledger/gw{NN}/forecast.jsonl` records
what the engine said with a `sealed_at` and a `seconds_before_deadline`, so the
counterfactual "the engine preferred your bench player" is a claim about what was
knowable at the time rather than hindsight dressed up as insight.

Take that away and this module is a scoreboard. Every other FPL product can tell
you that you left points on the bench. None can tell you which of those you could
have known, because none of them wrote a number down first.

## Three things the naive version gets wrong

**1. FPL rewrites your team before you can read it back.** The
`entry/{id}/event/{gw}/picks/` endpoint returns positions and multipliers *after*
automatic substitutions are applied. Measured on GW1 2026-27: the response showed
Thomas in an XI slot and Palestra on the bench, while `automatic_subs` recorded
Thomas coming *in* for Palestra — so the submitted eleven was the opposite of what
the payload displayed. Scoring the payload as-is grades FPL's correction of your
team instead of your team, which flatters every decision the auto-sub rescued.
`submitted_eleven` reverses them.

**2. Only the substitute who actually came on was rescued.** A first pass at this
credited every bench player who played against the same failed starter, reporting
two rescues for one substitution. The rescue set is exactly `element_in` from
`automatic_subs` and nothing else; the remaining bench players are ordinary
comparisons.

**3. A tie is not a lesson.** Two players the simulation cannot separate must never
produce a "you should have known". The sealed record publishes `mc_se`, the Monte
Carlo standard error of each mean, so the threshold is derived from the run's own
precision rather than picked: a gap counts only if it clears `sigmas` times the
combined standard error. On GW1 that correctly separated Thomas over Palestra
(gap 0.074, combined 2-sigma 0.053) while refusing a 0.0008 gap between two
midfielders whose combined 2-sigma was 0.100 — a gap `>` would have called a
lesson every week for the rest of the season.

## What it refuses to say

One settled gameweek is noise. `build` reports `observations` and withholds every
aggregate verdict below `MINIMUM_OBSERVATIONS`, the same refusal `accuracy.py`
makes for the model: a self-assessment that renders a confident number off one
week is indistinguishable from a real finding, and worse than saying nothing.

Per-gameweek calls are always emitted, because "Palestra did not play and three of
your four bench players were rated above him" is a fact about one gameweek and
does not need a season behind it. It is the *aggregate* — your captaincy edge, your
foreseeable-error rate — that needs the sample.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

#: Settled gameweeks required before any aggregate is reported. Below this the
#: per-gameweek calls stand alone and every rate is withheld.
MINIMUM_OBSERVATIONS = 6

#: How many combined standard errors two projections must differ by before the
#: difference is treated as something the simulation actually resolved. Two is
#: roughly a 95% interval on the difference of two means.
DEFAULT_SIGMAS = 2.0

#: A bench call's kind.
RESCUED = "rescued"          # auto-subbed in for a starter who did not play
COST = "cost"                # played, outscored a starter who also played
CORRECT = "correct"          # played, beat nobody who played
NO_CLAIM = "no_claim"        # did not play; benching him cannot be judged

#: Whether the sealed forecast supports calling a decision an error.
FORESEEABLE = "foreseeable"        # the engine ranked the bench player higher
DEFENSIBLE = "defensible"          # the engine ranked the starter higher
INDISTINGUISHABLE = "indistinguishable"  # the engine did not separate them


@dataclass(frozen=True)
class Sealed:
    """One player's pre-deadline forecast, with the precision behind it."""

    element_id: int
    xp: float
    #: Monte Carlo standard error of ``xp``. Without it a tie is unrecognisable.
    mc_se: float


@dataclass(frozen=True)
class BenchCall:
    """One bench decision, and whether the sealed forecast condemns it."""

    bench_element: int
    #: The starter this is measured against, or None for RESCUED/NO_CLAIM shapes
    #: where there is no comparison to make.
    starter_element: Optional[int]
    kind: str
    #: Points the bench player scored minus the starter's. Zero for NO_CLAIM.
    points_forgone: int
    #: One of FORESEEABLE / DEFENSIBLE / INDISTINGUISHABLE, or None when the
    #: sealed forecast did not cover both players — absent, never assumed.
    verdict: Optional[str]

    def is_lesson(self) -> bool:
        """
        The forecast said this was avoidable, whether or not it cost anything.

        Deliberately not gated on ``points_forgone``. Starting a player the engine
        ranked below one you benched is the same decision whether an automatic
        substitution rescued it or not — GW1 2026-27 produced exactly that case, and
        counting only the expensive ones would teach the manager to notice bad calls
        solely when they were also unlucky. The cost is reported separately.
        """
        return self.verdict == FORESEEABLE


@dataclass(frozen=True)
class CaptainCall:
    """Your armband against the sealed argmax of the eleven you submitted."""

    chosen: int
    #: Highest sealed xp among the submitted eleven, or None when the forecast
    #: covered none of them.
    sealed_best: Optional[int]
    agreed: Optional[bool]
    #: Actual points the argmax scored minus what your captain scored, doubled
    #: because the armband doubles. Positive means the engine's pick was better.
    #: None when either side is unknown.
    points_delta: Optional[int]


def separated(
    left: Sealed,
    right: Sealed,
    *,
    sigmas: float = DEFAULT_SIGMAS,
) -> bool:
    """
    Did the simulation actually resolve a difference between these two?

    The standard error of a difference of independent means is the root sum of
    squares of theirs. Anything inside ``sigmas`` of that is noise the run cannot
    distinguish, and calling it a managerial error would manufacture a lesson from
    arithmetic.
    """
    gap = abs(left.xp - right.xp)
    combined = math.sqrt(left.mc_se**2 + right.mc_se**2)
    return gap > sigmas * combined


def _verdict(
    bench: Optional[Sealed],
    starter: Optional[Sealed],
    *,
    sigmas: float = DEFAULT_SIGMAS,
) -> Optional[str]:
    """
    Whether the forecast condemns preferring ``starter`` over ``bench``.

    None when either player is missing from the sealed universe — its criteria
    exclude fringe players by design, and an absent forecast is not a forecast of
    zero.
    """
    if bench is None or starter is None:
        return None
    if not separated(bench, starter, sigmas=sigmas):
        return INDISTINGUISHABLE
    return FORESEEABLE if bench.xp > starter.xp else DEFENSIBLE


def submitted_eleven(picks: Mapping[str, Any]) -> Tuple[Set[int], List[int]]:
    """
    The eleven the manager actually submitted, and the four they benched.

    ``picks`` is the raw ``entry/{id}/event/{gw}/picks/`` payload, whose
    ``multiplier`` already reflects automatic substitutions. Reversing them is what
    recovers the decision: each substitution took ``element_out`` out of the
    submitted eleven and put ``element_in`` in, so undoing it restores both.

    Returns the eleven as a set and the bench in the payload's own position order,
    because bench order is itself a decision and the caller may want to score it.
    """
    rows = picks.get("picks") or []
    eleven = {
        int(row["element"])
        for row in rows
        if isinstance(row, Mapping) and int(row.get("multiplier") or 0) > 0
    }
    for sub in picks.get("automatic_subs") or []:
        if not isinstance(sub, Mapping):
            continue
        came_on, went_off = sub.get("element_in"), sub.get("element_out")
        if came_on is None or went_off is None:
            # A half-recorded substitution cannot be reversed. Leaving the eleven
            # as FPL rewrote it is the safer failure: it under-reports the
            # manager's errors rather than inventing one.
            logger.warning("automatic_sub missing element_in/out; not reversed: %s", sub)
            continue
        eleven.discard(int(came_on))
        eleven.add(int(went_off))

    bench = [
        int(row["element"])
        for row in sorted(
            (r for r in rows if isinstance(r, Mapping)),
            key=lambda r: int(r.get("position") or 0),
        )
        if int(row["element"]) not in eleven
    ]
    return eleven, bench


def rescued_pairs(picks: Mapping[str, Any]) -> Dict[int, int]:
    """
    Bench player -> the starter they were automatically substituted for.

    Exactly the recorded substitutions. Deriving this by looking for any failed
    starter is the mistake documented at the top of this module.
    """
    pairs: Dict[int, int] = {}
    for sub in picks.get("automatic_subs") or []:
        if not isinstance(sub, Mapping):
            continue
        came_on, went_off = sub.get("element_in"), sub.get("element_out")
        if came_on is not None and went_off is not None:
            pairs[int(came_on)] = int(went_off)
    return pairs


def review_bench(
    picks: Mapping[str, Any],
    points: Mapping[int, int],
    minutes: Mapping[int, int],
    sealed: Mapping[int, Sealed],
    *,
    sigmas: float = DEFAULT_SIGMAS,
) -> List[BenchCall]:
    """
    Every bench decision, classified.

    ``points`` and ``minutes`` are realised per element, from ``event/{gw}/live/``.
    A bench player who did not play yields NO_CLAIM rather than a zero cost: he
    might have been the right man to bench or the wrong one, and the gameweek did
    not say.
    """
    eleven, bench = submitted_eleven(picks)
    rescues = rescued_pairs(picks)
    played_starters = [e for e in eleven if minutes.get(e, 0) > 0]

    calls: List[BenchCall] = []
    for element in bench:
        if element in rescues:
            starter = rescues[element]
            calls.append(
                BenchCall(
                    bench_element=element,
                    starter_element=starter,
                    kind=RESCUED,
                    # The substitution already collected these points, so nothing
                    # was forgone. The verdict is still worth stating: it says
                    # whether the starter should have been picked at all.
                    points_forgone=0,
                    verdict=_verdict(
                        sealed.get(element), sealed.get(starter), sigmas=sigmas
                    ),
                )
            )
            continue

        if minutes.get(element, 0) <= 0:
            calls.append(
                BenchCall(
                    bench_element=element,
                    starter_element=None,
                    kind=NO_CLAIM,
                    points_forgone=0,
                    verdict=None,
                )
            )
            continue

        scored = points.get(element, 0)
        beaten = [s for s in played_starters if points.get(s, 0) < scored]
        if not beaten:
            calls.append(
                BenchCall(
                    bench_element=element,
                    starter_element=None,
                    kind=CORRECT,
                    points_forgone=0,
                    verdict=None,
                )
            )
            continue

        # The worst starter who actually played is the swap the manager could have
        # made, so it is the one the cost is measured against. Ties in points break
        # on the lower sealed projection, which is the more conservative charge.
        worst = min(
            beaten,
            key=lambda s: (points.get(s, 0), sealed[s].xp if s in sealed else 0.0),
        )
        calls.append(
            BenchCall(
                bench_element=element,
                starter_element=worst,
                kind=COST,
                points_forgone=scored - points.get(worst, 0),
                verdict=_verdict(sealed.get(element), sealed.get(worst), sigmas=sigmas),
            )
        )
    return calls


@dataclass(frozen=True)
class ElevenCheck:
    """
    The selection question, asked independently of who was auto-subbed.

    A per-player bench call compares a benched man against the starter he replaced
    or outscored, and both of those are decided by events. This asks the thing that
    was decided *before* kickoff: did the manager start anyone the engine ranked
    below a player they left out? On GW1 2026-27 the bench calls charged one
    marginal error against a single substitute, while this shows three of four bench
    players were rated above the weakest starter — the same decision, correctly
    sized.
    """

    worst_starter: Optional[int]
    best_bench: Optional[int]
    #: Bench players the forecast separated above the weakest starter.
    bench_rated_higher: Tuple[int, ...]
    #: Sealed xp gap between the best bench player and the worst starter, when both
    #: are covered and separated. None otherwise.
    gap: Optional[float]

    @property
    def misordered(self) -> bool:
        return bool(self.bench_rated_higher)


def review_eleven(
    picks: Mapping[str, Any],
    sealed: Mapping[int, Sealed],
    *,
    sigmas: float = DEFAULT_SIGMAS,
) -> ElevenCheck:
    """Was the submitted eleven consistent with the sealed forecast's own ordering?"""
    eleven, bench = submitted_eleven(picks)
    covered_xi = [e for e in eleven if e in sealed]
    covered_bench = [e for e in bench if e in sealed]
    if not covered_xi or not covered_bench:
        return ElevenCheck(None, None, (), None)

    worst = min(covered_xi, key=lambda e: sealed[e].xp)
    best = max(covered_bench, key=lambda e: sealed[e].xp)
    higher = tuple(
        e
        for e in covered_bench
        if sealed[e].xp > sealed[worst].xp
        and separated(sealed[e], sealed[worst], sigmas=sigmas)
    )
    gap = (
        sealed[best].xp - sealed[worst].xp
        if separated(sealed[best], sealed[worst], sigmas=sigmas)
        else None
    )
    return ElevenCheck(
        worst_starter=worst, best_bench=best, bench_rated_higher=higher, gap=gap
    )


def review_captain(
    picks: Mapping[str, Any],
    points: Mapping[int, int],
    sealed: Mapping[int, Sealed],
) -> Optional[CaptainCall]:
    """
    The armband against the engine's own pick, restricted to the submitted eleven.

    Restricted deliberately: comparing against the best captain in the whole game
    would score squad building, not the armband. The decision being reviewed is the
    one the manager actually had in front of them.
    """
    rows = picks.get("picks") or []
    chosen = next(
        (
            int(row["element"])
            for row in rows
            if isinstance(row, Mapping) and row.get("is_captain")
        ),
        None,
    )
    if chosen is None:
        return None

    eleven, _ = submitted_eleven(picks)
    covered = [e for e in eleven if e in sealed]
    if not covered:
        return CaptainCall(chosen=chosen, sealed_best=None, agreed=None, points_delta=None)

    best = max(covered, key=lambda e: sealed[e].xp)
    delta: Optional[int] = None
    if chosen in points or best in points:
        # The armband doubles, so a different captain moves the total by twice the
        # difference in their scores.
        delta = 2 * (points.get(best, 0) - points.get(chosen, 0))
    return CaptainCall(
        chosen=chosen, sealed_best=best, agreed=chosen == best, points_delta=delta
    )


def load_sealed(lines: Iterable[str]) -> Dict[int, Sealed]:
    """
    The sealed forecast, keyed by element.

    ``forecast.jsonl``'s first line is a ``record: "header"`` carrying the seal
    metadata; the rest are ``record: "forecast"`` player rows. Anything else is
    skipped rather than guessed at.
    """
    import json

    out: Dict[int, Sealed] = {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            logger.warning("unparseable line in sealed forecast; skipped")
            continue
        if not isinstance(row, Mapping) or row.get("record") != "forecast":
            continue
        element = row.get("element_id")
        xp = row.get("xp")
        mc_se = row.get("mc_se")
        if not isinstance(element, int) or xp is None or mc_se is None:
            # Without mc_se a tie cannot be recognised, and a default would make
            # every close call look decisive. Drop the row instead.
            continue
        out[element] = Sealed(element_id=element, xp=float(xp), mc_se=float(mc_se))
    return out


def sealed_header(lines: Iterable[str]) -> Optional[Dict[str, Any]]:
    """The seal metadata, which is what makes any of this a pre-deadline claim."""
    import json

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, Mapping) and row.get("record") == "header":
            return dict(row)
    return None


def _aggregate(
    reviews: Sequence[Mapping[str, Any]], minimum: int
) -> Optional[Dict[str, Any]]:
    """
    Season-to-date rates, or None while the sample is too small to mean anything.

    Returning None rather than a number with a caveat is deliberate: a caveat next
    to a figure is read as the figure.
    """
    if len(reviews) < minimum:
        return None

    lessons = 0
    forgone = 0
    captain_agreements = 0
    captain_measured = 0
    captain_delta = 0
    for review in reviews:
        for call in review.get("bench") or []:
            if call.get("kind") == COST:
                forgone += int(call.get("points_forgone") or 0)
                if call.get("verdict") == FORESEEABLE:
                    lessons += 1
        captain = review.get("captain")
        if captain and captain.get("agreed") is not None:
            captain_measured += 1
            captain_agreements += 1 if captain["agreed"] else 0
            captain_delta += int(captain.get("points_delta") or 0)

    return {
        "gameweeks": len(reviews),
        "points_forgone_on_bench": forgone,
        "foreseeable_bench_errors": lessons,
        "captain_agreement_rate": (
            round(captain_agreements / captain_measured, 4) if captain_measured else None
        ),
        "captain_points_vs_engine": captain_delta if captain_measured else None,
    }


def build(
    reviews: Sequence[Mapping[str, Any]],
    *,
    generated_at: str,
    season: Optional[str] = None,
    minimum_observations: int = MINIMUM_OBSERVATIONS,
) -> Dict[str, Any]:
    """
    The published view: every gameweek's calls, and aggregates once earned.

    ``reviews`` is one entry per settled gameweek, each as produced by
    ``review_gameweek``.
    """
    aggregate = _aggregate(reviews, minimum_observations)
    return {
        "schema_version": SCHEMA_VERSION,
        # Carried so the provenance strip can name the producer rather than
        # printing "version unknown" beside a real judgement about your season.
        "producer_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "season": season,
        "observations": len(reviews),
        "minimum_observations": minimum_observations,
        "aggregate": aggregate,
        "aggregate_reason": (
            None
            if aggregate is not None
            else (
                f"{len(reviews)} settled gameweek(s) reviewed; "
                f"{minimum_observations} are needed before a rate is reported. "
                "Per-gameweek calls below are complete."
            )
        ),
        "gameweeks": list(reviews),
    }


def review_gameweek(
    gameweek: int,
    picks: Mapping[str, Any],
    points: Mapping[int, int],
    minutes: Mapping[int, int],
    sealed: Mapping[int, Sealed],
    *,
    seal: Optional[Mapping[str, Any]] = None,
    sigmas: float = DEFAULT_SIGMAS,
) -> Dict[str, Any]:
    """One gameweek's decisions, as a serialisable record."""
    bench = review_bench(picks, points, minutes, sealed, sigmas=sigmas)
    captain = review_captain(picks, points, sealed)
    selection = review_eleven(picks, sealed, sigmas=sigmas)
    history = picks.get("entry_history") or {}
    eleven, bench_order = submitted_eleven(picks)

    return {
        "gameweek": gameweek,
        # Carried so a reader can tell a pre-deadline claim from a post-hoc one
        # without opening the ledger. Absent seal metadata is stated, not implied.
        "sealed_at": (seal or {}).get("sealed_at"),
        "seconds_before_deadline": (seal or {}).get("seconds_before_deadline"),
        "sealed_universe": len(sealed) or None,
        "points": history.get("points"),
        # FPL's own figure, kept beside ours precisely because they differ: theirs
        # is computed after automatic substitutions and so cannot see a rescue.
        "fpl_points_on_bench": history.get("points_on_bench"),
        "transfers": history.get("event_transfers"),
        "hit_cost": history.get("event_transfers_cost"),
        "submitted_eleven": sorted(eleven),
        "submitted_bench": bench_order,
        "selection": {
            "worst_starter": selection.worst_starter,
            "best_bench": selection.best_bench,
            "bench_rated_higher": list(selection.bench_rated_higher),
            "gap": None if selection.gap is None else round(selection.gap, 4),
            "misordered": selection.misordered,
        },
        "bench": [
            {
                "bench_element": call.bench_element,
                "starter_element": call.starter_element,
                "kind": call.kind,
                "points_forgone": call.points_forgone,
                "verdict": call.verdict,
                "is_lesson": call.is_lesson(),
            }
            for call in bench
        ],
        "captain": (
            None
            if captain is None
            else {
                "chosen": captain.chosen,
                "sealed_best": captain.sealed_best,
                "agreed": captain.agreed,
                "points_delta": captain.points_delta,
            }
        ),
    }
