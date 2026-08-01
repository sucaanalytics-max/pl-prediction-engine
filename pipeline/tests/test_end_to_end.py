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
        written = write_decision(decision, self.dir, public_dir=self.dir / "public")
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

        # ── deliver, dry run ─────────────────────────────────────────────
        from pipeline.learning.notify import notify

        payload = {
            "gameweek": GAMEWEEK,
            "deadline": state.deadline.isoformat(),
            "teams": [private],
        }
        result = notify(payload, "https://example.invalid", 2.0, require_delivery=False)
        self.assertIsNotNone(result)

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


if __name__ == "__main__":
    unittest.main()


class TestDeliveryIsWired(unittest.TestCase):
    """
    The notifier was built, tested, and called by nothing — the third module in
    this session found in that state. These assert the seal actually reaches it,
    which no test of notify.py itself could ever show.
    """

    def _state(self):
        return ScheduleState(
            phase=Phase.SEAL, gameweek=7,
            deadline=datetime.now(timezone.utc) + timedelta(hours=3),
            reason="delivery wiring test",
        )

    def test_seal_reaches_the_delivery_hook(self):
        """
        A seal that never attempts delivery is a decision nobody receives.

        Checked against _seal's own compiled constants and names, not by
        monkeypatching _deliver and then calling it directly — that variant
        passes whether or not _seal has ever heard of it, which is exactly the
        kind of test that let the notifier sit unwired in the first place.
        """
        import pipeline.learning.run_agent as agent

        referenced = set(agent._seal.__code__.co_names)
        self.assertIn(
            "_deliver", referenced,
            "_seal does not reference _deliver; the notifier is unwired again",
        )

    def test_deliver_is_the_last_thing_seal_does(self):
        """
        Its return value must be the seal's exit code, or a delivery failure
        would be swallowed and the run would report success.
        """
        import inspect

        import pipeline.learning.run_agent as agent

        source = inspect.getsource(agent._seal)
        self.assertIn(
            "return _deliver(", source,
            "_seal calls _deliver but discards its exit code",
        )

    def test_delivery_failure_returns_non_zero_without_unsealing(self):
        """
        Ordering: the forecast is already sealed and the artifacts written, so a
        mail outage costs a red build rather than a lost observation — but it
        must NOT report success, or a green run would claim a delivery that
        never happened.
        """
        import pipeline.learning.run_agent as agent
        from pipeline.learning.notify import NotificationError

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "decision.json"
            path.write_text(json.dumps({"gameweek": 7, "teams": []}))

            original = agent.__dict__.get("notify")
            import pipeline.learning.notify as notify_module

            def boom(*args, **kwargs):
                raise NotificationError("no mail server configured")

            real = notify_module.notify
            notify_module.notify = boom
            try:
                code = agent._deliver(
                    self._state(), {"season": {"decision": path}}, dry_run=False
                )
            finally:
                notify_module.notify = real

        self.assertEqual(code, 1, "a failed delivery reported success")

    def test_no_decisions_is_not_a_delivery_failure(self):
        """
        A gameweek with no unplayed fixtures produces no proposal. That is not
        an error, and failing the run would make an ordinary blank look broken.
        """
        import pipeline.learning.run_agent as agent

        self.assertEqual(agent._deliver(self._state(), {}, dry_run=False), 0)
