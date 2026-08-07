import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.validation.fplreview_benchmark import (
    compare,
    load_owned,
    load_reference,
)


class FPLReviewBenchmarkTests(unittest.TestCase):
    def test_identical_inputs_have_perfect_parity(self):
        reference = {
            1: {
                1: {"xp": 7.0, "minutes": 90.0},
                2: {"xp": 4.0, "minutes": 60.0},
                3: {"xp": 2.0, "minutes": 20.0},
            }
        }
        report = compare(reference, reference, top_n=2)
        metrics = report["aggregate"]
        self.assertEqual(metrics["xp_mae"], 0.0)
        self.assertEqual(metrics["xp_spearman"], 1.0)
        self.assertEqual(metrics["top_n_overlap"], 1.0)
        self.assertEqual(metrics["minutes_mae"], 0.0)

    def test_only_overlapping_gameweeks_and_ids_are_compared(self):
        reference = {
            1: {1: {"xp": 5.0, "minutes": 90.0}, 2: {"xp": 3.0, "minutes": 60.0}},
            2: {1: {"xp": 6.0, "minutes": 90.0}},
        }
        owned = {
            1: {1: {"xp": 4.0, "minutes": 80.0}, 3: {"xp": 8.0, "minutes": 90.0}},
            3: {1: {"xp": 2.0, "minutes": 90.0}},
        }
        report = compare(reference, owned)
        self.assertEqual(report["overlapping_gameweeks"], [1])
        self.assertEqual(report["aggregate"]["paired_players"], 1)
        self.assertEqual(report["aggregate"]["xp_mae"], 1.0)
        self.assertEqual(report["aggregate"]["minutes_mae"], 10.0)

    def test_reference_and_owned_artifacts_load_by_official_id(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            reference_path = root / "reference.json"
            owned_path = root / "xp_gw1.json"
            reference_path.write_text(json.dumps({
                "gameweeks": [1],
                "players": [{
                    "elementId": 42,
                    "projectedPoints": [5.5],
                    "expectedMinutes": [82],
                }],
            }))
            owned_path.write_text(json.dumps({
                "metadata": {"gameweek": 1},
                "players": [{"element_id": 42, "xp": 5.0, "e_minutes": 80}],
            }))
            report = compare(load_reference(reference_path), load_owned([owned_path]))
            self.assertEqual(report["aggregate"]["paired_players"], 1)
            self.assertEqual(report["aggregate"]["xp_mae"], 0.5)

    def test_duplicate_owned_gameweek_is_rejected(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for name in ("first.json", "second.json"):
                path = root / name
                path.write_text(json.dumps({"metadata": {"gameweek": 1}, "players": []}))
                paths.append(path)
            with self.assertRaisesRegex(ValueError, "duplicate owned artifact"):
                load_owned(paths)

    def test_no_overlap_is_missing_evidence_not_perfect_error(self):
        report = compare(
            {1: {1: {"xp": 5.0, "minutes": 90.0}}},
            {1: {2: {"xp": 5.0, "minutes": 90.0}}},
        )
        self.assertEqual(report["aggregate"]["paired_players"], 0)
        self.assertIsNone(report["aggregate"]["xp_mae"])
        self.assertIsNone(report["aggregate"]["xp_spearman"])
        self.assertIsNone(report["aggregate"]["top_n_overlap"])


if __name__ == "__main__":
    unittest.main()
