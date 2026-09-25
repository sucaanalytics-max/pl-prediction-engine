"""
The seal backstop asks for one more agent tick, and only when a seal is at risk.

`scripts/seal_backstop.py` runs from launchd on the owner's Mac, outside GitHub's
scheduler, because that scheduler delivered six to eight of the twenty-four hourly
ticks a day (measured 2026-09-24) and left a 3.5-hour seal band empty about one day
in four. What must hold, since it can dispatch a sealing run:

* it dispatches only inside the seal band, only when nothing is sealed, and only
  when no agent run is already in flight;
* the dispatch says `dry_run=false` — the workflow's input defaults to true, which
  seals nothing;
* its copy of the band matches the resolver's, or it would rescue the wrong hours.
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "seal_backstop.py"
spec = importlib.util.spec_from_file_location("seal_backstop", SCRIPT)
backstop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backstop)

DEADLINE = datetime(2026, 10, 10, 10, 0, tzinfo=timezone.utc)


class SealBackstopTests(unittest.TestCase):
    def _run(self, now, sealed=False, busy=None, dry_run=False):
        calls = []

        def gh(args, token):
            calls.append(args)
            return mock.Mock(returncode=0, stdout="[]", stderr="")

        with mock.patch.object(backstop, "owner_token", return_value="t") as token, \
             mock.patch.object(backstop, "next_deadline", return_value=(6, DEADLINE)), \
             mock.patch.object(backstop, "is_sealed", return_value=sealed), \
             mock.patch.object(backstop, "agent_busy", return_value=busy), \
             mock.patch.object(backstop, "_gh", side_effect=gh), \
             mock.patch.object(backstop.time, "sleep"):
            argv = ["--now", now.isoformat()] + (["--dry-run"] if dry_run else [])
            code = backstop.main(argv)
        self.token_used = token.called
        dispatches = [c for c in calls if c[:2] == ["workflow", "run"]]
        return code, dispatches

    def test_outside_the_band_it_touches_neither_the_keychain_nor_github(self):
        """Every ten minutes all season must cost nothing: no token read, no API."""
        _, dispatches = self._run(DEADLINE - timedelta(days=3))
        self.assertEqual(dispatches, [])
        self.assertFalse(self.token_used)

    def test_dispatches_a_sealing_run_when_the_band_is_open_and_nothing_sealed(self):
        code, dispatches = self._run(DEADLINE - timedelta(hours=3))
        self.assertEqual(code, 0)
        self.assertEqual(len(dispatches), 1)
        self.assertIn("dry_run=false", dispatches[0])

    def test_never_dispatches_the_workflows_default_dry_run(self):
        _, dispatches = self._run(DEADLINE - timedelta(hours=3))
        self.assertNotIn("dry_run=true", dispatches[0])
        self.assertEqual(dispatches[0][dispatches[0].index("-f") + 1], "dry_run=false")

    def test_does_nothing_before_the_band_opens(self):
        _, dispatches = self._run(DEADLINE - timedelta(hours=4, minutes=1))
        self.assertEqual(dispatches, [])

    def test_does_nothing_inside_the_lockout(self):
        """Inside the last thirty minutes the agent refuses to write a forecast."""
        _, dispatches = self._run(DEADLINE - timedelta(minutes=20))
        self.assertEqual(dispatches, [])

    def test_does_nothing_once_sealed(self):
        _, dispatches = self._run(DEADLINE - timedelta(hours=2), sealed=True)
        self.assertEqual(dispatches, [])

    def test_leaves_a_run_already_in_flight_to_finish(self):
        _, dispatches = self._run(DEADLINE - timedelta(hours=2), busy="run 1 is in_progress")
        self.assertEqual(dispatches, [])

    def test_a_dry_run_only_reports(self):
        _, dispatches = self._run(DEADLINE - timedelta(hours=2), dry_run=True)
        self.assertEqual(dispatches, [])

    def test_its_band_is_the_resolvers_band(self):
        from pipeline.learning.schedule import LOCKOUT_BEFORE_DEADLINE, SEAL_WINDOW

        self.assertEqual(backstop.SEAL_WINDOW, SEAL_WINDOW)
        self.assertEqual(backstop.LOCKOUT_BEFORE_DEADLINE, LOCKOUT_BEFORE_DEADLINE)

    def test_it_targets_the_workflow_that_exists(self):
        workflow = SCRIPT.parents[1] / ".github" / "workflows" / backstop.WORKFLOW
        self.assertTrue(workflow.exists())
        self.assertIn(f"name: {backstop.WORKFLOW_NAME}\n", workflow.read_text())
        self.assertIn("dry_run:", workflow.read_text())



class CalendarCacheTests(unittest.TestCase):
    """The season's deadlines are read from FPL rarely, and from disk otherwise."""

    CALENDAR = [(5, DEADLINE - timedelta(days=22)), (6, DEADLINE), (7, DEADLINE + timedelta(days=7))]

    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "calendar.json"
        self.fetches = 0

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self):
        self.fetches += 1
        return list(self.CALENDAR)

    def load(self, wall, fetch=None):
        return backstop.load_calendar(fetch=fetch or self.fetch, cache=self.cache, wall=wall)

    def test_a_fresh_cache_is_read_not_refetched(self):
        far = DEADLINE - timedelta(days=5)
        self.load(far)
        self.load(far + timedelta(hours=11))
        self.assertEqual(self.fetches, 1)

    def test_far_from_a_deadline_it_refreshes_twice_a_day(self):
        far = DEADLINE - timedelta(days=5)
        self.load(far)
        self.load(far + timedelta(hours=12, minutes=1))
        self.assertEqual(self.fetches, 2)

    def test_within_a_day_of_a_deadline_it_refreshes_hourly(self):
        """FPL occasionally moves a deadline; the day before is when that matters."""
        near = DEADLINE - timedelta(hours=20)
        self.load(near)
        self.load(near + timedelta(hours=1, minutes=1))
        self.assertEqual(self.fetches, 2)

    def test_a_failed_refresh_falls_back_to_the_cache(self):
        far = DEADLINE - timedelta(days=5)
        self.load(far)

        def broken():
            raise OSError("FPL is down")

        calendar = self.load(far + timedelta(hours=13), fetch=broken)
        self.assertEqual(calendar, self.CALENDAR)

    def test_no_cache_and_no_fpl_is_an_error_not_a_silent_skip(self):
        def broken():
            raise OSError("FPL is down")

        with self.assertRaises(OSError):
            self.load(DEADLINE - timedelta(days=5), fetch=broken)

    def test_a_stamp_from_the_future_is_stale_not_fresh(self):
        """A simulated `--now` once wrote a fetch time a fortnight ahead and froze the cache."""
        self.load(DEADLINE)                       # stamped at the deadline
        self.load(DEADLINE - timedelta(days=14))  # the real clock is two weeks earlier
        self.assertEqual(self.fetches, 2)

    def test_scenario_time_does_not_touch_the_cache_stamp(self):
        """next_deadline(--now) must leave the cache aged by the wall clock."""
        wall = datetime.now(timezone.utc)
        with mock.patch.object(backstop, "CALENDAR_CACHE", self.cache), \
             mock.patch.object(backstop, "fetch_calendar", side_effect=self.fetch):
            backstop.load_calendar(fetch=self.fetch, cache=self.cache)
            import json as _json
            stamp = backstop._parse(_json.loads(self.cache.read_text())["fetched_at"])
        self.assertLess(abs((stamp - wall).total_seconds()), 60)

    def test_the_next_deadline_is_the_first_one_still_ahead(self):
        calendar = self.load(DEADLINE - timedelta(days=5))
        self.assertEqual(backstop._next(calendar, DEADLINE - timedelta(days=5)), (6, DEADLINE))
        self.assertEqual(backstop._next(calendar, DEADLINE + timedelta(minutes=1))[0], 7)


class LaunchdPlistTests(unittest.TestCase):
    """
    The job checks often enough to catch every seal band, and never at load.

    The file is kept to strict XML so this test can read it — launchd's own parser
    is more lenient than Python's.
    """

    def _job(self):
        import plistlib

        with (SCRIPT.parent / "com.pl-prediction.seal-backstop.plist").open("rb") as handle:
            return plistlib.load(handle)

    def test_it_never_runs_at_load(self):
        job = self._job()
        self.assertIs(job["RunAtLoad"], False)
        self.assertTrue(job["ProgramArguments"][-1].endswith("scripts/seal_backstop.py"))

    def test_every_band_gets_many_checks_and_none_is_skipped_by_the_run_guard(self):
        job = self._job()
        self.assertNotIn("StartCalendarInterval", job, "a calendar covers some deadlines, not all")
        interval = timedelta(seconds=job["StartInterval"])
        band = backstop.SEAL_WINDOW - backstop.LOCKOUT_BEFORE_DEADLINE
        self.assertGreaterEqual(band / interval, 10)
        # At or above RECENT_RUN, so a run it dispatched is not re-dispatched while
        # it could still be starting.
        self.assertGreaterEqual(interval, backstop.RECENT_RUN)

if __name__ == "__main__":
    unittest.main()
