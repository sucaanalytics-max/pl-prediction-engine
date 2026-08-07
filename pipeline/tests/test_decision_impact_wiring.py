"""
Stage 2 of the news delta, exercised through the function the agent actually calls.

## Why this file exists

`test_deltas.py` tests `assess_impact`, which is pure. But the code that *calls* it
— `run_agent._record_decision_impact` — is wrapped in a broad
``except Exception: logger.warning(...)`` so that a reporting failure can never
lose a decision that has already been solved and written.

That is the right behaviour and it is also a perfect hiding place. A wiring bug
there produces a log line nobody reads and no impact records, and every unit test
stays green. This repo has already had that exact defect five times in one session
— modules written, fully tested, and reached by nothing — which is why
`test_module_reachability.py` exists. That test catches an unimported *module*; it
cannot catch an unexercised *function*.

So these tests drive the real function with real fakes and assert that records land
on disk.
"""
from __future__ import annotations

import json
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List

from pipeline.learning import deltas as D
from pipeline.learning.run_agent import _previous_decision, _record_decision_impact

STAMP = "2026-08-06T12:00:00Z"

XP_ROWS: List[Dict[str, Any]] = [
    {"element_id": 521, "xp": 1.2, "position": "MID"},
    {"element_id": 100, "xp": 6.1, "position": "FWD"},
    {"element_id": 9, "xp": 5.0, "position": "MID"},
]


@dataclass
class FakePlan:
    squad: List[int]
    xi: List[int]
    captain: int
    vice: int
    transfers_in: List[int]
    transfers_out: List[int]
    hits: int = 0
    bank_after: int = 0
    objective: float = 0.0
    free_transfers_banked: int = 0
    free_transfers_after: int = 1

    def as_dict(self) -> Dict[str, Any]:
        return {
            "squad": sorted(self.squad), "xi": sorted(self.xi),
            "captain": self.captain, "vice": self.vice,
            "transfers_in": sorted(self.transfers_in),
            "transfers_out": sorted(self.transfers_out),
            "hits": self.hits, "bank_after": self.bank_after,
            "objective": self.objective,
            "free_transfers_banked": self.free_transfers_banked,
            "free_transfers_after": self.free_transfers_after,
        }


@dataclass
class FakeEvaluation:
    plan: FakePlan
    mean_points: float


@dataclass
class FakeDecision:
    reported: FakeEvaluation
    generated_at: str = STAMP


def _decision(transfers_in, transfers_out, captain, mean_points=60.0) -> FakeDecision:
    plan = FakePlan(
        squad=[521, 100, 9], xi=[521, 100, 9], captain=captain, vice=100,
        transfers_in=transfers_in, transfers_out=transfers_out,
    )
    return FakeDecision(reported=FakeEvaluation(plan=plan, mean_points=mean_points))


def _seed_pending_delta(root: Path, gameweek: int = 1) -> str:
    """A stage-1 record awaiting its impact, as the poller would have left it."""
    change = D.ResolutionChange(
        element_id=521, claim_type="chance_of_playing",
        before=75, after=25, reason="75% -> 25%", rule="asymmetric_override",
    )
    delta = D.Delta(change=change, observed_at=STAMP, gameweek=gameweek,
                    player_name="Kulusevski", club="Spurs")
    D.record([delta], root)
    return delta.delta_id


class WiringTests(unittest.TestCase):
    """The function the agent calls, driven end to end."""

    def test_a_pending_delta_gets_an_impact_record(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            delta_id = _seed_pending_delta(root)
            self.assertEqual(len(D.unenriched(D.history(root))), 1)

            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous=None,
                decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )

            records = D.history(root)
            impacts = [r for r in records if r["kind"] == D.KIND_IMPACT]
            self.assertEqual(len(impacts), 1, "stage 2 produced nothing")
            self.assertEqual(impacts[0]["delta_id"], delta_id)

    def test_the_pending_delta_is_no_longer_pending(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous=None,
                decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            self.assertEqual(D.unenriched(D.history(root)), [])

    def test_the_impact_records_the_flip(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous={"decision": {"plan": FakePlan(
                    squad=[521, 100, 9], xi=[521, 100, 9], captain=100, vice=9,
                    transfers_in=[], transfers_out=[],
                ).as_dict()}, "xp_snapshot": {"521": 5.4}},
                decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            impact = [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT][0]
            self.assertTrue(impact["root_move"]["flipped"])
            self.assertEqual(impact["root_move"]["before"], "hold")
            self.assertEqual(impact["root_move"]["after"], "[521] -> [9]")

    def test_xp_moved_uses_the_previous_snapshot(self):
        """
        The `xp_snapshot` added to `Decision` exists for exactly this: the
        before-value lives only inside a run that has already finished.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous={"decision": {"plan": None}, "xp_snapshot": {"521": 5.4}},
                decision=_decision([], [], captain=100),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            impact = [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT][0]
            moved = impact["xp_moved"][0]
            self.assertEqual(moved["element_id"], 521)
            self.assertAlmostEqual(moved["before"], 5.4, places=4)
            self.assertAlmostEqual(moved["after"], 1.2, places=4)

    def test_a_missing_snapshot_yields_unknown_rather_than_zero(self):
        """
        An older producer emitted no snapshot. Reporting the move as 5.4 -> 0.0
        would be a fabricated collapse.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous={"decision": {"plan": None}},
                decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            impact = [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT][0]
            self.assertIsNone(impact["xp_moved"][0]["before"])


class ThresholdTests(unittest.TestCase):
    def test_an_impact_that_flips_nothing_and_moves_little_is_not_recorded(self):
        """
        The stage-2 threshold is on the DECISION. Recording every recomputation
        would make the feed noise, and a noisy feed gets muted.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                # Same plan, same captain, xp essentially unchanged.
                previous={"decision": {"plan": FakePlan(
                    squad=[521, 100, 9], xi=[521, 100, 9], captain=100, vice=9,
                    transfers_in=[], transfers_out=[],
                ).as_dict()}, "xp_snapshot": {"521": 1.25}},
                decision=_decision([], [], captain=100),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            impacts = [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT]
            self.assertEqual(impacts, [])
            # And it stays pending, so a later run that DOES flip can report it.
            self.assertEqual(len(D.unenriched(D.history(root))), 1)


class NoOpTests(unittest.TestCase):
    """Cases where doing nothing is correct — asserted so they stay distinguishable
    from the wiring being broken."""

    def test_no_pending_deltas_means_no_records(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous=None, decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            self.assertEqual(D.history(root), [])

    def test_a_delta_for_another_gameweek_is_left_alone(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root, gameweek=3)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous=None, decision=_decision([9], [521], captain=200),
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            self.assertEqual(
                [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT], [],
            )

    def test_a_broken_call_does_not_raise(self):
        """
        The whole reason for the broad except: a decision that has been solved and
        written must not be lost because the reporting failed. Asserted so the
        swallow stays deliberate.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_pending_delta(root)
            _record_decision_impact(
                predictions_dir=root, gameweek=1, entry_label="season",
                previous=None,
                decision=object(),  # has no .reported
                draws=None, xp_rows=XP_ROWS, rules=None,
            )
            self.assertEqual(
                [r for r in D.history(root) if r["kind"] == D.KIND_IMPACT], [],
            )


class PreviousDecisionTests(unittest.TestCase):
    def test_reads_the_artifact_about_to_be_replaced(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "fpl"
            directory.mkdir(parents=True)
            (directory / "decision_gw07_season.json").write_text(
                json.dumps({"gameweek": 7, "xp_snapshot": {"521": 5.4}})
            )
            found = _previous_decision(root, 7, "season")
            self.assertEqual(found["xp_snapshot"]["521"], 5.4)

    def test_none_on_the_first_run_of_a_gameweek(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(_previous_decision(Path(tmp), 7, "season"))

    def test_none_rather_than_raising_on_a_corrupt_artifact(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "fpl"
            directory.mkdir(parents=True)
            (directory / "decision_gw07_season.json").write_text("{not json")
            self.assertIsNone(_previous_decision(root, 7, "season"))

    def test_none_when_the_gameweek_is_unknown(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(_previous_decision(Path(tmp), None, "season"))


if __name__ == "__main__":
    unittest.main()
