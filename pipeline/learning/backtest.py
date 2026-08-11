"""
Walk-forward backtest for the minutes model.

For gameweek *k*, the model is fitted on data strictly before *k* and scored on
*k*. Nothing from gameweek *k* or later reaches the fit — that is the whole point,
and the test suite asserts it rather than trusting the loop.

The setup deliberately mirrors production's cold start: the prior season is
available as history, the current season accumulates. At gameweek 1 the model
knows only last year, which is exactly the position the live agent will be in.

Metrics chosen for what actually goes wrong. Most player-gameweeks are
non-appearances, so the dominant error is confidently predicting an appearance
for someone who does not play. The headline number is therefore the **zero-band
MAE**: mean predicted ``p_appears`` over rows where the player did not appear.
An aggregate MAE across all rows would be flattered by the mass of easy zeros.

Baselines are deliberately unflattering. A model that cannot beat "this
position's average start rate" and "did he start recently" is not adding
anything, whatever its absolute error looks like.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from pipeline.fpl.rules import POSITIONS, normalise_position
from pipeline.models.minutes import MinutesModel
from pipeline.validation.metrics import (
    brier_score,
    calibration_curve_data,
    expected_calibration_error,
)

logger = logging.getLogger(__name__)


@dataclass
class BacktestResult:
    """Per-model metrics from one walk-forward run."""

    season: str
    first_gameweek: int
    n_rows: int = 0
    n_gameweeks: int = 0
    metrics: Dict[str, Dict[str, float]] = field(default_factory=dict)
    calibration: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> str:
        lines = [
            f"{self.season}: {self.n_rows} player-gameweeks over "
            f"{self.n_gameweeks} gameweeks (from GW{self.first_gameweek})"
        ]
        header = f"  {'model':22s} {'zero-MAE':>9s} {'brier':>8s} {'ECE':>7s} {'min-MAE':>8s}"
        lines.append(header)
        for name, metric in sorted(
            self.metrics.items(), key=lambda kv: kv[1]["zero_band_mae"]
        ):
            lines.append(
                f"  {name:22s} "
                f"{metric['zero_band_mae']:9.4f} "
                f"{metric['brier_appears']:8.4f} "
                f"{metric['ece_appears']:7.4f} "
                f"{metric.get('minutes_mae', float('nan')):8.2f}"
            )
        return "\n".join(lines)


def _metrics(
    predicted_appears: np.ndarray,
    actual_appears: np.ndarray,
    predicted_minutes: Optional[np.ndarray] = None,
    actual_minutes: Optional[np.ndarray] = None,
) -> Dict[str, float]:
    predicted_appears = np.clip(np.asarray(predicted_appears, dtype=float), 0.0, 1.0)
    actual_appears = np.asarray(actual_appears, dtype=float)

    zeros = actual_appears == 0
    result = {
        "n": int(len(actual_appears)),
        "n_zeros": int(zeros.sum()),
        # Mean predicted appearance probability among players who did not
        # appear. Equivalently MAE against a target of 0 on that stratum.
        "zero_band_mae": float(predicted_appears[zeros].mean()) if zeros.any() else 0.0,
        "ones_band_mae": float((1.0 - predicted_appears[~zeros]).mean())
        if (~zeros).any()
        else 0.0,
        "brier_appears": float(brier_score(predicted_appears, actual_appears)),
        "ece_appears": float(
            expected_calibration_error(predicted_appears, actual_appears)
        ),
        "mean_predicted": float(predicted_appears.mean()),
        "base_rate": float(actual_appears.mean()),
    }
    if predicted_minutes is not None and actual_minutes is not None:
        result["minutes_mae"] = float(
            np.abs(
                np.asarray(predicted_minutes, dtype=float)
                - np.asarray(actual_minutes, dtype=float)
            ).mean()
        )
    return result


def backtest_minutes(
    season: str = "2526",
    prior_season: Optional[str] = "2425",
    first_gameweek: int = 1,
    priors_dir: Optional[Path] = None,
    key: str = "name_key",
) -> BacktestResult:
    """
    Walk forward through ``season``, refitting before each gameweek.

    ``prior_season`` is prepended as initial history so gameweek 1 is scored
    under realistic cold-start conditions rather than being skipped.

    Players are keyed on normalised name: the archive's ``element`` id is
    season-scoped and gets reused for different players across seasons, so it
    cannot join history to a later gameweek.
    """
    from pipeline.learning.backfill import load_archive_season

    current = load_archive_season(season, priors_dir=priors_dir)
    current["position_norm"] = current["position"].map(normalise_position)
    current = current[current["position_norm"].notna()].copy()
    current["minutes"] = pd.to_numeric(current["minutes"], errors="coerce").fillna(0)
    current["starts"] = pd.to_numeric(current["starts"], errors="coerce").fillna(0)

    history_frames: List[pd.DataFrame] = []
    if prior_season:
        previous = load_archive_season(prior_season, priors_dir=priors_dir)
        previous["position_norm"] = previous["position"].map(normalise_position)
        previous = previous[previous["position_norm"].notna()].copy()
        previous["minutes"] = pd.to_numeric(
            previous["minutes"], errors="coerce"
        ).fillna(0)
        previous["starts"] = pd.to_numeric(
            previous["starts"], errors="coerce"
        ).fillna(0)
        history_frames.append(previous)

    result = BacktestResult(season=season, first_gameweek=first_gameweek)

    collected: Dict[str, List[np.ndarray]] = {
        "model": [], "position_prior": [], "last5": [], "global_rate": [],
    }
    actual_appears_all: List[np.ndarray] = []
    model_minutes_all: List[np.ndarray] = []
    actual_minutes_all: List[np.ndarray] = []

    gameweeks = sorted(int(g) for g in current["GW"].unique())
    for gameweek in gameweeks:
        if gameweek < first_gameweek:
            continue

        target = current[current["GW"] == gameweek]
        if target.empty:
            continue

        past = pd.concat(
            history_frames + [current[current["GW"] < gameweek]],
            ignore_index=True,
        )
        if past.empty:
            continue

        model = MinutesModel().fit(past, key=key, position_column="position_norm")

        # Rolling last-5 appearance rate per player, from the same past-only data.
        #
        # Sort by (season, GW), not GW alone. `past` concatenates the prior season
        # with the current one, so sorting on gameweek NUMBER interleaves them and
        # GW34-38 of last season sorts after GW1-9 of this one. Measured: 470 of
        # 472 players present in both seasons had a tail(5) drawn entirely from
        # the prior season, making this "did he finish last season playing"
        # rather than "did he start recently" — and crippling the one baseline
        # that varies by player.
        recent = past.sort_values(["season", "GW"]).groupby(key)["minutes"].apply(
            lambda s: float((s.tail(5) > 0).mean())
        )
        global_rate = float((past["minutes"] > 0).mean())

        predicted_model: List[float] = []
        predicted_minutes: List[float] = []
        predicted_position: List[float] = []
        predicted_last5: List[float] = []
        actual_appears: List[float] = []
        actual_minutes: List[float] = []

        for row in target.itertuples():
            position = row.position_norm
            player_key = getattr(row, key)
            roles = model.predict(
                position=position,
                player_key=player_key,
                # The archive carries no availability flags, so this scores the
                # role model on its own merits rather than crediting it with
                # injury information it would have had live.
                status="a",
                chance_of_playing=None,
            )
            predicted_model.append(roles.p_appears)
            predicted_minutes.append(roles.expected_minutes)
            predicted_position.append(
                model.by_position[position]["start_rate"]
                + model.by_position[position]["bench_appear_rate"]
                * (1 - model.by_position[position]["start_rate"])
            )
            predicted_last5.append(float(recent.get(player_key, global_rate)))
            actual_appears.append(1.0 if row.minutes > 0 else 0.0)
            actual_minutes.append(float(row.minutes))

        collected["model"].append(np.array(predicted_model))
        collected["position_prior"].append(np.array(predicted_position))
        collected["last5"].append(np.array(predicted_last5))
        collected["global_rate"].append(np.full(len(target), global_rate))
        actual_appears_all.append(np.array(actual_appears))
        model_minutes_all.append(np.array(predicted_minutes))
        actual_minutes_all.append(np.array(actual_minutes))
        result.n_gameweeks += 1

    if not actual_appears_all:
        return result

    actual = np.concatenate(actual_appears_all)
    result.n_rows = int(len(actual))

    for name, chunks in collected.items():
        predictions = np.concatenate(chunks)
        if name == "model":
            result.metrics[name] = _metrics(
                predictions,
                actual,
                np.concatenate(model_minutes_all),
                np.concatenate(actual_minutes_all),
            )
            result.calibration[name] = calibration_curve_data(predictions, actual)
        else:
            result.metrics[name] = _metrics(predictions, actual)

    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    outcome = backtest_minutes()
    print(outcome.summary())
