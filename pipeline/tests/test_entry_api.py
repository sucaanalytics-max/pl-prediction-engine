"""
Tests for reading a manager's own team.

The load-bearing test is ``test_transfers_replay_oldest_first``. The API returns
transfers newest first; replaying in that order applies a later sale before the
purchase it depends on, quietly corrupting the price basis of anyone transferred
more than once — and the result still looks like a plausible squad.

The plan's own guidance: use a first sale several gameweeks after purchase,
because at the moment of purchase paid == current and a mix-up is invisible.
"""
from __future__ import annotations

import unittest

from pipeline.fpl.entry_api import EntryState, replay_purchase_prices


class TestReplayPurchasePrices(unittest.TestCase):
    def test_an_untouched_opening_squad_keeps_its_opening_prices(self):
        prices = replay_purchase_prices([1, 2, 3], {1: 50, 2: 60, 3: 70}, [])
        self.assertEqual(prices, {1: 50, 2: 60, 3: 70})

    def test_a_purchase_is_recorded_at_the_price_paid(self):
        """
        element_in_cost is the price AT THE TIME, which is the whole reason the
        transfer log has to be replayed rather than read off now_cost.
        """
        prices = replay_purchase_prices(
            [1, 2], {1: 50, 2: 60},
            [{"event": 5, "element_out": 2, "element_in": 9, "element_in_cost": 75}],
        )
        self.assertEqual(prices[9], 75)
        self.assertNotIn(2, prices)

    def test_transfers_replay_oldest_first(self):
        """
        The API returns newest first. Replaying in that order applies the GW10
        sale of player 9 before the GW5 purchase that created him, so he ends up
        in the squad with a stale basis — a plausible-looking wrong answer.
        """
        newest_first = [
            {"event": 10, "element_out": 9, "element_in": 12, "element_in_cost": 90},
            {"event": 5, "element_out": 2, "element_in": 9, "element_in_cost": 75},
        ]
        prices = replay_purchase_prices([1, 2], {1: 50, 2: 60}, newest_first)

        self.assertNotIn(9, prices, "a sold player survived the replay")
        self.assertEqual(prices[12], 90)
        self.assertEqual(prices[1], 50)

    def test_a_rebought_player_uses_his_most_recent_purchase(self):
        """
        Bought at 75, sold, bought again at 95. The basis is 95 — the old one
        would understate his sell-on fee for the rest of the season.
        """
        prices = replay_purchase_prices(
            [1], {1: 50},
            [
                {"event": 3, "element_out": 1, "element_in": 9, "element_in_cost": 75},
                {"event": 6, "element_out": 9, "element_in": 4, "element_in_cost": 60},
                {"event": 9, "element_out": 4, "element_in": 9, "element_in_cost": 95},
            ],
        )
        self.assertEqual(prices[9], 95)

    def test_ties_on_event_are_broken_by_time(self):
        """Two transfers in one gameweek must still replay in the order made."""
        prices = replay_purchase_prices(
            [1, 2], {1: 50, 2: 60},
            [
                {"event": 4, "time": "2026-09-01T12:00:00Z",
                 "element_out": 2, "element_in": 9, "element_in_cost": 70},
                {"event": 4, "time": "2026-09-01T09:00:00Z",
                 "element_out": 1, "element_in": 8, "element_in_cost": 65},
            ],
        )
        self.assertEqual(prices, {8: 65, 9: 70})


class TestEntryState(unittest.TestCase):
    def test_an_empty_state_is_an_opening_build_not_an_error(self):
        """
        Before a season starts there is nothing to read. That is GW1, which is
        a valid state — treating it as a failure would block the first decision
        of the year.
        """
        state = EntryState(entry_id=1, gameweek=1)
        self.assertEqual(state.squad, [])
        self.assertFalse(state.price_uncertain)

    def test_untraceable_purchases_are_flagged_not_hidden(self):
        state = EntryState(entry_id=1, gameweek=5, squad=[1, 2], untraced=[2])
        self.assertTrue(state.price_uncertain)
        self.assertIn("untraced", state.as_dict())
        self.assertEqual(state.as_dict()["untraced"], [2])

    def test_state_serialises(self):
        import json

        state = EntryState(
            entry_id=2561567, gameweek=3, squad=[1, 2],
            bank=15, purchase_prices={1: 50, 2: 60},
        )
        payload = json.loads(json.dumps(state.as_dict(), allow_nan=False))
        self.assertEqual(payload["entry_id"], 2561567)
        self.assertEqual(payload["bank"], 15)


class TestConfiguredEntries(unittest.TestCase):
    def test_the_owner_entry_is_configured(self):
        """
        This repo decides for exactly one account now: the owner's. Ronny and
        Wazza moved to their own project (see pipeline/config.py).
        """
        from pipeline.config import FPL_ENTRIES

        ids = {label: cfg["entry_id"] for label, cfg in FPL_ENTRIES.items()}
        self.assertEqual(set(ids), {"owner"})
        self.assertIsInstance(ids["owner"], int)
        self.assertGreater(ids["owner"], 0)

    def test_the_owner_s_objective_is_season(self):
        from pipeline.config import FPL_ENTRIES

        self.assertEqual(FPL_ENTRIES["owner"]["objective"], "season")
