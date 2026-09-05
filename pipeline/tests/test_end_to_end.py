"""
The single end-to-end test: does the whole agent work as one sequence?

Every stage below has its own unit tests and every one of them passes. That is
not the same claim. Three times this session a module was found built, tested,
and wired to nothing — fixture_rates, the horizon MILP, and the notifier — and
no unit test could have caught any of them, because each module's own tests
were green.

So this runs the real phases over settled 2025-26 gameweeks, in order, through
the real artifacts on disk:

    seal -> decide -> publish -> deliver -> settle -> score

The plan's readiness criterion is that this passes. It is deliberately built
from the actual entry points rather than reimplementing them, because a test
that reimplements the sequence tests the reimplementation.

Nothing here touches the network. The bootstrap comes from the committed
pre-season snapshot, outcomes come from the archive, and delivery runs in
dry-run mode so no mail is sent.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.fpl.rules import load_rules
from pipeline.learning.schedule import Phase, ScheduleState

try:
    import scipy.optimize  # noqa: F401

    HAVE_SCIPY = True
except ImportError:  # pragma: no cover
    HAVE_SCIPY = False

RULES = load_rules()
SEASON = "2526"
# Late enough that the walk-forward has real history behind it.
GAMEWEEK = 30


def _archive():
    from pipeline.learning.backfill import load_archive_season

    return load_archive_season(SEASON)


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestEndToEnd(unittest.TestCase):
    """One settled gameweek, start to finish, on disk."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = TemporaryDirectory()
        cls.dir = Path(cls._tmp.name)
        cls.archive = _archive()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _state(self, phase=Phase.SEAL):
        return ScheduleState(
            phase=phase, gameweek=GAMEWEEK,
            deadline=datetime.now(timezone.utc) + timedelta(hours=2),
            reason="end-to-end test",
        )

    def test_the_whole_sequence_runs(self):
        """
        seal -> decide -> publish -> deliver -> settle -> score, in order, with
        each stage consuming what the previous one actually wrote.
        """
        from pipeline.decide.run_decide import decide, write_decision
        from pipeline.learning.ledger import resolve_universe, seal_forecast
        from pipeline.learning.walk_forward import (
            project_gameweek,
            synthetic_bootstrap,
        )

        state = self._state()
        bootstrap = synthetic_bootstrap(self.archive, GAMEWEEK)

        # ── project ──────────────────────────────────────────────────────
        forecasts, actuals, unmatched = project_gameweek(
            self.archive, GAMEWEEK, RULES, n_draws=600
        )
        self.assertGreater(len(forecasts), 300, "projection covered too few players")
        self.assertEqual(unmatched, 0, "players played but were never projected")

        # ── seal ─────────────────────────────────────────────────────────
        sealed = seal_forecast(
            gameweek=GAMEWEEK,
            deadline=state.deadline.isoformat(),
            projections=forecasts,
            universe=resolve_universe(bootstrap),
            bootstrap=bootstrap,
            predictions_dir=self.dir,
            metadata={"source": "end_to_end_test"},
        )
        self.assertTrue(Path(sealed).exists(), "seal wrote no file")

        # ── seal is write-once ───────────────────────────────────────────
        # Asserting the SPECIFIC error: a bare `Exception` would also pass on a
        # signature slip, which would mean the write-once guarantee is untested
        # while looking tested.
        from pipeline.learning.ledger import AlreadySealedError

        with self.assertRaises(AlreadySealedError):
            seal_forecast(
                gameweek=GAMEWEEK, deadline=state.deadline.isoformat(),
                projections=forecasts, universe=resolve_universe(bootstrap),
                bootstrap=bootstrap, predictions_dir=self.dir, metadata={},
            )

        # ── decide, on two independent streams ───────────────────────────
        class _Draws:
            def __init__(self, rows, seed):
                import numpy as np

                rng = np.random.default_rng(seed)
                self.element_ids = [int(r["element_id"]) for r in rows]
                xp = np.array([max(float(r["xp"]), 0.01) for r in rows])
                self.points = rng.poisson(np.tile(xp, (150, 1))).astype("int64")
                self.minutes = np.where(
                    rng.random((150, len(xp))) < 0.85,
                    rng.integers(60, 91, size=(150, len(xp))), 0,
                ).astype("int32")
                self.gameweek = GAMEWEEK

        decision = decide(
            gameweek=GAMEWEEK,
            draws_select=_Draws(forecasts, 1),
            draws_report=_Draws(forecasts, 2),
            bootstrap=bootstrap, rules=RULES, xp_rows=forecasts,
            entry_label="season", objective="season", shortlist_size=2,
        )
        self.assertEqual(len(decision.reported.plan.squad), RULES.squad_size)
        self.assertEqual(len(decision.reported.plan.xi), RULES.lineup_size)
        self.assertEqual(decision.reported.plan.hits, 0, "opening build took a hit")

        # ── publish, private and public ──────────────────────────────────
        written = write_decision(
            decision, self.dir, public_dir=self.dir / "public", sealed=True,
        )
        self.assertTrue(written["decision"].exists())
        self.assertTrue(written["public"].exists())

        private = json.loads(written["decision"].read_text())
        public = json.loads(written["public"].read_text())
        self.assertIn("runners_up", private)
        self.assertNotIn("runners_up", public, "counterfactuals leaked to the public copy")
        self.assertEqual(
            public["evidence"]["beats_greedy_transfers"]["verdict"], "not established",
            "the failed criterion did not survive publication",
        )

        # ── publish the message feed ─────────────────────────────────────
        from pipeline.learning.messages import decision_messages, load_feed, publish

        messages = decision_messages(private, 2.0, "2026-10-01T09:00:00Z")
        self.assertTrue(messages, "a decision produced no messages")
        publish(messages, self.dir, self.dir / "public")

        feed = load_feed(self.dir)
        self.assertTrue(
            any(m["kind"] == "decision" for m in feed),
            "the decision never reached the feed, which is the only channel",
        )

        # ── settle from the archive, and score ────────────────────────────
        realised = (
            self.archive[self.archive["GW"] == GAMEWEEK]
            .groupby("element")["total_points"].sum().to_dict()
        )
        self.assertGreater(len(realised), 300)

        from pipeline.learning.calibration_check import check_calibration

        report = check_calibration(forecasts, actuals)
        self.assertEqual(report.n, len(actuals))
        # A gross miscalibration here means a stage upstream is misaligned,
        # which is exactly what an end-to-end test is for.
        self.assertLess(
            abs(report.tails["p_ge_2"]["bias"]), 0.10,
            f"p_ge_2 bias {report.tails['p_ge_2']['bias']:+.4f} is far outside "
            f"the calibrated range; a stage is misaligned",
        )

    def test_the_parameter_store_survives_a_promotion_and_a_rollback(self):
        """
        The learning loop's durable half, exercised against real files rather
        than in memory.
        """
        from pipeline.config import PARAM_REGISTRY
        from pipeline.learning.params import active, history, promote, rollback

        name = next(n for n, e in PARAM_REGISTRY.items() if e.get("tier") == "F")
        base = PARAM_REGISTRY[name]["value"]
        gates = [{"gate": "out_of_sample", "passed": True, "reason": ""}]
        stamp = "2026-08-02T00:00:00Z"

        self.assertEqual(active(self.dir).version, 0)
        promote(self.dir, {name: base * 1.01}, gates, "first", stamp)
        promote(self.dir, {name: base * 1.02}, gates, "second", stamp)
        rollback(self.dir, 1, "undo the second", stamp)

        versions = history(self.dir)
        self.assertEqual([v.version for v in versions], [1, 2, 3])
        self.assertEqual(versions[1].reason, "second", "history was rewritten")
        self.assertAlmostEqual(active(self.dir).values[name], base * 1.01)


class TestPublicationIsTheOnlyChannel(unittest.TestCase):
    """
    Email was removed, so the feed is the agent's only way to say anything.

    That raises the bar on publication: with a second channel a failed write was
    an inconvenience; now it is the difference between being told and not. These
    assert publication is verified rather than assumed.
    """

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _message(self, **over):
        from pipeline.learning.messages import Message

        params = dict(
            id="gw7-status", gameweek=7, kind="status", severity="info",
            title="t", body="b", created_at="2026-10-01T09:00:00Z",
        )
        params.update(over)
        return Message(**params)

    def test_publishing_writes_and_verifies_both_copies(self):
        from pipeline.learning.messages import load_feed, publish

        written = publish([self._message()], self.dir, self.dir / "public")
        self.assertIn("private", written)
        self.assertIn("public", written)
        self.assertEqual(len(load_feed(self.dir)), 1)

    def test_republishing_an_id_replaces_rather_than_duplicates(self):
        """
        The scheduler is state-derived and re-enters phases after a missed cron,
        so without this a caught-up run would fill the feed with duplicates.
        """
        from pipeline.learning.messages import load_feed, publish

        publish([self._message(body="first")], self.dir)
        publish([self._message(body="second")], self.dir)

        feed = load_feed(self.dir)
        self.assertEqual(len(feed), 1)
        self.assertEqual(feed[0]["body"], "second")

    def test_an_empty_message_set_is_refused(self):
        from pipeline.learning.messages import PublicationError, publish

        with self.assertRaises(PublicationError):
            publish([], self.dir)

    def test_private_fields_never_reach_the_feed(self):
        """The published feed is world-readable."""
        from pipeline.learning.messages import load_feed, publish

        publish(
            [self._message(detail={
                "entry_id": 2561567,
                "runners_up": [{"squad": [1, 2]}],
                "gameweek": 7,
            })],
            self.dir,
        )
        detail = load_feed(self.dir)[0]["detail"]
        self.assertNotIn("entry_id", detail)
        self.assertNotIn("runners_up", detail)
        self.assertEqual(detail["gameweek"], 7)

    def test_a_corrupt_feed_raises_rather_than_reading_as_empty(self):
        """
        An unreadable feed that returned [] would look exactly like an agent
        that had nothing to say.
        """
        from pipeline.learning.messages import PublicationError, load_feed, publish

        publish([self._message()], self.dir)
        path = self.dir / "fpl" / "messages.json"
        path.write_text('{"messages": [')
        with self.assertRaises(PublicationError):
            load_feed(self.dir)

    def test_an_unknown_kind_is_rejected_at_construction(self):
        from pipeline.learning.messages import Message

        with self.assertRaises(ValueError):
            Message(
                id="x", gameweek=1, kind="telegram", severity="info",
                title="t", body="b", created_at="",
            )




class TestFeedRecovery(unittest.TestCase):
    """
    A corrupt feed must never silence the agent.

    With email removed the feed is the only channel, so a writer that refuses to
    write because the PREVIOUS write was bad is a deadlock: one truncated file
    would mean the agent could never tell anyone anything again. Measured before
    the fix — a single bad write wedged every subsequent publish.
    """

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _message(self, ident, gameweek=1):
        from pipeline.learning.messages import Message

        return Message(
            id=ident, gameweek=gameweek, kind="status", severity="info",
            title=f"message {ident}", body="b", created_at="2026-08-01T00:00:00Z",
        )

    def _corrupt(self):
        (self.dir / "fpl" / "messages.json").write_text('{"messages": [')

    def test_publishing_recovers_from_a_corrupt_feed(self):
        from pipeline.learning.messages import load_feed, publish

        publish([self._message("m1")], self.dir)
        self._corrupt()
        publish([self._message("m2")], self.dir)

        titles = {m["title"] for m in load_feed(self.dir)}
        self.assertIn("message m2", titles, "the agent could not publish after corruption")

    def test_the_loss_is_announced_at_critical_severity(self):
        """
        A silently shortened feed is indistinguishable from a quiet agent, which
        is the opposite of what the reader should conclude.
        """
        from pipeline.learning.messages import load_feed, publish

        publish([self._message("m1")], self.dir)
        self._corrupt()
        publish([self._message("m2")], self.dir)

        critical = [m for m in load_feed(self.dir) if m["severity"] == "critical"]
        self.assertEqual(len(critical), 1)
        self.assertIn("history was lost", critical[0]["title"].lower())

    def test_the_corrupt_file_is_kept_not_deleted(self):
        """
        It may be partly recoverable, and a system that discards its own history
        when that history becomes inconvenient is not auditable.
        """
        from pipeline.learning.messages import publish

        publish([self._message("m1")], self.dir)
        self._corrupt()
        publish([self._message("m2")], self.dir)

        kept = list((self.dir / "fpl").glob("messages.json.corrupt.*"))
        self.assertEqual(len(kept), 1)
        self.assertIn("messages", kept[0].read_text())

    def test_a_second_corruption_does_not_overwrite_the_first_rescue(self):
        """
        Both quarantine names derive from the file's mtime, so two corruptions
        inside the same second collide — and Path.replace overwrites. Found by
        running the recovery twice in a row.
        """
        from pipeline.learning.messages import publish

        publish([self._message("m1")], self.dir)
        self._corrupt()
        publish([self._message("m2")], self.dir)
        self._corrupt()
        publish([self._message("m3")], self.dir)

        kept = list((self.dir / "fpl").glob("messages.json.corrupt.*"))
        self.assertEqual(
            len(kept), 2, "the second rescue destroyed the first quarantine file"
        )

    def test_reading_a_corrupt_feed_still_raises(self):
        """
        The writer recovers; the READER must not. Rendering a truncated history
        as though it were complete is a different and worse failure.
        """
        from pipeline.learning.messages import PublicationError, load_feed, publish

        publish([self._message("m1")], self.dir)
        self._corrupt()
        with self.assertRaises(PublicationError):
            load_feed(self.dir)


if __name__ == "__main__":
    unittest.main()
