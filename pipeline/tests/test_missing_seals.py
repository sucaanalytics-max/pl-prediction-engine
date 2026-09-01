"""
A gameweek that was played and never sealed must stay visible.

`verify_sealed_ledger` checks the integrity of the seals that EXIST. It says nothing
about a week that was never sealed — the more serious condition, because a seal is the
only evidence a forecast predated its deadline, so a missing one is unrecoverable.

The agent does detect the miss (`schedule.Phase.MISSED_SEAL`), but that phase is
deliberately transient: the report window is three days, "long enough to be noticed,
short enough not to shout about the same loss for a week", and it is checked last because
an earlier placement once starved the agent into a livelock. Both choices are right for a
phase, and their consequence is that the record expires.

Measured: GW2's deadline passed 2026-08-28T17:30Z with no seal. By 2026-09-01 — 3.91 days
later — the window had elapsed and `agent_status.json` read `outstanding: []`. The week was
played, its forecast is unverifiable forever, and nothing said so any more.
"""
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.validation.run_validation import missing_seals


def seal(root: Path, gameweek: int):
    week = root / "fpl" / "ledger" / f"gw{gameweek:02d}"
    week.mkdir(parents=True, exist_ok=True)
    (week / "forecast.jsonl").write_text(
        json.dumps({"gameweek": gameweek, "record": "header"}) + "\n", encoding="utf-8")
    return week


class TestMissingSeals(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_the_gw2_case_exactly_as_it_happened(self):
        seal(self.root, 1)
        report = missing_seals(self.root, 3)
        self.assertEqual(report["missing"], [2])
        self.assertEqual(report["sealed"], [1])
        self.assertEqual(report["expected_through"], 2)
        self.assertIn("permanently unscoreable", report["note"])

    def test_a_fully_sealed_history_reports_nothing_missing(self):
        seal(self.root, 1); seal(self.root, 2)
        report = missing_seals(self.root, 3)
        self.assertEqual(report["missing"], [])
        self.assertIsNone(report["note"])

    def test_the_current_gameweek_is_not_expected_to_be_sealed_yet(self):
        # Its deadline has not passed. Demanding a seal for the week being planned
        # would report a miss every single run.
        seal(self.root, 1); seal(self.root, 2)
        self.assertEqual(missing_seals(self.root, 3)["missing"], [])

    def test_gameweek_one_expects_nothing(self):
        for current in (None, 0, 1):
            report = missing_seals(self.root, current)
            self.assertEqual(report["missing"], [], f"current={current}")
            self.assertIsNone(report["expected_through"], f"current={current}")

    def test_several_missing_weeks_are_all_listed(self):
        seal(self.root, 3)
        self.assertEqual(missing_seals(self.root, 6)["missing"], [1, 2, 4, 5])

    def test_a_directory_without_a_forecast_does_not_count_as_sealed(self):
        # An `inputs/` folder or a settled outcome is not a seal. Only a forecast
        # written before the deadline is.
        (self.root / "fpl" / "ledger" / "gw02" / "inputs").mkdir(parents=True)
        (self.root / "fpl" / "ledger" / "gw02" / "outcome.jsonl").write_text("{}\n")
        seal(self.root, 1)
        self.assertEqual(missing_seals(self.root, 3)["missing"], [2])

    def test_no_ledger_at_all_reports_every_past_week(self):
        self.assertEqual(missing_seals(self.root, 4)["missing"], [1, 2, 3])

    def test_an_unparsable_directory_name_is_ignored_not_crashed_on(self):
        (self.root / "fpl" / "ledger" / "gwXX").mkdir(parents=True)
        (self.root / "fpl" / "ledger" / "gwXX" / "forecast.jsonl").write_text("{}\n")
        seal(self.root, 1)
        self.assertEqual(missing_seals(self.root, 3)["missing"], [2])


class TestTheRealLedger(unittest.TestCase):
    def test_it_reports_the_live_state_without_raising(self):
        predictions = Path("predictions")
        if not (predictions / "latest.json").is_file():
            self.skipTest("no predictions in this checkout")
        current = (json.loads((predictions / "latest.json").read_text())
                   .get("metadata") or {}).get("gameweek")
        report = missing_seals(predictions, current)
        self.assertIn("missing", report)
        self.assertIsInstance(report["missing"], list)


if __name__ == "__main__":
    unittest.main()
