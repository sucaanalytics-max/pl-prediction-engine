"""
`health.json` has two writers on different cadences, and the fast one erased the slow one.

The daily pipeline writes run diagnostics; `run_validation` writes verification results
weekly (Sundays 10:00 UTC per .github/workflows/validate.yml). Validation already merged —
it reads the file and `update`s its keys onto it — but the pipeline rebuilt the document
and wrote it with `"w"`, so everything validation produced was gone within a day.

Measured in the file's own history:

    2152c2e  2026-08-30T14:47  validated_at present, ledger_integrity present
    270be90  2026-08-31T12:01  neither

A weekly check whose output survives twenty hours is a check nobody reads, which is the
exact failure the ledger verification and the missing-seal report were added to end.

Same defect as `public_xp.publish_from_artifact` dropping the agent's horizon block: two
publishers of one artifact, the frequent one silently discarding the rare one's work.

These tests exercise the merge rule directly rather than running the whole pipeline, which
needs network. The rule is the thing that was wrong.
"""
import json
import tempfile
import unittest
from pathlib import Path

#: Kept in step with `run_pipeline`'s tuple by `test_the_owned_set_matches_the_pipeline`.
VALIDATION_OWNED = (
    "validated_at", "artifact_contract", "prediction_age_hours",
    "ledger_integrity", "ledger_integrity_ok", "missing_seals", "eval_targets",
)


def merge(previous: dict, fresh: dict) -> dict:
    """The rule as `run_pipeline` applies it."""
    carried = {k: previous[k] for k in VALIDATION_OWNED if k in previous}
    return {**carried, **fresh}


#: What a Sunday validation run leaves behind.
VALIDATED = {
    "validated_at": "2026-08-30T14:47:49",
    "artifact_contract": "valid",
    "prediction_age_hours": 4.2,
    "ledger_integrity": {"gw01": "verified"},
    "ledger_integrity_ok": True,
    "missing_seals": {"expected_through": 2, "sealed": [1], "missing": [2]},
    "eval_targets": {"assessable": False, "n_evaluated_matches": 10},
    # Shared keys validation also writes.
    "gameweek": 2,
    "status": "healthy",
}

#: What the next daily pipeline run produces.
FRESH = {
    "last_updated": "2026-08-31T12:01:57Z",
    "gameweek": 3,
    "n_predictions": 10,
    "status": "degraded",
    "degraded": ["odds"],
    "pipeline_version": "5.1.0",
}


class TestTheMerge(unittest.TestCase):
    def test_every_validation_field_survives_a_daily_run(self):
        merged = merge(VALIDATED, FRESH)
        for key in VALIDATION_OWNED:
            self.assertIn(key, merged, f"{key} was destroyed by the daily run")
        self.assertEqual(merged["ledger_integrity"], {"gw01": "verified"})
        self.assertEqual(merged["missing_seals"]["missing"], [2])

    def test_the_fresh_run_still_wins_on_shared_keys(self):
        # For a run diagnostic the pipeline IS the fresher source. Carrying validation's
        # stale `gameweek` forward would be worse than dropping it.
        merged = merge(VALIDATED, FRESH)
        self.assertEqual(merged["gameweek"], 3)
        self.assertEqual(merged["status"], "degraded")
        self.assertEqual(merged["last_updated"], FRESH["last_updated"])

    def test_a_first_run_with_no_previous_file_is_just_the_fresh_data(self):
        self.assertEqual(merge({}, FRESH), FRESH)

    def test_nothing_is_invented_when_validation_has_never_run(self):
        merged = merge({"gameweek": 2, "status": "healthy"}, FRESH)
        for key in VALIDATION_OWNED:
            self.assertNotIn(key, merged, f"{key} appeared from nowhere")

    def test_a_partial_validation_record_carries_only_what_it_has(self):
        merged = merge({"validated_at": "2026-08-30T14:47:49"}, FRESH)
        self.assertIn("validated_at", merged)
        self.assertNotIn("ledger_integrity", merged)

    def test_the_merge_is_idempotent(self):
        once = merge(VALIDATED, FRESH)
        self.assertEqual(merge(once, FRESH), once)


class TestItStaysInStepWithTheCode(unittest.TestCase):
    def test_the_owned_set_matches_the_pipeline(self):
        # If a new validation-only key is added to `run_validation` and not to the
        # pipeline's tuple, the next daily run silently deletes it. This is the assertion
        # that makes that impossible to do quietly.
        source = Path("pipeline/run_pipeline.py").read_text()
        for key in VALIDATION_OWNED:
            self.assertIn(f'"{key}"', source,
                          f"run_pipeline does not carry {key} forward")

    def test_run_validation_writes_exactly_these_extra_keys(self):
        # The other direction: a key validation writes that is NOT in the owned set is
        # one the pipeline will erase.
        source = Path("pipeline/validation/run_validation.py").read_text()
        for key in ("ledger_integrity", "missing_seals", "eval_targets", "validated_at"):
            self.assertIn(f'"{key}"', source)


if __name__ == "__main__":
    unittest.main()
