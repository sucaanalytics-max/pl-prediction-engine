"""
Tests for deadline-aware scheduling and decision delivery.

Two properties matter most and are asserted directly rather than inferred.

The scheduler must derive its phase from **state**, not from the clock: a cron
that fails or a runner that queues for an hour must not lose a gameweek. At 38
observations a season, each loss is permanent.

And it must stay **standard library only**, because it gates a CI job that runs
several times a day all year. If it needed the full requirements file the gate
would cost more than the work it guards.
"""
import json
import importlib.abc
import subprocess
import sys
import unittest
import urllib.error
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning.schedule import (
    BOOTSTRAP_URL,
    Phase,
    determine_phase,
    fetch_events,
    ledger_state,
    parse_deadline,
    resolve,
)

DEADLINE = datetime(2026, 8, 21, 17, 30, tzinfo=timezone.utc)


def _events(overrides=None):
    """A three-gameweek calendar; override any gameweek's flags by number."""
    overrides = overrides or {}
    events = []
    for index in range(3):
        gameweek = index + 1
        event = {
            "id": gameweek,
            "deadline_time": (DEADLINE + timedelta(days=7 * index))
            .isoformat()
            .replace("+00:00", "Z"),
            "finished": False,
            "data_checked": False,
        }
        event.update(overrides.get(gameweek, {}))
        events.append(event)
    return events


def _at(hours_from_deadline: float) -> datetime:
    """A moment relative to GW1's deadline. Negative is before."""
    return DEADLINE + timedelta(hours=hours_from_deadline)


class DeadlineParsingTests(unittest.TestCase):
    def test_zulu_suffix_parses_to_utc(self):
        parsed = parse_deadline("2026-08-21T17:30:00Z")
        self.assertEqual(parsed, DEADLINE)
        self.assertIsNotNone(parsed.tzinfo)

    def test_naive_timestamps_are_treated_as_utc(self):
        self.assertEqual(parse_deadline("2026-08-21T17:30:00"), DEADLINE)


class CalendarFetchTests(unittest.TestCase):
    """
    The CI gate's only dependency, and until now the only one with no test at all.

    `resolve` calls fetch_events unguarded, the decide step's exit code is the
    job's verdict, and the work job is gated on outputs a failed decide never
    emits. So the behaviour of this one function on a bad day decides whether a
    gameweek gets sealed. GW1 has seven seal attempts, but they were seven
    identical calls to one host — an outage spanning the band fails them all.
    """

    def _response(self, body):
        handle = mock.MagicMock()
        handle.read.return_value = body.encode("utf-8")
        handle.__enter__ = lambda self_: self_
        handle.__exit__ = lambda *a: False
        return handle

    def _http_error(self, code):
        # Closed on teardown: an undisposed HTTPError with fp=None allocates a
        # tempfile and emits a ResourceWarning when collected.
        error = urllib.error.HTTPError(
            BOOTSTRAP_URL, code, f"status {code}", {}, None
        )
        self.addCleanup(error.close)
        return error

    def test_a_transient_failure_is_retried_rather_than_losing_the_tick(self):
        calls = []

        def flaky(request, timeout=None):
            calls.append(1)
            if len(calls) < 3:
                raise urllib.error.URLError("connection reset")
            return self._response('{"events": [{"id": 1}]}')

        with mock.patch("urllib.request.urlopen", flaky), \
                mock.patch("time.sleep"):
            events = fetch_events()

        self.assertEqual(events, [{"id": 1}])
        self.assertEqual(len(calls), 3, "should have retried twice before succeeding")

    def test_a_persistent_failure_raises_rather_than_returning_no_gameweeks(self):
        """
        The regression this exists to prevent. An empty calendar looks to
        determine_phase like a season with no gameweeks: needs_work false, exit
        zero, a GREEN run — and a silently skipped seal. Returning [] on failure
        would be the single most expensive bug available in this file.
        """
        with mock.patch("urllib.request.urlopen",
                        side_effect=urllib.error.URLError("down")), \
                mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.URLError):
                fetch_events()

    def test_a_deterministic_error_is_not_retried(self):
        """A 404 will fail identically three times; retrying only burns the tick."""
        calls = []

        def not_found(request, timeout=None):
            calls.append(1)
            raise self._http_error(404)

        with mock.patch("urllib.request.urlopen", not_found), \
                mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.HTTPError):
                fetch_events()

        self.assertEqual(len(calls), 1, "a 404 must not be retried")

    def test_a_server_error_is_retried(self):
        calls = []

        def unavailable(request, timeout=None):
            calls.append(1)
            raise self._http_error(503)

        with mock.patch("urllib.request.urlopen", unavailable), \
                mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.HTTPError):
                fetch_events()

        self.assertEqual(len(calls), 3, "503 is retryable")

    def test_a_truncated_body_is_retried(self):
        """A half-read body raises JSONDecodeError, as transient as the socket."""
        calls = []

        def truncated(request, timeout=None):
            calls.append(1)
            if len(calls) < 2:
                return self._response('{"events": [{"id": 1}')
            return self._response('{"events": [{"id": 7}]}')

        with mock.patch("urllib.request.urlopen", truncated), \
                mock.patch("time.sleep"):
            self.assertEqual(fetch_events(), [{"id": 7}])

    def test_resolve_propagates_a_fetch_failure_instead_of_swallowing_it(self):
        """
        Guards the gate's contract from the other side. If anyone wraps this in a
        try/except that returns a default state, the decide job goes green, emits
        no outputs, the work job is skipped, and nothing looks wrong.
        """
        with TemporaryDirectory() as tmp, \
                mock.patch("urllib.request.urlopen",
                           side_effect=urllib.error.URLError("down")), \
                mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.URLError):
                resolve(Path(tmp))


class PhaseFromClockTests(unittest.TestCase):
    def test_far_out_is_idle(self):
        state = determine_phase(_at(-24 * 60), _events())
        self.assertEqual(state.phase, Phase.IDLE)
        self.assertFalse(state.needs_work)

    def test_two_days_out_is_refresh(self):
        state = determine_phase(_at(-40), _events())
        self.assertEqual(state.phase, Phase.REFRESH)
        self.assertTrue(state.needs_work)

    def test_a_few_hours_out_is_seal(self):
        state = determine_phase(_at(-3), _events())
        self.assertEqual(state.phase, Phase.SEAL)
        self.assertEqual(state.gameweek, 1)

    def test_inside_the_lockout_refuses_to_work(self):
        """A seal racing the deadline would make the record a lie."""
        state = determine_phase(_at(-0.2), _events())
        self.assertEqual(state.phase, Phase.LOCKED)
        self.assertFalse(state.needs_work)

    def test_already_sealed_goes_idle_rather_than_resealing(self):
        state = determine_phase(_at(-3), _events(), sealed={1})
        self.assertEqual(state.phase, Phase.IDLE)
        self.assertIn("already sealed", state.reason)


class PhaseFromStateTests(unittest.TestCase):
    """The property that makes a skipped cron survivable."""

    def test_a_late_run_still_seals_rather_than_skipping(self):
        """
        The cron that should have fired at T-4h did not. The next one, at T-1h,
        must still seal — a clock-driven scheduler would have missed it.
        """
        state = determine_phase(_at(-1), _events())
        self.assertEqual(state.phase, Phase.SEAL)

    def test_a_confirmed_unsettled_gameweek_is_settled_first(self):
        state = determine_phase(
            _at(-3),
            _events({1: {"finished": True, "data_checked": True}}),
            sealed={1},
        )
        self.assertEqual(state.phase, Phase.SETTLE_FINAL)
        self.assertEqual(state.gameweek, 1)

    def test_settlement_takes_priority_over_preparing_the_next_gameweek(self):
        """
        Outcome data is only cleanly available for a short window, and an
        unscored gameweek blocks every later refit.
        """
        events = _events({1: {"finished": True, "data_checked": True}})
        state = determine_phase(_at(24 * 6), events, sealed={1, 2})
        self.assertEqual(state.phase, Phase.SETTLE_FINAL)

    def test_finished_but_unconfirmed_is_only_provisional(self):
        """Bonus and defensive contributions still move before FPL confirms."""
        state = determine_phase(
            _at(24),
            _events({1: {"finished": True, "data_checked": False}}),
            sealed={1},
        )
        self.assertEqual(state.phase, Phase.SETTLE_PROVISIONAL)

    def test_settled_but_unscored_triggers_the_refit_path(self):
        state = determine_phase(_at(24 * 3), _events(), sealed={1}, settled={1})
        self.assertEqual(state.phase, Phase.REFIT)
        self.assertEqual(state.gameweek, 1)

    def test_a_missed_seal_is_reported_as_unrecoverable(self):
        """
        A forecast produced after the deadline is worthless however good it is.
        The agent must say so rather than quietly backfilling one.
        """
        state = determine_phase(_at(6), _events(), sealed=set())
        self.assertEqual(state.phase, Phase.MISSED_SEAL)
        self.assertIn("cannot be recovered", state.reason)

    def test_a_missed_seal_does_not_block_the_next_gameweek(self):
        """
        The livelock. Checked BEFORE the forward-looking phases, the missed-seal
        report outlived the miss: its window was longer than the gap between
        deadlines minus the seal window, so one miss preempted SEAL and REFRESH
        for every later gameweek. Reproduced at three hours before GW2's deadline
        still returning `missed_seal gw=1`. Nothing writes forecast.jsonl yet, so
        `sealed` is always empty — the agent would have gone red every three
        hours forever without ever working.
        """
        # 165h after GW1 = 3h before GW2's deadline, GW1 never sealed.
        state = determine_phase(_at(165), _events(), sealed=set())
        self.assertEqual(state.phase, Phase.SEAL)
        self.assertEqual(state.gameweek, 2)

    def test_a_missed_seal_does_not_block_a_refresh_either(self):
        state = determine_phase(_at(128), _events(), sealed=set())
        self.assertEqual(state.phase, Phase.REFRESH)
        self.assertEqual(state.gameweek, 2)

    def test_the_missed_seal_window_is_shorter_than_the_deadline_gap(self):
        """Structural guard: a longer window would recreate the livelock."""
        from pipeline.learning.schedule import (
            MISSED_SEAL_REPORT_WINDOW, SEAL_WINDOW,
        )
        from datetime import timedelta

        self.assertLess(MISSED_SEAL_REPORT_WINDOW, timedelta(days=7) - SEAL_WINDOW)

    def test_an_old_missed_seal_stops_being_reported(self):
        """Otherwise the agent would report the same loss forever."""
        state = determine_phase(_at(24 * 30), _events(), sealed=set())
        self.assertNotEqual(state.phase, Phase.MISSED_SEAL)

    def test_no_upcoming_deadline_is_idle(self):
        state = determine_phase(_at(24 * 400), _events(), sealed={1, 2, 3})
        self.assertEqual(state.phase, Phase.IDLE)


class LedgerStateTests(unittest.TestCase):
    def _week(self, ledger, gameweek, outcome_header=None):
        week = ledger / f"gw{gameweek:02d}"
        week.mkdir()
        (week / "forecast.jsonl").write_text("{}\n")
        if outcome_header is not None:
            (week / "outcome.jsonl").write_text(json.dumps(outcome_header) + "\n")
        return week

    def test_reads_gameweek_numbers_from_the_ledger_layout(self):
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            self._week(ledger, 1)
            self._week(ledger, 2, {"provisional": False})
            state = ledger_state(ledger)
            self.assertEqual(state["sealed"], {1, 2})
            self.assertEqual(state["settled"], {2})
            self.assertEqual(state["scored"], set())

    def test_a_dry_run_ledger_never_counts_as_sealed(self):
        """
        A dry run writes `ledger/dryrun/gwNN/forecast.jsonl`
        (ledger.gameweek_dir), and the agent's commit pathspec is the whole of
        `predictions/fpl/ledger` — so a `dry_run: true` dispatch puts that
        subtree on main. If it read as a seal, the phase machine would believe
        the gameweek was already sealed and go IDLE instead of sealing it, and
        the observation would be lost with nothing looking wrong.

        Two things independently prevent it: `gw(\\d{2})` is a fullmatch, so
        the name `dryrun` cannot match, and the scan is `iterdir` rather than
        `rglob`, so `dryrun/gw01` is never visited. Both are easy to loosen by
        accident, which is why this is pinned rather than left to inspection.
        """
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            quarantined = ledger / "dryrun" / "gw01"
            quarantined.mkdir(parents=True)
            (quarantined / "forecast.jsonl").write_text("{}\n")

            self.assertEqual(ledger_state(ledger)["sealed"], set())

            # Not a vacuous assertion: a real seal in the same ledger IS seen.
            self._week(ledger, 1)
            self.assertEqual(ledger_state(ledger)["sealed"], {1})

    def test_a_provisional_settlement_does_not_count_as_settled(self):
        """
        This is the whole reason `settled` reads the header rather than testing
        for the file. A Sunday-night settle runs before bonus is confirmed; if it
        counted, the Tuesday final settle would never fire, bonus would never be
        captured, and the field observation beside it would stay unusable for
        every gameweek of the season.
        """
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            self._week(ledger, 5, {"provisional": True})
            state = ledger_state(ledger)
            self.assertEqual(state["settled"], set())
            # Still visible as "something was recorded", which is what
            # missed-observation reasoning needs.
            self.assertEqual(state["settled_any"], {5})

    def test_a_header_with_no_flag_is_treated_as_provisional(self):
        """
        Retrying a settle is cheap and settle_gameweek refuses to overwrite a
        final with a provisional. Abandoning one loses bonus permanently, so an
        ambiguous header errs toward retrying.
        """
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            self._week(ledger, 7, {})
            self.assertEqual(ledger_state(ledger)["settled"], set())

    def test_an_unreadable_header_is_treated_as_provisional(self):
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            week = self._week(ledger, 9)
            (week / "outcome.jsonl").write_text("{not json\n")
            self.assertEqual(ledger_state(ledger)["settled"], set())

    def test_a_dry_run_directory_is_not_mistaken_for_a_gameweek(self):
        """`dryrun/` must never be read as real ledger state."""
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            (ledger / "dryrun").mkdir()
            (ledger / "dryrun" / "forecast.jsonl").write_text("{}\n")
            self.assertEqual(ledger_state(ledger)["sealed"], set())

    def test_a_missing_ledger_is_empty_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(ledger_state(Path(tmp) / "nope")["sealed"], set())

    def test_resolve_combines_calendar_and_disk(self):
        with TemporaryDirectory() as tmp:
            state = resolve(Path(tmp), now=_at(-3), events=_events())
            self.assertEqual(state.phase, Phase.SEAL)


class StdlibOnlyTests(unittest.TestCase):
    def test_schedule_module_imports_with_third_party_blocked(self):
        """
        Enforced, not just intended. This module gates a CI job that runs several
        times a day all year; needing pandas and PyMC would make the gate cost
        more than the work it guards.
        """
        script = (
            "import sys, importlib.abc\n"
            "BLOCKED={'pandas','numpy','scipy','sklearn','xgboost','pymc',"
            "'yaml','requests','supabase','arviz','statsmodels','shap','lightgbm'}\n"
            "class B(importlib.abc.MetaPathFinder):\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name.split('.')[0] in BLOCKED:\n"
            "            raise ImportError('blocked: ' + name)\n"
            "        return None\n"
            "sys.meta_path.insert(0, B())\n"
            "import pipeline.learning.schedule\n"
            "print('ok')\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(Path(__file__).resolve().parents[2]),
            capture_output=True,
            text=True,
            env={"PYTHONPATH": str(Path(__file__).resolve().parents[2]), "PATH": ""},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ok", result.stdout)


# PublicationStrippingTests and EmailRenderingTests were removed with the email
# channel. Their subject matter did not disappear with it: stripping private
# fields before publication now lives in pipeline/learning/messages.py and is
# tested in test_end_to_end.py, because the feed is world-readable and is now
# the agent's ONLY channel.


if __name__ == "__main__":
    unittest.main()


class AgentStatusPublishTests(unittest.TestCase):
    """
    The status file that explains an absent agent artifact.

    ## Why it exists

    The agent self-gates: `needs_work` is false in IDLE and LOCKED, so the CI job
    that runs it is skipped. Measured on 2026-08-11 that was every run — the GW1
    deadline was 247 hours away and the resolver correctly said "nothing due yet".

    It writes `evidence_view.json`, `messages.json` and `xp_gw*`, so those are
    absent for roughly ten days before each deadline. `evidence_view.json` has in
    fact never been published, and `/evidence` showed the same `absent` state
    whether the agent was idle by design or broken.

    ## The load-bearing property

    **This must be written by the phase resolver, never by the agent.** The agent is
    skipped exactly when the file is needed, so publishing it there would reproduce
    the bug it fixes. The last test in this class is the one that matters.
    """

    def _state(self, phase, **over):
        from pipeline.learning.schedule import Phase, ScheduleState

        return ScheduleState(phase=phase, **over)

    def test_it_publishes_when_the_agent_did_not_run(self):
        import json
        import tempfile
        from pathlib import Path

        from pipeline.learning.schedule import Phase, publish_status

        with tempfile.TemporaryDirectory() as tmp:
            state = self._state(Phase.IDLE, gameweek=1, reason="nothing due yet")
            self.assertFalse(state.needs_work)
            path = publish_status(state, Path(tmp))
            payload = json.loads(path.read_text(encoding="utf-8"))

        self.assertIs(payload["agent_ran"], False)
        self.assertEqual(payload["phase"], "idle")
        self.assertEqual(payload["gameweek"], 1)
        self.assertIn("nothing due yet", payload["reason"])

    def test_agent_ran_is_true_when_there_is_work(self):
        import json
        import tempfile
        from pathlib import Path

        from pipeline.learning.schedule import Phase, publish_status

        working = [p for p in Phase if p not in (Phase.IDLE, Phase.LOCKED)]
        self.assertTrue(working, "no working phases to test")

        with tempfile.TemporaryDirectory() as tmp:
            path = publish_status(self._state(working[0], gameweek=2), Path(tmp))
            payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertIs(payload["agent_ran"], True)

    def test_locked_is_also_a_non_running_phase(self):
        # Two ways to be idle. A frontend deriving this from `phase == "idle"` would
        # miss LOCKED, which is why `agent_ran` is published explicitly.
        import json
        import tempfile
        from pathlib import Path

        from pipeline.learning.schedule import Phase, publish_status

        with tempfile.TemporaryDirectory() as tmp:
            path = publish_status(self._state(Phase.LOCKED, gameweek=1), Path(tmp))
            payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertIs(payload["agent_ran"], False)

    def test_it_carries_a_sentence_explaining_the_absence(self):
        import json
        import tempfile
        from pathlib import Path

        from pipeline.learning.schedule import Phase, publish_status

        with tempfile.TemporaryDirectory() as tmp:
            path = publish_status(self._state(Phase.IDLE, gameweek=1), Path(tmp))
            payload = json.loads(path.read_text(encoding="utf-8"))
        # Named in the artifact so a page cannot paraphrase it into something the
        # producer does not claim.
        self.assertIn("absent", payload["explains_absence"])
        self.assertIn("evidence", payload["explains_absence"].lower())

    def test_the_write_is_atomic_and_leaves_no_scratch_file(self):
        import tempfile
        from pathlib import Path

        from pipeline.learning.schedule import Phase, publish_status

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested"
            publish_status(self._state(Phase.IDLE), target)
            self.assertEqual(list(target.glob("*.tmp")), [])

    def test_the_cli_publishes_it_unconditionally(self):
        """
        THE test.

        The status must be written by the phase resolver, which always runs — not
        by the agent, which is skipped whenever nothing is due. Publishing it from
        the agent would mean the file is absent exactly when a screen needs it to
        explain an absence.
        """
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "learning" / "schedule.py").read_text(
            encoding="utf-8",
        )
        self.assertIn("publish_status(resolved", source)
        # Not behind a needs_work check.
        cli = source[source.index('if __name__ == "__main__":'):]
        self.assertNotIn("needs_work", cli)

    def test_the_workflow_commits_it_from_the_phase_job(self):
        from pathlib import Path

        workflow = (
            Path(__file__).resolve().parents[2]
            / ".github" / "workflows" / "fpl_agent.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("agent_status.json", workflow)
        # The commit step must sit in the `decide` job, before the `work` job that
        # `if: needs.decide.outputs.needs_work == 'true'` gates.
        self.assertLess(
            workflow.index("agent_status.json"),
            workflow.index("needs_work == 'true'"),
            "the status commit must be in the always-running phase job",
        )

    def test_schedule_still_imports_nothing_outside_the_standard_library(self):
        # The constraint that lets the phase job run with no pip install. The
        # config import for FPL_PUBLIC_DIR is inside __main__, like PREDICTIONS_DIR.
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "learning" / "schedule.py").read_text(
            encoding="utf-8",
        )
        module_level = source[: source.index('if __name__ == "__main__":')]
        self.assertNotIn("from pipeline.config import", module_level)

    def test_refresh_reaches_a_deadline_a_week_out(self):
        """
        REFRESH_WINDOW stayed at 48h on purpose — widening it silently ate the
        missed-seal report (see the ordering test below). PROJECTION_WINDOW is
        the one that must reach a week out, so a projection for the next
        gameweek is kept warm well before the front page needs it.
        """
        from datetime import timedelta
        from pipeline.learning.schedule import PROJECTION_WINDOW

        self.assertGreaterEqual(PROJECTION_WINDOW, timedelta(days=7))

    def test_a_deadline_five_days_out_resolves_to_refresh(self):
        """
        The behaviour the constant above only implies, and the whole point of
        this change.

        `PROJECTION_WINDOW`'s magnitude was the only thing asserted, so the
        thirteen lines in `determine_phase` that act on it could be deleted and
        the suite stayed green — while the phase fell back to IDLE, the agent job
        was skipped, `xp_public_gw{next}.json` was never written and the planner,
        the XI, the captain and the squad's xP were all blank for roughly 4.5
        days of every 7. That is the blank front page, and it was one `if` away.

        Five days out with nothing sealed: too far for SEAL (4h) and for REFRESH
        (48h), no past deadline for MISSED_SEAL to report, and well inside
        IDLE_HORIZON. The only gate that can return REFRESH here is the
        projection-warmth one.
        """
        state = determine_phase(_at(-120), _events(), sealed=set())
        self.assertEqual(state.phase, Phase.REFRESH)
        self.assertEqual(state.gameweek, 1)
        # Named so the reason on the status artifact says WHY it is working,
        # rather than reading like an ordinary pre-deadline refresh.
        self.assertIn("warm", state.reason)

    def test_the_warmth_gate_covers_the_whole_gap_between_deadlines(self):
        """
        Not just five days. Deadlines sit about seven days apart, so a gate that
        only reached a few days out would leave the front page blank for the
        first half of every week — which is the state this replaced.
        """
        for hours_before in (49, 72, 120, 160):
            with self.subTest(hours_before=hours_before):
                state = determine_phase(
                    _at(-hours_before), _events(), sealed=set(),
                )
                self.assertEqual(state.phase, Phase.REFRESH)

    def test_projection_warmth_does_not_outrank_a_missed_seal(self):
        """
        The property that broke when REFRESH_WINDOW itself was widened to 8 days:
        a forward-looking gate that wide sits inside the window for the ENTIRE
        gap between deadlines, so it always returns before the MISSED_SEAL check
        ever runs, silently losing the report for "GW1 deadline passed with no
        sealed forecast" — one of 38 irrecoverable observations a season.
        PROJECTION_WINDOW is checked AFTER that report instead, so this scenario
        — 6h after a missed GW1 deadline, with GW2's deadline (7 days out)
        comfortably inside the 8-day PROJECTION_WINDOW — must still report the
        miss rather than quietly moving on to keep GW2's projection warm.
        """
        state = determine_phase(_at(6), _events(), sealed=set())
        self.assertEqual(state.phase, Phase.MISSED_SEAL)
        self.assertEqual(state.gameweek, 1)
