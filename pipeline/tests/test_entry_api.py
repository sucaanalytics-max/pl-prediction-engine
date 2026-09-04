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

from pipeline.fpl.entry_api import (
    EntryState,
    banked_free_transfers,
    read_entry_state,
    replay_purchase_prices,
)


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


class TestBankedFreeTransfers(unittest.TestCase):
    """
    The count FPL does not publish, derived from the history it does.

    ``read_entry_state`` returned a hardcoded 1 with a comment saying the caller
    derived the real number from the previous decision's ``free_transfers_after``.
    No caller ever did, and that derivation is wrong anyway: it assumes the human
    executed the plan, so a proposal of five transfers that the human declined
    left the agent believing one transfer had been banked when four had.

    Measured consequence on entry 20945 before this existed: the GW4 decision was
    scored with a -4 hit it would not have taken, understating its own plan by
    exactly 4.00 points.
    """

    OWNER_HISTORY = {
        # The real shape from entry 20945: nothing in GW1 or GW2, one transfer in
        # GW3 (Maguire out, Thiaw in). FPL's own app showed 2 available for GW4.
        "current": [
            {"event": 1, "event_transfers": 0},
            {"event": 2, "event_transfers": 0},
            {"event": 3, "event_transfers": 1},
        ],
        "chips": [],
    }

    def test_the_second_gameweek_starts_with_one(self):
        """GW1 transfers are unlimited, so nothing before GW2 can be banked."""
        history = {"current": [{"event": 1, "event_transfers": 14}], "chips": []}
        self.assertEqual(banked_free_transfers(history, gameweek=2, cap=5), 1)

    def test_an_unused_transfer_banks_for_the_next_gameweek(self):
        history = {"current": [{"event": 1, "event_transfers": 0},
                               {"event": 2, "event_transfers": 0}], "chips": []}
        self.assertEqual(banked_free_transfers(history, gameweek=3, cap=5), 2)

    def test_the_owner_s_history_gives_two_for_gw4(self):
        """The regression: this returned 1, and the hit it implied was not real."""
        self.assertEqual(
            banked_free_transfers(self.OWNER_HISTORY, gameweek=4, cap=5), 2
        )

    def test_a_spent_transfer_does_not_bank(self):
        history = {"current": [{"event": 1, "event_transfers": 0},
                               {"event": 2, "event_transfers": 1}], "chips": []}
        self.assertEqual(banked_free_transfers(history, gameweek=3, cap=5), 1)

    def test_banking_stops_at_the_cap(self):
        """
        The cap is a rule, not a preference: `max_extra_free_transfers` + 1 from
        bootstrap. Uncapped, an idle entry would claim transfers FPL would refuse.
        """
        history = {"current": [{"event": g, "event_transfers": 0} for g in range(1, 12)],
                   "chips": []}
        self.assertEqual(banked_free_transfers(history, gameweek=12, cap=5), 5)

    def test_taking_hits_leaves_nothing_banked(self):
        """Four transfers on one banked leaves the next gameweek with just its own."""
        history = {"current": [{"event": 1, "event_transfers": 0},
                               {"event": 2, "event_transfers": 4}], "chips": []}
        self.assertEqual(banked_free_transfers(history, gameweek=3, cap=5), 1)

    def test_a_wildcard_week_does_not_spend_the_bank(self):
        """
        A wildcard's transfers are unlimited and free, so the bank survives it.
        Counting them would silently zero a bank the manager still holds.
        """
        history = {
            "current": [{"event": 1, "event_transfers": 0},
                        {"event": 2, "event_transfers": 0},
                        {"event": 3, "event_transfers": 11}],
            "chips": [{"name": "wildcard", "event": 3}],
        }
        self.assertEqual(banked_free_transfers(history, gameweek=4, cap=5), 3)

    def test_a_bench_boost_is_not_a_transfer_chip(self):
        """Only wildcard and free hit grant transfers; the others must not exempt."""
        history = {
            "current": [{"event": 1, "event_transfers": 0},
                        {"event": 2, "event_transfers": 2}],
            "chips": [{"name": "bboost", "event": 2}],
        }
        self.assertEqual(banked_free_transfers(history, gameweek=3, cap=5), 1)


class TestReadEntryStateFreeTransfers(unittest.TestCase):
    """
    The wiring, which is where the bug actually lived.

    ``banked_free_transfers`` being right is no use while ``read_entry_state``
    returns a constant, so this asserts on the state the decision path receives.
    The three fetches are patched because they are network reads; everything
    below them is the real code.
    """

    HISTORY = {
        "current": [
            {"event": 1, "event_transfers": 0, "bank": 0},
            {"event": 2, "event_transfers": 0, "bank": 0},
            {"event": 3, "event_transfers": 1, "bank": 0},
        ],
        "chips": [],
    }
    PICKS = {
        "picks": [{"element": 1}, {"element": 445}],
        "entry_history": {"bank": 0},
    }
    TRANSFERS = [
        {"event": 3, "element_in": 445, "element_in_cost": 50, "element_out": 418}
    ]

    def test_two_banked_free_transfers_are_read_not_assumed(self):
        """Returned a hardcoded 1 here, which cost the GW4 plan a phantom -4."""
        from unittest import mock

        with (
            mock.patch("pipeline.fpl.entry_api.fetch_picks", return_value=self.PICKS),
            mock.patch(
                "pipeline.fpl.entry_api.fetch_transfers", return_value=self.TRANSFERS
            ),
            mock.patch(
                "pipeline.fpl.entry_api.fetch_history", return_value=self.HISTORY
            ),
        ):
            state = read_entry_state(
                20945, 4, {1: 60, 445: 50}, max_banked_free_transfers=5
            )

        self.assertEqual(state.free_transfers, 2)
        self.assertEqual(state.squad, [1, 445])
