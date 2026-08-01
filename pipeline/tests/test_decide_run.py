"""
End-to-end tests for the decision path: pool -> MILP -> adjudication -> artifact.

The per-module suites test each stage against its own contract. This one tests
that the stages agree with each other — that the pool's element ids survive into
the MILP, that the MILP's Plan is something the simulator can score, and that
the artifact reports the independent stream rather than the optimistic one.

Every module below passed its own tests while the seam between them was wrong at
least once during development, which is the case for testing the seam directly.
"""
from __future__ import annotations

import json
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Dict, List

import numpy as np

from pipeline.decide.run_decide import (
    MAX_CREDIBLE_OPTIMISM,
    decide,
    strip_for_publication,
    write_decision,
)
from pipeline.fpl.rules import load_rules

try:
    import scipy.optimize  # noqa: F401

    HAVE_SCIPY = True
except ImportError:  # pragma: no cover
    HAVE_SCIPY = False

RULES = load_rules()

CLUBS = [
    {"id": i, "name": n}
    for i, n in enumerate(
        ["Arsenal", "Chelsea", "Everton", "Fulham", "Liverpool", "Newcastle"], start=1
    )
]
ELEMENT_TYPES = [
    {"id": 1, "singular_name_short": "GKP"},
    {"id": 2, "singular_name_short": "DEF"},
    {"id": 3, "singular_name_short": "MID"},
    {"id": 4, "singular_name_short": "FWD"},
]
COUNTS = {1: 6, 2: 15, 3: 15, 4: 9}


def _bootstrap():
    elements = []
    element_id = 1
    for element_type, count in COUNTS.items():
        for i in range(count):
            elements.append(
                {
                    "id": element_id,
                    "element_type": element_type,
                    "team": CLUBS[element_id % len(CLUBS)]["id"],
                    "now_cost": 40 + (i % 8) * 10,
                    "status": "a",
                }
            )
            element_id += 1
    return {"teams": CLUBS, "element_types": ELEMENT_TYPES, "elements": elements}


BOOTSTRAP = _bootstrap()
ALL_IDS = [e["id"] for e in BOOTSTRAP["elements"]]
XP_ROWS = [
    {"element_id": e["id"], "xp": 1.0 + 0.9 * ((e["id"] * 7) % 8)}
    for e in BOOTSTRAP["elements"]
]


@dataclass
class FakeDraws:
    element_ids: List[int]
    points: np.ndarray
    minutes: np.ndarray
    gameweek: int = 1


def _draws(seed: int, n: int = 200) -> FakeDraws:
    """
    Draws whose mean per player tracks that player's xp, so the simulator and
    the MILP are looking at the same football rather than at unrelated noise.
    """
    rng = np.random.default_rng(seed)
    xp = np.array([row["xp"] for row in XP_ROWS])
    points = rng.poisson(np.tile(xp, (n, 1))).astype(np.int64)
    minutes = np.where(
        rng.random((n, len(ALL_IDS))) < 0.9,
        rng.integers(60, 91, size=(n, len(ALL_IDS))),
        0,
    ).astype(np.int32)
    return FakeDraws(element_ids=list(ALL_IDS), points=points, minutes=minutes)


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestDecide(unittest.TestCase):
    def setUp(self):
        self.select = _draws(seed=1)
        self.report = _draws(seed=2)

    def _decide(self, **kwargs):
        params = dict(
            gameweek=1, draws_select=self.select, draws_report=self.report,
            bootstrap=BOOTSTRAP, rules=RULES, xp_rows=XP_ROWS, shortlist_size=4,
        )
        params.update(kwargs)
        return decide(**params)

    def test_produces_a_legal_squad_end_to_end(self):
        decision = self._decide()
        plan = decision.reported.plan

        self.assertEqual(len(plan.squad), RULES.squad_size)
        self.assertEqual(len(plan.xi), RULES.lineup_size)
        self.assertIn(plan.captain, plan.xi)
        self.assertNotEqual(plan.captain, plan.vice)

        by_id = {e["id"]: e for e in BOOTSTRAP["elements"]}
        spend = sum(by_id[p]["now_cost"] for p in plan.squad)
        self.assertLessEqual(spend, RULES.budget_tenths)

    def test_opening_squad_takes_no_hit(self):
        """
        Fifteen purchases into an empty squad are slot-filling, not transfers.
        Charging them would open the season on a -56.
        """
        decision = self._decide(free_transfers=1)
        self.assertEqual(decision.reported.plan.hits, 0)

    def test_reported_numbers_come_from_the_independent_stream(self):
        """
        The whole point of two streams. The artifact's headline must be the
        stream that played no part in selection, or the score is the optimistic
        one and every accuracy claim built on it is inflated.
        """
        decision = self._decide()
        payload = decision.as_dict()
        self.assertAlmostEqual(
            payload["decision"]["mean_points"],
            round(decision.reported.mean_points, 4),
        )
        self.assertNotEqual(
            id(decision.reported), id(decision.chosen),
            "reported and selected are the same object",
        )

    def test_optimism_gap_is_measured_and_recorded(self):
        decision = self._decide()
        self.assertAlmostEqual(
            decision.optimism_gap,
            decision.chosen.mean_points - decision.reported.mean_points,
            places=9,
        )

    def test_single_stream_is_warned_about_not_silently_zeroed(self):
        """
        Passing one stream twice makes the gap identically zero. That reads as
        "no selection bias" when it means "not measured", so it must warn.
        """
        decision = self._decide(draws_report=self.select)
        self.assertEqual(decision.optimism_gap, 0.0)
        self.assertTrue(
            any("SAME draws" in w for w in decision.warnings),
            f"no warning raised: {decision.warnings}",
        )

    def test_shortlist_is_distinct_and_ordered(self):
        decision = self._decide(shortlist_size=4)
        squads = [tuple(sorted(e.plan.squad)) for e in decision.shortlist]
        self.assertEqual(len(set(squads)), len(squads))
        objectives = [e.objective for e in decision.shortlist]
        self.assertEqual(objectives, sorted(objectives, reverse=True))

    def test_weekly_objective_uses_the_tail(self):
        season = self._decide(objective="season")
        weekly = self._decide(objective="weekly", tail_threshold=70)

        tails = [e.tails["p_ge_70"] for e in weekly.shortlist]
        self.assertEqual(tails, sorted(tails, reverse=True))
        # Both must still be legal squads; they may or may not differ on this
        # fixture, and asserting that they differ would make the test depend on
        # the fixture's correlation structure rather than on the code.
        self.assertEqual(len(season.reported.plan.squad), RULES.squad_size)
        self.assertEqual(len(weekly.reported.plan.squad), RULES.squad_size)

    def test_held_squad_is_carried_through_every_stage(self):
        opening = self._decide()
        held = opening.reported.plan.squad

        followed = self._decide(held=held, bank=0, free_transfers=1)
        self.assertEqual(len(followed.reported.plan.squad), RULES.squad_size)
        # With one free transfer at most one player can change without a hit.
        changed = len(set(held) ^ set(followed.reported.plan.squad)) // 2
        self.assertLessEqual(changed, 1 + followed.reported.plan.hits)

    def test_price_uncertainty_is_surfaced_as_a_warning(self):
        opening = self._decide()
        held = opening.reported.plan.squad
        followed = self._decide(held=held, bank=0, purchase_prices=None)
        self.assertTrue(
            any("now_cost" in w for w in followed.warnings),
            f"unpriced holdings not warned about: {followed.warnings}",
        )

    def test_credible_flag_tracks_the_threshold(self):
        decision = self._decide()
        self.assertEqual(
            decision.credible, decision.optimism_gap <= MAX_CREDIBLE_OPTIMISM
        )


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestArtifact(unittest.TestCase):
    def setUp(self):
        self.decision = decide(
            gameweek=7, draws_select=_draws(3), draws_report=_draws(4),
            bootstrap=BOOTSTRAP, rules=RULES, xp_rows=XP_ROWS, shortlist_size=3,
        )

    def test_artifact_round_trips_as_json(self):
        """
        Serialisation is the contract with the frontend. numpy scalars survive
        a dataclass but not json.dumps, and the failure would land in CI on
        deadline day rather than here.
        """
        text = json.dumps(self.decision.as_dict(), allow_nan=False)
        payload = json.loads(text)
        self.assertEqual(payload["gameweek"], 7)
        self.assertEqual(payload["execution"], "propose_only")

    def test_public_copy_drops_counterfactuals_and_the_optimistic_score(self):
        public = strip_for_publication(self.decision)
        self.assertNotIn("runners_up", public)
        self.assertNotIn("selection_stream", public)
        self.assertIn("decision", public)

    def test_write_decision_produces_both_files(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            written = write_decision(self.decision, root, public_dir=root / "public")

            self.assertTrue(written["decision"].exists())
            self.assertTrue(written["public"].exists())
            self.assertIn("gw07", written["decision"].name)

            private = json.loads(written["decision"].read_text())
            published = json.loads(written["public"].read_text())
            self.assertIn("runners_up", private)
            self.assertNotIn("runners_up", published)


if __name__ == "__main__":
    unittest.main()


class TestSeedStreams(unittest.TestCase):
    """
    The two draw streams must be independent, and the default must not move.

    A changed default seed would silently alter every existing artifact, turning
    the reproducibility guarantee -- "a diff means a real parameter change, not a
    reseed" -- into a false claim.
    """

    def test_default_stream_is_unchanged_by_the_new_parameter(self):
        import hashlib

        from pipeline.run_pipeline import stable_seed_entropy

        for gameweek in range(1, 39):
            legacy = int.from_bytes(
                hashlib.sha256(f"2627:{gameweek}:fpl".encode()).digest()[:4], "big"
            )
            self.assertEqual(stable_seed_entropy("2627", gameweek), legacy)

    def test_streams_are_distinct(self):
        """
        Identical streams would make the optimism gap identically zero, which
        reads as "no selection bias" when it means "not measured".
        """
        from pipeline.run_pipeline import stable_seed_entropy

        for gameweek in range(1, 39):
            self.assertNotEqual(
                stable_seed_entropy("2627", gameweek),
                stable_seed_entropy("2627", gameweek, "fpl_report"),
            )


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestHorizonIntegration(unittest.TestCase):
    """The horizon must reach the artifact, or it is dead code."""

    def setUp(self):
        self.select = _draws(seed=5)
        self.report = _draws(seed=6)

    def _decide(self, **kwargs):
        params = dict(
            gameweek=1, draws_select=self.select, draws_report=self.report,
            bootstrap=BOOTSTRAP, rules=RULES, xp_rows=XP_ROWS, shortlist_size=3,
        )
        params.update(kwargs)
        return decide(**params)

    def _weekly_xp(self, weeks=4):
        """Per-week {element_id: xp}, which is the interface decide() takes."""
        return [
            {row["element_id"]: row["xp"] * (1.0 + 0.05 * w) for row in XP_ROWS}
            for w in range(weeks)
        ]

    def test_horizon_decision_records_both_horizons(self):
        decision = self._decide(xp_by_week=self._weekly_xp(4), transfer_horizon=2)
        self.assertIsNotNone(decision.horizon)
        self.assertEqual(decision.horizon["eval_horizon"], 4)
        self.assertEqual(decision.horizon["transfer_horizon"], 2)
        self.assertEqual(len(decision.horizon["provisional"]), 3)

    def test_horizon_decision_is_still_a_legal_squad(self):
        decision = self._decide(xp_by_week=self._weekly_xp(3))
        plan = decision.reported.plan
        self.assertEqual(len(plan.squad), RULES.squad_size)
        self.assertEqual(len(plan.xi), RULES.lineup_size)
        self.assertIn(plan.captain, plan.xi)

    def test_single_week_run_is_labelled_myopic(self):
        """
        A horizon-less decision must never be mistaken for a planned one. The
        absence of a horizon is recorded explicitly rather than inferred from a
        missing field.
        """
        decision = self._decide()
        self.assertIsNone(decision.horizon)
        self.assertTrue(
            any("myopic" in w for w in decision.warnings),
            f"no myopia warning: {decision.warnings}",
        )
        self.assertIsNone(decision.as_dict()["horizon"])

    def test_horizon_run_carries_no_myopia_warning(self):
        decision = self._decide(xp_by_week=self._weekly_xp(3))
        self.assertFalse(any("myopic" in w for w in decision.warnings))

    def test_artifact_serialises_with_the_horizon(self):
        decision = self._decide(xp_by_week=self._weekly_xp(3))
        payload = json.loads(json.dumps(decision.as_dict(), allow_nan=False))
        self.assertEqual(payload["horizon"]["eval_horizon"], 3)


class TestEvidenceTravelsWithTheDecision(unittest.TestCase):
    """
    A proposal that travels without its evidence invites more confidence than
    the evidence supports. The criterion the agent FAILS must be as visible as
    the one it passes — including on the public copy, which is the version most
    likely to be read.
    """

    def _payload(self):
        decision = decide(
            gameweek=3, draws_select=_draws(11), draws_report=_draws(12),
            bootstrap=BOOTSTRAP, rules=RULES, xp_rows=XP_ROWS, shortlist_size=2,
        )
        return decision.as_dict(), strip_for_publication(decision)

    def test_the_failed_criterion_is_present_and_labelled_a_failure(self):
        private, _ = self._payload()
        greedy = private["evidence"]["beats_greedy_transfers"]
        self.assertEqual(greedy["verdict"], "not established")
        self.assertLess(greedy["margin_2025_26"], 0)

    def test_the_established_claim_is_not_overstated_into_the_failed_one(self):
        private, _ = self._payload()
        self.assertEqual(
            private["evidence"]["beats_doing_nothing"]["verdict"], "established"
        )
        self.assertNotEqual(
            private["evidence"]["beats_greedy_transfers"]["verdict"], "established"
        )

    def test_evidence_survives_publication(self):
        """Stripping counterfactuals must not strip the caveats with them."""
        _, public = self._payload()
        self.assertIn("evidence", public)
        self.assertEqual(
            public["evidence"]["beats_greedy_transfers"]["verdict"], "not established"
        )

    def test_evidence_serialises(self):
        private, _ = self._payload()
        json.loads(json.dumps(private, allow_nan=False))


class TestEvidenceIsInternallyConsistent(unittest.TestCase):
    """
    The evidence block is transcribed by hand and nothing recomputes it, so the
    realistic failure is someone updating a margin after a re-run and leaving
    the verdict alone — leaving the artifact claiming an edge the numbers no
    longer support. These assert the verdicts follow from the numbers beside
    them.
    """

    def _claims(self):
        from pipeline.decide.run_decide import EVIDENCE

        return {
            k: v for k, v in EVIDENCE.items()
            if isinstance(v, dict) and "verdict" in v
        }

    def test_a_sign_flip_across_seasons_cannot_be_called_established(self):
        for name, claim in self._claims().items():
            margins = [
                claim[k] for k in ("margin_2025_26", "margin_2024_25") if k in claim
            ]
            if len(margins) == 2 and margins[0] * margins[1] < 0:
                self.assertEqual(
                    claim["verdict"], "not established",
                    f"{name} has margins {margins} of opposite sign but claims "
                    f"{claim['verdict']!r}",
                )

    def test_an_established_claim_has_no_negative_margin(self):
        for name, claim in self._claims().items():
            if claim["verdict"] != "established":
                continue
            for key in ("margin_2025_26", "margin_2024_25"):
                if key in claim:
                    self.assertGreater(
                        claim[key], 0,
                        f"{name} is called established but {key} is {claim[key]}",
                    )

    def test_every_verdict_uses_a_known_value(self):
        for name, claim in self._claims().items():
            self.assertIn(claim["verdict"], ("established", "not established"), name)

    def test_provenance_is_recorded(self):
        """Numbers with no stated origin cannot be judged stale."""
        from pipeline.decide.run_decide import EVIDENCE

        self.assertIn("measured_on", EVIDENCE)
        self.assertTrue(EVIDENCE["measured_on"]["seasons"])
        self.assertIn("backtest_decisions", EVIDENCE["measured_on"]["harness"])
