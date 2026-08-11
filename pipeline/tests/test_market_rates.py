"""
Tests for market-implied goal rates and the blend with the Dixon-Coles posterior.

The load-bearing test is the round trip: take known ``(lambda, mu, rho)``,
generate the exact prices a bookmaker with a known margin would post, remove the
margin, invert, and require the original rates back. Without an inverse the
inversion could only be checked against itself, which is unfalsifiable. It runs
over a seeded grid and asserts the tolerance for every draw, not one case.

Two structural properties are asserted because they are the failures that would
otherwise hide:

* ``invert_fixture`` must have no path accepting the aggregated best-price dict —
  a max over bookmakers whose implied probabilities do not sum to a margin;
* anchoring only week 1 must NOT create a level discontinuity against week 2,
  because the optimiser would read one as "this week is better" and churn
  transfers for a reason unrelated to fixture difficulty.
"""
import math
import unittest

import numpy as np

from pipeline.models.devig import PROPORTIONAL, SHIN, apply_margin
from pipeline.models.dixon_coles import BayesianDixonColes
from pipeline.models.market_rates import (
    STATUS_ABSENT,
    STATUS_CONVERGED,
    STATUS_NOT_CONVERGED,
    STATUS_REJECTED_SIGN,
    MarketRates,
    _outcome_probabilities,
    _p_over,
    blend_log,
    invert_fixture,
    level_correction,
)

RHO = 0.05
LINES = (2.5, 3.5)


def _market(lam, mu, rho=RHO, booksum=1.05, n_books=5, lines=LINES, spread=0.0):
    """
    The exact prices bookmakers with `booksum` overround would post for these rates.

    ``spread`` tilts each book slightly so the set is not degenerate. With
    identical books the best price per outcome equals every book's price, so a
    "best-price vector" fixture would be indistinguishable from a real book — the
    test would then pass for the wrong reason.
    """
    matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho)
    home, draw, away = _outcome_probabilities(matrix)
    h2h, totals = {}, {}
    for index in range(n_books):
        key = f"book{index}"
        tilt = spread * (index - (n_books - 1) / 2.0)
        h2h[key] = apply_margin(
            {
                "home": home + tilt,
                "draw": draw - tilt / 2.0,
                "away": away - tilt / 2.0,
            },
            booksum,
        )
        totals[key] = {}
        for line in lines:
            over = _p_over(matrix, line)
            totals[key][str(line)] = apply_margin(
                {"over": over + tilt, "under": 1.0 - over - tilt}, booksum
            )
    return h2h, totals


def _rates(lam, mu, weight=1.0, status=STATUS_CONVERGED):
    return MarketRates(
        lambda_home=lam, mu_away=mu, status=status, weight=weight,
        n_bookmakers=5, dispersion=0.01, residual=0.0, n_constraints=4,
    )


class RoundTripTests(unittest.TestCase):
    def test_a_seeded_grid_recovers_every_draw(self):
        rng = np.random.default_rng(20260804)
        for _ in range(120):
            lam = float(rng.uniform(0.5, 3.2))
            mu = float(rng.uniform(0.4, 2.6))
            rho = float(rng.uniform(-0.12, 0.12))
            h2h, totals = _market(lam, mu, rho)
            result = invert_fixture(h2h, totals, rho, devig_method=PROPORTIONAL)
            with self.subTest(lam=round(lam, 3), mu=round(mu, 3)):
                self.assertEqual(result.status, STATUS_CONVERGED)
                self.assertAlmostEqual(result.lambda_home, lam, places=3)
                self.assertAlmostEqual(result.mu_away, mu, places=3)

    def test_a_sharp_low_margin_book_recovers_exactly(self):
        """
        A 1% book, which is about as sharp as a real market gets. A synthetic
        ZERO-margin book is deliberately refused upstream: a vector with no margin
        is not a bookmaker's book, and the commonest way to produce one is to take
        the best price across several books.
        """
        h2h, totals = _market(1.8, 1.1, booksum=1.01)
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertEqual(result.status, STATUS_CONVERGED)
        self.assertAlmostEqual(result.lambda_home, 1.8, places=4)
        self.assertAlmostEqual(result.mu_away, 1.1, places=4)

    def test_the_diagnostics_are_derived_not_stored_separately(self):
        h2h, totals = _market(2.1, 0.9)
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertAlmostEqual(
            result.supremacy, result.lambda_home - result.mu_away, places=12
        )
        self.assertAlmostEqual(
            result.total_goals, result.lambda_home + result.mu_away, places=12
        )

    def test_the_system_is_overdetermined_so_the_residual_is_informative(self):
        """
        Two unknowns against four constraints. If rho were also free the system
        would be exactly identified, the residual would always be zero, and the
        "can our forward model even fit this market" diagnostic would vanish.
        """
        h2h, totals = _market(1.7, 1.2)
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertEqual(result.n_constraints, 4)
        self.assertLess(result.residual, 1e-6)

    def test_a_single_totals_line_still_solves(self):
        h2h, totals = _market(1.6, 1.3, lines=(2.5,))
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertEqual(result.status, STATUS_CONVERGED)
        self.assertEqual(result.n_constraints, 3)
        self.assertAlmostEqual(result.lambda_home, 1.6, places=2)


class InputDisciplineTests(unittest.TestCase):
    def test_a_best_price_book_among_the_bookmakers_is_dropped(self):
        """
        The best price per outcome across books is a max, not any book's view; its
        implied probabilities sum to at or below one, so there is no margin to
        remove. It must be dropped rather than de-vigged.
        """
        # Books must genuinely differ, or the max equals every book's own price
        # and the fixture is indistinguishable from a real book.
        h2h, totals = _market(1.8, 1.1, spread=0.03)
        best = {
            outcome: max(book[outcome] for book in h2h.values())
            for outcome in ("home", "draw", "away")
        }
        self.assertLess(
            sum(1.0 / price for price in best.values()), 1.005,
            "the fixture must actually produce a marginless vector",
        )
        h2h["mixed_best_price"] = best
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        # Five real books survive; the mixed vector does not.
        self.assertEqual(result.n_bookmakers, 5)
        self.assertAlmostEqual(result.lambda_home, 1.8, places=2)

    def test_a_flat_price_mapping_raises_rather_than_degrading(self):
        """
        Handed ``{outcome: price}`` instead of ``{bookmaker: {outcome: price}}``
        the module must say so. This is a caller bug — and the flat shape is
        exactly the best-price vector the design refuses — so it is loud rather
        than quietly reported as "no market available", which would look like a
        fixture the bookmakers had not priced.
        """
        from pipeline.models.devig import DevigError

        _, totals = _market(1.8, 1.1)
        flat = {"home": 1.85, "draw": 3.50, "away": 4.20}
        with self.assertRaises(DevigError) as caught:
            invert_fixture(flat, totals, RHO, devig_method=PROPORTIONAL)
        self.assertIn("best-price", str(caught.exception))

    def test_no_market_is_absent_not_an_error(self):
        self.assertEqual(invert_fixture({}, {}, RHO).status, STATUS_ABSENT)
        self.assertFalse(invert_fixture({}, {}, RHO).usable)

    def test_h2h_without_totals_is_absent(self):
        """Two unknowns need the total pinned; 1X2 alone fixes only the ratio."""
        h2h, _ = _market(1.8, 1.1)
        self.assertEqual(invert_fixture(h2h, {}, RHO).status, STATUS_ABSENT)

    def test_a_thin_market_is_used_but_weighted_down(self):
        h2h, totals = _market(1.8, 1.1, n_books=2)
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertEqual(result.status, STATUS_CONVERGED)
        self.assertLess(result.weight, 1.0)
        self.assertGreater(result.weight, 0.0)


class FailureTests(unittest.TestCase):
    def test_an_internally_inconsistent_market_does_not_converge(self):
        """
        A market our forward model cannot represent at all. The warm start must
        never be returned dressed as a solution.
        """
        h2h = {
            f"book{i}": apply_margin(
                {"home": 0.90, "draw": 0.06, "away": 0.04}, 1.05
            )
            for i in range(5)
        }
        totals = {
            f"book{i}": {
                "1.5": apply_margin({"over": 0.05, "under": 0.95}, 1.05),
                "4.5": apply_margin({"over": 0.90, "under": 0.10}, 1.05),
            }
            for i in range(5)
        }
        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertNotEqual(result.status, STATUS_CONVERGED)
        self.assertFalse(result.usable)
        self.assertEqual(result.weight, 0.0)

    def test_a_sign_flipped_supremacy_on_a_lopsided_fixture_is_rejected(self):
        """
        Opposite signs when both sides are lopsided is almost certainly a
        mislabelled home/away, and it would invert every clean-sheet projection in
        the fixture.
        """
        h2h, totals = _market(2.6, 0.8)
        result = invert_fixture(
            h2h, totals, RHO, devig_method=PROPORTIONAL, dc_supremacy=-1.5
        )
        self.assertEqual(result.status, STATUS_REJECTED_SIGN)
        self.assertFalse(result.usable)

    def test_disagreement_on_an_even_fixture_is_kept_as_information(self):
        """
        Deliberately asymmetric to the test above: a market that disagrees about a
        near-even match is telling us something, and clipping it would hide the
        case the anchor exists for.
        """
        h2h, totals = _market(1.35, 1.30)
        result = invert_fixture(
            h2h, totals, RHO, devig_method=PROPORTIONAL, dc_supremacy=-0.2
        )
        self.assertEqual(result.status, STATUS_CONVERGED)


class BlendTests(unittest.TestCase):
    def test_zero_weight_reproduces_the_posterior_exactly(self):
        lam, mu, source = blend_log(1.50, 1.10, _rates(2.20, 0.80), weight=0.0)
        self.assertAlmostEqual(lam, 1.50, places=12)
        self.assertAlmostEqual(mu, 1.10, places=12)
        self.assertEqual(source, "dixon_coles_posterior")

    def test_full_weight_reproduces_the_market_exactly(self):
        lam, mu, source = blend_log(1.50, 1.10, _rates(1.80, 0.95), weight=1.0)
        self.assertAlmostEqual(lam, 1.80, places=9)
        self.assertAlmostEqual(mu, 0.95, places=9)
        self.assertEqual(source, "market_blend")

    def test_the_blend_lies_between_the_two_inputs(self):
        """
        One assertion catching a wrong-sign weight, a swapped home and away, and a
        units error at once.
        """
        for weight in (0.1, 0.25, 0.5, 0.75, 0.9):
            with self.subTest(weight=weight):
                lam, mu, _ = blend_log(1.50, 1.10, _rates(1.90, 0.85), weight)
                self.assertGreaterEqual(lam, 1.50 - 1e-9)
                self.assertLessEqual(lam, 1.90 + 1e-9)
                self.assertLessEqual(mu, 1.10 + 1e-9)
                self.assertGreaterEqual(mu, 0.85 - 1e-9)

    def test_the_blend_is_monotone_in_the_weight(self):
        values = [
            blend_log(1.50, 1.10, _rates(1.90, 0.85), w)[0]
            for w in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
        ]
        for near, far in zip(values, values[1:]):
            self.assertGreater(far, near)

    def test_it_is_geometric_not_arithmetic(self):
        """
        Log space, so the halfway point is the geometric mean. Kept inside the
        0.5-in-log deviation cap: a 4x disagreement would be capped, and the test
        would then be measuring the cap rather than the blend.
        """
        lam, _, _ = blend_log(1.0, 1.0, _rates(1.5, 1.0), weight=0.5)
        self.assertAlmostEqual(lam, math.sqrt(1.5), places=9)
        arithmetic = 0.5 * (1.0 + 1.5)
        self.assertLess(lam, arithmetic)

    def test_an_unusable_market_falls_back_to_the_posterior(self):
        for status in (STATUS_NOT_CONVERGED, STATUS_ABSENT):
            with self.subTest(status=status):
                lam, mu, source = blend_log(
                    1.50, 1.10, _rates(9.0, 0.1, status=status), weight=1.0
                )
                self.assertAlmostEqual(lam, 1.50, places=12)
                self.assertEqual(source, "dixon_coles_posterior")

    def test_a_violent_disagreement_is_capped_not_clipped_to_the_posterior(self):
        """
        The market is usually right when it disagrees hard — a promoted club, a
        manager change, an injury the posterior cannot see. Capping bounds the
        damage; clipping to the posterior would delete the signal.
        """
        lam, _, source = blend_log(1.00, 1.00, _rates(6.00, 1.00), weight=1.0)
        self.assertEqual(source, "market_blend")
        self.assertGreater(lam, 1.00)
        self.assertLess(lam, 6.00)
        self.assertAlmostEqual(lam, math.exp(0.5), places=6)


class LevelCorrectionTests(unittest.TestCase):
    def test_a_uniform_uplift_is_recovered_up_to_shrinkage(self):
        anchored = [(_rates(1.5 * 1.1, 1.2 * 1.1), 1.5, 1.2) for _ in range(10)]
        home, away = level_correction(anchored)
        expected = math.log(1.1) * (10 / 15)
        self.assertAlmostEqual(home, expected, places=9)
        self.assertAlmostEqual(away, expected, places=9)

    def test_one_anchored_fixture_barely_moves_the_league(self):
        home, _ = level_correction([(_rates(1.5 * 1.2, 1.2), 1.5, 1.2)])
        self.assertLess(abs(home), math.log(1.2) * 0.2)

    def test_an_absurd_correction_is_clamped(self):
        anchored = [(_rates(1.5 * 3.0, 1.2 * 3.0), 1.5, 1.2) for _ in range(20)]
        home, away = level_correction(anchored)
        self.assertAlmostEqual(home, 0.20, places=9)
        self.assertAlmostEqual(away, 0.20, places=9)

    def test_no_usable_anchor_gives_no_correction(self):
        self.assertEqual(level_correction([]), (0.0, 0.0))
        self.assertEqual(
            level_correction([(_rates(2.0, 1.0, status=STATUS_ABSENT), 1.5, 1.2)]),
            (0.0, 0.0),
        )

    def test_anchoring_only_week_one_creates_no_level_discontinuity(self):
        """
        The test that fails on the naive design. Ten week-1 fixtures each 10%
        above the posterior, and ten week-2 fixtures with no market at all. After
        the level correction the mean uplift must agree between the weeks, or the
        optimiser reads week 1 as better and churns transfers for a reason that
        has nothing to do with fixture difficulty.
        """
        dc = [(1.4 + 0.05 * i, 1.1 + 0.03 * i) for i in range(10)]
        uplift = 1.10
        week1_market = [_rates(h * uplift, a * uplift) for h, a in dc]

        level = level_correction(
            [(m, h, a) for m, (h, a) in zip(week1_market, dc)],
            shrinkage=0.0,
        )

        week1 = [
            blend_log(h, a, m, weight=1.0, level=level)
            for m, (h, a) in zip(week1_market, dc)
        ]
        week2 = [blend_log(h, a, None, weight=1.0, level=level) for h, a in dc]

        def mean_uplift(blended):
            return float(np.mean([
                math.log(lam / h) for (lam, _, _), (h, _) in zip(blended, dc)
            ]))

        self.assertLess(abs(mean_uplift(week1) - mean_uplift(week2)), 0.05)

    def test_a_week_without_a_market_still_receives_the_level_shift(self):
        """
        This is what makes the anchor reach a gameweek it has no prices for, and
        the reason no discontinuity appears.
        """
        lam, mu, source = blend_log(1.5, 1.2, None, weight=1.0, level=(0.1, 0.1))
        self.assertAlmostEqual(lam, 1.5 * math.exp(0.1), places=9)
        self.assertAlmostEqual(mu, 1.2 * math.exp(0.1), places=9)
        self.assertEqual(source, "dixon_coles_posterior+level")

    def test_the_league_level_is_not_double_counted(self):
        """
        A fixture exactly at the league mean uplift must land at the level shift
        and no further, or every anchored fixture gets the correction twice.
        """
        anchored = [(_rates(1.5 * 1.1, 1.2 * 1.1), 1.5, 1.2) for _ in range(10)]
        level = level_correction(anchored, shrinkage=0.0)
        lam, mu, _ = blend_log(1.5, 1.2, _rates(1.5 * 1.1, 1.2 * 1.1), 1.0, level)
        self.assertAlmostEqual(lam, 1.5 * 1.1, places=9)
        self.assertAlmostEqual(mu, 1.2 * 1.1, places=9)


class ScorelineMatrixTests(unittest.TestCase):
    def test_the_grid_is_a_distribution(self):
        for lam, mu, rho in ((1.5, 1.2, 0.05), (0.4, 3.0, -0.1), (2.5, 2.5, 0.0)):
            with self.subTest(lam=lam, mu=mu, rho=rho):
                matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho)
                self.assertAlmostEqual(float(matrix.sum()), 1.0, places=12)
                self.assertTrue((matrix >= 0).all())

    def test_a_higher_home_rate_raises_the_home_win_probability(self):
        low = _outcome_probabilities(
            BayesianDixonColes.scoreline_matrix(1.2, 1.2, 0.0)
        )[0]
        high = _outcome_probabilities(
            BayesianDixonColes.scoreline_matrix(2.4, 1.2, 0.0)
        )[0]
        self.assertGreater(high, low)

    def test_the_low_score_correction_moves_the_draw(self):
        """rho is the whole point of Dixon-Coles over independent Poisson."""
        neutral = _outcome_probabilities(
            BayesianDixonColes.scoreline_matrix(1.4, 1.2, 0.0)
        )[1]
        corrected = _outcome_probabilities(
            BayesianDixonColes.scoreline_matrix(1.4, 1.2, 0.1)
        )[1]
        self.assertNotAlmostEqual(neutral, corrected, places=4)

    def test_probability_of_over_falls_as_the_line_rises(self):
        matrix = BayesianDixonColes.scoreline_matrix(1.6, 1.3, 0.05)
        values = [_p_over(matrix, line) for line in (0.5, 1.5, 2.5, 3.5, 4.5)]
        for near, far in zip(values, values[1:]):
            self.assertLess(far, near)


if __name__ == "__main__":
    unittest.main()


class TrustWeightingTests(unittest.TestCase):
    """
    How much a market is allowed to pull the fit.

    Both properties here were inverted in the first version, and both fail in the
    unsafe direction — they over-trusted thin evidence.
    """

    def test_a_single_book_does_not_outrank_a_well_sampled_consensus(self):
        """
        Dispersion alone inverts for one book: `aggregate_books` reports dispersion
        0.0 when there is nothing to disagree with, so `1/dispersion` handed a
        one-book market the MAXIMUM constraint weight while five books with genuine
        disagreement got less.

        Asserted on `residual_weight` itself. The first version of this test
        compared `MarketRates.weight` — the consensus weight, which the fix does
        not touch — so it passed with the inverted version still in place.
        """
        from pipeline.models.devig import aggregate_books
        from pipeline.models.market_rates import residual_weight

        one = aggregate_books(_market(1.8, 1.1, n_books=1)[0], method=PROPORTIONAL)
        many = aggregate_books(
            _market(1.8, 1.1, n_books=5, spread=0.02)[0], method=PROPORTIONAL
        )
        self.assertEqual(one.n_books, 1)
        self.assertEqual(many.n_books, 5)
        # Unmeasurable, NOT zero — reporting zero let a lone book score best.
        from pipeline.models.devig import UNMEASURED_DISPERSION

        self.assertEqual(one.dispersion, UNMEASURED_DISPERSION)
        self.assertLess(many.dispersion, UNMEASURED_DISPERSION)
        self.assertLess(
            residual_weight(one), residual_weight(many),
            "a lone book must not pull the fit harder than a five-book consensus",
        )

    def test_one_thin_extra_line_does_not_collapse_the_anchor(self):
        """
        Taking the minimum weight across totals lines let a single thinly-quoted
        extra line gut the whole anchor: five books on 2.5/3.5 plus one book on 1.5
        gave weight 0.333, so an 0.55 blend became 0.18. Books splitting between
        lines is the ordinary case with one main line each, not an edge case, so
        the minimum would have quietly gutted the anchor most weeks.
        """
        h2h, totals = _market(1.8, 1.1, n_books=5, spread=0.02, lines=(2.5, 3.5))
        # One extra book quoting only an unusual line.
        thin_h2h, thin_totals = _market(1.8, 1.1, n_books=1, lines=(1.5,))
        totals["lonely"] = thin_totals["book0"]

        result = invert_fixture(h2h, totals, RHO, devig_method=PROPORTIONAL)
        self.assertEqual(result.status, STATUS_CONVERGED)
        self.assertAlmostEqual(result.weight, 1.0, places=9)
        # The extra line still constrains the fit; only the trust weight ignores it.
        self.assertGreaterEqual(result.n_constraints, 5)
