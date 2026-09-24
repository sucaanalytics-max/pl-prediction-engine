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

        with mock.patch.object(backstop, "owner_token", return_value="t"), \
             mock.patch.object(backstop, "next_deadline", return_value=(6, DEADLINE)), \
             mock.patch.object(backstop, "is_sealed", return_value=sealed), \
             mock.patch.object(backstop, "agent_busy", return_value=busy), \
             mock.patch.object(backstop, "_gh", side_effect=gh), \
             mock.patch.object(backstop.time, "sleep"):
            argv = ["--now", now.isoformat()] + (["--dry-run"] if dry_run else [])
            code = backstop.main(argv)
        dispatches = [c for c in calls if c[:2] == ["workflow", "run"]]
        return code, dispatches

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



class LaunchdPlistTests(unittest.TestCase):
    """
    The job that schedules the backstop fires when it is meant to, and only then.

    Calendar times in a LaunchAgent are local and easy to get wrong by an offset;
    fired outside the band, the backstop would check at hours when it can do
    nothing. The file is kept to strict XML so this test can read it — launchd's
    own parser is more lenient than Python's.
    """

    def test_the_backstop_never_runs_at_load_and_fires_inside_gw6s_band(self):
        import plistlib

        with (SCRIPT.parent / "com.pl-prediction.seal-backstop.plist").open("rb") as handle:
            job = plistlib.load(handle)
        # Installing it must not dispatch anything.
        self.assertIs(job["RunAtLoad"], False)
        self.assertTrue(job["ProgramArguments"][-1].endswith("scripts/seal_backstop.py"))
        # Calendar times are local; the plist documents local as IST (+05:30).
        ist = timezone(timedelta(hours=5, minutes=30))
        opens, closes = DEADLINE - backstop.SEAL_WINDOW, DEADLINE - backstop.LOCKOUT_BEFORE_DEADLINE
        for entry in job["StartCalendarInterval"]:
            fires = datetime(2026, entry["Month"], entry["Day"], entry["Hour"], entry["Minute"], tzinfo=ist)
            with self.subTest(fires=fires.isoformat()):
                self.assertTrue(opens <= fires < closes, f"{fires} is outside GW6's band")


if __name__ == "__main__":
    unittest.main()
