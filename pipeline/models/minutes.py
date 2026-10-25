"""
Minutes and role model: will this player play, and for how long.

This is the largest single source of expected-points error. A state-of-the-art
attacking model still loses on aggregate through minutes alone, because most
player-gameweeks are zeros and getting the zeros wrong swamps getting the
haulers right.

Three roles per fixture, exhaustive and mutually exclusive: **start**,
**appear as a substitute**, **unused**. Their probabilities sum to 1 before the
availability gate and are scaled by it afterwards, so the gate can never push
mass outside [0, 1].

Estimation is empirical-Bayes with explicit shrinkage rather than a filter. A
player with two fixtures of history is pulled hard toward his position's prior;
a player with thirty is barely moved. Nothing is excluded for a low sample —
exclusion would silently delete exactly the rotation-risk players the optimiser
most needs an honest number for. Every prediction carries the weight of its own
evidence so a caller can tell a well-supported 0.9 from a prior-driven one.

Availability comes from FPL's `status` and `chance_of_playing_next_round`. That
field is sparse and lags, so a missing value is treated as *no information* and
falls back to the status — never as 100%.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.fpl.rules import POSITIONS, normalise_position

logger = logging.getLogger(__name__)

# FPL availability status codes.
STATUS_AVAILABLE = "a"
STATUS_DOUBTFUL = "d"
STATUS_INJURED = "i"
STATUS_SUSPENDED = "s"
STATUS_UNAVAILABLE = "u"
STATUS_NOT_IN_SQUAD = "n"

# A player FPL has marked unavailable or removed from the squad cannot play.
# These are hard gates, not priors: no amount of history overrides them.
#
# Note what is NOT here: STATUS_SUSPENDED. A banned player reaches zero through
# `chance_of_playing == 0` instead, which is why a fix keyed on this set would
# have missed every suspension in production. Verified against the committed
# pre-season snapshot: all three suspended players carry chance 0 and status "s".
HARD_GATE_STATUSES = frozenset({STATUS_UNAVAILABLE, STATUS_NOT_IN_SQUAD})

# How an absence is expected to end. `chance_of_playing` alone cannot express
# this: a one-match ban, a season-ending loan and an undiagnosed injury all
# arrive as zero, and projecting them identically over a six-week horizon is the
# defect these classes exist to remove.
PERSISTENCE_NONE = "none"                            # available, nothing to end
PERSISTENCE_GRADED = "graded"                        # FPL published a percentage
PERSISTENCE_OPEN_ENDED = "open_ended"                # absent, no end date known
PERSISTENCE_DATED_FITNESS = "dated_fitness"          # "Expected back 30 Aug"
PERSISTENCE_DATED_ELIGIBILITY = "dated_eligibility"  # "Suspended until 29 Aug"
PERSISTENCE_PERMANENT = "permanent"                  # transferred, loaned, released

# Fallback when a player has no Premier League history at all (a signing from
# abroad). Deliberately pessimistic on starting: an unknown player is more
# likely to be squad filler than an immediate starter, and the alternative —
# assuming the position mean — would have the optimiser buy unknowns eagerly.
NEW_SIGNING_START_RATE = 0.35

# Optional `fit` column: the player's availability AT THAT FIXTURE'S DEADLINE,
# in [0, 1], as the projection that week computed it from the flags FPL showed
# then (`availability_state(...).now`; see `fpl_inputs.deadline_availability`).
# NaN, or the column being absent, means "not known" and leaves the row
# exactly as it was before this column existed. The archive seasons carry no
# flag of any kind, so for them it is always absent.
AVAILABILITY_AT_DEADLINE = "availability_at_deadline"


def _param(name: str) -> float:
    return float(PARAM_REGISTRY[name]["value"])


@dataclass(frozen=True)
class RoleProbabilities:
    """Role distribution and minutes expectations for one player-fixture."""

    p_start: float
    p_bench_appear: float
    p_unused: float
    minutes_if_start: float
    minutes_if_bench: float
    p_60_if_start: float
    availability: float
    # Fixtures of the player's own history behind this estimate. 0 means the
    # numbers are entirely prior-driven; the optimiser must not treat a
    # prior-only projection as equal to an evidence-backed one.
    evidence_fixtures: int
    evidence_weight: float
    gate_reason: Optional[str] = None
    # Split out of `p_unused`, which conflated "in the squad and not used" with
    # "not available to be picked". The simulator's substitute layer wants the
    # first and would over-project fringe players if handed the second.
    p_unavailable: float = 0.0
    # Which horizon week this estimate is for, and which branch produced it.
    horizon: int = 0
    horizon_reason: Optional[str] = None

    @property
    def p_appears(self) -> float:
        return self.p_start + self.p_bench_appear

    @property
    def p_60(self) -> float:
        """P(60+ minutes). A substitute appearance essentially never reaches it."""
        return self.p_start * self.p_60_if_start

    @property
    def expected_minutes(self) -> float:
        return (
            self.p_start * self.minutes_if_start
            + self.p_bench_appear * self.minutes_if_bench
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "p_start": self.p_start,
            "p_bench_appear": self.p_bench_appear,
            "p_unused": self.p_unused,
            "p_appears": self.p_appears,
            "p_60": self.p_60,
            "minutes_if_start": self.minutes_if_start,
            "minutes_if_bench": self.minutes_if_bench,
            "p_60_if_start": self.p_60_if_start,
            "expected_minutes": self.expected_minutes,
            "availability": self.availability,
            "p_unavailable": self.p_unavailable,
            "evidence_fixtures": self.evidence_fixtures,
            "evidence_weight": self.evidence_weight,
            "gate_reason": self.gate_reason,
            "horizon": self.horizon,
            "horizon_reason": self.horizon_reason,
        }


def availability(
    status: Optional[str],
    chance_of_playing: Optional[float],
    news_age_days: Optional[float] = None,
) -> Tuple[float, Optional[str]]:
    """
    Probability the player is available, and the reason if it is gated.

    Order matters. A hard-gate status wins outright. Otherwise an explicit
    ``chance_of_playing`` is believed, because it is FPL's own judgement. Only
    when that is absent do we fall back to the status — and a missing value
    never means "fine".
    """
    code = (status or STATUS_AVAILABLE).strip().lower()

    if code in HARD_GATE_STATUSES:
        return 0.0, f"status_{code}"

    if chance_of_playing is not None:
        chance = float(chance_of_playing)
        if chance <= 0:
            return 0.0, "chance_of_playing_zero"
        return min(1.0, chance / 100.0), None

    if code == STATUS_AVAILABLE:
        return 1.0, None

    # A stale note on an otherwise-available player stops suppressing him: FPL
    # often leaves an old flag in place after a return.
    stale_after = _param("minutes.news_staleness_days")
    if news_age_days is not None and news_age_days > stale_after:
        return 1.0, "news_stale"

    if code == STATUS_DOUBTFUL:
        return _param("minutes.doubtful_default"), "doubtful_no_chance_field"
    if code in (STATUS_INJURED, STATUS_SUSPENDED):
        return _param("minutes.injured_default"), f"status_{code}_no_chance_field"

    return 0.0, f"unrecognised_status_{code}"


def horizon_availability_factor(horizon: int) -> float:
    """
    How much a FULLY AVAILABLE player's availability should be discounted
    ``horizon`` gameweeks ahead. 1.0 for the immediate gameweek.

    A player fit today may be injured, rested or out of the side in six weeks.
    That risk accumulates but does not compound forever — it reverts toward a
    long-run base rate — so this is ``floor + (1 - floor) * rho^h`` rather than a
    geometric decay.

    Without this, the horizon treats a GW+6 projection as being as certain as a
    GW+1 one, which measurably overstates far-horizon availability by around
    15% and makes distant fixtures look more attractive than they are.

    This is the *healthy* ceiling. An impaired player's path is
    ``horizon_availability``, which reverts up toward this curve rather than
    decaying away from it.
    """
    floor = _param("minutes.horizon_availability_floor")
    rho = _param("minutes.horizon_availability_rho")
    return float(floor + (1.0 - floor) * rho ** max(0, int(horizon)))


@dataclass(frozen=True)
class AvailabilityState:
    """
    Availability now, plus what has to happen for it to change.

    Separated from the single number because the number is not enough to project
    forward. Two players at ``chance_of_playing == 0`` can have opposite futures,
    and the horizon has to know which is which.
    """

    now: float
    gate_reason: Optional[str] = None
    persistence: str = PERSISTENCE_NONE
    # ISO date from which he can play again, for the two dated classes.
    available_from: Optional[str] = None
    # Claim ids behind this state, once the evidence store feeds it.
    evidence_claim_ids: Tuple[str, ...] = ()
    # True when the state was resolved under an unresolved evidence conflict, so
    # the artifact can say the projection was made in that condition.
    conflict: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "now": self.now,
            "gate_reason": self.gate_reason,
            "persistence": self.persistence,
            "available_from": self.available_from,
            "evidence_claim_ids": list(self.evidence_claim_ids),
            "conflict": self.conflict,
        }


def availability_state(
    status: Optional[str],
    chance_of_playing: Optional[float],
    news_age_days: Optional[float] = None,
    news: Optional[str] = None,
    news_added: Optional[str] = None,
) -> AvailabilityState:
    """
    Today's availability, classified by how the absence is expected to end.

    ``news`` is FPL's own text and is used only to CLASSIFY — it never overrides
    the number, which stays exactly what ``availability`` computes. So a parser
    that stops recognising a phrase loses the classification and falls back to
    today's behaviour; it can never move an availability in the wrong direction.
    """
    from pipeline.data.availability_news import parse_news

    now, gate_reason = availability(status, chance_of_playing, news_age_days)
    parsed = parse_news(news, news_added)
    code = (status or STATUS_AVAILABLE).strip().lower()

    # FPL's LIVE fields outrank any news string, and this ordering is the whole
    # point of the fail-safe. A player FPL currently reports as available and
    # selected is available, whatever a leftover note says — otherwise a stale
    # "Has joined X permanently" from last season would zero a fit, selected
    # player at every horizon week, for ever, with no staleness check to rescue
    # him. Measured: status "a", chance 100, a 400-day-old exit note projected
    # 0.0 availability while `availability()` itself returned 1.0.
    #
    # `gate_reason is None` is what distinguishes a genuine clean bill of health
    # from `news_stale`, which also returns 1.0 but must still reach the dated
    # logic below.
    if now >= 1.0 and code == STATUS_AVAILABLE and gate_reason is None:
        return AvailabilityState(now=now, gate_reason=gate_reason)

    # A departure outranks a percentage: FPL sometimes leaves a stale chance on a
    # player who has left. It does NOT outrank the fast path above.
    if parsed.exit_kind is not None:
        return AvailabilityState(
            now=0.0, gate_reason=gate_reason or f"exit_{parsed.exit_kind}",
            persistence=PERSISTENCE_PERMANENT,
        )

    # `u`/`n` with no news saying otherwise: FPL says he is not in the squad, and
    # inventing a return on no evidence is the worse error.
    if code in HARD_GATE_STATUSES:
        return AvailabilityState(
            now=0.0, gate_reason=gate_reason, persistence=PERSISTENCE_PERMANENT
        )

    # A note carrying an explicit end date does not go stale the way an
    # undated one does — a long absence NATURALLY has an old note, which is
    # exactly when the 21-day cliff misfires. The date is better evidence than
    # the age, so it supersedes the staleness clearing rather than being
    # overridden by it. Without this, a player cleared to 1.0 by staleness was
    # still gated to 0.0 at every future week by his own return date, which is
    # a contradiction visible in the artifact.
    if gate_reason == "news_stale" and (
        parsed.unavailable_until is not None or parsed.return_date is not None
    ):
        now = _param("minutes.injured_default")
        gate_reason = "dated_absence_supersedes_stale_news"

    if parsed.unavailable_until is not None:
        return AvailabilityState(
            now=now, gate_reason=gate_reason,
            persistence=PERSISTENCE_DATED_ELIGIBILITY,
            available_from=parsed.unavailable_until,
        )
    if parsed.return_date is not None:
        return AvailabilityState(
            now=now, gate_reason=gate_reason,
            persistence=PERSISTENCE_DATED_FITNESS,
            available_from=parsed.return_date,
        )

    # "Unknown return date" outranks a published percentage, because the two
    # answer different questions: the percentage is about THIS week, while the
    # phrase is FPL stating directly that the absence has no known end. Since the
    # class exists precisely to say how an absence ends, the explicit statement
    # about ending wins — the percentage still sets today's level.
    if parsed.matched_pattern == "injury_undated":
        return AvailabilityState(
            now=now, gate_reason=gate_reason, persistence=PERSISTENCE_OPEN_ENDED
        )

    if chance_of_playing is not None and float(chance_of_playing) > 0:
        return AvailabilityState(
            now=now, gate_reason=gate_reason, persistence=PERSISTENCE_GRADED
        )
    return AvailabilityState(
        now=now, gate_reason=gate_reason, persistence=PERSISTENCE_OPEN_ENDED
    )


def is_fit_now(state: AvailabilityState) -> bool:
    """
    Whether FPL shows the player as fully, unconditionally available today.

    Status 'a' with no chance-of-playing below 100 and no staleness override —
    exactly the fast path of :func:`availability_state`. A graded flag, a stale
    note cleared to 1.0, or a lowering evidence claim all fail it.
    """
    return (
        float(state.now) >= 1.0
        and state.gate_reason is None
        and state.persistence == PERSISTENCE_NONE
    )


def horizon_availability(
    state: AvailabilityState,
    horizon: int,
    target_kickoff: Optional[Any] = None,
) -> Tuple[float, str]:
    """
    Availability for a fixture ``horizon`` weeks out, and why.

    The shape is two multiplied hazards — does today's problem still persist, and
    has a new one arisen since:

        a_h = A(h) * [ 1 - (1 - a_0) * kappa^h ]

    where ``A(h)`` is ``horizon_availability_factor``. At ``a_0 = 1`` the bracket
    is 1 and this reduces to ``A(h)`` **exactly**, which is what allows the
    already-fitted floor and rho to keep the meaning they were fitted with. Two
    natural-looking alternatives — ``a_0*L^h + A(h)*(1-L^h)`` and
    ``A(h) - (A(h)-a_0)*L^h`` — both give 0.973 at h=1 where the fitted curve
    gives 0.946, so either would silently reinterpret both parameters.

    An impaired player therefore reverts UP toward the healthy curve while a
    nailed player decays DOWN toward the floor, from one formula.

    The dated classes bypass the reversion where the date settles the matter: a
    suspension is zero until the ban expires and then full strength, because a
    ban is an eligibility constraint and the player has been training throughout.
    A dated injury gets a ramp instead, because fitness returns gradually.
    """
    horizon = max(0, int(horizon))
    healthy = horizon_availability_factor(horizon)

    if state.persistence == PERSISTENCE_PERMANENT:
        return 0.0, PERSISTENCE_PERMANENT

    if horizon == 0:
        return state.now, "current"

    dated = state.persistence in (
        PERSISTENCE_DATED_ELIGIBILITY, PERSISTENCE_DATED_FITNESS
    )
    if dated and state.available_from:
        kickoffs = _as_kickoffs(target_kickoff)
        if not kickoffs:
            # No fixture date to compare against. Fall through to the reverting
            # path rather than assuming he is fit: assuming would field a banned
            # player, and the reverting path is the conservative reading.
            return _reverting(state, healthy, horizon), (
                f"{state.persistence}_no_kickoff"
            )

        try:
            available_from = datetime.fromisoformat(state.available_from)
        except (TypeError, ValueError):
            # An unparseable date must not kill the seal — a gameweek without a
            # sealed forecast is a permanently lost observation, whereas a
            # conservative projection is merely imprecise.
            logger.warning(
                "unparseable available_from %r; falling back to the reverting path",
                state.available_from,
            )
            return _reverting(state, healthy, horizon), (
                f"{state.persistence}_bad_date"
            )
        if available_from.tzinfo is None:
            available_from = available_from.replace(tzinfo=timezone.utc)

        # ELIGIBLE FRACTION, not the earliest fixture. A double gameweek whose ban
        # expires between the two fixtures is the case that matters: taking the
        # earliest kickoff blanked BOTH (understating by a full fixture), and
        # taking the latest would field him for both (overstating). Since expected
        # points are summed over the week's fixtures while roles are shared across
        # them, scaling availability by the fraction he is eligible for is exactly
        # right in expectation — and it reduces to 0 or 1 for an ordinary single
        # fixture, so nothing else changes.
        eligible = [k for k in kickoffs if k >= available_from]
        fraction = len(eligible) / len(kickoffs)
        if fraction == 0.0:
            return 0.0, f"{state.persistence}_before_{state.available_from}"

        partial = "" if fraction == 1.0 else f"_partial_{len(eligible)}of{len(kickoffs)}"
        if state.persistence == PERSISTENCE_DATED_ELIGIBILITY:
            # Match-fit throughout a ban, so no ramp. True by construction, not
            # by a tunable constant, so it cannot drift.
            return healthy * fraction, PERSISTENCE_DATED_ELIGIBILITY + partial

        weeks_back = min((k - available_from).days for k in eligible) / 7.0
        return (
            healthy * _return_ramp(weeks_back) * fraction,
            PERSISTENCE_DATED_FITNESS + partial,
        )

    return _reverting(state, healthy, horizon), state.persistence


def _as_kickoffs(target_kickoff: Optional[Any]) -> Tuple[datetime, ...]:
    """
    Normalise one kickoff or a sequence of them into a UTC-aware tuple.

    Accepts a single datetime so every existing caller keeps working, and a
    sequence so a double gameweek can express both of its fixtures. A naive
    datetime is read as UTC, matching the rest of the module.
    """
    if target_kickoff is None:
        return ()
    candidates = (
        [target_kickoff] if isinstance(target_kickoff, datetime)
        else list(target_kickoff)
    )
    out = []
    for candidate in candidates:
        if not isinstance(candidate, datetime):
            continue
        out.append(
            candidate.replace(tzinfo=timezone.utc)
            if candidate.tzinfo is None else candidate
        )
    return tuple(sorted(out))


def _reverting(state: AvailabilityState, healthy: float, horizon: int) -> float:
    """
    ``A(h) * [1 - (1 - a_0) * kappa^h]``, clipped into [0, 1].

    ``kappa`` depends on the class because a graded knock and an undiagnosed
    injury are different processes. A player FPL has put at 75% is expected back
    imminently; a player with an explicitly unknown return date is not, and the
    dated absences in the archive have a 4.6-week median that is a *lower* bound
    on the undated ones — a diagnosable injury is a shorter injury.
    """
    kappa = _param(
        "minutes.impairment_persistence_graded"
        if state.persistence == PERSISTENCE_GRADED
        else "minutes.impairment_persistence_open"
    )
    deficit = (1.0 - float(state.now)) * kappa ** horizon
    return float(np.clip(healthy * (1.0 - deficit), 0.0, 1.0))


def horizon_start_reversion(horizon: int) -> float:
    """
    Fraction of the way a player's start probability should be pulled toward his
    position's base rate, ``horizon`` gameweeks ahead. 0.0 for this gameweek.

    **This is the PRINCIPAL mechanism carrying horizon uncertainty for a fit
    player. It is not the only one — do not delete the availability factor on the
    strength of the measurement below.**

    Measured: scaling every player's availability by a common factor changes a
    club's TOTAL expected points by under 1%, because the simulator samples an
    exact-count lineup and eleven players start whatever the scaling. That is why a
    uniform haircut cannot express horizon churn. But it is a club-total result,
    and the optimiser consumes PER-PLAYER expected points — there the same haircut
    moves individual projections by roughly -10% to +30%, because exact-count
    sampling is invariant to a common scaling of *odds*, not of probabilities, so
    a nailed player loses and a fringe player gains.

    So both mechanisms contribute and the delivered calibration needs both. The
    multiplied-totals design was wrong in kind rather than degree: it scaled
    finished expected points by the availability factor — a quantity the
    simulator cannot produce from any input, since handed a uniform haircut it
    returns almost the original club total.

    **Which target.** The real phenomenon is churn in WHO starts, and it is a
    reversion — but toward the PLAYER'S OWN long-run start rate, not toward his
    position's pool. With ``minutes.horizon_start_target_half_life`` > 0 (the
    default since 2026-10-25) ``predict`` uses ``p_h = L + (p_0 - L) * rho^h``,
    where ``L`` is his start rate on that longer half-life, and this function
    (the pool path) is not called. The pool path below is kept only so that
    setting the half-life to 0 restores it exactly.

    Why the pool target failed, measured on 2024-25 and 2025-26 in
    start-probability space:

    * **The pool is the wrong population.** It counts every registered squad
      member, so a nailed keeper was pulled toward a 0.25 GK start rate made of
      second and third choices. Archive keepers with h=0 p_start >= 0.85 fell
      0.927 -> 0.671 by h=3 from this reversion alone, and to 0.589 after the
      availability factor, against a realised 0.867 — reversion is 76% of the
      modelled drop. A per-position cap fitted the GK cap at ~0.
    * **Its fit was off by one.** The 16,548-anchor measurement below anchored
      on players who STARTED gameweek g and read g+1 as h=1. At the next
      deadline g is already in the fit, so g+1 is h=0 — whose drop the h=0 model
      already predicts. The first step of reversion was counted twice.

    Out of fold at h=1-5 the own-rate target improves start Brier by 0.0118
    [0.0102, 0.0134] overall and in every position, and the sealed 2026-27
    seals agree (0.0051 [0.0012, 0.0089]); h=0, and so the sealed row, is
    untouched by construction. The registry entry carries the full table.

    The availability factor still decays a nailed player. That residual is what
    remains for keepers (0.786 predicted vs 0.867 realised at h=3); refitting the
    factor jointly helped keepers but hurt nailed midfielders, so it is unchanged.

    On the top-ten-starters check this docstring used to quote (h=8/h=0 xP 0.710
    against an "archive anchor" of 0.692): that anchor cannot be reproduced and
    appears to condition on a realised start at g, the same off-by-one. Selected
    at prediction time, the archive's top ten keep 0.861 of their minutes and
    0.820 of their points from h=0 to h=8; the model's expected-minutes ratio
    is 0.586 on the pool path and 0.784 on the own-rate path, and GW9 2026-27's
    simulated top-ten xP ratio moves 0.722 -> 0.789.

    Pool-path measurement, as originally recorded: players who started gameweek
    g average 82.4 minutes that week, 68.7 at g+1, 62.4 at g+3 and 56.1 at g+9,
    against a pool mean of 26.1; as a fraction of the gap to that mean the
    reversion is 0.243 / 0.356 / 0.467 at "h" = 1 / 3 / 9, and ``cap * (1 -
    rho^h)`` fits cap 0.447, rho 0.541, RMSE 0.0174.
    """
    cap = _param("minutes.horizon_start_reversion_cap")
    rho = _param("minutes.horizon_start_reversion_rho")
    return float(cap * (1.0 - rho ** max(0, int(horizon))))


def _return_ramp(weeks_since_return: float) -> float:
    """
    Fraction of the healthy path a player holds after returning from injury.

    Linear from a floor to 1.0 over ``return_ramp_weeks``. Linear rather than
    exponential because there is no evidence to prefer a curve, and a linear ramp
    with two interpretable endpoints is easier to argue about than a rate.
    """
    weeks = _param("minutes.return_ramp_weeks")
    floor = _param("minutes.return_ramp_floor")
    if weeks <= 0:
        return 1.0
    progress = float(np.clip(weeks_since_return / weeks, 0.0, 1.0))
    return float(floor + (1.0 - floor) * progress)


def _shrink(
    observed_numerator: float,
    observed_denominator: float,
    prior: float,
    strength: float,
) -> float:
    """Posterior mean of a rate under a conjugate prior of ``strength`` pseudo-observations."""
    return (observed_numerator + strength * prior) / (observed_denominator + strength)


def unavailability_posterior(
    availability_at_deadline: Any, p_appear_if_available: Any
) -> np.ndarray:
    """
    P(he was unavailable | he did not play), for a fixture he did not play in.

    A non-appearance has two causes, and only one of them is evidence about his
    place in the side::

        P(0 min) = (1 - a)  +  a * (1 - pi)
                   unavailable   available and not picked

    where ``a`` is availability at that deadline and ``pi`` is his probability of
    appearing when available. Bayes gives the share of the zero owed to the first
    term. That share is what the role fit must NOT count as a benching, because
    ``predict`` multiplies by availability separately and would charge the same
    absence twice.

    The posterior is what keeps the opposite failure out. A nailed starter
    (``pi`` 0.95) who misses a match at 75% is ~0.87 unavailable — the knock
    explains the zero. A fringe player (``pi`` 0.3) who misses one at 75% is only
    ~0.32 unavailable, because "not picked" explained his zeros before the knock
    and still explains most of this one. Only a hard zero (``a`` = 0) removes a
    row outright, and that is correct whatever his role: a player who cannot be
    selected tells you nothing about whether he would have been.
    """
    a = np.clip(np.asarray(availability_at_deadline, dtype=float), 0.0, 1.0)
    pi = np.clip(np.asarray(p_appear_if_available, dtype=float), 0.0, 1.0)
    unavailable = 1.0 - a
    not_picked = a * (1.0 - pi)
    denominator = unavailable + not_picked
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(denominator > 0, unavailable / denominator, 0.0)
    return np.clip(share, 0.0, 1.0)


class MinutesModel:
    """
    Fitted role and minutes model.

    ``fit`` consumes settled per-fixture history — the linked season archive, and
    in-season the current campaign's rows appended. It is deliberately a
    frequency model with shrinkage rather than a classifier: with one observation
    per player per fixture and a heavily zero-inflated target, a well-specified
    hierarchical rate is both more honest and more interpretable than a fitted
    black box, and its parameters are few enough to actually identify.
    """

    def __init__(self) -> None:
        self.by_player: Dict[Any, Dict[str, float]] = {}
        self.by_position: Dict[str, Dict[str, float]] = {}
        self.availability_diagnostics: Dict[str, Any] = {}
        self.fitted = False

    @staticmethod
    def _fixture_index(frame: pd.DataFrame) -> pd.Series:
        """
        A monotonic ordering of fixtures within and across seasons.

        Built from (season, GW) when a season column exists. Ordering on GW alone
        across concatenated seasons interleaves them — last season's GW38 would
        sort after this season's GW1 — which is exactly the defect that crippled
        the recency baseline in the backtest.
        """
        gameweek = pd.to_numeric(frame.get("GW", 0), errors="coerce").fillna(0)
        if "season" in frame.columns:
            seasons = sorted(str(s) for s in frame["season"].dropna().unique())
            rank = {season: index for index, season in enumerate(seasons)}
            offset = frame["season"].astype(str).map(rank).fillna(0) * 38
            return offset + gameweek
        return gameweek

    def fit(
        self,
        history: pd.DataFrame,
        key: str = "code",
        position_column: str = "position_current",
    ) -> "MinutesModel":
        """
        Fit from settled per-fixture rows.

        ``position_column`` defaults to the *current* classification, not the
        historical one: FPL reclassifies players between seasons, and a position
        prior built from stale labels is wrong for exactly the players whose
        role changed.
        """
        required = {"minutes", "starts", key, position_column}
        missing = required - set(history.columns)
        if missing:
            raise ValueError(f"history is missing required columns: {sorted(missing)}")

        frame = history.copy()
        frame["minutes"] = pd.to_numeric(frame["minutes"], errors="coerce").fillna(0)
        frame["starts"] = pd.to_numeric(frame["starts"], errors="coerce").fillna(0)
        frame["_position"] = frame[position_column].map(normalise_position)
        frame = frame[frame["_position"].notna()]

        # Recency weighting. Without it every fixture counts equally, so a player
        # who started 30 of 38 last season but has been benched for the last five
        # still projects as a starter. Measured consequence: a trivial
        # five-fixture recency heuristic beat this model on Brier and on both MAE
        # bands, losing only on calibration. Uniform weighting was the deficiency.
        #
        # Weights are relative to the most recent fixture in the TRAINING data,
        # shared across players, so someone who stopped playing months ago is
        # correctly discounted rather than merely having fewer rows.
        frame["_fixture_index"] = self._fixture_index(frame)
        half_life = _param("minutes.recency_half_life_fixtures")
        latest = float(frame["_fixture_index"].max()) if len(frame) else 0.0
        age = latest - frame["_fixture_index"].astype(float)
        frame["_w"] = 0.5 ** (age / max(half_life, 1e-6))

        started = frame["starts"] > 0
        appeared = frame["minutes"] > 0

        # Long-memory weights for the horizon reversion TARGET (his own long-run
        # start rate); see `horizon_start_reversion`. Absent when the parameter
        # is 0, which leaves every stat and prediction exactly as before.
        long_half_life = _param("minutes.horizon_start_target_half_life")
        if long_half_life > 0:
            frame["_w_long"] = 0.5 ** (age / long_half_life)

        # Starts cut short by injury; see `_injury_exit_rows`. Absent when the
        # parameter is 0, so the P(60 | start) fit is exactly what it was.
        exit_strength = _param("minutes.injury_exit_p60_strength")
        if exit_strength > 0:
            frame["_injury_exit"] = self._injury_exit_rows(frame, key)

        # Position-level priors first: they are what individual players shrink
        # toward, so they must be computed over everyone.
        for position in POSITIONS:
            rows = frame[frame["_position"] == position]
            if rows.empty:
                self.by_position[position] = {
                    "start_rate": NEW_SIGNING_START_RATE,
                    "minutes_if_start": 80.0,
                    "minutes_if_bench": 20.0,
                    "p_60_if_start": 0.8,
                    "bench_appear_rate": 0.3,
                }
                continue
            rows_started = rows[rows["starts"] > 0]
            rows_bench = rows[(rows["starts"] == 0) & (rows["minutes"] > 0)]
            rows_not_started = rows[rows["starts"] == 0]
            self.by_position[position] = {
                "start_rate": float((rows["starts"] > 0).mean()),
                "minutes_if_start": float(rows_started["minutes"].mean())
                if len(rows_started)
                else 80.0,
                "minutes_if_bench": float(rows_bench["minutes"].mean())
                if len(rows_bench)
                else 20.0,
                "p_60_if_start": float((rows_started["minutes"] >= 60).mean())
                if len(rows_started)
                else 0.8,
                "bench_appear_rate": float((rows_not_started["minutes"] > 0).mean())
                if len(rows_not_started)
                else 0.3,
            }
            if exit_strength > 0 and len(rows_started):
                # The p60 prior WITHOUT injury exits, and the population rate of
                # them, from the same rows. Their product reproduces the plain
                # prior exactly at strength 1 — (1 - e/n) * n60/(n - e) = n60/n —
                # which is what stops the exclusion inflating anyone's P(60).
                exits = rows_started["_injury_exit"].astype(float) * exit_strength
                kept = float(len(rows_started) - exits.sum())
                self.by_position[position]["p_60_if_start_clean"] = (
                    float((rows_started["minutes"] >= 60).sum()) / kept
                    if kept > 0 else 0.8
                )
                self.by_position[position]["injury_exit_rate"] = float(
                    exits.sum() / len(rows_started)
                )

        # The weight each row carries as evidence about his ROLE. Equal to `_w`
        # unless the row is a non-appearance at a deadline where he was flagged;
        # see `_discount_unavailable`.
        frame["_w_role"], self.availability_diagnostics = self._discount_unavailable(
            frame, key
        )
        if "_injury_exit" in frame.columns:
            self.availability_diagnostics["injury_exit_starts"] = int(
                frame["_injury_exit"].sum()
            )

        for player_key, rows in frame.groupby(key, dropna=True):
            self.by_player[player_key] = self._player_stats(rows, "_w_role")

        self._fit_now_stats(frame, key)

        self.fitted = True
        logger.info(
            "MinutesModel fitted on %d rows: %d players, position start rates %s, "
            "deadline availability %s",
            len(frame),
            len(self.by_player),
            {p: round(v["start_rate"], 3) for p, v in self.by_position.items()},
            self.availability_diagnostics,
        )
        return self

    @staticmethod
    def _player_stats(rows: pd.DataFrame, weight: str) -> Dict[str, Any]:
        """
        One player's recency-weighted role and minutes sufficient statistics.

        Every count is a weighted sum. `n_fixtures` becomes an effective sample
        size, which is also the right input to the evidence weight surfaced
        downstream: thirty stale fixtures should not read as strong evidence.

        ``weight`` names the column to weight by. `_w_role` differs from `_w`
        only on non-appearances, so every conditional-on-appearing quantity
        (minutes if started or benched, P(60 | started)) is unchanged by the
        unavailability discount by construction — it only moves the role split.
        """
        w = rows[weight]
        started = rows["starts"] > 0
        not_started = ~started
        bench = not_started & (rows["minutes"] > 0)
        positions = rows["_position"].dropna()
        extra: Dict[str, Any] = {}
        if "_w_long" in rows.columns:
            # Same row discounts as `weight` (the fit-now credit, the
            # unavailable-fixture retention), on a long half-life instead of the
            # 1.5-fixture one. `_w` is a positive power of 0.5, never 0.
            long_w = rows["_w_long"] * (w / rows["_w"])
            extra["n_fixtures_long"] = float(long_w.sum())
            extra["n_starts_long"] = float(long_w[started].sum())
        if "_injury_exit" in rows.columns:
            # P(60 | start) is fitted on starts NOT cut short by injury; the
            # population exit rate is multiplied back in `predict`.
            strength = _param("minutes.injury_exit_p60_strength")
            p60_w = w * (1.0 - strength * rows["_injury_exit"].astype(float))
            extra["n_started_rows_p60"] = float(p60_w[started].sum())
            extra["injury_exit_starts"] = float(rows.loc[started, "_injury_exit"].sum())
        return {
            **extra,
            "n_fixtures": float(w.sum()),
            "n_starts": float(w[started].sum()),
            "n_not_started": float(w[not_started].sum()),
            "n_bench_appearances": float(w[bench].sum()),
            "sum_minutes_if_start": float((rows.loc[started, "minutes"] * w[started]).sum()),
            "n_started_rows": float(w[started].sum()),
            "sum_minutes_if_bench": float((rows.loc[bench, "minutes"] * w[bench]).sum()),
            "n_60_starts": float(w[started & (rows["minutes"] >= 60)].sum()),
            "raw_fixtures": int(len(rows)),
            # Raw (unweighted) fixtures' worth of non-appearances the fit
            # attributed to unavailability rather than selection. Carried so an
            # artifact can say WHY a flagged player's role did not fall.
            "fixtures_discounted_as_unavailable": float(rows["_discounted"].sum()),
            "position": positions.iloc[-1] if len(positions) else None,
        }

    def _fit_now_stats(self, frame: pd.DataFrame, key: str) -> None:
        """
        Attach a ``fit_now`` role fit to every player with a flagged absence.

        Used by ``predict`` ONLY when the player is fit at the prediction
        deadline (status 'a', no chance-of-playing below 100, no lowering
        evidence; see :func:`is_fit_now`). For everyone else the published fit
        above is used, unchanged — so this is inert for every player who is
        flagged today and for every player who never carried a flag.

        In the ``fit_now`` fit each non-appearance at a flagged deadline keeps
        ``1 - s * q`` of its role weight, where ``s`` is
        ``minutes.fit_now_absence_credit`` and ``q`` is
        :func:`unavailability_posterior` — P(he was unavailable | he did not
        play). That is the injury double count `_discount_unavailable` removes,
        restricted to the one case where it can be removed safely: today's
        availability is exactly 1.0, so the face-value miscalibration of FPL's
        graded flags (which the double count was partly cancelling for flagged
        players) cannot re-enter through ``predict``'s availability multiplier.

        Recency age is deliberately NOT moved onto an "available clock" that
        would keep his pre-injury rows fresh. Measured on the sealed ledger,
        that version did no better than this one on start and was worse on 60+:
        a player back from injury does not walk straight back into his old role.
        See the registry entry for the numbers.

        Identification is by the sealed flags, never by the zeros alone: a
        player dropped while fit carries no flag, has ``q`` = 0 everywhere, and
        gets no ``fit_now`` entry.
        """
        strength = _param("minutes.fit_now_absence_credit")
        if strength <= 0 or "_q_unavailable" not in frame.columns:
            return
        flagged = frame["_q_unavailable"] > 0
        if not flagged.any():
            return
        players = frame.loc[flagged, key].dropna().unique()
        rows = frame[frame[key].isin(players)].copy()
        # Never weaker than the global discount, should both ever be on.
        removal = max(
            1.0 - _param("minutes.unavailable_fixture_retention"), strength
        ) * rows["_q_unavailable"]
        rows["_w_fit_now"] = rows["_w"] * (1.0 - removal)
        n_players = 0
        for player_key, player_rows in rows.groupby(key, dropna=True):
            if player_key in self.by_player:
                self.by_player[player_key]["fit_now"] = self._player_stats(
                    player_rows, "_w_fit_now"
                )
                n_players += 1
        self.availability_diagnostics["players_with_fit_now_fit"] = n_players

    @staticmethod
    def _injury_exit_rows(frame: pd.DataFrame, key: str) -> pd.Series:
        """
        1.0 for each start cut short by injury, else 0.0. Read ONLY by the
        P(60 | start) fit (``minutes.injury_exit_p60_strength``).

        A start counts when it lasted under 60 minutes, the player was NOT sent
        off in it, and the next gameweek shows he was hurt:

        * **Flag, where known.** His ``availability_at_deadline`` at the next
          gameweek he has a row in is below 1.0 — FPL marked him doubtful or
          out at the very next deadline. This season's rows carry it from the
          sealed bootstraps.
        * **Proxy, where not** (the archive; a gameweek with no seal). He was a
          regular — started at least 3 of his previous 4 fixtures — and played
          no minutes at all in his next gameweek, within the same season. A
          regular who goes off early and then disappears is hurt far more often
          than dropped.

        Own red cards are excluded because the suspension that follows produces
        exactly the "flagged / missed the next match" signature: in the archive,
        35 of the 311 regulars' short starts followed by a zero were sendings
        off. They stay in the fit as ordinary starts — see the registry entry.

        The latest start of every player has no next gameweek yet and is never
        labelled, which is the old behaviour for that row.
        """
        started = frame["starts"] > 0
        short = started & (frame["minutes"] < 60)
        if "red_cards" in frame.columns:
            short &= pd.to_numeric(frame["red_cards"], errors="coerce").fillna(0) <= 0
        if not short.any():
            return pd.Series(0.0, index=frame.index)

        work = pd.DataFrame({
            "row": np.arange(len(frame)),
            "key": frame[key].to_numpy(),
            "idx": frame["_fixture_index"].astype(float).to_numpy(),
            "season": (
                frame["season"].astype(str).to_numpy()
                if "season" in frame.columns else np.full(len(frame), "")
            ),
            "started": started.astype(int).to_numpy(),
            "played": (frame["minutes"] > 0).astype(float).to_numpy(),
            "short": short.to_numpy(),
            "avail": (
                pd.to_numeric(frame[AVAILABILITY_AT_DEADLINE], errors="coerce").to_numpy()
                if AVAILABILITY_AT_DEADLINE in frame.columns
                else np.full(len(frame), np.nan)
            ),
        })
        work = work[pd.notna(work["key"])]
        # Stable sort: rows sharing a gameweek keep their input order.
        work = work.sort_values(["key", "idx"], kind="mergesort").reset_index(drop=True)

        # Regular: started >= 3 of his previous 4 fixtures (rows), before this one.
        work["prev4"] = work.groupby("key", sort=False)["started"].transform(
            lambda s: s.shift(1).rolling(4, min_periods=4).sum()
        )

        # His NEXT GAMEWEEK (strictly later index, so the second fixture of a
        # double gameweek does not answer for the first): did he play at all,
        # and what was his availability at its deadline.
        per_gw = work.groupby(["key", "idx"], sort=True).agg(
            season=("season", "first"), played=("played", "max"), avail=("avail", "min"),
        ).reset_index()
        nxt = per_gw.groupby("key", sort=False)[["season", "played", "avail"]].shift(-1)
        per_gw["next_season"] = nxt["season"]
        per_gw["next_played"] = nxt["played"]
        per_gw["next_avail"] = nxt["avail"]
        work = work.merge(
            per_gw[["key", "idx", "next_season", "next_played", "next_avail"]],
            on=["key", "idx"], how="left",
        )

        flagged = work["next_avail"].notna() & (work["next_avail"] < 1.0)
        proxy = (
            work["next_avail"].isna()
            & work["next_played"].notna()
            & (work["next_season"] == work["season"])
            & (work["next_played"] == 0.0)
            & (work["prev4"] >= 3)
        )
        label = np.zeros(len(frame))
        hit = work.loc[work["short"] & (flagged | proxy), "row"].to_numpy()
        label[hit] = 1.0
        return pd.Series(label, index=frame.index)

    def _discount_unavailable(
        self, frame: pd.DataFrame, key: str
    ) -> Tuple[pd.Series, Dict[str, Any]]:
        """
        Role weights with flagged non-appearances discounted, plus diagnostics.

        **The defect this removes.** ``predict`` returns ``p_start * availability``,
        which is right only if ``p_start`` is P(start | available). Fitted on raw
        rows it is P(start) unconditionally, so a fixture missed through injury
        enters twice: once as a benching in ``p_start``, and again through the flag
        in ``availability``. With a 1.5-fixture half-life the missed fixture is the
        heaviest row in the fit, and the horizon never recovers from it, because
        ``horizon_start_reversion`` pulls toward the POSITION base rate rather than
        back to the role he held before the knock. Measured 2026-10-06: Joao Pedro,
        four 90-minute starts then 0 minutes at 75% in GW5, fitted p_start 0.569
        with the GW5 row and 0.862 without it; published GW6 p_appears 0.46.

        **Off by default, on measurement.** ``minutes.unavailable_fixture_retention``
        is 1.0, which makes this an exact no-op. Removing the double count made
        calibration WORSE on this season's real deadline flags, because FPL's
        graded flags resolve far below face value and the double count was partly
        cancelling that. The registry entry carries the numbers and the order of
        work that would let it be switched on.

        Each non-appearance at a known, sub-1.0 deadline availability keeps
        ``1 - (1 - retention) * q`` of its weight, where ``q`` is
        :func:`unavailability_posterior` evaluated at his role estimated from his
        OTHER rows — the clean ones, where availability is known to be full or
        unknown, or where he played. One step, not iterated to convergence: the
        clean-row estimate is already the role conditional on being available,
        which is the quantity the posterior needs.

        Appearances are never discounted: a player who played was available, and
        whether he started is clean evidence about his role.

        What is deliberately NOT changed:

        * **Recency age.** Weights stay relative to the latest fixture in the
          training data, so a long absence still makes the pre-injury role STALE
          and pulls a returning player toward the position prior rather than
          restoring him as nailed. That is the conservative reading of a long
          absence — the side moves on — and it is not double counting, because the
          stale rows are not counted as benchings.
        * **Position priors.** Computed over every row, as before. They are both
          the shrinkage target and the horizon reversion target, and the latter
          was measured unconditionally over two archive seasons that carry no
          flags. Conditioning one and not the other would be worse than neither.
        """
        weights = frame["_w"].astype(float)
        frame["_discounted"] = 0.0
        # P(unavailable | did not play) per row; 0 wherever the row is not a
        # non-appearance at a known, flagged deadline. Read by the fit-now path.
        frame["_q_unavailable"] = 0.0
        diagnostics: Dict[str, Any] = {
            "rows_with_deadline_availability": 0,
            "rows_discounted": 0,
            "fixtures_removed": 0.0,
        }
        if AVAILABILITY_AT_DEADLINE not in frame.columns:
            return weights, diagnostics

        known = pd.to_numeric(frame[AVAILABILITY_AT_DEADLINE], errors="coerce")
        diagnostics["rows_with_deadline_availability"] = int(known.notna().sum())
        ambiguous = (frame["minutes"] <= 0) & known.notna() & (known < 1.0)
        if not ambiguous.any():
            return weights, diagnostics

        # Role when available, from the clean rows, shrunk exactly as `predict`
        # shrinks — so the posterior judges each zero against the same role the
        # model would otherwise have projected.
        strength = _param("minutes.start_shrinkage")
        clean = frame[~ambiguous]
        clean_started = clean["starts"] > 0
        clean_bench = (~clean_started) & (clean["minutes"] > 0)
        per_player = pd.DataFrame({
            "n": clean.groupby(key)["_w"].sum(),
            "starts": clean[clean_started].groupby(key)["_w"].sum(),
            "not_started": clean[~clean_started].groupby(key)["_w"].sum(),
            "bench": clean[clean_bench].groupby(key)["_w"].sum(),
        }).fillna(0.0)

        targets = frame.loc[ambiguous, [key, "_position"]]
        prior_start = targets["_position"].map(
            lambda p: self.by_position.get(p, {}).get("start_rate", NEW_SIGNING_START_RATE)
        ).astype(float)
        prior_bench = targets["_position"].map(
            lambda p: self.by_position.get(p, {}).get("bench_appear_rate", 0.3)
        ).astype(float)
        counts = per_player.reindex(targets[key].values).fillna(0.0)
        counts.index = targets.index
        p_start = _shrink(counts["starts"], counts["n"], prior_start, strength)
        p_bench = _shrink(counts["bench"], counts["not_started"], prior_bench, strength)
        p_appear = p_start + (1.0 - p_start) * p_bench

        share = unavailability_posterior(known[ambiguous], p_appear)
        frame.loc[ambiguous, "_q_unavailable"] = share
        retention = _param("minutes.unavailable_fixture_retention")
        removed = (1.0 - retention) * share

        weights = weights.copy()
        weights.loc[ambiguous] = weights.loc[ambiguous] * (1.0 - removed)
        frame.loc[ambiguous, "_discounted"] = removed
        diagnostics["rows_discounted"] = int((removed > 0).sum())
        diagnostics["fixtures_removed"] = round(float(removed.sum()), 3)
        return weights, diagnostics

    def predict(
        self,
        position: str,
        player_key: Any = None,
        status: Optional[str] = STATUS_AVAILABLE,
        chance_of_playing: Optional[float] = None,
        news_age_days: Optional[float] = None,
        fallback_start_rate: Optional[float] = None,
        horizon: int = 0,
        availability_override: Optional[AvailabilityState] = None,
        target_kickoff: Optional[datetime] = None,
    ) -> RoleProbabilities:
        """
        Role probabilities for one player-fixture.

        ``fallback_start_rate`` lets a caller supply a prior-season rate for a
        player with no per-fixture history — for instance ``starts / 38`` from the
        committed pre-season snapshot. It is used only as the shrinkage target,
        never as the answer, and it is clipped: a naive ``starts / matches_played``
        with the wrong denominator produced values above 8 in testing.

        ``availability_override`` supplies a pre-classified ``AvailabilityState``
        so a horizon projection can reuse one classification across every week
        instead of re-parsing news per week. ``target_kickoff`` is the fixture's
        own kickoff, needed only to decide whether a dated absence has expired.
        """
        canonical = normalise_position(position)
        if canonical is None:
            raise ValueError(f"cannot predict for position {position!r}")

        prior = self.by_position.get(canonical) or {
            "start_rate": NEW_SIGNING_START_RATE,
            "minutes_if_start": 80.0,
            "minutes_if_bench": 20.0,
            "p_60_if_start": 0.8,
            "bench_appear_rate": 0.3,
        }

        start_prior = prior["start_rate"]
        if fallback_start_rate is not None:
            start_prior = float(np.clip(fallback_start_rate, 0.0, 1.0))

        state = availability_override or availability_state(
            status, chance_of_playing, news_age_days
        )

        stats = self.by_player.get(player_key) if player_key is not None else None
        # A player fit NOW whose recent zeros came at flagged deadlines is fitted
        # with those absences credited to the flag; see `_fit_now_stats`. Exists
        # only when minutes.fit_now_absence_credit > 0 and he carries a flag.
        if stats and "fit_now" in stats and is_fit_now(state):
            stats = stats["fit_now"]
        n_fixtures = int(stats.get("raw_fixtures", 0)) if stats else 0
        n_effective = float(stats["n_fixtures"]) if stats else 0.0

        if stats:
            p_start = _shrink(
                stats["n_starts"], stats["n_fixtures"], start_prior,
                _param("minutes.start_shrinkage"),
            )
            p_bench_given_not_start = _shrink(
                stats["n_bench_appearances"], stats["n_not_started"],
                prior["bench_appear_rate"], _param("minutes.start_shrinkage"),
            )
            minutes_if_start = _shrink(
                stats["sum_minutes_if_start"], stats["n_started_rows"],
                prior["minutes_if_start"], _param("minutes.minutes_shrinkage"),
            )
            minutes_if_bench = _shrink(
                stats["sum_minutes_if_bench"], stats["n_bench_appearances"],
                prior["minutes_if_bench"], _param("minutes.minutes_shrinkage"),
            )
            if "n_started_rows_p60" in stats and "p_60_if_start_clean" in prior:
                # P(60 | start) = P(no injury exit) * P(60 | start, no exit):
                # his rate on starts not cut short by injury, shrunk toward the
                # position's rate on the same footing, times the POSITION's
                # exit-free rate. Fitting the second factor without the first
                # would inflate everyone who had an exit; see the registry entry.
                p_60_if_start = (1.0 - prior["injury_exit_rate"]) * _shrink(
                    stats["n_60_starts"], stats["n_started_rows_p60"],
                    prior["p_60_if_start_clean"], _param("minutes.p60_shrinkage"),
                )
            else:
                p_60_if_start = _shrink(
                    stats["n_60_starts"], stats["n_started_rows"],
                    prior["p_60_if_start"], _param("minutes.p60_shrinkage"),
                )
        else:
            p_start = start_prior
            p_bench_given_not_start = prior["bench_appear_rate"]
            minutes_if_start = prior["minutes_if_start"]
            minutes_if_bench = prior["minutes_if_bench"]
            p_60_if_start = prior["p_60_if_start"]

        # Horizon churn in WHO starts. With minutes.horizon_start_target_half_life
        # > 0 (the default) he reverts toward HIS OWN long-run start rate, fully,
        # at rate rho^h: today's form fades into his long-run role, not into the
        # position pool, which for a keeper is mostly second and third choices.
        # A regular whose form dipped drifts up, a player who just broke in drifts
        # down, and a nailed starter barely moves. See `horizon_start_reversion`.
        #
        # At 0 the old path: a pull toward the POSITION base rate by
        # cap*(1-rho^h), under which a nailed starter drifts down and a fringe
        # player drifts up. (A model fitted with the parameter off carries no
        # long-memory stats and keeps that path even if it is switched on later.)
        own_target = _param("minutes.horizon_start_target_half_life") > 0 and (
            not stats or "n_fixtures_long" in stats
        )
        if horizon > 0:
            if own_target:
                if stats:
                    toward = _shrink(
                        stats["n_starts_long"], stats["n_fixtures_long"],
                        start_prior, _param("minutes.start_shrinkage"),
                    )
                else:
                    # No history: p_start already IS the prior, and the prior
                    # is a long-run rate, so there is nothing to revert toward.
                    toward = p_start
                keep = _param("minutes.horizon_start_target_rho") ** int(horizon)
                p_start = toward + (p_start - toward) * keep
            else:
                toward = prior["start_rate"]
                pull = horizon_start_reversion(horizon)
                p_start = p_start + (toward - p_start) * pull

        # Availability is projected forward through the horizon path, which knows
        # how this player's absence is expected to END. Applied to the AVAILABILITY
        # term rather than to the role split, so it reduces the chance of
        # featuring at all without distorting the start-versus-bench mix — which
        # is what an accumulating injury and rotation hazard actually does.
        #
        # Critically, this happens BEFORE simulation. The previous code discounted
        # finished expected points instead, so the haircut never crossed the
        # 60-minute clean-sheet gate or the 1-minute appearance gate. Those two
        # non-linearities run in opposite directions and are position-dependent,
        # so a scalar on totals mis-ranks defenders against forwards at horizon.
        avail, horizon_reason = horizon_availability(state, horizon, target_kickoff)
        gate_reason = state.gate_reason

        # Roles are exhaustive before gating; the gate then scales the two
        # appearing branches. This ordering keeps every probability inside [0, 1]
        # by construction.
        ungated_start = float(np.clip(p_start, 0.0, 1.0))
        ungated_bench = float(np.clip(p_bench_given_not_start, 0.0, 1.0)) * (
            1.0 - ungated_start
        )
        p_start = ungated_start * avail
        p_bench_appear = ungated_bench * avail
        p_bench_appear = float(np.clip(p_bench_appear, 0.0, 1.0 - p_start))
        # The residual splits in two. "Unused" is available but not picked, which
        # is what the simulator's substitute layer renormalises over;
        # "unavailable" is not pickable at all. Conflating them let an injured
        # player absorb bench-appearance mass that should have gone to a fit one.
        p_unavailable = float(np.clip(1.0 - avail, 0.0, 1.0))
        p_unused = float(
            np.clip(1.0 - p_start - p_bench_appear - p_unavailable, 0.0, 1.0)
        )

        strength = _param("minutes.start_shrinkage")
        evidence_weight = (
            n_effective / (n_effective + strength) if strength > 0 else 0.0
        )

        result = RoleProbabilities(
            p_start=p_start,
            p_bench_appear=p_bench_appear,
            p_unused=p_unused,
            minutes_if_start=float(np.clip(minutes_if_start, 0.0, 90.0)),
            minutes_if_bench=float(np.clip(minutes_if_bench, 0.0, 90.0)),
            p_60_if_start=float(np.clip(p_60_if_start, 0.0, 1.0)),
            availability=avail,
            evidence_fixtures=n_fixtures,
            evidence_weight=float(evidence_weight),
            gate_reason=gate_reason,
            p_unavailable=p_unavailable,
            horizon=int(max(0, horizon)),
            horizon_reason=horizon_reason,
        )

        # Cheap, and it has already caught a real defect: a p_start above 1 makes
        # every downstream probability meaningless while still looking plausible
        # in an artifact. Now four-way, since the residual was split.
        total = (
            result.p_start + result.p_bench_appear
            + result.p_unused + result.p_unavailable
        )
        if not 0.999 <= total <= 1.001:
            raise AssertionError(
                f"role probabilities sum to {total}, not 1 "
                f"(start={result.p_start}, bench={result.p_bench_appear}, "
                f"unused={result.p_unused}, unavailable={result.p_unavailable})"
            )
        return result
