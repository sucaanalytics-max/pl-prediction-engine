"""Scheduled artifact and freshness validation entry point."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pipeline.validation.artifacts import assert_valid_prediction_output


def assess_eval_targets(health: dict) -> dict:
    """
    Compare the model metrics already in `health.json` against `config.EVAL`.

    `EVAL` names four targets — Brier, log loss, calibration error, and the minimum
    match count at which the first three mean anything — and nothing read any of
    them. They looked like the model's pass/fail bar and were four inert numbers, so
    an unmet target was indistinguishable from a met one. Every quantity they name is
    already computed and written here: `brier_1x2_*`, `log_loss_home`, `ece` and
    `n_evaluated_matches`.

    `backtest_min_matches` is a GATE, not a fifth target. Below it the verdict is
    "insufficient sample" rather than a pass or a fail — with ten matches evaluated
    an ECE of 0.26 says almost nothing, and reporting it as a failure would train the
    reader to ignore this block, which is how the targets got ignored in the first
    place.

    Returns a verdict map. Reported, not raised: validation's job is to make the
    state visible, and a model below target is a fact about the model rather than a
    broken artifact.
    """
    from pipeline.config import EVAL

    metrics = health.get("model_metrics") or {}
    calibration = health.get("calibration") or {}
    n = metrics.get("n_evaluated_matches") or 0
    minimum = EVAL["backtest_min_matches"]

    verdicts: dict = {"n_evaluated_matches": n, "backtest_min_matches": minimum}
    if n < minimum:
        verdicts["assessable"] = False
        verdicts["note"] = (
            f"{n} matches evaluated, below the {minimum} the targets are stated "
            "for — the metrics are reported but not judged"
        )
        return verdicts

    verdicts["assessable"] = True
    # The 1X2 Brier is per-outcome in the artifact; the target is one number, so the
    # worst of the three is the one that has to clear it. A mean would let a
    # well-predicted draw column hide a badly-predicted home column.
    briers = [v for k, v in metrics.items() if k.startswith("brier_1x2_")]
    checks = {
        "brier": (max(briers) if briers else None, EVAL["brier_target"]),
        "log_loss": (metrics.get("log_loss_home"), EVAL["log_loss_target"]),
        "calibration_error": (
            metrics.get("ece", calibration.get("ece")),
            EVAL["calibration_error_target"],
        ),
    }
    for name, (actual, target) in checks.items():
        if actual is None:
            verdicts[name] = "not computed"
        else:
            verdicts[name] = {
                "actual": round(float(actual), 6),
                "target": target,
                # Lower is better for all three.
                "meets_target": float(actual) <= target,
            }
    verdicts["all_targets_met"] = all(
        isinstance(v, dict) and v.get("meets_target")
        for k, v in verdicts.items() if k in checks
    )
    return verdicts


def verify_sealed_ledger(predictions_dir: Path) -> dict:
    """
    Re-verify every sealed gameweek's frozen inputs against its recorded digest.

    ``ledger.freeze_inputs`` gzips the bootstrap beside each seal and writes its
    digest into the forecast header, and ``ledger.load_frozen_bootstrap`` is the
    function that reads it back and refuses on a mismatch. That function had ZERO
    production callers — so the digest was written on every seal and compared to
    nothing, and the guarantee its docstring states (a gameweek with missing or
    altered frozen inputs is "treated as unscoreable rather than reconstructed from
    live data") was never enforced by any running code.

    Validation is the right place for it rather than scoring: this is an integrity
    question about the whole record, it should be answered on a schedule instead of
    only when a week happens to be scored, and a corrupted seal is worth knowing
    about long before the week it belongs to comes up.

    READ-ONLY on ``predictions/fpl/ledger``. It opens the sealed files and hashes
    them; it writes nothing there and must not.

    Returns a per-gameweek verdict rather than raising: one unreadable seal must not
    stop the freshness check that the rest of validation exists to perform. The
    verdict lands in `health.json`, where a failure is visible.
    """
    import json as _json

    from pipeline.learning.ledger import LedgerError, load_frozen_bootstrap

    ledger_dir = predictions_dir / "fpl" / "ledger"
    verdicts: dict = {}
    if not ledger_dir.is_dir():
        return verdicts

    for week_dir in sorted(ledger_dir.glob("gw*")):
        forecast = week_dir / "forecast.jsonl"
        if not forecast.is_file():
            continue
        try:
            with forecast.open(encoding="utf-8") as handle:
                header = _json.loads(handle.readline())
        except (OSError, ValueError) as error:
            verdicts[week_dir.name] = f"unreadable header: {error}"
            continue
        if not (header.get("frozen_inputs") or {}):
            # Sealed before `freeze_inputs` existed. Not a failure — there is
            # nothing to verify — but it must not read as verified either.
            verdicts[week_dir.name] = "no frozen inputs recorded"
            continue
        try:
            load_frozen_bootstrap(week_dir, header)
        except LedgerError as error:
            verdicts[week_dir.name] = f"FAILED: {error}"
        except Exception as error:  # noqa: BLE001 - see the returns-a-verdict note
            verdicts[week_dir.name] = f"FAILED: {type(error).__name__}: {error}"
        else:
            verdicts[week_dir.name] = "verified"
    return verdicts


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

    ledger_integrity = verify_sealed_ledger(predictions_dir)

    health.update({
        "last_updated": generated_at,
        "gameweek": metadata.get("gameweek"),
        "n_predictions": len(predictions.get("predictions", [])),
        "status": "stale" if stale else "healthy",
        "pipeline_version": metadata.get("pipeline_version"),
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "artifact_contract": "valid",
        "prediction_age_hours": age_hours,
        "ledger_integrity": ledger_integrity,
        # Surfaced as its own flag so a reader does not have to scan the per-week
        # map to learn that something is wrong.
        "ledger_integrity_ok": all(
            v == "verified" or v == "no frozen inputs recorded"
            for v in ledger_integrity.values()
        ),
    })
    # After the update, so it reads the metrics this run just recorded.
    health["eval_targets"] = assess_eval_targets(health)

    predictions_dir.mkdir(parents=True, exist_ok=True)
    health_path.write_text(json.dumps(health, indent=2))
    return health


if __name__ == "__main__":
    result = run_validation()
    print(json.dumps(result, indent=2))
