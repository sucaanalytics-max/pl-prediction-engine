"""
Tests for the simulator adjudication stage.

The load-bearing test is ``test_fast_path_equals_score_squad``. ``evaluate_plan``
scores most draws with a vectorised sum and the rest through the exact autosub
resolver, on the argument that the two are identical when all eleven starters
appear. If that argument is wrong, most of every distribution is computed by
code that never runs in a test — so it is asserted draw for draw against the
resolver rather than reasoned about.
"""
from __future__ import annotations

import unittest
from dataclasses import dataclass, field
from typing import Dict, List

import numpy as np

from pipeline.decide.milp import Plan
from pipeline.decide.plan_eval import (
    TAIL_THRESHOLDS,
    adjudicate,
    evaluate_plan,
    order_bench,
    reranked,
)
from pipeline.fpl.autosub import score_squad
from pipeline.fpl.rules import load_rules

RULES = load_rules()

# A legal 3-4-3 plus a bench of keeper, defender, midfielder, forward.
XI = [1, 11, 12, 13, 21, 22, 23, 24, 31, 32, 33]
BENCH = [2, 14, 25, 34]
SQUAD = XI + BENCH
POSITIONS: Dict[int, str] = {
    1: "GKP", 2: "GKP",
    11: "DEF", 12: "DEF", 13: "DEF", 14: "DEF",
    21: "MID", 22: "MID", 23: "MID", 24: "MID", 25: "MID",
    31: "FWD", 32: "FWD", 33: "FWD", 34: "FWD",
}
XP = {p: 5.0 - 0.1 * i for i, p in enumerate(SQUAD)}


@dataclass
class FakeDraws:
    """Minimal stand-in for GameweekDraws: the two matrices plan_eval reads."""

    element_ids: List[int]
    points: np.ndarray
    minutes: np.ndarray
    gameweek: int = 1


def _plan(hits: int = 0, banked: int = 0, captain: int = 31, vice: int = 21) -> Plan:
    return Plan(
        squad=list(SQUAD), xi=list(XI), captain=captain, vice=vice,
        transfers_in=[], transfers_out=[], hits=hits, bank_after=0,
        objective=0.0, free_transfers_banked=banked, free_transfers_after=1,
    )


def _draws(n: int = 400, seed: int = 11, force_absence: bool = True) -> FakeDraws:
    """
    Random but reproducible draws.

    ``force_absence`` guarantees a healthy share of draws where a starter does
    not appear. Without it a seeded sample can easily contain none, and the
    autosub path -- the entire reason this module exists -- would go untested
    while the suite stayed green.
    """
    rng = np.random.default_rng(seed)
    points = rng.integers(0, 14, size=(n, len(SQUAD))).astype(np.int64)
    # Baseline minutes start at 1 so that absence is introduced ONLY by the
    # block below. Allowing a random zero here would put a stray vice-captaincy
    # fallback into fixtures meant to isolate a different effect.
    minutes = rng.integers(1, 91, size=(n, len(SQUAD))).astype(np.int32)
    if force_absence:
        # Roughly a third of draws lose one to three starters.
        for d in range(0, n, 3):
            for i in rng.choice(len(XI), size=rng.integers(1, 4), replace=False):
                minutes[d, i] = 0
                points[d, i] = 0
    return FakeDraws(element_ids=list(SQUAD), points=points, minutes=minutes)


class TestBenchOrder(unittest.TestCase):
    def test_keeper_is_first(self):
        """Slot 12 is the reserve keeper: FPL fixes this, it is not a choice."""
        order = order_bench(_plan(), POSITIONS, XP)
        self.assertEqual(POSITIONS[order[0]], "GKP")

    def test_outfield_sorted_by_expected_points(self):
        order = order_bench(_plan(), POSITIONS, XP)
        outfield = order[1:]
        values = [XP[p] for p in outfield]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_bench_is_exactly_the_non_starters(self):
        order = order_bench(_plan(), POSITIONS, XP)
        self.assertEqual(sorted(order), sorted(BENCH))

    def test_order_is_deterministic_under_ties(self):
        """Equal xp must not produce a different bench on different runs."""
        flat = {p: 1.0 for p in SQUAD}
        first = order_bench(_plan(), POSITIONS, flat)
        second = order_bench(_plan(), POSITIONS, flat)
        self.assertEqual(first, second)


class TestEvaluatePlan(unittest.TestCase):
    def _exact(self, draws, plan, chip=None):
        """Every draw forced through the resolver — the oracle for the fast path."""
        bench = order_bench(plan, POSITIONS, XP)
        column = {e: i for i, e in enumerate(draws.element_ids)}
        return [
            score_squad(
                XI, bench, plan.captain, plan.vice, POSITIONS,
                {p: int(draws.points[d, column[p]]) for p in SQUAD},
                {p: bool(draws.minutes[d, column[p]] >= 1) for p in SQUAD},
                rules=RULES, chip=chip, transfer_cost=4 * plan.hits,
            ).total
            for d in range(draws.points.shape[0])
        ]

    def test_fast_path_equals_score_squad(self):
        """
        The vectorised path and the exact resolver must agree on every draw.

        Any divergence means the fast path is scoring a different team than the
        resolver would, for the majority of draws, invisibly.
        """
        draws = _draws()
        plan = _plan()
        expected = self._exact(draws, plan)

        result = evaluate_plan(plan, draws, POSITIONS, rules=RULES, xp=XP)
        self.assertAlmostEqual(result.mean_points, float(np.mean(expected)), places=9)
        self.assertAlmostEqual(
            result.sd_points, float(np.std(expected, ddof=1)), places=9
        )

    def test_fast_path_equals_score_squad_under_every_chip(self):
        """
        The same equivalence must hold with a chip active, and it does not hold
        via the fast path: Bench Boost counts all fifteen and Triple Captain
        multiplies by three, neither of which a plain XI sum expresses.

        Without this test the chip was silently dropped for every draw in which
        all eleven starters appeared -- most of them -- so a Bench Boost week
        scored 54.5 against a true 60.5, understating the bench that is the
        entire point of the chip, and the agent would have ranked playing it as
        strictly worse than not playing it.
        """
        draws = _draws()
        plan = _plan()
        for chip in (None, "3xc", "bboost"):
            with self.subTest(chip=chip):
                expected = float(np.mean(self._exact(draws, plan, chip=chip)))
                result = evaluate_plan(
                    plan, draws, POSITIONS, rules=RULES, xp=XP, chip=chip
                )
                self.assertAlmostEqual(result.mean_points, expected, places=9)

    def test_bench_boost_is_worth_more_than_no_chip(self):
        """
        A directional sanity check independent of the resolver: counting four
        extra players cannot lower the score. This would have failed on the old
        code, which dropped the bench on most draws.
        """
        draws = _draws()
        plain = evaluate_plan(_plan(), draws, POSITIONS, rules=RULES, xp=XP)
        boosted = evaluate_plan(
            _plan(), draws, POSITIONS, rules=RULES, xp=XP, chip="bboost"
        )
        self.assertGreater(boosted.mean_points, plain.mean_points)

    def test_triple_captain_adds_exactly_one_more_captain_share(self):
        """
        With everyone appearing, 3xc minus 2x is exactly the captain's mean.
        Anything else means the multiplier is being applied inconsistently
        across the two scoring paths.
        """
        draws = _draws(force_absence=False)
        column = {e: i for i, e in enumerate(draws.element_ids)}
        plain = evaluate_plan(_plan(captain=31), draws, POSITIONS, rules=RULES, xp=XP)
        tripled = evaluate_plan(
            _plan(captain=31), draws, POSITIONS, rules=RULES, xp=XP, chip="3xc"
        )
        self.assertAlmostEqual(
            tripled.mean_points - plain.mean_points,
            float(draws.points[:, column[31]].mean()),
            places=9,
        )

    def test_autosub_path_is_actually_exercised(self):
        """
        A green suite that never entered the slow path would prove nothing about
        it. Assert the fixture really does produce substitutions.
        """
        result = evaluate_plan(_plan(), _draws(), POSITIONS, rules=RULES, xp=XP)
        self.assertGreater(result.autosub_rate, 0.05)

    def test_captain_is_doubled(self):
        """
        Two plans identical but for the armband must differ by exactly the
        captain's expected points, since everything else is common.
        """
        draws = _draws(force_absence=False)
        column = {e: i for i, e in enumerate(draws.element_ids)}

        a = evaluate_plan(_plan(captain=31), draws, POSITIONS, rules=RULES, xp=XP)
        b = evaluate_plan(_plan(captain=32), draws, POSITIONS, rules=RULES, xp=XP)

        delta = draws.points[:, column[31]].mean() - draws.points[:, column[32]].mean()
        self.assertAlmostEqual(a.mean_points - b.mean_points, float(delta), places=9)

    def test_vice_takes_over_when_captain_is_absent(self):
        """The armband moves only on a complete no-show, never on a cameo."""
        draws = _draws(n=50, force_absence=False)
        column = {e: i for i, e in enumerate(draws.element_ids)}
        # Captain absent in every draw.
        draws.minutes[:, column[31]] = 0
        draws.points[:, column[31]] = 0

        result = evaluate_plan(_plan(captain=31, vice=21), draws, POSITIONS,
                               rules=RULES, xp=XP)
        self.assertEqual(result.vice_rate, 1.0)

        # A one-minute cameo keeps the armband with the captain.
        draws.minutes[:, column[31]] = 1
        cameo = evaluate_plan(_plan(captain=31, vice=21), draws, POSITIONS,
                              rules=RULES, xp=XP)
        self.assertEqual(cameo.vice_rate, 0.0)

    def test_hit_is_subtracted_exactly_once(self):
        draws = _draws(force_absence=False)
        clean = evaluate_plan(_plan(hits=0), draws, POSITIONS, rules=RULES, xp=XP)
        hit = evaluate_plan(_plan(hits=1), draws, POSITIONS, rules=RULES, xp=XP)
        self.assertAlmostEqual(clean.mean_points - hit.mean_points, 4.0, places=9)

    def test_hit_does_not_change_the_spread(self):
        """A hit is a constant, so it shifts the distribution without widening it."""
        draws = _draws()
        clean = evaluate_plan(_plan(hits=0), draws, POSITIONS, rules=RULES, xp=XP)
        hit = evaluate_plan(_plan(hits=2), draws, POSITIONS, rules=RULES, xp=XP)
        self.assertAlmostEqual(clean.sd_points, hit.sd_points, places=9)

    def test_banked_transfers_lift_objective_not_points(self):
        """
        Banked value is a modelling assumption, so it must never leak into the
        reported points -- otherwise the agent would publish a score it cannot
        actually achieve.
        """
        draws = _draws()
        none = evaluate_plan(_plan(banked=0), draws, POSITIONS, rules=RULES, xp=XP)
        some = evaluate_plan(_plan(banked=2), draws, POSITIONS, rules=RULES, xp=XP)

        self.assertAlmostEqual(none.mean_points, some.mean_points, places=9)
        self.assertGreater(some.objective, none.objective)

    def test_absent_player_raises(self):
        """
        A squad member missing from the draws must raise, not score zero. Zero
        would convert a real footballer into a guaranteed blank.
        """
        draws = _draws()
        draws.element_ids = list(SQUAD)
        plan = _plan()
        plan.squad = plan.squad[:-1] + [999]
        with self.assertRaises(KeyError):
            evaluate_plan(plan, draws, POSITIONS, rules=RULES, xp=XP)

    def test_quantiles_are_ordered(self):
        result = evaluate_plan(_plan(), _draws(), POSITIONS, rules=RULES, xp=XP)
        values = [result.quantiles[k] for k in ("q10", "q25", "q50", "q75", "q90", "q99")]
        self.assertEqual(values, sorted(values))

    def test_tails_are_non_increasing_in_threshold(self):
        """P(X >= a) must be at least P(X >= b) for a < b, by definition."""
        result = evaluate_plan(_plan(), _draws(), POSITIONS, rules=RULES, xp=XP)
        values = [result.tails[f"p_ge_{t}"] for t in TAIL_THRESHOLDS]
        for higher, lower in zip(values, values[1:]):
            self.assertGreaterEqual(higher, lower)


class TestAdjudicate(unittest.TestCase):
    def setUp(self):
        self.draws = _draws()

    def test_season_ranks_on_expected_points(self):
        plans = [_plan(captain=31), _plan(captain=32), _plan(captain=33)]
        ranked = adjudicate(plans, self.draws, POSITIONS, rules=RULES, xp=XP)
        objectives = [e.objective for e in ranked]
        self.assertEqual(objectives, sorted(objectives, reverse=True))

    def test_weekly_ranks_on_the_tail_not_the_mean(self):
        """
        The two objectives are different functionals, so the ranking key must
        actually be the tail. Verified by checking the returned order is sorted
        by p_ge_threshold, which is the property the season ranking lacks.
        """
        plans = [_plan(captain=31), _plan(captain=32), _plan(captain=33)]
        ranked = adjudicate(
            plans, self.draws, POSITIONS, rules=RULES, xp=XP,
            objective="weekly", tail_threshold=70,
        )
        tails = [e.tails["p_ge_70"] for e in ranked]
        self.assertEqual(tails, sorted(tails, reverse=True))

    def test_uncomputed_tail_threshold_raises(self):
        with self.assertRaises(ValueError):
            adjudicate(
                [_plan()], self.draws, POSITIONS, rules=RULES, xp=XP,
                objective="weekly", tail_threshold=12345,
            )

    def test_unknown_objective_raises(self):
        with self.assertRaises(ValueError):
            adjudicate([_plan()], self.draws, POSITIONS, rules=RULES,
                       xp=XP, objective="vibes")

    def test_empty_plan_list_raises(self):
        with self.assertRaises(ValueError):
            adjudicate([], self.draws, POSITIONS, rules=RULES, xp=XP)

    def test_all_plans_share_the_same_draws(self):
        """
        Common random numbers: evaluating the same plan twice must give exactly
        the same number. If it did not, plan differences would be contaminated
        by simulation noise and the ranking would be partly random.
        """
        first = evaluate_plan(_plan(), self.draws, POSITIONS, rules=RULES, xp=XP)
        second = evaluate_plan(_plan(), self.draws, POSITIONS, rules=RULES, xp=XP)
        self.assertEqual(first.mean_points, second.mean_points)

    def test_reranked_detects_disagreement(self):
        same = [_plan()]
        evaluations = adjudicate(same, self.draws, POSITIONS, rules=RULES, xp=XP)
        self.assertFalse(reranked(same, evaluations))

        other = _plan()
        other.squad = [999] + SQUAD[1:]
        self.assertTrue(reranked([other], evaluations))


if __name__ == "__main__":
    unittest.main()
