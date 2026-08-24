"""
A wide projection window must not mean a full simulation on every hourly tick.

Two separate questions live here, and conflating them is how the gate shipped
throttling the wrong band:

  * `projection_is_current` — is the published file for THIS gameweek young
    enough to keep. Pure, and tested first.
  * the REFRESH branch of `run` — whether that answer is even consulted. It is
    not consulted inside REFRESH_WINDOW, because in the last two days before a
    deadline late team news dominates projection error and a six-hour-old
    projection is stale regardless of what its timestamp says.
"""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from pipeline.learning import run_agent
from pipeline.learning.run_agent import projection_is_current
from pipeline.learning.schedule import Phase, REFRESH_WINDOW, ScheduleState

NOW = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
MAX_AGE = timedelta(hours=20)


class ProjectionIsCurrent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # A stand-in for FPL_PUBLIC_DIR itself (frontend/public/predictions/fpl/),
        # not for PREDICTIONS_DIR. The function reads the leaf directory the
        # frontend fetches from, not a "fpl" child of whatever is passed in.
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, gameweek, generated_at):
        path = self.root / f"xp_public_gw{gameweek:02d}.json"
        path.write_text(json.dumps({"generated_at": generated_at}))

    def test_absent_is_not_current(self):
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_a_fresh_projection_is_current(self):
        self.write(2, "2026-08-24T06:00:00Z")
        self.assertTrue(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_an_aged_projection_is_not_current(self):
        self.write(2, "2026-08-23T06:00:00Z")  # 30 hours old
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_another_gameweek_s_file_does_not_count(self):
        # The exact failure being fixed: gw01 on disk, gw02 requested.
        self.write(1, "2026-08-24T06:00:00Z")
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_an_unreadable_stamp_is_not_current(self):
        path = self.root / "xp_public_gw02.json"
        path.write_text("{not json")
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_a_missing_stamp_is_not_current(self):
        self.write(2, None)
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_reads_the_public_dir_directly_not_a_predictions_style_tree(self):
        """
        The actual defect this whole file exists to catch: the gate's call site
        used to pass PREDICTIONS_DIR and the function appended "fpl" itself, so
        it checked `predictions/fpl/xp_public_gw{NN}.json` — a path that never
        held the file, since `_publish_public_xp` writes straight into
        FPL_PUBLIC_DIR (`frontend/public/predictions/fpl/`) with no further
        nesting. Reproducing that old shape here — the file one directory
        deeper than the leaf `public_dir` passed in — must NOT be found. If
        this ever starts passing as True, the function has regressed back to
        appending "fpl" and the gate will silently stop firing again.
        """
        nested = self.root / "fpl"
        nested.mkdir()
        (nested / "xp_public_gw02.json").write_text(
            json.dumps({"generated_at": "2026-08-24T06:00:00Z"})
        )
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )


class RefreshGate(unittest.TestCase):
    """
    Whether a REFRESH run rebuilds, by how far out it is.

    The defect: the gate read `remaining > SEAL_WINDOW`, so it applied from four
    hours out rather than from forty-eight. Between 48h and 4h — the window the
    whole REFRESH phase exists for — a run with a projection an hour old did
    nothing, so the projection rebuilt roughly every PROJECTION_MAX_AGE instead
    of hourly. That also skipped `record_claims`, which only runs inside
    `refresh_expected_points`, so the intra-week availability path `/evidence`
    reads was throttled by the same line.

    These call `run` rather than reading the source, so the gate has to actually
    behave: `refresh_expected_points` is the thing whose being called or not IS
    the refresh.
    """

    def _run(self, hours_out, projection_current):
        state = ScheduleState(
            phase=Phase.REFRESH,
            gameweek=2,
            seconds_to_deadline=hours_out * 3600,
            reason=f"GW2 deadline in {hours_out}h",
        )
        with mock.patch.object(
            run_agent, "projection_is_current", return_value=projection_current
        ), mock.patch.object(
            run_agent, "refresh_expected_points", return_value={"status": "ok"}
        ) as refresh:
            code = run_agent.run(state)
        return code, refresh

    def test_a_day_out_refreshes_even_with_an_hour_old_projection(self):
        # 24h is inside REFRESH_WINDOW (48h) and outside SEAL_WINDOW (4h) — the
        # band the old comparison silently throttled.
        code, refresh = self._run(24, projection_current=True)
        self.assertEqual(code, 0)
        refresh.assert_called_once()

    def test_the_whole_refresh_window_refreshes_not_just_the_seal_window(self):
        # Both ends of the window, so a gate that regressed to SEAL_WINDOW cannot
        # pass by being right about the last few hours.
        for hours in (2, 6, 24, 47):
            with self.subTest(hours=hours):
                _, refresh = self._run(hours, projection_current=True)
                refresh.assert_called_once()

    def test_further_out_a_current_projection_is_kept(self):
        # PROJECTION_WINDOW reaches eight days, so most ticks of a week land
        # here. Rebuilding on each of them buys nothing: no team news has landed.
        code, refresh = self._run(120, projection_current=True)
        self.assertEqual(code, 0)
        refresh.assert_not_called()

    def test_further_out_an_aged_projection_is_rebuilt(self):
        _, refresh = self._run(120, projection_current=False)
        refresh.assert_called_once()

    def test_the_boundary_is_the_refresh_window_itself(self):
        # Stated as a property of the constant rather than of 48: the gate is
        # `remaining > REFRESH_WINDOW`, so exactly at the boundary it refreshes.
        at = REFRESH_WINDOW.total_seconds() / 3600
        _, refresh = self._run(at, projection_current=True)
        refresh.assert_called_once()
        _, skipped = self._run(at + 1, projection_current=True)
        skipped.assert_not_called()
