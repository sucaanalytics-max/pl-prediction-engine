"""Forward-only forecast ledger and result matching for honest validation."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Tuple

import pandas as pd

from pipeline.data.team_mapping import update_fpl_team_map
from pipeline.validation.metrics import evaluate_predictions


def update_forecast_ledger(output: Dict, path: Path) -> Dict:
    """
    Upsert the latest pre-match forecast for each stable fixture ID.

    A fixture disappears from the live prediction set after kickoff, leaving
    its final pre-match forecast immutable and ready to score against results.
    """
    if path.exists():
        try:
            ledger = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            ledger = {}
    else:
        ledger = {}

    forecasts = ledger.get("forecasts", {})
    generated_at = output.get("metadata", {}).get("generated_at")
    for prediction in output.get("predictions", []):
        forecasts[prediction["match_id"]] = {
            "match_id": prediction["match_id"],
            "generated_at": generated_at,
            "fixture": prediction.get("fixture", {}),
            "probabilities": prediction.get("probabilities", {}),
            "expected_goals": prediction.get("expected_goals", {}),
            "odds_comparison": prediction.get("odds_comparison"),
        }

    ledger = {
        "season": output.get("metadata", {}).get("season"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": forecasts,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger, indent=2))
    return ledger


def actuals_from_fpl(bootstrap: Dict, fixtures: list) -> pd.DataFrame:
    """Convert completed current-season FPL fixtures to evaluation rows."""
    team_map = update_fpl_team_map(bootstrap.get("teams", []))
    rows = []
    for fixture in fixtures:
        home_score = fixture.get("team_h_score")
        away_score = fixture.get("team_a_score")
        kickoff_raw = fixture.get("kickoff_time")
        if (
            not fixture.get("finished")
            or home_score is None
            or away_score is None
            or not kickoff_raw
        ):
            continue

        kickoff = pd.to_datetime(kickoff_raw, utc=True, errors="coerce")
        if pd.isna(kickoff):
            continue
        home = team_map.get(fixture.get("team_h"))
        away = team_map.get(fixture.get("team_a"))
        if not home or not away:
            continue

        home_score = int(home_score)
        away_score = int(away_score)
        result = "H" if home_score > away_score else ("A" if home_score < away_score else "D")
        rows.append({
            "match_id": f"{kickoff.strftime('%Y%m%d')}_{home}_{away}".replace(" ", "_"),
            "FTR": result,
            "FTHG": home_score,
            "FTAG": away_score,
        })
    return pd.DataFrame(rows, columns=["match_id", "FTR", "FTHG", "FTAG"])


def evaluate_ledger(
    ledger: Dict,
    bootstrap: Dict,
    fixtures: list,
) -> Tuple[Dict, Dict]:
    """Return flattened UI metrics and calibration data."""
    actuals = actuals_from_fpl(bootstrap, fixtures)
    forecasts = list(ledger.get("forecasts", {}).values())
    if actuals.empty or not forecasts:
        return {}, {"bins": []}

    evaluation = evaluate_predictions(forecasts, actuals)
    if evaluation.get("n_matches", 0) == 0:
        return {}, {"bins": []}

    one_x_two = evaluation["1x2"]
    metrics = {
        "n_evaluated_matches": evaluation["n_matches"],
        "brier_1x2_home": one_x_two["brier_home"],
        "brier_1x2_draw": one_x_two["brier_draw"],
        "brier_1x2_away": one_x_two["brier_away"],
        "log_loss_home": one_x_two["log_loss_home"],
        "rps_mean": one_x_two["rps_mean"],
        "ece": one_x_two["calibration"]["ece"],
    }
    if "over_2.5" in evaluation:
        metrics["brier_ou25"] = evaluation["over_2.5"]["brier"]
    if "btts" in evaluation:
        metrics["brier_btts"] = evaluation["btts"]["brier"]
    return metrics, one_x_two["calibration"]
