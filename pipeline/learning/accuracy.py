"""
Are we any good, and how would anyone know.

## The one number that means something on day one

Model accuracy is published by exactly one product in this category, once, on
2022/23 data. A rolling in-season dashboard would be unique — and it needs
sealed gameweeks, of which there are currently none.

But the **perfect-model ceiling** does not. That is the whole reason it is the
strongest epistemic device available here, and it is computable from what we
already publish:

    A model that knows the true distribution of a player's points cannot do
    better than predict its mean. Its expected squared error is then exactly the
    variance of that distribution. So

        ceiling_RMSE = sqrt( mean_i Var_i )

    is the error an omniscient forecaster still incurs, and it needs no outcomes
    at all — only the spread of our own simulated distributions, which
    `xp_public_gw{NN}.json` already carries as `xp_sd`.

This matters because FPL points are close to irreducibly random. The published
benchmark puts the top six public models within 0.08 RMSE of each other and all
near ~2.8, against a perfect model's ~2.806. Reporting "our RMSE is 2.9" without
that ceiling invites the reader to imagine a 2.0 is achievable. It is not, and
the gap between our number and the ceiling is the only part that is skill.

## What is deliberately absent

`measured` stays null until gameweeks seal, and every downstream field with it.
There is no partial credit and no placeholder: an accuracy dashboard that shows
a number before it has measured anything is worse than one that says it has
measured nothing, because the first is indistinguishable from a real result.

`predicted_xi` is the same. SportMonks publishes 84% on this and it is the
standard we set for ourselves — if we lose to it over six gameweeks the licence
is the answer. Until a gameweek seals we cannot compute ours, so it reports the
benchmark and a null.

## Bands, because the aggregate hides the decision

Splitting by outcome band is what made the OpenFPL comparison interesting:
FPL Review wins the low band, OpenFPL the high band, and **the high band is what
moves rank**. An aggregate RMSE averages those into a number that hides the only
decision-relevant fact — a model that is excellent at predicting blanks and poor
at predicting hauls will look fine and lose you the season.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

POSITIONS = ("GKP", "DEF", "MID", "FWD")

#: Outcome bands, low to high, as (name, inclusive lower bound).
#:
#: A "return" starts at 2 because that is a played-60-minutes appearance and
#: nothing else; below it the player did not feature meaningfully. A "haul"
#: starts at 10, the threshold the weekly objective is actually buying.
BANDS: Tuple[Tuple[str, int], ...] = (
    ("blank", -99),
    ("return", 2),
    ("haul", 10),
)

#: SportMonks' published predicted-XI accuracy. Named as the bar we set for
#: ourselves, not as something we have matched.
PREDICTED_XI_BENCHMARK = 0.84

#: Below this many settled player-gameweeks an RMSE is sample noise.
MIN_OBSERVATIONS = 50


def band_of(points: float) -> str:
    """Which outcome band a realised score falls in."""
    name = BANDS[0][0]
    for candidate, floor in BANDS:
        if points >= floor:
            name = candidate
    return name


def perfect_model_rmse(spreads: Sequence[float]) -> Optional[float]:
    """
    The RMSE an omniscient forecaster still incurs.

    ``spreads`` are per-player standard deviations of the simulated points
    distribution — `xp_sd` in the published projection.

    Returns None for an empty population rather than 0.0: a ceiling of zero
    would say a perfect model makes no errors, which is the opposite of what
    this number exists to communicate.
    """
    usable = [float(s) for s in spreads if isinstance(s, (int, float)) and s >= 0]
    if not usable:
        return None
    # Root-mean-square of the standard deviations, which is the square root of
    # the mean variance. Averaging the SDs instead would understate it: the
    # mean of square roots is not the square root of the mean.
    return math.sqrt(sum(s * s for s in usable) / len(usable))


@dataclass
class _Bucket:
    """Squared-error accumulator for one slice."""

    n: int = 0
    sum_sq: float = 0.0
    #: Per-observation errors, kept for the anytime-valid bound.
    errors: List[float] = field(default_factory=list)

    def add(self, predicted: float, actual: float) -> None:
        error = actual - predicted
        self.n += 1
        self.sum_sq += error * error
        self.errors.append(error)

    def rmse(self) -> Optional[float]:
        return math.sqrt(self.sum_sq / self.n) if self.n else None


def _slice(bucket: _Bucket, minimum: int) -> Optional[Dict[str, Any]]:
    """A reportable slice, or None when the sample is too thin to mean anything."""
    if bucket.n < minimum:
        return None
    payload: Dict[str, Any] = {"n": bucket.n, "rmse": round(bucket.rmse() or 0.0, 4)}
    try:
        from pipeline.learning.gates import anytime_valid_bound

        mean, radius = anytime_valid_bound(bucket.errors)
        # Bias, not error: the mean of the signed residuals. Reported beside the
        # RMSE because a model that is 0.5 points optimistic every week is a
        # different problem from one that is noisy, and RMSE alone conflates them.
        payload["bias"] = round(mean, 4)
        payload["bias_radius"] = None if math.isinf(radius) else round(radius, 4)
    except Exception as error:  # noqa: BLE001 - the bound is a nicety, not the number
        logger.debug("anytime-valid bound unavailable: %s", error)
    return payload


def measure(
    settled: Sequence[Mapping[str, Any]], *, minimum: int = MIN_OBSERVATIONS,
) -> Optional[Dict[str, Any]]:
    """
    Measured accuracy from settled gameweeks, or None.

    Each record needs ``position``, ``predicted``, ``actual`` and, where the
    forecast was made more than a week ahead, ``horizon`` (1 for the imminent
    gameweek). Returns None when nothing clears ``minimum`` — a partial
    dashboard is not better than an honest empty one.
    """
    overall = _Bucket()
    by_position: Dict[str, _Bucket] = {p: _Bucket() for p in POSITIONS}
    by_band: Dict[str, _Bucket] = {name: _Bucket() for name, _ in BANDS}
    by_horizon: Dict[int, _Bucket] = {}

    for record in settled:
        predicted = record.get("predicted")
        actual = record.get("actual")
        if not isinstance(predicted, (int, float)) or not isinstance(actual, (int, float)):
            continue
        predicted, actual = float(predicted), float(actual)

        overall.add(predicted, actual)
        position = record.get("position")
        if position in by_position:
            by_position[position].add(predicted, actual)
        # Banded on the REALISED score, not the prediction: the question is
        # "how well do we predict hauls", and bucketing by our own forecast
        # would answer "how well do we predict what we predicted".
        by_band[band_of(actual)].add(predicted, actual)
        horizon = record.get("horizon")
        if isinstance(horizon, int) and horizon > 0:
            by_horizon.setdefault(horizon, _Bucket()).add(predicted, actual)

    if overall.n < minimum:
        return None

    return {
        "overall": _slice(overall, minimum),
        "by_position": {
            p: s for p in POSITIONS if (s := _slice(by_position[p], minimum))
        },
        "by_band": {
            name: s for name, _ in BANDS if (s := _slice(by_band[name], minimum))
        },
        "by_horizon": {
            str(h): s for h in sorted(by_horizon) if (s := _slice(by_horizon[h], minimum))
        },
    }


def build(
    *,
    settled: Sequence[Mapping[str, Any]],
    spreads: Sequence[float],
    gameweeks_sealed: int,
    generated_at: str,
    season: Optional[str] = None,
    minimum: int = MIN_OBSERVATIONS,
) -> Dict[str, Any]:
    """
    The accuracy rollup. Aggregates only — never a per-player row.

    The ceiling is computed whenever a projection exists, which is now. The
    measured half stays null until gameweeks seal. Publishing the ceiling alone
    is not a placeholder: it is the answer to "how good could anything be", and
    it is the number that stops a future 2.9 being read as a failure.
    """
    ceiling = perfect_model_rmse(spreads)
    measured = measure(settled, minimum=minimum)

    skill: Optional[float] = None
    if measured and ceiling is not None:
        rmse = (measured.get("overall") or {}).get("rmse")
        if isinstance(rmse, (int, float)):
            # What is left after the irreducible noise. Never clamped at zero:
            # a negative value means we beat the ceiling, which is evidence of
            # a bug — most likely a look-ahead leak — and hiding it would be
            # hiding the most important thing this file could ever say.
            skill = round(float(rmse) - ceiling, 4)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "season": season,
        "gameweeks_sealed": int(gameweeks_sealed),
        "observations": len(settled),
        "perfect_model_rmse": None if ceiling is None else round(ceiling, 4),
        "perfect_model_basis": (
            "Root-mean-square of the simulated per-player standard deviations. "
            "A forecaster that knew each player's true distribution would still "
            "incur this, because the outcome is random."
        ),
        "measured": measured,
        "excess_over_ceiling": skill,
        "predicted_xi": {
            "ours": None,
            "benchmark": PREDICTED_XI_BENCHMARK,
            "benchmark_source": "SportMonks published predicted-XI accuracy",
            "reason": (
                "No gameweek has sealed, so realised lineups cannot be compared "
                "against what was forecast."
            ),
        },
        "reason": None if measured else (
            f"{gameweeks_sealed} gameweek(s) sealed and {len(settled)} settled "
            f"player-gameweeks recorded; at least {minimum} are needed before an "
            "error measurement describes the model rather than the sample."
        ),
    }


def write(payload: Mapping[str, Any], public_dir: Any) -> Any:
    """Publish the rollup for the /accuracy screen."""
    from pathlib import Path

    from pipeline.fpl.artifacts import write_json_atomically

    directory = Path(public_dir)
    directory.mkdir(parents=True, exist_ok=True)
    return write_json_atomically(dict(payload), directory / "accuracy.json")
