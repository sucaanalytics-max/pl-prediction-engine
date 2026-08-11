"""
Which way de-vigging moves an edge, and what a one-sided market does.

## Why this file exists

Both facts were stated backwards or left untested, on the function that sizes real
money.

The module docstring asserted that the overround makes "model edges appear larger
than they are". It is the reverse: raw implied probabilities are inflated, so
`edge = p - 1/odds` measures against a number that is too big and **understates**
the edge. De-vigging lowers every implied probability, which makes edges LARGER and
stakes BIGGER.

That direction matters more than the arithmetic. CLAUDE.md says never to widen
stake sizing as a side effect, and a comment claiming a change is conservative when
it is not is exactly how that happens.

The second fact is that a **single outcome cannot be de-vigged**: with one entry
the total is that entry, so the result is 1.0 — a certainty — and every such bet
scores `edge = p - 1.0` and is dropped silently. Thin totals lines where the book
prices only one side hit this.
"""
from __future__ import annotations

import unittest

from pipeline.risk.kelly import devig_implied_prob, kelly_stake

# A real Over 2.5 line from the committed artifact.
OVER_ODDS = 2.1724137931034484
UNDER_ODDS = 1.8
MODEL_PROB = 0.5165


class DirectionTests(unittest.TestCase):
    """De-vigging raises edges. Stated as a test so it cannot be mis-documented."""

    def test_devigging_lowers_every_implied_probability(self):
        raw = {k: 1.0 / v for k, v in {"over": OVER_ODDS, "under": UNDER_ODDS}.items()}
        devigged = devig_implied_prob({"over": OVER_ODDS, "under": UNDER_ODDS})
        for outcome, value in devigged.items():
            self.assertLess(value, raw[outcome])

    def test_devigged_probabilities_sum_to_one(self):
        devigged = devig_implied_prob({"over": OVER_ODDS, "under": UNDER_ODDS})
        self.assertAlmostEqual(sum(devigged.values()), 1.0, places=10)

    def test_raw_probabilities_sum_above_one(self):
        # The overround. If this ever stopped holding, de-vigging would be a no-op.
        raw = 1.0 / OVER_ODDS + 1.0 / UNDER_ODDS
        self.assertGreater(raw, 1.0)

    def test_devigging_INCREASES_the_edge(self):
        """
        The correction. Not a safety improvement — it makes the recommended stake
        bigger, and anything asserting otherwise is wrong.
        """
        without = kelly_stake(MODEL_PROB, OVER_ODDS, 1000.0)
        with_context = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS, "under": UNDER_ODDS},
            outcome_key="over",
        )
        self.assertGreater(with_context["edge"], without["edge"])

    def test_and_therefore_increases_the_stake(self):
        without = kelly_stake(MODEL_PROB, OVER_ODDS, 1000.0)
        with_context = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS, "under": UNDER_ODDS},
            outcome_key="over",
        )
        # Both may hit the max_stake_pct cap, in which case they tie — never the
        # other way round.
        self.assertGreaterEqual(
            with_context["full_kelly_pct"], without["full_kelly_pct"],
        )

    def test_the_three_way_example_in_the_docstring_still_holds(self):
        devigged = devig_implied_prob({"home": 2.10, "draw": 3.40, "away": 3.80})
        self.assertAlmostEqual(devigged["home"], 0.461, places=3)
        self.assertAlmostEqual(devigged["draw"], 0.285, places=3)
        self.assertAlmostEqual(devigged["away"], 0.255, places=3)


class OneSidedMarketTests(unittest.TestCase):
    """
    A market with one price. Common on thin totals lines.

    Before the guard, `devig_implied_prob({"over": x})` returned `{"over": 1.0}` —
    dividing the single entry by itself — and the bet was skipped with
    `edge = p - 1.0`. Silently, because a skipped bet simply never appears.
    """

    def test_a_single_outcome_is_not_reported_as_a_certainty(self):
        devigged = devig_implied_prob({"over": OVER_ODDS})
        self.assertNotEqual(devigged["over"], 1.0)

    def test_it_returns_the_raw_implied_probability_untouched(self):
        devigged = devig_implied_prob({"over": OVER_ODDS})
        self.assertAlmostEqual(devigged["over"], 1.0 / OVER_ODDS, places=12)

    def test_the_bet_survives_instead_of_vanishing(self):
        stake = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS}, outcome_key="over",
        )
        self.assertEqual(stake["recommendation"], "bet")
        self.assertGreater(stake["edge"], 0)

    def test_it_scores_the_same_as_having_no_context_at_all(self):
        """
        The conservative reading. With one price there is no overround to remove,
        so the honest answer is the understated raw edge rather than a fabricated
        de-vigged one.
        """
        one_sided = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS}, outcome_key="over",
        )
        no_context = kelly_stake(MODEL_PROB, OVER_ODDS, 1000.0)
        self.assertAlmostEqual(one_sided["edge"], no_context["edge"], places=12)

    def test_a_one_sided_market_never_out_stakes_a_two_sided_one(self):
        """
        The safety property. A missing opposing price must not be able to produce a
        LARGER stake than a fully priced market, or an outage becomes a reason to
        bet more.
        """
        one_sided = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS}, outcome_key="over",
        )
        two_sided = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS, "under": UNDER_ODDS},
            outcome_key="over",
        )
        self.assertLessEqual(one_sided["edge"], two_sided["edge"])

    def test_an_empty_market_is_still_empty(self):
        self.assertEqual(devig_implied_prob({}), {})

    def test_an_all_invalid_market_is_empty(self):
        # Odds of 1.0 or below are not prices.
        self.assertEqual(devig_implied_prob({"over": 1.0, "under": 0.5}), {})

    def test_one_valid_price_among_invalid_ones_is_treated_as_one_sided(self):
        devigged = devig_implied_prob({"over": OVER_ODDS, "under": 1.0})
        self.assertAlmostEqual(devigged["over"], 1.0 / OVER_ODDS, places=12)
        self.assertNotIn("under", devigged)


class PublishedArtifactTests(unittest.TestCase):
    """
    What the committed `latest.json` actually contains, and why.

    Its Over 2.5 bets carry `implied_prob == raw_implied_prob`, which reproduces
    exactly under `kelly_stake(...)` with NO market context. That artifact is
    `pipeline_version 4.0.0` and predates the totals de-vig, so the published edges
    are the understated ones — not, as it first appeared, inflated ones.
    """

    def test_no_context_reproduces_the_published_numbers(self):
        stake = kelly_stake(MODEL_PROB, OVER_ODDS, 1000.0)
        self.assertAlmostEqual(stake["edge"], 0.05618253968253967, places=12)
        self.assertAlmostEqual(stake["implied_prob"], stake["raw_implied_prob"], places=12)

    def test_the_current_code_would_publish_a_larger_edge(self):
        # So a re-run raises these stakes. Worth knowing before one happens.
        with_context = kelly_stake(
            MODEL_PROB, OVER_ODDS, 1000.0,
            market_odds={"over": OVER_ODDS, "under": UNDER_ODDS},
            outcome_key="over",
        )
        self.assertGreater(with_context["edge"], 0.05618253968253967)


if __name__ == "__main__":
    unittest.main()
