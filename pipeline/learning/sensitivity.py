"""
How well a recommendation survives being wrong.

## The point

Ranking a transfer by expected points asks "which move scores highest if the
projections are right". That is the wrong question, because they are not. The
useful question is "which move still looks best when the projections are
perturbed by as much as they have historically been wrong by" — and a move that
wins on 92 of 100 noisy re-solves is a different recommendation from one that
wins on 51, even when both have the same headline EV.

The competitor study called this the single best pattern in the category. It is
cheap to implement and almost impossible to fake, because it needs a *measured*
error distribution to mean anything.

## Which is why this module refuses to run today

**No gameweek has ever sealed.** There is no `forecast_ledger.json`, no
`predictions/ledger/`, and the archive holds match-outcome forecasts rather than
per-player FPL residuals. So there is nothing to calibrate a sigma from.

The plan is explicit about what to do here, and this module does it: *"The noise
must be calibrated, not chosen. An invented sigma produces a confident-looking
table about nothing."* `measure_noise` returns ``None`` until enough sealed
gameweeks exist, and `assess` then reports ``measurable=False`` with the reason
and the observation count. It does not fall back to a plausible-looking default,
because a robustness score computed from a guessed error distribution is worse
than no robustness score: it launders a guess through arithmetic and comes out
looking like evidence.

Everything below the measurement gate is built and tested against synthetic
residuals, so the day a fourth gameweek seals this starts producing real numbers
with no further work.

## Correlated noise, and where this departs from the plan

Independent per-player noise would badly understate the risk of tripling up on
one defence: three Liverpool defenders share a single clean-sheet outcome, and
sampling them independently implies that outcome can happen to one and not the
others. Averaged over draws, that makes a concentrated squad look as safe as a
diversified one, which is precisely the risk the analysis exists to expose.

The plan says to sample **at the fixture level**. This module samples at the
**team** level instead, deliberately:

    A fixture couples its two sides with *opposite* signs depending on the
    scoring component. If Liverpool keep a clean sheet, Bournemouth by
    definition did not score — a negative coupling. But a high-tempo game lifts
    both sides' attacking returns — a positive one. A single scalar shock per
    fixture has to pick one sign, and whichever it picks is wrong for the other
    half of the points.

Team-level shocks capture the dominant effect (a defence keeps a clean sheet or
does not; an attack fires or does not) with a sign that is correct for every
component. The fixture-level coupling is real but second-order, and modelling it
with the wrong sign would be worse than omitting it. If a measured
cross-fixture correlation ever exists, this is the place to add it — as two
signed parameters, not one.

So each player's perturbed xP is

    xp + team_shock[team] * sqrt(rho) + player_shock * sqrt(1 - rho)

scaled by that position's residual standard deviation, where ``rho`` is the
share of variance common to a team. ``rho = 0`` is independent noise and
``rho = 1`` makes every player on a team move in lockstep.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# Positions the residual model is keyed on. A position absent from a measured
# sample is not given a borrowed sigma from another position: goalkeeper and
# forward error distributions have nothing to do with each other.
POSITIONS = ("GKP", "DEF", "MID", "FWD")

# Below this many settled player-gameweeks per position, a standard deviation is
# an artefact of the sample rather than a measurement. Four gameweeks of a
# 15-man squad is roughly 60 observations in total and far fewer per position;
# the plan's own retirement gate for the heuristic engine is four gameweeks, and
# this is deliberately stricter because a sigma drives every number downstream.
MIN_OBSERVATIONS_PER_POSITION = 30


class NotMeasurableError(RuntimeError):
    """Raised when a caller demands a noise model that cannot be measured."""


@dataclass(frozen=True)
class NoiseModel:
    """
    A measured per-position error distribution.

    Only ever constructed from settled outcomes. There is no default instance
    and no constructor that invents one.
    """

    #: Residual standard deviation in FPL points, per position.
    sd_by_position: Mapping[str, float]
    #: Share of variance shared by players on the same team, in [0, 1].
    intra_team_rho: float
    #: Settled player-gameweeks behind the estimate, per position.
    observations: Mapping[str, int]
    #: How many sealed gameweeks contributed.
    gameweeks: int

    def sd_for(self, position: str) -> float:
        """The sigma for a position, or 0.0 when it was never measured."""
        return float(self.sd_by_position.get(position, 0.0))


@dataclass(frozen=True)
class MoveOutcome:
    """One distinct root move and how often it won."""

    #: Stable description, e.g. "521->9" or "hold".
    move: str
    wins: int
    draws_seen: int

    @property
    def frequency(self) -> float:
        return self.wins / self.draws_seen if self.draws_seen else 0.0


@dataclass(frozen=True)
class SensitivityReport:
    """
    What survived.

    ``measurable`` is the field to read first. When it is False every other
    number is either absent or structural, and rendering a survival percentage
    would be inventing one.
    """

    measurable: bool
    reason: Optional[str] = None
    baseline_move: Optional[str] = None
    #: Fraction of re-solves in which the baseline move remained best.
    survival: Optional[float] = None
    outcomes: Tuple[MoveOutcome, ...] = ()
    draws: int = 0
    noise: Optional[NoiseModel] = None
    #: Draws that could not be solved, reported rather than silently dropped.
    failed_draws: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "measurable": self.measurable,
            "reason": self.reason,
            "baseline_move": self.baseline_move,
            "survival": None if self.survival is None else round(self.survival, 4),
            "draws": self.draws,
            "failed_draws": self.failed_draws,
            "alternatives": [
                {
                    "move": o.move,
                    "wins": o.wins,
                    "frequency": round(o.frequency, 4),
                }
                for o in self.outcomes
            ],
            "noise": None
            if self.noise is None
            else {
                "sd_by_position": {
                    k: round(v, 4) for k, v in self.noise.sd_by_position.items()
                },
                "intra_team_rho": round(self.noise.intra_team_rho, 4),
                "observations": dict(self.noise.observations),
                "gameweeks": self.noise.gameweeks,
            },
        }


# ─────────────────────────────────────────────────────────────────────────────
# Measurement
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _Accumulator:
    """Streaming sum of squares, so a long history never lands in memory."""

    n: int = 0
    total: float = 0.0
    total_sq: float = 0.0

    def add(self, residual: float) -> None:
        self.n += 1
        self.total += residual
        self.total_sq += residual * residual

    def sd(self) -> float:
        """
        Sample standard deviation about the *measured mean*, not about zero.

        Deliberate. A model with a systematic bias — every forward projected a
        point light, say — has a small spread around a shifted centre. Measuring
        about zero would fold that bias into the sigma and report the model as
        noisier than it is, which would then widen every perturbation and make
        every recommendation look more fragile than the evidence supports. Bias
        is a calibration problem and belongs in the calibration report; this
        number is about spread alone.
        """
        if self.n < 2:
            return 0.0
        mean = self.total / self.n
        variance = (self.total_sq / self.n) - (mean * mean)
        # Bessel's correction, and a floor at zero for floating-point noise on a
        # near-constant sample.
        variance = max(0.0, variance) * self.n / (self.n - 1)
        return math.sqrt(variance)


def measure_noise(
    settled: Sequence[Mapping[str, Any]],
    *,
    min_observations: int = MIN_OBSERVATIONS_PER_POSITION,
) -> Optional[NoiseModel]:
    """
    Derive the error distribution from settled gameweeks, or ``None``.

    ``settled`` is a sequence of records, each carrying at minimum::

        {"gameweek": 7, "element_id": 427, "position": "MID",
         "team": "LIV", "predicted": 5.4, "actual": 2.0}

    Returns ``None`` — never a fallback — when no position clears
    ``min_observations``. A partial measurement is still returned: if midfielders
    have enough history and goalkeepers do not, the model carries a sigma for
    MID and none for GKP, and `perturb` leaves goalkeepers unperturbed rather
    than borrowing a number from another position.
    """
    by_position: Dict[str, _Accumulator] = {p: _Accumulator() for p in POSITIONS}
    # Team-gameweek residual means, for the intra-team correlation.
    team_groups: Dict[Tuple[Any, Any], List[float]] = {}
    gameweeks = set()

    for record in settled:
        position = record.get("position")
        if position not in by_position:
            # An unknown position is dropped rather than pooled: pooling it
            # would contaminate whichever bucket it landed in.
            continue
        predicted = record.get("predicted")
        actual = record.get("actual")
        if not isinstance(predicted, (int, float)) or not isinstance(actual, (int, float)):
            continue
        residual = float(actual) - float(predicted)
        by_position[position].add(residual)
        gameweeks.add(record.get("gameweek"))
        key = (record.get("gameweek"), record.get("team"))
        team_groups.setdefault(key, []).append(residual)

    sd_by_position = {
        position: acc.sd()
        for position, acc in by_position.items()
        if acc.n >= min_observations and acc.sd() > 0.0
    }
    if not sd_by_position:
        return None

    return NoiseModel(
        sd_by_position=sd_by_position,
        intra_team_rho=_intra_team_rho(team_groups),
        observations={p: acc.n for p, acc in by_position.items()},
        gameweeks=len({g for g in gameweeks if g is not None}),
    )


def _intra_team_rho(groups: Mapping[Tuple[Any, Any], Sequence[float]]) -> float:
    """
    Share of residual variance common to a team in one gameweek.

    Estimated as the ratio of between-group variance to total variance across
    team-gameweek groups — the intraclass correlation, computed the plain way
    rather than through a variance-components fit, because with the handful of
    gameweeks this will first run on the extra machinery would add precision the
    data does not have.

    Clamped to [0, 1]. A negative estimate is a small-sample artefact, and a
    negative rho would make `perturb`'s ``sqrt(rho)`` a complex number.
    """
    usable = [list(values) for values in groups.values() if len(values) >= 2]
    if len(usable) < 2:
        return 0.0

    everything = [value for group in usable for value in group]
    grand_mean = sum(everything) / len(everything)
    total_var = sum((v - grand_mean) ** 2 for v in everything) / len(everything)
    if total_var <= 0.0:
        return 0.0

    between = sum(
        len(group) * ((sum(group) / len(group)) - grand_mean) ** 2 for group in usable
    ) / len(everything)
    return min(1.0, max(0.0, between / total_var))


# ─────────────────────────────────────────────────────────────────────────────
# Perturbation
# ─────────────────────────────────────────────────────────────────────────────


def perturb(
    candidates: Sequence[Any],
    noise: NoiseModel,
    rng: Any,
) -> List[Any]:
    """
    Return candidates with xP resampled once, correlated within each team.

    Each candidate must expose ``position``, ``team`` and ``xp``; the objects
    returned are shallow copies with ``xp`` replaced, so the caller's originals
    are untouched and can be re-perturbed for the next draw.

    Perturbed xP is floored at zero. A negative expected-points value is not a
    forecast the optimiser can interpret — it would make the player worth
    actively benching in a way no real projection supports, and the floor bounds
    the damage without distorting the bulk of the distribution.
    """
    rho = max(0.0, min(1.0, noise.intra_team_rho))
    common_weight = math.sqrt(rho)
    idiosyncratic_weight = math.sqrt(1.0 - rho)

    teams = {getattr(c, "team", None) for c in candidates}
    team_shock = {team: rng.normal() for team in teams}

    out: List[Any] = []
    for candidate in candidates:
        sd = noise.sd_for(getattr(candidate, "position", ""))
        if sd <= 0.0:
            # Never measured for this position. Leaving it unperturbed is the
            # honest choice: borrowing another position's sigma would make the
            # report a statement about a distribution nobody measured.
            out.append(_copy(candidate))
            continue
        shock = (
            common_weight * team_shock[getattr(candidate, "team", None)]
            + idiosyncratic_weight * rng.normal()
        )
        out.append(_copy(candidate, xp=max(0.0, candidate.xp + sd * shock)))
    return out


def _copy(candidate: Any, **changes: Any) -> Any:
    """Shallow copy with field overrides, for frozen or plain dataclasses."""
    import dataclasses

    if dataclasses.is_dataclass(candidate):
        return dataclasses.replace(candidate, **changes)
    import copy as _copy_mod

    clone = _copy_mod.copy(candidate)
    for key, value in changes.items():
        setattr(clone, key, value)
    return clone


# ─────────────────────────────────────────────────────────────────────────────
# The report
# ─────────────────────────────────────────────────────────────────────────────


def describe_move(plan: Any) -> str:
    """
    A stable label for the root move, so two draws can be compared.

    Sorted on both sides: the optimiser has no reason to return transfers in a
    consistent order, and an unsorted label would count one move as several.
    """
    out = sorted(getattr(plan, "transfers_out", []) or [])
    into = sorted(getattr(plan, "transfers_in", []) or [])
    if not out and not into:
        return "hold"
    return f"{','.join(map(str, out))}->{','.join(map(str, into))}"


def assess(
    candidates: Sequence[Any],
    noise: Optional[NoiseModel],
    solve_once: Any,
    *,
    draws: int = 100,
    rng: Any = None,
) -> SensitivityReport:
    """
    Re-solve ``draws`` times under perturbed projections and count the winners.

    ``solve_once`` takes a candidate sequence and returns a plan, or raises. It
    is injected rather than imported so this module does not depend on the MILP
    layer and can be tested without a solver.

    A draw that fails to solve is counted in ``failed_draws`` and excluded from
    the denominator. Treating it as a loss for the baseline would report the
    solver's limits as evidence against the recommendation.
    """
    if noise is None:
        return SensitivityReport(
            measurable=False,
            reason=(
                "No gameweek has been settled, so the projection error "
                "distribution has never been measured. A robustness score "
                "computed from a guessed sigma would describe nothing."
            ),
        )

    baseline_plan = solve_once(list(candidates))
    baseline = describe_move(baseline_plan)

    wins: Dict[str, int] = {}
    completed = 0
    failed = 0

    for _ in range(draws):
        try:
            plan = solve_once(perturb(candidates, noise, rng))
        except Exception as error:  # noqa: BLE001 - any solver failure
            # Logged, counted, and kept out of the denominator.
            logger.debug("sensitivity draw failed: %s", error)
            failed += 1
            continue
        wins[describe_move(plan)] = wins.get(describe_move(plan), 0) + 1
        completed += 1

    outcomes = tuple(
        sorted(
            (MoveOutcome(move=m, wins=w, draws_seen=completed) for m, w in wins.items()),
            key=lambda o: (-o.wins, o.move),
        )
    )
    survival = (wins.get(baseline, 0) / completed) if completed else None

    return SensitivityReport(
        measurable=True,
        baseline_move=baseline,
        survival=survival,
        outcomes=outcomes,
        draws=completed,
        noise=noise,
        failed_draws=failed,
    )


def interpret(survival: Optional[float]) -> str:
    """
    The band vocabulary that ships with the number.

    FPL Review publishes bands alongside its xMins and it is the right habit:
    a bare "0.62" invites the reader to invent their own threshold, and they
    will pick a different one each time they look.
    """
    if survival is None:
        return "not measured"
    if survival >= 0.80:
        return "robust — survives the model being wrong"
    if survival >= 0.60:
        return "leaning — better than the alternatives, but not decisively"
    if survival >= 0.40:
        return "a coin toss between the top options"
    return "fragile — the headline ranking is noise"
