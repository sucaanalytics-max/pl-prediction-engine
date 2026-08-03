"""
Scoring: how good was the sealed forecast, measured against settled outcomes.

Produces ``score.json`` per gameweek. This is the first honest, out-of-sample
accuracy record the project has ever had — everything before it was either
in-sample or unfalsifiable.

Rules that keep the number meaningful:

* **Score the sealed universe, exactly.** Both the model and every baseline are
  evaluated over the element list recorded in the seal, never over whatever
  happens to be present. A candidate that could shrink its own benchmark could
  win a paired comparison without improving.
* **Never score from provisional data.** Bonus and defensive contributions move
  until FPL confirms, so a provisional settlement produces a diagnostic, not an
  accuracy claim.
* **Never score a late seal.** A forecast recorded after the deadline is
  excluded outright rather than quietly included with a caveat.
* **Baselines are computed here, from the same rows.** A comparison against a
  baseline computed elsewhere, over a different universe, is not a comparison.

Per-component reliability is reported because an aggregate hides direction: a
model can have an excellent mean expected-points error while being systematically
over-optimistic about appearances, which is precisely the failure that would send
the optimiser after cheap bench filler.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from pipeline.learning.ledger import gameweek_dir, read_forecast
from pipeline.learning.outcomes import read_outcomes
from pipeline.validation.metrics import (
    brier_score,
    calibration_curve_data,
    expected_calibration_error,
)

logger = logging.getLogger(__name__)

SCORE_SCHEMA_VERSION = 1

# Binary events the forecast makes an explicit probability claim about, paired
# with how the settled outcome realises each.
BINARY_COMPONENTS = {
    "p_appears": lambda row: 1.0 if row["minutes"] > 0 else 0.0,
    "p_60": lambda row: 1.0 if row["minutes"] >= 60 else 0.0,
    "p_goal": lambda row: 1.0 if row["goals_scored"] > 0 else 0.0,
    "p_multi_goal": lambda row: 1.0 if row["goals_scored"] > 1 else 0.0,
    "p_clean_sheet": lambda row: 1.0 if row["clean_sheets"] > 0 else 0.0,
    "p_ge_2": lambda row: 1.0 if row["total_points"] >= 2 else 0.0,
    "p_ge_5": lambda row: 1.0 if row["total_points"] >= 5 else 0.0,
    "p_ge_10": lambda row: 1.0 if row["total_points"] >= 10 else 0.0,
    "p_ge_15": lambda row: 1.0 if row["total_points"] >= 15 else 0.0,
}


class UnscoreableError(RuntimeError):
    """This gameweek cannot yield an honest accuracy claim."""


@dataclass
class ScoreReport:
    gameweek: int
    n_scored: int
    metrics: Dict[str, Any]
    provisional: bool

    def as_dict(self) -> Dict[str, Any]:
        return {
            "gameweek": self.gameweek,
            "n_scored": self.n_scored,
            "provisional": self.provisional,
            **self.metrics,
        }


def _component_metrics(
    predictions: np.ndarray, actuals: np.ndarray
) -> Dict[str, Any]:
    if len(predictions) == 0:
        return {"n": 0}
    return {
        "n": int(len(predictions)),
        "base_rate": float(actuals.mean()),
        "mean_predicted": float(predictions.mean()),
        "brier": float(brier_score(predictions, actuals)),
        "ece": float(expected_calibration_error(predictions, actuals)),
        "calibration": calibration_curve_data(predictions, actuals),
    }


def score_gameweek(
    gameweek: int,
    predictions_dir: Path,
    now: Optional[datetime] = None,
    dry_run: bool = False,
    allow_provisional: bool = False,
) -> ScoreReport:
    """
    Score one sealed gameweek against its settled outcomes.

    Raises :class:`UnscoreableError` rather than returning a degraded number: a
    figure that silently came from provisional data or a late seal is worse than
    no figure, because it will be quoted.
    """
    now = now or datetime.now(timezone.utc)
    directory = gameweek_dir(predictions_dir, gameweek, dry_run=dry_run)

    forecast = read_forecast(directory / "forecast.jsonl")
    outcomes = read_outcomes(directory / "outcome.jsonl")

    header = forecast["header"]
    if header.get("seconds_before_deadline", 0) <= 0:
        raise UnscoreableError(
            f"GW{gameweek} was sealed at or after its deadline; it cannot "
            "support an accuracy claim and is excluded rather than caveated."
        )

    provisional = bool(outcomes["header"].get("provisional", True))
    if provisional and not allow_provisional:
        raise UnscoreableError(
            f"GW{gameweek} is settled only provisionally. Bonus and defensive "
            "contributions still move until FPL confirms, so this would measure "
            "the wrong thing. Pass allow_provisional=True for a diagnostic."
        )

    # The sealed universe, exactly. Not the intersection with whatever the
    # outcome file happens to contain, and not the model's own selection.
    outcome_rows = outcomes["rows"]
    forecast_rows = {int(r["element_id"]): r for r in forecast["rows"]}

    scored: List[Dict[str, Any]] = []
    missing_outcome = 0
    for element_id, row in sorted(forecast_rows.items()):
        outcome = outcome_rows.get(element_id)
        if outcome is None:
            # A sealed player with no settled row did not feature in the API's
            # response at all. Counted, not dropped silently.
            missing_outcome += 1
            continue
        scored.append({"forecast": row, "outcome": outcome})

    if not scored:
        raise UnscoreableError(f"GW{gameweek}: no sealed player had a settled outcome")

    actual_points = np.array(
        [float(s["outcome"]["total_points"]) for s in scored]
    )
    predicted_points = np.array([float(s["forecast"].get("xp", 0.0)) for s in scored])

    components: Dict[str, Any] = {}
    for name, realise in BINARY_COMPONENTS.items():
        predictions = np.array(
            [float(s["forecast"].get(name, 0.0)) for s in scored]
        )
        actuals = np.array([realise(s["outcome"]) for s in scored])
        components[name] = _component_metrics(np.clip(predictions, 0, 1), actuals)

    # Baselines, computed here over the same rows so the comparison is real.
    baselines = {
        "zero": np.zeros_like(predicted_points),
        "position_mean": np.full_like(predicted_points, float(actual_points.mean())),
    }
    baseline_metrics = {
        name: {
            "mae": float(np.abs(values - actual_points).mean()),
            "rmse": float(np.sqrt(((values - actual_points) ** 2).mean())),
        }
        for name, values in baselines.items()
    }

    errors = predicted_points - actual_points
    zeros = actual_points == 0

    # Distributional calibration, measured every gameweek rather than by hand.
    #
    # The tail probabilities are what the weekly objective ranks on, and the
    # module that checks them was imported by NOTHING outside tests — so the
    # headline "every tail within 0.0024" was only ever produced by someone
    # running a script, and nothing would have noticed the day it stopped being
    # true. The mean-accuracy metrics below cannot substitute: a model can have
    # a perfect MAE and a badly wrong P(>=10).
    from pipeline.learning.calibration_check import check_calibration

    calibration = check_calibration([s["forecast"] for s in scored], actual_points)

    metrics = {
        "schema_version": SCORE_SCHEMA_VERSION,
        "scored_at": now.isoformat(),
        "sealed_at": header.get("sealed_at"),
        "deadline_time": header.get("deadline_time"),
        "hours_before_deadline": round(
            float(header.get("seconds_before_deadline", 0)) / 3600, 2
        ),
        "universe_digest": header.get("universe_digest"),
        "universe_size": header.get("universe_size"),
        "n_missing_outcome": missing_outcome,
        "outcome_revision": outcomes["header"].get("revision"),
        "distribution": calibration.as_dict(),
        "points": {
            "mae": float(np.abs(errors).mean()),
            "rmse": float(np.sqrt((errors**2).mean())),
            "bias": float(errors.mean()),
            "mean_actual": float(actual_points.mean()),
            "mean_predicted": float(predicted_points.mean()),
            # Stratified, because an aggregate hides direction. Most
            # player-gameweeks are zeros, so a model can look excellent overall
            # while being systematically over-optimistic about who plays.
            "mae_zeros": float(np.abs(errors[zeros]).mean()) if zeros.any() else 0.0,
            "mae_returners": float(np.abs(errors[~zeros]).mean())
            if (~zeros).any()
            else 0.0,
            "n_zeros": int(zeros.sum()),
        },
        "components": components,
        "baselines": baseline_metrics,
        "beats_zero_baseline": bool(
            float(np.abs(errors).mean()) < baseline_metrics["zero"]["mae"]
        ),
    }

    report = ScoreReport(
        gameweek=int(gameweek),
        n_scored=len(scored),
        metrics=metrics,
        provisional=provisional,
    )

    score_path = directory / "score.json"
    score_path.write_text(json.dumps(report.as_dict(), indent=2) + "\n")
    logger.info(
        "scored GW%d: %d players, points MAE %.3f (zeros %.3f, returners %.3f)",
        gameweek,
        len(scored),
        metrics["points"]["mae"],
        metrics["points"]["mae_zeros"],
        metrics["points"]["mae_returners"],
    )
    return report
