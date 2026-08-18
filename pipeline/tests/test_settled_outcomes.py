"""The reader must find the file the writer writes.

This defect is invisible by construction: both the broken and the correct
state return [] before any gameweek settles, and the docstring's excuse for
the empty case stays plausible forever. Only a test with a settled file on
disk can tell them apart.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline.learning.ledger import RECORD_HEADER


class SettledOutcomeDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger = Path(self.tmpdir) / "fpl" / "ledger" / "gw01"
        self.ledger.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_settled_gameweek(self):
        """Write the shape outcomes.settle_gameweek produces: a JSONL file
        whose first line is a header and whose remaining lines are players."""
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 1, "revision": 1,
                 "provisional": False}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")

    def test_finds_a_settled_gameweek(self):
        self._write_settled_gameweek()
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["element_id"], 328)

    def test_returns_empty_when_nothing_has_settled(self):
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            self.assertEqual(_settled_outcomes(), [])

    def test_rows_carry_the_settled_weeks_gameweek(self):
        """A row with no gameweek would make every distinct-gameweek count
        collapse to one — the exact bug this stamping guards against."""
        self._write_settled_gameweek()
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()
        self.assertEqual(rows[0]["gameweek"], 1)

    def test_two_settled_weeks_produce_rows_spanning_both(self):
        """This is the exact computation at run_agent.py:201
        (gameweeks_sealed=len({r.get("gameweek") for r in settled})) — it is
        what stops the defect returning."""
        self._write_settled_gameweek()
        second = Path(self.tmpdir) / "fpl" / "ledger" / "gw02"
        second.mkdir(parents=True)
        with (second / "outcome.jsonl").open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 2, "revision": 1,
                 "provisional": False}) + "\n")
            handle.write(json.dumps(
                {"element_id": 501, "total_points": 6, "minutes": 90}) + "\n")

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()

        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["gameweek"] for r in rows}), 2)

    def test_a_provisional_week_is_excluded(self):
        """Bonus and defensive contributions still move until 09:00 UK the
        day after the last match: provisional rows are not settled."""
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 1, "revision": 1,
                 "provisional": True}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            self.assertEqual(_settled_outcomes(), [])

    def test_a_week_with_no_provisional_key_is_excluded(self):
        """Absent must default to "not settled", not to "settled"."""
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 1, "revision": 1}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            self.assertEqual(_settled_outcomes(), [])

    def test_gameweek_falls_back_to_directory_name_when_header_lacks_it(self):
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "revision": 1,
                 "provisional": False}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["gameweek"], 1)

    def test_a_malformed_row_in_one_week_does_not_discard_another_weeks_rows(self):
        """Regression test for the Critical finding: read_outcomes does an
        unchecked int(record["element_id"]) on every non-header line, so a
        row missing element_id raises KeyError, not LedgerError/ValueError/
        OSError. Before the except tuple was widened, that KeyError escaped
        _settled_outcomes entirely and discarded every already-collected row
        from healthy weeks, not just the corrupt one."""
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 1, "revision": 1,
                 "provisional": False}) + "\n")
            # Malformed: no element_id.
            handle.write(json.dumps({"total_points": 9, "minutes": 90}) + "\n")

        second = Path(self.tmpdir) / "fpl" / "ledger" / "gw02"
        second.mkdir(parents=True)
        with (second / "outcome.jsonl").open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 2, "revision": 1,
                 "provisional": False}) + "\n")
            handle.write(json.dumps(
                {"element_id": 501, "total_points": 6, "minutes": 90}) + "\n")

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["element_id"], 501)
        self.assertEqual(rows[0]["gameweek"], 2)
