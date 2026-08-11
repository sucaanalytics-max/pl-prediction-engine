"""
Tests for the candidate pool.

Exclusions here are invisible downstream — the artifact reports the best plan
over whatever the pool contained, so a wrongly dropped player leaves no trace in
any counterfactual. These tests therefore assert what is KEPT at least as hard
as what is dropped.

The selling-price tests use a first sale several gameweeks after purchase. At the
moment of purchase, price paid equals current price, so a buy/sell mix-up is
invisible; the bug only shows once the price has moved.
"""
from __future__ import annotations

import unittest

from pipeline.decide.pool import UNSELECTABLE_STATUS, build_pool, positions_of, xp_of
from pipeline.fpl.rules import load_rules

RULES = load_rules()

TEAMS = [
    {"id": 1, "name": "Arsenal"},
    {"id": 2, "name": "Chelsea"},
]
ELEMENT_TYPES = [
    {"id": 1, "singular_name_short": "GKP"},
    {"id": 2, "singular_name_short": "DEF"},
    {"id": 3, "singular_name_short": "MID"},
    {"id": 4, "singular_name_short": "FWD"},
]


def _element(element_id, element_type=3, team=1, now_cost=60, status="a"):
    return {
        "id": element_id, "element_type": element_type, "team": team,
        "now_cost": now_cost, "status": status,
    }


def _bootstrap(elements):
    return {"teams": TEAMS, "element_types": ELEMENT_TYPES, "elements": elements}


def _xp(rows):
    return [{"element_id": e, "xp": v} for e, v in rows]


class TestBuildPool(unittest.TestCase):
    def test_available_players_are_kept(self):
        pool, report = build_pool(
            _xp([(1, 5.0), (2, 3.0)]),
            _bootstrap([_element(1), _element(2)]),
            RULES,
        )
        self.assertEqual({c.element_id for c in pool}, {1, 2})
        self.assertEqual(report.n_excluded, 0)

    def test_injured_and_doubtful_are_kept(self):
        """
        The minutes model already prices availability. Filtering here would
        double-count it, and a player injured this week is often the correct buy
        for next week.
        """
        pool, _ = build_pool(
            _xp([(1, 1.0), (2, 1.0), (3, 1.0)]),
            _bootstrap([
                _element(1, status="i"), _element(2, status="d"), _element(3, status="s"),
            ]),
            RULES,
        )
        self.assertEqual({c.element_id for c in pool}, {1, 2, 3})

    def test_unselectable_status_is_dropped(self):
        for status in sorted(UNSELECTABLE_STATUS):
            pool, report = build_pool(
                _xp([(1, 5.0)]), _bootstrap([_element(1, status=status)]), RULES,
            )
            self.assertEqual(pool, [], f"status {status!r} should be unselectable")
            self.assertEqual(report.n_excluded, 1)

    def test_held_player_survives_every_filter(self):
        """
        A held player missing from the pool makes the MILP unable to represent
        the current squad, and the transfer arithmetic treats him as sold.
        """
        pool, _ = build_pool(
            _xp([(1, 0.0)]),
            _bootstrap([_element(1, status="u")]),
            RULES,
            held=[1],
        )
        self.assertEqual([c.element_id for c in pool], [1])
        self.assertTrue(pool[0].owned)

    def test_held_player_absent_from_bootstrap_raises(self):
        with self.assertRaises(ValueError):
            build_pool(_xp([(1, 5.0)]), _bootstrap([_element(1)]), RULES, held=[999])

    def test_player_missing_from_xp_is_kept_at_zero(self):
        """
        Absent from the projection is not absent from the game. Dropping him
        would remove a real footballer from every counterfactual; scoring him at
        zero keeps him selectable and lets the objective decline him.
        """
        pool, report = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1), _element(2)]), RULES,
        )
        self.assertEqual({c.element_id for c in pool}, {1, 2})
        self.assertEqual(report.n_zero_xp, 1)
        self.assertEqual([c.xp for c in pool if c.element_id == 2], [0.0])

    def test_priceless_player_is_dropped(self):
        pool, report = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=0)]), RULES,
        )
        self.assertEqual(pool, [])
        self.assertEqual(report.excluded_by_reason.get("no_price"), 1)


class TestSellingPrice(unittest.TestCase):
    def test_unheld_player_sells_at_current_price(self):
        pool, _ = build_pool(_xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=75)]), RULES)
        self.assertEqual(pool[0].buy_price, 75)
        self.assertEqual(pool[0].sell_price, 75)

    def test_risen_player_sells_for_half_the_rise(self):
        """
        Bought at 60, now 65: FPL returns 60 + floor(5 * 0.5) = 62, not 65.
        Using now_cost would hand the solver 0.3m it does not have.
        """
        pool, report = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=65)]), RULES,
            held=[1], purchase_prices={1: 60},
        )
        self.assertEqual(pool[0].buy_price, 65)
        self.assertEqual(pool[0].sell_price, 62)
        self.assertFalse(report.price_uncertain)

    def test_odd_rise_rounds_against_the_manager(self):
        """A 0.3m rise returns 0.1m, not 0.15m — FPL rounds down."""
        pool, _ = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=63)]), RULES,
            held=[1], purchase_prices={1: 60},
        )
        self.assertEqual(pool[0].sell_price, 61)

    def test_fallen_player_passes_the_fall_on_in_full(self):
        pool, _ = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=55)]), RULES,
            held=[1], purchase_prices={1: 60},
        )
        self.assertEqual(pool[0].sell_price, 55)

    def test_missing_purchase_price_is_flagged_not_fatal(self):
        """
        Refusing to solve is not safer than solving with a declared uncertainty
        — it just means no decision at all on deadline day.
        """
        pool, report = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=65)]), RULES, held=[1],
        )
        self.assertEqual(pool[0].sell_price, 65)
        self.assertTrue(report.price_uncertain)
        self.assertEqual(report.held_missing_purchase_price, [1])

    def test_selling_price_never_exceeds_now_cost(self):
        """The invariant purchase <= selling <= now_cost, over a range of rises."""
        for now_cost in range(50, 90):
            pool, _ = build_pool(
                _xp([(1, 5.0)]), _bootstrap([_element(1, now_cost=now_cost)]), RULES,
                held=[1], purchase_prices={1: 60},
            )
            sell = pool[0].sell_price
            self.assertLessEqual(sell, max(60, now_cost))
            if now_cost >= 60:
                self.assertGreaterEqual(sell, 60)


class TestPoolMetadata(unittest.TestCase):
    def test_positions_are_normalised(self):
        pool, _ = build_pool(
            _xp([(i, 1.0) for i in range(1, 5)]),
            _bootstrap([_element(i, element_type=i) for i in range(1, 5)]),
            RULES,
        )
        self.assertEqual(
            [c.position for c in sorted(pool, key=lambda c: c.element_id)],
            ["GKP", "DEF", "MID", "FWD"],
        )

    def test_team_names_are_canonicalised(self):
        pool, _ = build_pool(
            _xp([(1, 1.0)]), _bootstrap([_element(1, team=2)]), RULES,
        )
        self.assertEqual(pool[0].team, "Chelsea")

    def test_unknown_element_type_is_dropped(self):
        pool, report = build_pool(
            _xp([(1, 5.0)]), _bootstrap([_element(1, element_type=99)]), RULES,
        )
        self.assertEqual(pool, [])
        self.assertEqual(report.excluded_by_reason.get("unusable_position"), 1)

    def test_held_player_with_unusable_position_raises(self):
        with self.assertRaises(ValueError):
            build_pool(
                _xp([(1, 5.0)]), _bootstrap([_element(1, element_type=99)]), RULES,
                held=[1],
            )

    def test_lookups_cover_the_whole_pool(self):
        pool, _ = build_pool(
            _xp([(1, 5.0), (2, 3.0)]), _bootstrap([_element(1), _element(2)]), RULES,
        )
        self.assertEqual(set(positions_of(pool)), {1, 2})
        self.assertEqual(xp_of(pool), {1: 5.0, 2: 3.0})


if __name__ == "__main__":
    unittest.main()
