"""
Tests for bookmaker margin removal.

The properties asserted are relationships, not magic numbers, because the exact
closed forms are the part most likely to be wrong from memory. Specifically:

* every method sums to one;
* all three converge as the margin goes to zero;
* Shin and power move the longshot DOWN relative to proportional — the
  favourite-longshot direction — asserted as an inequality;
* a round trip through a known margin recovers the original probabilities.

That last one is what makes the suite able to fail. A de-vig checked only against
itself is unfalsifiable, so :func:`apply_margin` exists purely as the inverse.

One regression is pinned by name: Shin was initially special-cased at ``z = 0`` to
return the proportional result, which sums to one. The objective was therefore
zero at the bracket's left end, the bisection returned ``z = 0`` immediately, and
Shin silently *became* proportional — identical to twelve decimal places for every
input. ``test_shin_is_not_merely_proportional`` is the guard.
"""
import unittest

from pipeline.models.devig import (
    BOOK_EXCHANGE,
    BOOK_MARGIN,
    MAX_PLAUSIBLE_MARGIN,
    METHODS,
    POWER,
    PROPORTIONAL,
    SHIN,
    DevigError,
    aggregate_books,
    apply_margin,
    assert_single_book,
    book_margin,
    classify_book,
    devig,
)

# A realistic single-book 1X2 carrying ~6.4%.
BOOK = {"home": 1.85, "draw": 3.50, "away": 4.20}
TRUE = {"home": 0.55, "draw": 0.26, "away": 0.19}


def _books(n: int, spread: float = 0.02) -> dict:
    """`n` bookmakers quoting the same market with slightly different views."""
    out = {}
    for index in range(n):
        tilt = spread * (index - (n - 1) / 2.0)
        probabilities = {
            "home": TRUE["home"] + tilt,
            "draw": TRUE["draw"] - tilt / 2.0,
            "away": TRUE["away"] - tilt / 2.0,
        }
        out[f"book{index}"] = apply_margin(probabilities, 1.05)
    return out


class MarginTests(unittest.TestCase):
    def test_the_margin_is_the_excess_over_one(self):
        self.assertAlmostEqual(book_margin(BOOK), 0.06437, places=4)

    def test_a_fair_book_has_no_margin(self):
        self.assertAlmostEqual(book_margin(apply_margin(TRUE, 1.0000001)), 0.0, places=6)

    def test_a_best_price_vector_is_refused(self):
        """
        The input error this module exists to prevent. A max over bookmakers sums
        to at or below one, so there is no margin to remove and normalising it
        INFLATES every probability.
        """
        with self.assertRaises(DevigError) as caught:
            assert_single_book({"home": 2.02, "draw": 3.60, "away": 4.40})
        self.assertIn("single bookmaker", str(caught.exception))

    def test_an_implausibly_wide_book_is_refused(self):
        wide = apply_margin(TRUE, 1.0 + MAX_PLAUSIBLE_MARGIN + 0.05)
        with self.assertRaises(DevigError):
            assert_single_book(wide)

    def test_devig_refuses_a_best_price_vector_by_default(self):
        """Strictness is on by default, because the failure is silent."""
        with self.assertRaises(DevigError):
            devig({"home": 2.02, "draw": 3.60, "away": 4.40})

    def test_a_single_outcome_cannot_be_devigged(self):
        with self.assertRaises(DevigError):
            devig({"over": 1.90})

    def test_odds_at_or_below_evens_are_rejected(self):
        with self.assertRaises(DevigError):
            devig({"home": 1.0, "draw": 3.5, "away": 4.2}, strict=False)


class MethodTests(unittest.TestCase):
    def test_every_method_sums_to_one(self):
        for method in METHODS:
            with self.subTest(method=method):
                total = sum(devig(BOOK, method=method).values())
                self.assertAlmostEqual(total, 1.0, places=12)

    def test_every_method_preserves_price_ordering(self):
        for method in METHODS:
            with self.subTest(method=method):
                result = devig(BOOK, method=method)
                self.assertGreater(result["home"], result["draw"])
                self.assertGreater(result["draw"], result["away"])

    def test_the_methods_converge_as_the_margin_vanishes(self):
        nearly_fair = apply_margin(TRUE, 1.0005)
        results = {
            method: devig(nearly_fair, method=method, strict=False)
            for method in METHODS
        }
        for outcome in TRUE:
            values = [results[method][outcome] for method in METHODS]
            self.assertLess(max(values) - min(values), 1e-3, outcome)

    def test_shin_is_not_merely_proportional(self):
        """
        The pinned regression. A z=0 special case returning the proportional
        result made the objective zero at the bracket's left end, so the solve
        returned immediately and Shin became proportional for every input.
        """
        proportional = devig(BOOK, method=PROPORTIONAL)
        shin = devig(BOOK, method=SHIN)
        self.assertGreater(
            max(abs(shin[k] - proportional[k]) for k in proportional), 1e-4
        )

    def test_shin_and_power_move_the_longshot_below_proportional(self):
        """
        The favourite-longshot direction, asserted as an inequality rather than
        against a magic number. Bookmakers load more margin onto longshots, so
        removing it proportionally overstates them.
        """
        proportional = devig(BOOK, method=PROPORTIONAL)
        for method in (SHIN, POWER):
            with self.subTest(method=method):
                result = devig(BOOK, method=method)
                self.assertLess(result["away"], proportional["away"])
                self.assertGreater(result["home"], proportional["home"])

    def test_power_moves_further_than_shin_on_this_book(self):
        proportional = devig(BOOK, method=PROPORTIONAL)
        shin = devig(BOOK, method=SHIN)
        power = devig(BOOK, method=POWER)
        self.assertGreater(
            power["home"] - proportional["home"], shin["home"] - proportional["home"]
        )

    def test_an_unknown_method_raises(self):
        with self.assertRaises(DevigError):
            devig(BOOK, method="vibes")

    def test_a_two_way_market_works_for_every_method(self):
        """Totals are two-way, and that is half the goal-rate inversion."""
        totals = {"over": 1.85, "under": 2.05}
        for method in METHODS:
            with self.subTest(method=method):
                result = devig(totals, method=method)
                self.assertAlmostEqual(sum(result.values()), 1.0, places=12)
                self.assertGreater(result["over"], result["under"])


class RoundTripTests(unittest.TestCase):
    def test_proportional_recovers_known_probabilities_exactly(self):
        for booksum in (1.02, 1.05, 1.10):
            with self.subTest(booksum=booksum):
                recovered = devig(apply_margin(TRUE, booksum), method=PROPORTIONAL)
                for outcome, probability in TRUE.items():
                    self.assertAlmostEqual(recovered[outcome], probability, places=10)

    def test_a_seeded_grid_round_trips_for_every_draw(self):
        """
        Invariants over all draws, not one case — the repo idiom, and the only way
        to catch a method that works on a favourite-heavy book and fails on an
        even one.
        """
        import numpy as np

        rng = np.random.default_rng(20260804)
        for _ in range(200):
            weights = rng.dirichlet([2.0, 2.0, 2.0])
            probabilities = {
                "home": float(weights[0]),
                "draw": float(weights[1]),
                "away": float(weights[2]),
            }
            if min(probabilities.values()) < 0.02:
                continue
            booksum = float(rng.uniform(1.01, 1.12))
            recovered = devig(
                apply_margin(probabilities, booksum), method=PROPORTIONAL
            )
            for outcome, value in probabilities.items():
                self.assertAlmostEqual(recovered[outcome], value, places=9)

    def test_apply_margin_refuses_a_booksum_at_or_below_one(self):
        with self.assertRaises(DevigError):
            apply_margin(TRUE, 1.0)


class ClassificationTests(unittest.TestCase):
    def test_exchanges_are_recognised(self):
        for key in ("betfair_ex_uk", "matchbook_ex_eu", "betfair_ex"):
            with self.subTest(key=key):
                self.assertEqual(classify_book(key), BOOK_EXCHANGE)

    def test_ordinary_bookmakers_are_margin_books(self):
        for key in ("bet365", "williamhill", "paddypower", ""):
            with self.subTest(key=key):
                self.assertEqual(classify_book(key), BOOK_MARGIN)

    def test_an_exchange_takes_the_proportional_path(self):
        """
        A back price has no bookmaker margin to model — its spread is a bid/ask
        between punters — so an insider-driven margin model does not apply.
        """
        self.assertEqual(
            devig(BOOK, method=SHIN, bookmaker_key="betfair_ex_uk"),
            devig(BOOK, method=PROPORTIONAL),
        )


class AggregationTests(unittest.TestCase):
    def test_the_consensus_sums_to_one_and_reports_its_size(self):
        consensus = aggregate_books(_books(5))
        self.assertAlmostEqual(sum(consensus.probabilities.values()), 1.0, places=12)
        self.assertEqual(consensus.n_books, 5)
        self.assertEqual(consensus.status, "ok")
        self.assertEqual(consensus.weight, 1.0)

    def test_a_stale_outlier_book_barely_moves_the_median(self):
        """
        Median, not mean, so a stale price is ignored with no threshold to tune.
        """
        clean = aggregate_books(_books(5))
        with_outlier = dict(_books(5))
        with_outlier["stale"] = apply_margin(
            {"home": 0.20, "draw": 0.30, "away": 0.50}, 1.05
        )
        polluted = aggregate_books(with_outlier)
        self.assertLess(
            abs(polluted.probabilities["home"] - clean.probabilities["home"]), 0.03
        )

    def test_a_wide_margin_book_is_dropped_with_a_reason(self):
        books = dict(_books(4))
        books["novelty"] = apply_margin(TRUE, 1.40)
        consensus = aggregate_books(books)
        self.assertEqual(consensus.n_books, 4)
        self.assertIn("novelty", consensus.dropped)

    def test_a_best_price_vector_among_the_books_is_dropped(self):
        books = dict(_books(4))
        books["mixed_best_price"] = {"home": 2.02, "draw": 3.60, "away": 4.40}
        consensus = aggregate_books(books)
        self.assertIn("mixed_best_price", consensus.dropped)
        self.assertEqual(consensus.n_books, 4)

    def test_too_few_books_is_thin_and_weighted_down(self):
        """
        Not discarded — that would throw away real information — and not treated
        as equal to a five-book consensus either.
        """
        consensus = aggregate_books(_books(2))
        self.assertEqual(consensus.status, "thin")
        self.assertEqual(consensus.n_books, 2)
        self.assertAlmostEqual(consensus.weight, 0.5)
        self.assertLess(consensus.weight, aggregate_books(_books(5)).weight)

    def test_one_book_gets_about_a_third_of_the_weight(self):
        consensus = aggregate_books({"only": apply_margin(TRUE, 1.05)})
        self.assertEqual(consensus.status, "thin")
        self.assertAlmostEqual(consensus.weight, 1 / 3)

    def test_no_usable_books_is_absent_not_an_error(self):
        consensus = aggregate_books({"bad": {"home": 2.02, "draw": 3.60, "away": 4.40}})
        self.assertEqual(consensus.status, "absent")
        self.assertEqual(consensus.weight, 0.0)
        self.assertEqual(consensus.probabilities, {})

    def test_an_empty_input_is_absent(self):
        self.assertEqual(aggregate_books({}).status, "absent")

    def test_dispersion_rises_when_books_disagree(self):
        """
        Dispersion is what down-weights a market's residual in the inversion, so
        it has to actually track disagreement.
        """
        tight = aggregate_books(_books(5, spread=0.005))
        loose = aggregate_books(_books(5, spread=0.05))
        self.assertLess(tight.dispersion, loose.dispersion)

    def test_a_book_quoting_a_different_outcome_set_is_dropped(self):
        books = dict(_books(4))
        books["partial"] = {"home": 1.85, "draw": 3.50}
        consensus = aggregate_books(books)
        self.assertIn("partial", consensus.dropped)
        self.assertEqual(sorted(consensus.probabilities), ["away", "draw", "home"])


if __name__ == "__main__":
    unittest.main()
