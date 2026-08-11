"""
Tests for the field observation record.

This is on a fuse: average_entry_score and highest_score exist only on the
current season's bootstrap, are absent from the public archive, and cannot be
recovered afterwards. So the tests concentrate on what must never be recorded —
a zero from an unfinished gameweek would poison the calibration band with a
field that scored nothing, and it would look like data.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning.field_observations import (
    FieldObservation,
    consecutive_calibrated,
    extract,
    history,
    latest_per_gameweek,
    record,
)

STAMP = "2026-08-02T12:00:00Z"


def _bootstrap(**overrides):
    event = {
        "id": 5, "finished": True, "data_checked": True,
        "average_entry_score": 54, "highest_score": 128,
        "most_captained": 351, "most_vice_captained": 99,
    }
    event.update(overrides)
    return {"events": [{"id": 4, "finished": True}, event]}


class TestExtract(unittest.TestCase):
    def test_a_finished_gameweek_is_captured(self):
        o = extract(_bootstrap(), 5, STAMP, provisional=False)
        self.assertEqual(o.average_entry_score, 54.0)
        self.assertEqual(o.highest_score, 128.0)
        self.assertEqual(o.most_captained, 351)
        self.assertTrue(o.usable)

    def test_an_unfinished_gameweek_records_nothing(self):
        """
        An unfinished gameweek reports zero. Recording that would tell the
        calibration band the entire field scored nothing — and it would look
        like a real observation.
        """
        self.assertIsNone(
            extract(
                _bootstrap(finished=False, data_checked=False,
                           average_entry_score=0, highest_score=None),
                5, STAMP, provisional=True,
            )
        )

    def test_a_finished_gameweek_with_no_figures_yet_records_nothing(self):
        self.assertIsNone(
            extract(
                _bootstrap(average_entry_score=0, highest_score=None),
                5, STAMP, provisional=False,
            )
        )

    def test_an_absent_gameweek_records_nothing(self):
        self.assertIsNone(extract(_bootstrap(), 99, STAMP, provisional=False))

    def test_a_provisional_reading_is_recorded_but_not_usable(self):
        """
        Bonus settles a day or two later and the average moves with it.
        Calibrating on a provisional reading judges the model against a number
        that was not yet true.
        """
        o = extract(_bootstrap(), 5, STAMP, provisional=True)
        self.assertIsNotNone(o)
        self.assertFalse(o.usable)


class TestRecord(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _obs(self, gameweek, provisional, average=54.0, stamp=STAMP):
        return FieldObservation(
            gameweek=gameweek, average_entry_score=average, highest_score=128.0,
            most_captained=351, most_vice_captained=99,
            provisional=provisional, captured_at=stamp,
        )

    def test_a_correction_appends_rather_than_overwriting(self):
        """
        The provisional reading stays on disk as the record of what was known at
        the time; overwriting would replace a real observation with a later one
        and leave no trace that it changed.
        """
        record(self._obs(5, provisional=True, average=52.0), self.dir)
        record(self._obs(5, provisional=False, average=54.0,
                         stamp="2026-08-04T12:00:00Z"), self.dir)

        rows = history(self.dir)
        self.assertEqual(len(rows), 2)
        self.assertEqual([r.provisional for r in rows], [True, False])

    def test_the_final_reading_supersedes_the_provisional_one(self):
        record(self._obs(5, provisional=True, average=52.0), self.dir)
        record(self._obs(5, provisional=False, average=54.0,
                         stamp="2026-08-04T12:00:00Z"), self.dir)
        best = latest_per_gameweek(self.dir)
        self.assertEqual(best[5].average_entry_score, 54.0)
        self.assertTrue(best[5].usable)

    def test_dry_run_writes_nothing(self):
        record(self._obs(5, provisional=False), self.dir, dry_run=True)
        self.assertEqual(history(self.dir), [])

    def test_no_file_is_an_empty_history_not_an_error(self):
        self.assertEqual(history(self.dir), [])
        self.assertEqual(latest_per_gameweek(self.dir), {})


class TestConsecutiveRun(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        for gameweek in range(1, 8):
            record(
                FieldObservation(
                    gameweek=gameweek, average_entry_score=54.0, highest_score=128.0,
                    most_captained=1, most_vice_captained=2,
                    provisional=False, captured_at=STAMP,
                ),
                self.dir,
            )

    def test_an_unbroken_run_is_counted(self):
        self.assertEqual(
            consecutive_calibrated(self.dir, {g: True for g in range(1, 8)}), 7
        )

    def test_a_recent_failure_resets_the_run(self):
        """
        The gate asks whether the field model is working NOW. A total count
        would let six scattered successes open it while the model failed every
        recent week.
        """
        passes = {g: True for g in range(1, 8)}
        passes[6] = False
        self.assertEqual(consecutive_calibrated(self.dir, passes), 1)

    def test_an_old_failure_does_not_shorten_a_current_run(self):
        passes = {g: True for g in range(1, 8)}
        passes[1] = False
        self.assertEqual(consecutive_calibrated(self.dir, passes), 6)

    def test_no_observations_is_a_run_of_zero(self):
        with TemporaryDirectory() as empty:
            self.assertEqual(consecutive_calibrated(Path(empty), {}), 0)
