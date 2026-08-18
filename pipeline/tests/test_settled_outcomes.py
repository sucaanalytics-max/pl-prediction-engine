"""The reader must find the file the writer writes — and return a scoreable row.

Two defects live here, both invisible by construction:

1. Discovery. Both the broken and the correct state return [] before any
   gameweek settles, and the docstring's excuse for the empty case stays
   plausible forever. Only a test with a settled file on disk can tell them
   apart.
2. Shape. Returning RAW settlement rows also "works" — the list is non-empty
   and every test that asserts on this function's own return passes — while
   `accuracy.measure` silently matches nothing, so accuracy.json publishes
   "600 settled player-gameweeks recorded; at least 50 are needed", which is
   false. Only a test that feeds the output into the real consumer catches it.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline.learning.ledger import RECORD_FORECAST, RECORD_HEADER


def _write_outcome(directory, gameweek, players, provisional=False,
                   include_gameweek=True):
    """Write the shape outcomes.settle_gameweek produces: a JSONL file whose
    first line is a header and whose remaining lines are players."""
    header = {"record": RECORD_HEADER, "revision": 1, "provisional": provisional}
    if include_gameweek:
        header["gameweek"] = gameweek
    with (Path(directory) / "outcome.jsonl").open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header) + "\n")
        for row in players:
            handle.write(json.dumps(row) + "\n")


def _write_forecast(directory, gameweek, players):
    """Write the shape ledger.seal_forecast produces."""
    with (Path(directory) / "forecast.jsonl").open("w", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "record": RECORD_HEADER, "gameweek": gameweek,
            "rows_written": len(players), "seconds_before_deadline": 3600.0,
        }) + "\n")
        for row in players:
            handle.write(json.dumps({"record": RECORD_FORECAST, **row}) + "\n")


class SettledOutcomeDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger = Path(self.tmpdir) / "fpl" / "ledger" / "gw01"
        self.ledger.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _settled(self):
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            return _settled_outcomes()

    def _week(self, gameweek):
        directory = Path(self.tmpdir) / "fpl" / "ledger" / f"gw{gameweek:02d}"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _write_settled_gameweek(self, directory=None, gameweek=1,
                                element_id=328, points=9, xp=4.5, **kwargs):
        directory = directory or self.ledger
        _write_outcome(directory, gameweek,
                       [{"element_id": element_id, "total_points": points,
                         "minutes": 90}], **kwargs)
        _write_forecast(directory, gameweek,
                        [{"element_id": element_id, "xp": xp}])

    def test_finds_a_settled_gameweek(self):
        self._write_settled_gameweek()
        rows = self._settled()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["element_id"], 328)

    def test_returns_empty_when_nothing_has_settled(self):
        self.assertEqual(self._settled(), [])

    def test_rows_are_joined_predicted_versus_actual(self):
        """The regression guard on SHAPE. accuracy.measure and
        sensitivity.measure_noise both key on `predicted` and `actual`; a raw
        settlement row carries neither and is silently dropped by both."""
        self._write_settled_gameweek(points=9, xp=4.25)
        rows = self._settled()
        self.assertEqual(rows[0]["predicted"], 4.25)
        self.assertEqual(rows[0]["actual"], 9.0)

    def test_rows_carry_the_settled_weeks_gameweek(self):
        """A row with no gameweek would make every distinct-gameweek count
        collapse to one — the exact bug this stamping guards against."""
        self._write_settled_gameweek()
        self.assertEqual(self._settled()[0]["gameweek"], 1)

    def test_two_settled_weeks_produce_rows_spanning_both(self):
        """This is the exact computation in _publish_accuracy
        (gameweeks_sealed=len({r.get("gameweek") for r in settled})) — it is
        what stops the defect returning."""
        self._write_settled_gameweek()
        self._write_settled_gameweek(directory=self._week(2), gameweek=2,
                                     element_id=501, points=6, xp=3.0)
        rows = self._settled()
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["gameweek"] for r in rows}), 2)

    def test_a_provisional_week_is_excluded(self):
        """Bonus and defensive contributions still move until 09:00 UK the
        day after the last match: provisional rows are not settled."""
        self._write_settled_gameweek(provisional=True)
        self.assertEqual(self._settled(), [])

    def test_a_week_with_no_provisional_key_is_excluded(self):
        """Absent must default to "not settled", not to "settled"."""
        _write_outcome(self.ledger, 1, [{"element_id": 328, "total_points": 9}])
        # Rewrite without the provisional key at all.
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"record": RECORD_HEADER, "gameweek": 1, "revision": 1}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")
        _write_forecast(self.ledger, 1, [{"element_id": 328, "xp": 4.5}])
        self.assertEqual(self._settled(), [])

    def test_gameweek_falls_back_to_directory_name_when_header_lacks_it(self):
        self._write_settled_gameweek(include_gameweek=False)
        rows = self._settled()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["gameweek"], 1)

    def test_a_malformed_row_in_one_week_does_not_discard_another_weeks_rows(self):
        """Regression test for the Critical finding: read_outcomes does an
        unchecked int(record["element_id"]) on every non-header line, so a
        row missing element_id raises KeyError, not LedgerError/ValueError/
        OSError. Before the except tuple was widened, that KeyError escaped
        _settled_outcomes entirely and discarded every already-collected row
        from healthy weeks, not just the corrupt one."""
        _write_outcome(self.ledger, 1, [{"total_points": 9, "minutes": 90}])
        _write_forecast(self.ledger, 1, [{"element_id": 328, "xp": 4.5}])
        self._write_settled_gameweek(directory=self._week(2), gameweek=2,
                                     element_id=501, points=6, xp=3.0)

        rows = self._settled()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["element_id"], 501)
        self.assertEqual(rows[0]["gameweek"], 2)

    def test_a_week_with_no_forecast_file_is_skipped_and_the_others_survive(self):
        """A settled week that cannot be joined is excluded — but it must not
        take the weeks that CAN be joined down with it, and it must not raise."""
        _write_outcome(self.ledger, 1, [{"element_id": 328, "total_points": 9}])
        # No forecast.jsonl beside it.
        self._write_settled_gameweek(directory=self._week(2), gameweek=2,
                                     element_id=501, points=6, xp=3.0)

        with self.assertLogs("pipeline.learning.run_agent", level="WARNING") as logs:
            rows = self._settled()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["gameweek"], 2)
        self.assertTrue(any("forecast" in line for line in logs.output))

    def test_an_unmatched_element_is_skipped_and_counted_in_a_warning(self):
        """Silently shrinking the sample changes every sigma computed from it."""
        _write_outcome(self.ledger, 1, [
            {"element_id": 328, "total_points": 9, "minutes": 90},
            {"element_id": 999, "total_points": 2, "minutes": 12},
        ])
        _write_forecast(self.ledger, 1, [
            {"element_id": 328, "xp": 4.5},
            {"element_id": 777, "xp": 1.0},
        ])

        with self.assertLogs("pipeline.learning.run_agent", level="WARNING") as logs:
            rows = self._settled()

        self.assertEqual([r["element_id"] for r in rows], [328])
        joined = [line for line in logs.output if "join" in line]
        self.assertEqual(len(joined), 1)
        self.assertIn("1 settled with no sealed forecast", joined[0])
        self.assertIn("1 sealed with no settled outcome", joined[0])


class SettledOutcomesFeedTheAccuracyRollup(unittest.TestCase):
    """The regression guard that matters: the rows must be measurable.

    Before the join, `accuracy.build` received hundreds of rows and matched
    none of them, so it published `measured: null` beside
    `observations: 600` and the reason string "600 settled player-gameweeks
    recorded; at least 50 are needed" — a statement that is false whenever
    observations >= MIN_OBSERVATIONS. Every existing test asserted on
    _settled_outcomes' own return and none of them saw it.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger = Path(self.tmpdir) / "fpl" / "ledger" / "gw01"
        self.ledger.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_fifty_joined_observations_produce_a_measurement_not_an_excuse(self):
        from pipeline.learning import accuracy

        n = accuracy.MIN_OBSERVATIONS + 10
        outcomes = [{"element_id": 100 + i, "total_points": i % 12, "minutes": 90}
                    for i in range(n)]
        forecasts = [{"element_id": 100 + i, "xp": (i % 12) * 0.8}
                     for i in range(n)]
        _write_outcome(self.ledger, 1, outcomes)
        _write_forecast(self.ledger, 1, forecasts)

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            settled = _settled_outcomes()

        self.assertEqual(len(settled), n)

        payload = accuracy.build(
            settled=settled,
            spreads=[2.5] * n,
            gameweeks_sealed=len({r.get("gameweek") for r in settled}),
            generated_at="2026-08-18T00:00:00Z",
            season="2026-27",
        )

        self.assertIsNotNone(
            payload["measured"],
            "settled rows reached accuracy.build but measured nothing",
        )
        self.assertIsNone(
            payload["reason"],
            "the rollup published an 'at least 50 are needed' excuse while "
            "reporting more than 50 observations",
        )
        self.assertEqual(payload["observations"], n)
        self.assertIsNotNone(payload["measured"]["overall"]["rmse"])

    def test_by_position_stays_empty_because_position_is_not_sealed(self):
        """Documented, not accidental: gameweek_sim's player rows carry no
        position, so the sealed forecast cannot carry one either."""
        from pipeline.learning import accuracy

        n = accuracy.MIN_OBSERVATIONS + 10
        _write_outcome(self.ledger, 1, [
            {"element_id": 100 + i, "total_points": i % 12} for i in range(n)])
        _write_forecast(self.ledger, 1, [
            {"element_id": 100 + i, "xp": (i % 12) * 0.8} for i in range(n)])

        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            settled = _settled_outcomes()

        self.assertNotIn("position", settled[0])
        measured = accuracy.measure(settled)
        self.assertEqual(measured["by_position"], {})
