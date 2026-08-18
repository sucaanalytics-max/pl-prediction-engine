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
