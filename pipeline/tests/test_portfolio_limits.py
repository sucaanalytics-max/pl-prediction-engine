"""
The portfolio caps, on the path that sizes real money.

## The measured defect

`check_portfolio_exposure` was complete, correct, and had **no callers**. Nothing
in the pipeline applied a portfolio cap, so the published card was bounded only by
the 5% per-selection `max_stake_pct`.

Measured on the committed 4.1.0 artifact: **14 selections at 2.5% each, 35% of
bankroll live at once.** Replaying that card through the per-match, per-team and
per-market-type limits reduced nothing — the worst fixture held 7.5% against a 15%
cap. The limits were not too loose; the aggregate they were meant to bound did not
exist.

Two things were missing, both about correlation:

* **No total.** 14 selections gave 35%; 30 would have given 75%. Per-bet caps do
  not compose into a portfolio cap.
* **Correlated positions summed as independent.** 12.5% of bank sat on UNDER
  across five fixtures — one bet on a low-scoring weekend, not five independent
  ones. And `Under 2.5` + `Under 3.5` on the same match is not two views; the
  first winning implies the second winning.

## What these tests hold

The direction. Every assertion here is that a cap **reduces** — never that it
permits. A test that pins an exact stake would have to be edited to widen sizing,
which is the one edit this file exists to make expensive.
"""

from __future__ import annotations

import copy
import unittest

from pipeline.config import RISK
from pipeline.risk.kelly import (
    PORTFOLIO_LIMITS,
    apply_portfolio_limits,
    bet_direction,
    check_portfolio_exposure,
    nesting_key,
)

BANK = 1000.0


def bet(market, market_type, edge=0.10, stake=25.0):
    """One selection at the per-bet half-Kelly cap (2.5% of a 1000 bank)."""
    return {
        "market": market, "market_type": market_type, "edge": edge,
        "half_kelly": stake, "full_kelly": stake * 2,
        "half_kelly_pct": stake / BANK, "full_kelly_pct": stake * 2 / BANK,
    }


def card(*specs):
    """Build a predictions list: each spec is (home, away, [bets])."""
    return [
        {"fixture": {"home_team": home, "away_team": away},
         "value_bets": list(bets)}
        for home, away, bets in specs
    ]


def exposure(predictions):
    return sum(
        b["half_kelly_pct"]
        for p in predictions for b in p.get("value_bets") or []
    )


class GroupingTests(unittest.TestCase):
    """Which selections are treated as one position."""

    def test_two_unders_on_one_match_share_a_nesting_key(self):
        a = {**bet("Under 2.5 Goals", "over_under"), "match": "A v B"}
        b = {**bet("Under 3.5 Goals", "over_under"), "match": "A v B"}
        self.assertEqual(nesting_key(a), nesting_key(b))

    def test_an_over_and_an_under_are_not_nested(self):
        a = {**bet("Under 2.5 Goals", "over_under"), "match": "A v B"}
        b = {**bet("Over 2.5 Goals", "over_under"), "match": "A v B"}
        self.assertNotEqual(nesting_key(a), nesting_key(b))

    def test_the_same_line_on_two_matches_is_not_nested(self):
        # Correlated, yes — the direction cap handles that. Not nested: one match
        # going under says nothing logical about another.
        a = {**bet("Under 2.5 Goals", "over_under"), "match": "A v B"}
        b = {**bet("Under 2.5 Goals", "over_under"), "match": "C v D"}
        self.assertNotEqual(nesting_key(a), nesting_key(b))

    def test_the_same_direction_across_matches_shares_a_direction(self):
        a = {**bet("Under 2.5 Goals", "over_under"), "match": "A v B"}
        b = {**bet("Under 3.5 Goals", "over_under"), "match": "C v D"}
        self.assertEqual(bet_direction(a), bet_direction(b))

    def test_a_home_win_and_an_under_are_different_factors(self):
        # Both "one direction", but not the same one. Grouping them would cap two
        # genuinely different views against a single budget.
        self.assertNotEqual(
            bet_direction({**bet("Home Win", "1x2"), "match": "A v B"}),
            bet_direction({**bet("Under 2.5 Goals", "over_under"), "match": "A v B"}),
        )

    def test_a_market_with_no_direction_returns_none(self):
        self.assertIsNone(bet_direction({**bet("BTTS Yes", "btts"), "match": "A v B"}))
        self.assertIsNone(nesting_key({**bet("BTTS Yes", "btts"), "match": "A v B"}))

    def test_an_unnamed_market_does_not_crash_the_grouper(self):
        # The staking path runs unattended; a market string the parser has never
        # seen must yield "no group", not an exception.
        for odd in ({}, {"market": None}, {"market": "", "market_type": None}):
            self.assertIsNone(nesting_key(odd))
            self.assertIsNone(bet_direction(odd))


class TotalExposureTests(unittest.TestCase):
    """The cap whose absence made the others moot."""

    def test_the_total_cap_exists(self):
        # Its absence WAS the defect. Deleting the key should fail loudly here
        # rather than quietly restore a 35% card.
        self.assertIn("max_total_exposure_pct", PORTFOLIO_LIMITS)
        self.assertGreater(PORTFOLIO_LIMITS["max_total_exposure_pct"], 0)

    def test_a_card_is_capped_at_the_total(self):
        # 20 selections at 2.5% would be 50% of bank. Spread across market types
        # and directions so ONLY the total cap can bind.
        specs = []
        for i in range(20):
            market = "BTTS Yes" if i % 2 else "BTTS No"
            specs.append((f"H{i}", f"A{i}", [bet(market, "btts", edge=0.20 - i * 0.001)]))
        predictions = card(*specs)
        self.assertAlmostEqual(exposure(predictions), 0.50, places=6)

        apply_portfolio_limits(predictions, bankroll=BANK)
        # Epsilon on the CAP, not on the measurement: being exactly at the cap
        # is correct, and `+ 1e-9` on the left demanded strictly under it.
        self.assertLessEqual(
            exposure(predictions),
            PORTFOLIO_LIMITS["max_total_exposure_pct"] + 1e-9,
        )

    def test_the_measured_card_drops_from_35_to_20_percent(self):
        """
        The regression this whole change exists for.

        Fourteen selections at the per-bet cap, which is what the 4.1.0 artifact
        published.
        """
        specs = [(f"H{i}", f"A{i}", [bet("BTTS Yes" if i % 2 else "BTTS No", "btts",
                                        edge=0.20 - i * 0.001)])
                 for i in range(14)]
        predictions = card(*specs)
        self.assertAlmostEqual(exposure(predictions), 0.35, places=6)
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertAlmostEqual(exposure(predictions), 0.20, places=6)

    def test_a_card_already_inside_the_cap_is_untouched(self):
        # The caps must not be a tax on a modest card.
        predictions = card(("A", "B", [bet("Home Win", "1x2")]))
        before = exposure(predictions)
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertAlmostEqual(exposure(predictions), before, places=9)


class NestingTests(unittest.TestCase):
    def test_two_nested_unders_share_the_single_bet_cap(self):
        """
        The Man City v Bournemouth case, from the committed artifact.

        `Under 3.5` and `Under 2.5` were published at 2.5% each: presented as two
        selections diversifying one another, in fact 5% on "few goals at the
        Etihad" — the entire per-bet cap in a single view.
        """
        predictions = card(("Man City", "Bournemouth", [
            bet("Under 3.5 Goals", "over_under", edge=0.114),
            bet("Under 2.5 Goals", "over_under", edge=0.103),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK)
        total = exposure(predictions)
        # Half-Kelly basis: max_stake_pct is the FULL-Kelly cap.
        self.assertLessEqual(total, RISK["max_stake_pct"] / 2 + 1e-9)

    def test_the_higher_edge_leg_is_the_one_kept(self):
        predictions = card(("Man City", "Bournemouth", [
            bet("Under 3.5 Goals", "over_under", edge=0.114),
            bet("Under 2.5 Goals", "over_under", edge=0.103),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK)
        kept = [b["market"] for p in predictions for b in p["value_bets"]]
        self.assertEqual(kept, ["Under 3.5 Goals"])

    def test_an_over_and_an_under_on_one_match_are_not_merged(self):
        # Opposite views. Whatever else is true of betting both, they are not one
        # position, and merging them would silently halve a legitimate stake.
        predictions = card(("A", "B", [
            bet("Over 2.5 Goals", "over_under", edge=0.12),
            bet("Under 3.5 Goals", "over_under", edge=0.11),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertEqual(len([b for p in predictions for b in p["value_bets"]]), 2)


class DirectionTests(unittest.TestCase):
    def test_one_direction_across_the_card_is_capped(self):
        # Five UNDERs on five different fixtures: not nested, but they lose
        # together on a high-scoring weekend.
        specs = [(f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under",
                                        edge=0.20 - i * 0.01)])
                 for i in range(6)]
        predictions = card(*specs)
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertLessEqual(
            exposure(predictions),
            PORTFOLIO_LIMITS["max_per_direction_pct"] + 1e-9,
        )

    def test_opposite_directions_get_their_own_budgets(self):
        # Three UNDERs and three OVERs. Each direction has its own 10%, so the
        # card can hold more than one direction's worth without the direction cap
        # binding — it is not a disguised total cap.
        specs = []
        for i in range(3):
            specs.append((f"U{i}", f"X{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)]))
            specs.append((f"O{i}", f"Y{i}", [bet("Over 2.5 Goals", "over_under", edge=0.19 - i * 0.01)]))
        predictions = card(*specs)
        apply_portfolio_limits(predictions, bankroll=BANK)
        by_direction = {}
        for p in predictions:
            for b in p["value_bets"]:
                key = bet_direction({**b, "match": "x"})
                by_direction[key] = by_direction.get(key, 0) + b["half_kelly_pct"]
        for key, total in by_direction.items():
            self.assertLessEqual(total,
                                 PORTFOLIO_LIMITS["max_per_direction_pct"] + 1e-9, key)
        # And both directions survived, rather than one eating the whole budget.
        self.assertEqual(len(by_direction), 2)


class DirectionOfTravelTests(unittest.TestCase):
    """
    Every cap may only reduce.

    This is the property that matters most on this file. A change that widened
    sizing would have to break one of these, and each names the reason.
    """

    def test_no_bet_ever_grows(self):
        predictions = card(
            ("A", "B", [bet("Home Win", "1x2", edge=0.2), bet("Under 2.5 Goals", "over_under", edge=0.15)]),
            ("C", "D", [bet("Away Win", "1x2", edge=0.12), bet("Over 2.5 Goals", "over_under", edge=0.11)]),
        )
        original = {
            (p["fixture"]["home_team"], b["market"]): b["half_kelly_pct"]
            for p in predictions for b in p["value_bets"]
        }
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                key = (p["fixture"]["home_team"], b["market"])
                self.assertLessEqual(b["half_kelly_pct"], original[key] + 1e-12, key)

    def test_total_exposure_never_grows(self):
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(8)
        ])
        before = exposure(predictions)
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertLessEqual(exposure(predictions), before + 1e-12)

    def test_no_bet_is_added(self):
        predictions = card(("A", "B", [bet("Home Win", "1x2")]))
        before = sum(len(p["value_bets"]) for p in predictions)
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertLessEqual(sum(len(p["value_bets"]) for p in predictions), before)

    def test_the_money_and_percentage_fields_stay_consistent(self):
        # The frontend reads `half_kelly_pct`; a human reads `half_kelly`. Scaling
        # one without the other publishes two different stakes for one bet.
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(8)
        ])
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                self.assertAlmostEqual(b["half_kelly"], b["half_kelly_pct"] * BANK, places=6)
                self.assertAlmostEqual(b["full_kelly"], b["full_kelly_pct"] * BANK, places=6)

    def test_half_kelly_stays_half_of_full(self):
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(8)
        ])
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                self.assertAlmostEqual(b["half_kelly_pct"] * 2, b["full_kelly_pct"], places=9)


class DeterminismTests(unittest.TestCase):
    def test_the_same_card_produces_the_same_portfolio(self):
        # A staking recommendation that reshuffles between runs cannot be checked
        # against what was actually placed.
        specs = [(f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.1)])
                 for i in range(8)]
        first, second = card(*specs), card(*specs)
        apply_portfolio_limits(first, bankroll=BANK)
        apply_portfolio_limits(second, bankroll=BANK)
        self.assertEqual(
            [(p["fixture"]["home_team"], b["market"], b["half_kelly_pct"])
             for p in first for b in p["value_bets"]],
            [(p["fixture"]["home_team"], b["market"], b["half_kelly_pct"])
             for p in second for b in p["value_bets"]],
        )

    def test_ties_on_edge_are_broken_deterministically(self):
        # All edges identical: order must still be total, or the cap cuts a
        # different selection each run.
        specs = [(f"H{i}", f"A{i}", [bet("BTTS Yes", "btts", edge=0.1)]) for i in range(12)]
        runs = []
        for _ in range(3):
            predictions = card(*specs)
            apply_portfolio_limits(predictions, bankroll=BANK)
            runs.append([p["fixture"]["home_team"] for p in predictions if p["value_bets"]])
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])


class ReportingTests(unittest.TestCase):
    """A cap that deletes six selections silently looks like a model that found eight."""

    def test_the_summary_names_what_was_cut(self):
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(8)
        ])
        summary = apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertEqual(summary["n_bets_before"], 8)
        self.assertLess(summary["n_bets_after"], 8)
        self.assertTrue(summary["reductions"])
        for reduction in summary["reductions"]:
            self.assertLess(reduction["now_pct"], reduction["was_pct"] + 1e-12)
            self.assertTrue(reduction["reason"])

    def test_the_summary_agrees_with_the_published_bets(self):
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(8)
        ])
        summary = apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertAlmostEqual(summary["total_exposure_pct"], exposure(predictions), places=9)

    def test_nothing_is_published_at_a_zero_stake(self):
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet("Under 2.5 Goals", "over_under", edge=0.2 - i * 0.01)])
            for i in range(10)
        ])
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                self.assertGreater(b["half_kelly_pct"], 0)


class WiringTests(unittest.TestCase):
    """
    The function existed and nothing called it. That is the defect to pin.
    """

    def test_the_pipeline_applies_the_limits_before_exporting(self):
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "run_pipeline.py").read_text(
            encoding="utf-8",
        )
        self.assertIn("apply_portfolio_limits(all_predictions", source)
        # Before the export, not after: capping a file already written is not a cap.
        self.assertLess(
            source.index("apply_portfolio_limits(all_predictions"),
            source.index("Step 10: Export JSON"),
        )

    def test_the_artifact_reports_the_portfolio(self):
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "run_pipeline.py").read_text(
            encoding="utf-8",
        )
        self.assertIn('"n_bets_before_limits"', source)
        self.assertIn('"total_exposure_pct"', source)

    def test_the_caps_are_configured_rather_than_inline(self):
        # The repo rule: configuration in config.py. It also means the numbers can
        # be changed without touching the logic that enforces them.
        for key in ("max_total_exposure_pct", "max_per_direction_pct",
                    "max_per_match_pct", "bankroll"):
            self.assertIn(key, RISK, key)


class EdgeCaseTests(unittest.TestCase):
    def test_a_zero_bankroll_approves_nothing(self):
        predictions = card(("A", "B", [bet("Home Win", "1x2")]))
        apply_portfolio_limits(predictions, bankroll=0.0)
        self.assertEqual([b for p in predictions for b in p["value_bets"]], [])

    def test_an_empty_card_is_handled(self):
        summary = apply_portfolio_limits([], bankroll=BANK)
        self.assertEqual(summary["n_bets_after"], 0)
        self.assertEqual(summary["total_exposure_pct"], 0.0)

    def test_a_prediction_with_no_value_bets_is_untouched(self):
        predictions = [{"fixture": {"home_team": "A", "away_team": "B"}}]
        apply_portfolio_limits(predictions, bankroll=BANK)
        self.assertEqual(predictions[0].get("value_bets"), [])

    def test_a_bet_missing_its_stake_does_not_crash(self):
        predictions = [{
            "fixture": {"home_team": "A", "away_team": "B"},
            "value_bets": [{"market": "Home Win", "market_type": "1x2", "edge": 0.1}],
        }]
        apply_portfolio_limits(predictions, bankroll=BANK)  # must not raise


if __name__ == "__main__":
    unittest.main()


class PartialReductionTests(unittest.TestCase):
    """
    The branch where a stake is SCALED rather than dropped.

    Found by mutation testing: disabling the `half_kelly_pct` rewrite survived the
    whole suite. Every card above happens to sit at an exact multiple of the cap,
    so bets were either kept whole or refused, and the scaling arithmetic never
    ran. A stake that is scaled in one field and not the other publishes two
    different numbers for one bet — and the frontend reads the one that would have
    stayed stale.
    """

    def _card_forcing_a_partial(self):
        # Three at 2.5% plus one at 4% against the 10% direction cap: the fourth
        # must be scaled to 2.5%, not dropped.
        return card(
            ("H0", "A0", [bet("Under 2.5 Goals", "over_under", edge=0.20)]),
            ("H1", "A1", [bet("Under 2.5 Goals", "over_under", edge=0.19)]),
            ("H2", "A2", [bet("Under 2.5 Goals", "over_under", edge=0.18)]),
            ("H3", "A3", [bet("Under 2.5 Goals", "over_under", edge=0.17, stake=40.0)]),
        )

    def test_a_stake_is_scaled_rather_than_dropped_when_it_partly_fits(self):
        predictions = self._card_forcing_a_partial()
        apply_portfolio_limits(predictions, bankroll=BANK)
        stakes = [b["half_kelly_pct"] for p in predictions for b in p["value_bets"]]
        self.assertEqual(len(stakes), 4, "the partly-fitting bet should survive scaled")
        self.assertAlmostEqual(sum(stakes), PORTFOLIO_LIMITS["max_per_direction_pct"], places=9)

    def test_a_scaled_bet_keeps_its_money_and_pct_fields_in_step(self):
        predictions = self._card_forcing_a_partial()
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                self.assertAlmostEqual(b["half_kelly"], b["half_kelly_pct"] * BANK, places=6)
                self.assertAlmostEqual(b["full_kelly"], b["full_kelly_pct"] * BANK, places=6)

    def test_a_scaled_bet_keeps_half_at_half_of_full(self):
        predictions = self._card_forcing_a_partial()
        apply_portfolio_limits(predictions, bankroll=BANK)
        for p in predictions:
            for b in p["value_bets"]:
                self.assertAlmostEqual(b["half_kelly_pct"] * 2, b["full_kelly_pct"], places=9)

    def test_the_scaled_bet_is_the_lowest_edge_one(self):
        predictions = self._card_forcing_a_partial()
        apply_portfolio_limits(predictions, bankroll=BANK)
        scaled = [(b["edge"], b["half_kelly_pct"]) for p in predictions for b in p["value_bets"]]
        lowest = min(scaled, key=lambda row: row[0])
        self.assertLess(lowest[1], 40.0 / BANK, "the weakest selection should absorb the cut")


class CapValuesTests(unittest.TestCase):
    """
    The caps are asserted against LITERALS here, not against PORTFOLIO_LIMITS.

    Every other assertion in this file compares behaviour to the configured cap,
    which is right for testing the mechanism and useless for testing the number:
    raising the cap raises the expectation with it, so the test can never fail.
    Mutation testing proved it — widening the cap to 999% left the suite green.

    Money needs one place where the number itself is pinned. Changing a cap must
    require editing this test, so widening exposure is a deliberate, reviewable act
    rather than a config tweak nothing notices.
    """

    def test_the_total_exposure_cap_is_twenty_percent(self):
        self.assertEqual(RISK["max_total_exposure_pct"], 0.20)
        self.assertEqual(PORTFOLIO_LIMITS["max_total_exposure_pct"], 0.20)

    def test_the_direction_cap_is_ten_percent(self):
        self.assertEqual(RISK["max_per_direction_pct"], 0.10)
        self.assertEqual(PORTFOLIO_LIMITS["max_per_direction_pct"], 0.10)

    def test_the_per_bet_cap_is_five_percent(self):
        self.assertEqual(RISK["max_stake_pct"], 0.05)

    def test_the_per_match_cap_is_fifteen_percent(self):
        self.assertEqual(PORTFOLIO_LIMITS["max_per_match_pct"], 0.15)

    def test_the_total_cap_binds_before_the_per_market_type_cap(self):
        # Otherwise the total is decorative: 40% of one market type would be
        # reachable while the portfolio cap says 20%.
        self.assertLess(
            PORTFOLIO_LIMITS["max_total_exposure_pct"],
            PORTFOLIO_LIMITS["max_per_market_type_pct"],
        )

    def test_a_single_bet_cannot_consume_the_whole_portfolio(self):
        # Half-Kelly per bet must leave room for diversification.
        self.assertLess(
            RISK["max_stake_pct"] / 2,
            PORTFOLIO_LIMITS["max_total_exposure_pct"],
        )
