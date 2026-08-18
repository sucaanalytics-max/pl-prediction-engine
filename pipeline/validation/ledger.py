"""Forward-only forecast ledger and result matching for honest validation."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Tuple

import pandas as pd

from pipeline.data.team_mapping import update_fpl_team_map
from pipeline.validation.metrics import evaluate_predictions

logger = logging.getLogger(__name__)


def _parse_iso(value):
    """Return an aware UTC datetime, or None if unparseable/absent."""
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def update_forecast_ledger(output: Dict, path: Path) -> Dict:
    """
    Admit the first pre-match forecast for each stable fixture ID.

    A fixture disappears from the live prediction set after kickoff, leaving
    its final pre-match forecast immutable and ready to score against results.

    A prediction is only admitted as evidence if it can be shown to predate
    kickoff: the fixture must have a known kickoff time, the run must record
    when it was generated, and generation must strictly precede kickoff. This
    is a check on precedence, not on prediction — TBC and postponed fixtures
    are still predicted upstream; they simply cannot be recorded as proof of
    precedence until FPL publishes a real kickoff time.
    """
    if path.exists():
        try:
            ledger = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            ledger = {}
    else:
        ledger = {}

    forecasts = ledger.get("forecasts", {})
    rejected = []
    generated_at = output.get("metadata", {}).get("generated_at")
    generated_dt = _parse_iso(generated_at)

    for prediction in output.get("predictions", []):
        match_id = prediction["match_id"]
        kickoff_dt = _parse_iso(prediction.get("fixture", {}).get("date"))

        # A forecast is only evidence if we can show it predated kickoff.
        # We still PREDICT these fixtures; we refuse to record the prediction
        # as proof of precedence.
        if kickoff_dt is None:
            rejected.append({"match_id": match_id,
                             "reason": "no kickoff time — cannot prove precedence"})
            continue
        if generated_dt is None:
            rejected.append({"match_id": match_id,
                             "reason": "no generated_at — cannot prove precedence"})
            continue
        if generated_dt >= kickoff_dt:
            rejected.append({"match_id": match_id,
                             "reason": f"generated {generated_at} at or after kickoff"})
            continue

        # First admissible forecast wins. A later one is not more honest for
        # being later, and overwriting would destroy the earlier proof.
        if match_id in forecasts:
            continue

        forecasts[match_id] = {
            "match_id": match_id,
            "generated_at": generated_at,
            "fixture": prediction.get("fixture", {}),
            "probabilities": prediction.get("probabilities", {}),
            "expected_goals": prediction.get("expected_goals", {}),
            "odds_comparison": prediction.get("odds_comparison"),
        }

    if rejected:
        logger.warning(
            "forecast ledger rejected %d of %d predictions as unprovable: %s",
            len(rejected), len(output.get("predictions", [])),
            ", ".join(r["match_id"] for r in rejected),
        )

    ledger = {
        "season": output.get("metadata", {}).get("season"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": forecasts,
        "rejected": rejected,
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
