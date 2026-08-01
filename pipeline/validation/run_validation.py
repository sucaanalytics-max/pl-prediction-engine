"""Scheduled artifact and freshness validation entry point."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pipeline.validation.artifacts import assert_valid_prediction_output


def run_validation(predictions_dir: Path = Path("predictions")) -> dict:
    latest_path = predictions_dir / "latest.json"
    health_path = predictions_dir / "health.json"
    if not latest_path.exists():
        raise FileNotFoundError(f"Missing prediction artifact: {latest_path}")

    predictions = json.loads(latest_path.read_text())
    assert_valid_prediction_output(predictions)

    metadata = predictions.get("metadata", {})
    generated_at = metadata.get("generated_at")
    age_hours = None
    stale = True
    if generated_at:
        generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
        age_hours = (datetime.now(timezone.utc) - generated).total_seconds() / 3600
        stale = age_hours > 48

    health = {}
    if health_path.exists():
        try:
            health = json.loads(health_path.read_text())
        except json.JSONDecodeError:
            health = {}

    health.update({
        "last_updated": generated_at,
        "gameweek": metadata.get("gameweek"),
        "n_predictions": len(predictions.get("predictions", [])),
        "status": "stale" if stale else "healthy",
        "pipeline_version": metadata.get("pipeline_version"),
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "artifact_contract": "valid",
        "prediction_age_hours": age_hours,
    })
    predictions_dir.mkdir(parents=True, exist_ok=True)
    health_path.write_text(json.dumps(health, indent=2))
    return health


if __name__ == "__main__":
    result = run_validation()
    print(json.dumps(result, indent=2))
