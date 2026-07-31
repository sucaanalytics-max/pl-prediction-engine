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
import importlib.abc
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning.notify import (
    DeliveryResult,
    NotificationError,
    notify,
    render_email,
    strip_for_publication,
)
from pipeline.learning.schedule import (
    Phase,
    determine_phase,
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
    def test_reads_gameweek_numbers_from_the_ledger_layout(self):
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp)
            (ledger / "gw01").mkdir()
            (ledger / "gw01" / "forecast.jsonl").write_text("{}\n")
            (ledger / "gw02").mkdir()
            (ledger / "gw02" / "forecast.jsonl").write_text("{}\n")
            (ledger / "gw02" / "outcome.jsonl").write_text("{}\n")
            state = ledger_state(ledger)
            self.assertEqual(state["sealed"], {1, 2})
            self.assertEqual(state["settled"], {2})
            self.assertEqual(state["scored"], set())

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


class PublicationStrippingTests(unittest.TestCase):
    def test_private_fields_are_removed(self):
        """The site artifact is world-readable once published."""
        decision = {
            "gameweek": 5,
            "entry_id": 20945,
            "manager_name": "someone",
            "counterfactuals": [{"alternative": "x"}],
            "teams": [{"label": "season", "entry_id": 20945, "captain": "Haaland"}],
        }
        public = strip_for_publication(decision)
        self.assertNotIn("entry_id", public)
        self.assertNotIn("manager_name", public)
        self.assertNotIn("counterfactuals", public)
        self.assertNotIn("entry_id", public["teams"][0])
        self.assertEqual(public["teams"][0]["captain"], "Haaland")


class EmailRenderingTests(unittest.TestCase):
    def _decision(self, **overrides):
        decision = {
            "gameweek": 5,
            "deadline": "2026-09-12T10:30:00Z",
            "generated_at": "2026-09-12T06:00:00Z",
            "entry_id": 20945,
            "teams": [
                {
                    "label": "season",
                    "captain": "Haaland",
                    "vice_captain": "Saka",
                    "transfers": [{"out": "Smith", "in": "Jones", "note": "-4 hit"}],
                    "chip": None,
                    "projected_points": 61.2,
                    "projected_interval": "[42, 84]",
                    "status": "ok",
                },
                {
                    "label": "weekly",
                    "captain": "Saka",
                    "transfers": [],
                    "projected_points": 58.9,
                    "status": "field_model_uncalibrated",
                },
            ],
        }
        decision.update(overrides)
        return decision

    def test_subject_carries_gameweek_and_urgency(self):
        subject, _ = render_email(self._decision(), "https://x.test/decisions", 4.0)
        self.assertIn("GW5", subject)
        self.assertIn("4.0", subject)

    def test_body_contains_both_teams_and_their_decisions(self):
        _, body = render_email(self._decision(), "https://x.test/decisions", 4.0)
        self.assertIn("SEASON", body)
        self.assertIn("WEEKLY", body)
        self.assertIn("Haaland", body)
        self.assertIn("Smith -> Jones", body)

    def test_no_transfers_is_stated_explicitly(self):
        """Silence about transfers would read as an omission, not a decision."""
        _, body = render_email(self._decision(), "https://x.test", 4.0)
        self.assertIn("Transfers: none (roll)", body)

    def test_a_degraded_team_status_is_surfaced(self):
        _, body = render_email(self._decision(), "https://x.test", 4.0)
        self.assertIn("FIELD_MODEL_UNCALIBRATED", body)

    def test_private_fields_never_reach_the_body(self):
        _, body = render_email(self._decision(), "https://x.test", 4.0)
        self.assertNotIn("20945", body)

    def test_degraded_rules_are_called_out(self):
        decision = self._decision(metadata={"fpl_rules_degraded": True})
        _, body = render_email(decision, "https://x.test", 4.0)
        self.assertIn("drift detected", body)

    def test_body_states_that_nothing_was_submitted(self):
        """Propose-and-approve must be unambiguous in the message itself."""
        _, body = render_email(self._decision(), "https://x.test", 4.0)
        self.assertIn("Nothing has been submitted", body)


class DeliveryTests(unittest.TestCase):
    def test_delivery_failure_raises_rather_than_returning_quietly(self):
        """
        A decision nobody received is not a decision, and a missed FPL deadline
        cannot be made up later.
        """
        with self.assertRaises(NotificationError):
            notify(
                {"gameweek": 5, "teams": []},
                "https://x.test",
                4.0,
                channels=("email",),
                email_config={"host": "", "sender": "", "recipient": ""},
            )

    def test_dry_run_may_tolerate_no_delivery(self):
        result = notify(
            {"gameweek": 5, "teams": []},
            "https://x.test",
            4.0,
            channels=("email",),
            email_config={"host": "", "sender": "", "recipient": ""},
            require_delivery=False,
        )
        self.assertFalse(result.any_delivered)
        self.assertIn("email", result.failed)

    def test_site_channel_counts_as_delivered(self):
        result = notify(
            {"gameweek": 5, "teams": []},
            "https://x.test",
            4.0,
            channels=("site",),
        )
        self.assertEqual(result.delivered, ["site"])

    def test_unknown_channel_is_skipped_not_silently_ignored(self):
        result = notify(
            {"gameweek": 5, "teams": []},
            "https://x.test",
            4.0,
            channels=("site", "carrier-pigeon"),
        )
        self.assertIn("carrier-pigeon", result.skipped)


if __name__ == "__main__":
    unittest.main()
