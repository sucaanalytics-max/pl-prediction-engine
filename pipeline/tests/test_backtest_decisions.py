"""
Tests for the season backtest.

The risk here is not a crash — it is a backtest that runs cleanly and reports a
flattering number. So these target the accounting that would inflate a result:
selling prices, the paired comparison, and scoring against real outcomes rather
than against the projection that chose the squad.
"""
from __future__ import annotations

import unittest

import numpy as np

from pipeline.fpl.rules import load_rules
from pipeline.learning.backtest_decisions import (
    GameweekOutcome,
    SeasonState,
    StrategyResult,
    advance,
    compare,
    sell_prices,
)

RULES = load_rules()


class _Plan:
    """Minimal stand-in for a solver Plan."""

    def __init__(self, squad, ins=(), outs=(), bank_after=0, ft_after=1):
        self.squad = list(squad)
        self.xi = list(squad)[:11]
        self.captain = self.xi[0]
        self.vice = self.xi[1]
        self.transfers_in = list(ins)
        self.transfers_out = list(outs)
        self.hits = 0
        self.bank_after = bank_after
        self.free_transfers_after = ft_after
        self.free_transfers_banked = 0


class TestSellPrices(unittest.TestCase):
    def test_risen_player_sells_for_half_the_rise(self):
        state = SeasonState(squad=[1], purchase_prices={1: 60})
        self.assertEqual(sell_prices(state, {1: 66}, RULES)[1], 63)

    def test_fall_is_passed_on_in_full(self):
        state = SeasonState(squad=[1], purchase_prices={1: 60})
        self.assertEqual(sell_prices(state, {1: 54}, RULES)[1], 54)

    def test_unknown_purchase_falls_back_to_current_price(self):
        state = SeasonState(squad=[1], purchase_prices={})
        self.assertEqual(sell_prices(state, {1: 70}, RULES)[1], 70)


class TestAdvance(unittest.TestCase):
    def test_purchase_price_is_recorded_for_incoming_players(self):
        """
        Without this the next sale is priced off nothing, and the bank drifts
        further from the truth with every transfer.
        """
        state = SeasonState(squad=[1, 2], purchase_prices={1: 50, 2: 60})
        plan = _Plan([1, 3], ins=[3], outs=[2], bank_after=5)
        after = advance(state, plan, {3: 75}, RULES)
        self.assertEqual(after.purchase_prices[3], 75)

    def test_sold_player_loses_his_price_basis(self):
        """A player rebought later starts a fresh basis, not the old one."""
        state = SeasonState(squad=[1, 2], purchase_prices={1: 50, 2: 60})
        after = advance(state, _Plan([1, 3], ins=[3], outs=[2]), {3: 75}, RULES)
        self.assertNotIn(2, after.purchase_prices)

    def test_state_is_not_mutated_in_place(self):
        """
        Strategies share a starting state. In-place mutation would let one
        strategy's transfers leak into another's season.
        """
        state = SeasonState(squad=[1, 2], purchase_prices={1: 50, 2: 60}, bank=10)
        advance(state, _Plan([1, 3], ins=[3], outs=[2], bank_after=99), {3: 75}, RULES)
        self.assertEqual(state.squad, [1, 2])
        self.assertEqual(state.bank, 10)
        self.assertIn(2, state.purchase_prices)


class TestCompare(unittest.TestCase):
    def _result(self, name, points):
        r = StrategyResult(name=name)
        for i, p in enumerate(points):
            r.weeks.append(GameweekOutcome(
                gameweek=i + 1, points=p, hits=0, transfers=0, captain=1,
                captain_points=0, autosubs=0, vice_used=False, bench_points=0,
            ))
        return r

    def test_margin_is_the_paired_difference(self):
        a = self._result("a", [50, 60, 70])
        b = self._result("b", [40, 55, 80])
        c = compare(a, b)
        self.assertEqual(c["total_margin"], 5.0)
        self.assertEqual(c["weeks_ahead"], 2)
        self.assertEqual(c["weeks_behind"], 1)

    def test_identical_strategies_have_zero_margin_and_zero_error(self):
        """
        Shared projections mean identical decisions must score identically. A
        non-zero margin here would mean the comparison is unpaired, and every
        reported difference would be contaminated by simulation noise.
        """
        a = self._result("a", [50, 60, 70])
        b = self._result("b", [50, 60, 70])
        c = compare(a, b)
        self.assertEqual(c["total_margin"], 0.0)
        self.assertEqual(c["se_per_gameweek"], 0.0)

    def test_unequal_lengths_are_truncated_not_padded(self):
        """
        Padding a short season with zeros would credit the longer strategy with
        points it never scored.
        """
        c = compare(self._result("a", [10, 10, 10]), self._result("b", [5, 5]))
        self.assertEqual(c["n"], 2)
        self.assertEqual(c["total_margin"], 10.0)

    def test_empty_comparison_is_safe(self):
        self.assertEqual(compare(self._result("a", []), self._result("b", []))["n"], 0)


class TestDecomposition(unittest.TestCase):
    def test_margin_decomposes_into_named_sources(self):
        """
        The plan requires a margin to be explainable, not merely quoted. Hits
        are reported as a negative cost so the components read in the same
        direction as the total.
        """
        r = StrategyResult(name="x")
        r.weeks.append(GameweekOutcome(
            gameweek=1, points=50, hits=2, transfers=3, captain=7,
            captain_points=12, autosubs=1, vice_used=True, bench_points=4,
        ))
        d = r.decomposition()
        self.assertEqual(d["captain_points"], 12)
        self.assertEqual(d["hits_cost"], -8)
        self.assertEqual(d["transfers"], 3)
        self.assertEqual(d["vice_used"], 1)
