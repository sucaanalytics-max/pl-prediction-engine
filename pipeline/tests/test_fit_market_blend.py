"""
Properties of the out-of-sample market blend-weight harness.

Fast tests only. The real fit is run by hand over three seasons of
Football-Data.co.uk closing prices; nothing here fetches, and nothing here fits
more than a few dozen synthetic matches. What is asserted instead is that the
harness can DISTINGUISH — an exactly-right market must recover a weight near 1
and a pure-noise market a weight near 0 — because a harness that returns a
plausible number regardless of the truth is worse than no harness.
"""
from __future__ import annotations

import contextlib
import io
import json
import logging
import math
import tempfile
import unittest
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from pipeline.config import MAX_GOALS
from pipeline.data.football_data import CLOSING_BOOKS
from pipeline.learning.fit_market_blend import (
    CAVEAT_CLOSING_LINE,
    CAVEAT_MLE_SUBSTITUTE,
    CAVEAT_THIN_BOOKS,
    WEIGHT_GRID,
    CorpusDiagnostics,
    FixtureCase,
    blended_rates,
    build_report,
    case_metrics,
    clean_sheet_log_losses,
    devig_comparison,
    flat_region,
    main,
    metric_table,
    outcome_log_loss,
    round_labels,
    round_means,
    scoreline_log_loss,
    total_goals_crps,
    walk_forward_cases,
)
from pipeline.models.dc_mle import MLEDixonColes
from pipeline.models.devig import POWER, PROPORTIONAL, SHIN, apply_margin
from pipeline.models.dixon_coles import BayesianDixonColes
from pipeline.models.market_rates import (
    STATUS_CONVERGED,
    MarketRates,
    _outcome_probabilities,
    invert_fixture,
)

# The eight-club synthetic frame is deliberately thin at the start, so the
# walk-forward's earliest fits log "rates outside the plausible band" and the
# inversion logs a handful of supremacy-sign rejections. Both are the behaviour
# under test, not a problem, and letting them print would train a reader to
# ignore those exact messages when they matter. Silenced for this module only.
_NOISY_LOGGERS = ("pipeline.models.dc_mle", "pipeline.models.market_rates")
_RESTORE: Dict[str, int] = {}


def setUpModule() -> None:
    for name in _NOISY_LOGGERS:
        logger = logging.getLogger(name)
        _RESTORE[name] = logger.level
        logger.setLevel(logging.CRITICAL)


def tearDownModule() -> None:
    for name, level in _RESTORE.items():
        logging.getLogger(name).setLevel(level)


# ── Builders ─────────────────────────────────────────────────────────────────

RECOVERY_ROUNDS = 60
RECOVERY_PER_ROUND = 12
RECOVERY_RHO = -0.08
RECOVERY_SD = 0.30

# Tolerances measured, not guessed. Over seeds 101/202/303/404/505 at 720
# fixtures in 60 rounds with sd 0.30:
#
#     market is the truth   argmin 0.95 1.00 1.00 1.00 1.00, lower bound vs w=0
#                           +0.035 +0.076 +0.043 +0.067 +0.103, all exclude zero
#     market is pure noise  argmin 0.10 0.00 0.10 0.00 0.00, lower bound vs w=1
#                           +0.022 +0.060 +0.033 +0.049 +0.084, all exclude zero
#
# The corpus is that size because a smaller one does not settle. At 480 fixtures
# and sd 0.25 the same five seeds gave argmins of 0.80/1.00/0.95/1.00/1.00 and
# 0.25/0.00/0.05/0.05/0.00, and no interval excluded zero — mean +0.054 against a
# radius of 0.060. That is not a defect in the harness: the scoreline
# log-likelihood is locally quadratic in the log-rate error, so the curve really
# is flat within a couple of grid steps of its optimum, and the anytime-valid
# radius really does need this many rounds. It is worth knowing before reading the
# real fit's interval. Seed 101 is the least favourable of the five and is the one
# used, deliberately.
RECOVERY_SEED = 101
EXACT_MARKET_FLOOR = 0.90
NOISE_MARKET_CEILING = 0.15
MIN_SEPARATION = 0.75

# Book margins used to synthesise prices. Both sit inside devig's
# [0.5%, 15%] plausible-single-book band and near the medians measured on the
# real corpus (Pinnacle 2.9%, Bet365 5.5%).
BOOK_MARGINS = {"pinnacle": 1.029, "bet365": 1.055}


def _market(lam: float, mu: float) -> MarketRates:
    """A converged market at full weight — the shape the corpus hands the grid."""
    return MarketRates(
        lambda_home=lam, mu_away=mu, status=STATUS_CONVERGED,
        n_bookmakers=2, dispersion=0.16, residual=0.01, n_constraints=3,
        devig_method=PROPORTIONAL, weight=1.0,
    )


def _draw_scoreline(rng: np.random.Generator, lam: float, mu: float, rho: float):
    """One scoreline from the grid the harness scores against."""
    matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho, MAX_GOALS)
    flat = matrix.ravel()
    index = int(rng.choice(flat.size, p=flat / flat.sum()))
    return divmod(index, matrix.shape[1])


def recovery_cases(
    seed: int, market_is_truth: bool, sd: float = RECOVERY_SD
) -> List[FixtureCase]:
    """
    Cases whose answer is known by construction.

    True rates generate the scorelines. One of the two inputs is the truth and
    the other is the truth times ``exp(eps)``, so the blend
    ``log lam = log dc + w (log mkt - log dc)`` equals the truth at exactly one
    weight: w = 1 when the market is the truth, w = 0 when the posterior is.

    Parameters and scorelines draw from SEPARATE streams (``[seed, 1]`` and
    ``[seed, 2]``). A single generator would make the goals a deterministic
    function of the same stream words that produced the perturbation, which is
    the one correlation that could manufacture the answer.
    """
    params = np.random.default_rng([seed, 1])
    goals = np.random.default_rng([seed, 2])
    cases: List[FixtureCase] = []
    for round_index in range(RECOVERY_ROUNDS):
        for slot in range(RECOVERY_PER_ROUND):
            lam_true = float(1.45 * math.exp(params.normal(0.0, 0.28)))
            mu_true = float(1.20 * math.exp(params.normal(0.0, 0.28)))
            drift_home = float(params.normal(0.0, sd))
            drift_away = float(params.normal(0.0, sd))
            home_goals, away_goals = _draw_scoreline(
                goals, lam_true, mu_true, RECOVERY_RHO
            )
            wrong = (lam_true * math.exp(drift_home), mu_true * math.exp(drift_away))
            if market_is_truth:
                dc, market = wrong, (lam_true, mu_true)
            else:
                dc, market = (lam_true, mu_true), wrong
            cases.append(
                FixtureCase(
                    match_id=f"synthetic_{round_index:02d}_{slot:02d}",
                    season="synthetic",
                    round_label=f"synthetic-W{round_index:02d}",
                    home_team=f"Home {slot}",
                    away_team=f"Away {slot}",
                    home_goals=home_goals,
                    away_goals=away_goals,
                    lambda_home_dc=dc[0],
                    mu_away_dc=dc[1],
                    rho=RECOVERY_RHO,
                    markets={PROPORTIONAL: _market(*market)},
                )
            )
    return cases


def _price_row(matrix: np.ndarray) -> Dict[str, float]:
    """
    Every closing price column, generated from a scoreline grid.

    ``apply_margin`` is devig's own inverse, so the prices carry a KNOWN margin
    and the round trip through ``invert_fixture`` is a real test of the corpus
    path rather than of a hand-typed price table.
    """
    home, draw, away = _outcome_probabilities(matrix)
    total = home + draw + away
    home, draw, away = home / total, draw / total, away / total
    rows, columns = np.indices(matrix.shape)
    over = float(matrix[(rows + columns) > 2].sum())

    prices: Dict[str, float] = {}
    for book, booksum in BOOK_MARGINS.items():
        spec = CLOSING_BOOKS[book]
        h2h = apply_margin({"home": home, "draw": draw, "away": away}, booksum)
        totals = apply_margin({"over": over, "under": 1.0 - over}, booksum)
        for side, column in zip(("home", "draw", "away"), spec["h2h"]):
            prices[column] = h2h[side]
        over_column, under_column = spec["totals"][2.5]
        prices[over_column] = totals["over"]
        prices[under_column] = totals["under"]
    return prices


def synthetic_closing_frame(seed: int = 7, rho: float = -0.08) -> pd.DataFrame:
    """
    A ``load_closing_odds``-shaped frame: eight clubs, one round a week.

    Eight rather than twenty so the fits are trivially cheap and no club is left
    goalless in a 20-match window, which would raise ``SeparatedDesignError``
    and make the walk-forward skip rounds for a reason unrelated to the test.
    """
    params = np.random.default_rng([seed, 1])
    goals = np.random.default_rng([seed, 2])
    teams = [f"Club {letter}" for letter in "ABCDEFGH"]
    attack = dict(zip(teams, params.normal(0.0, 0.22, len(teams))))
    defence = dict(zip(teams, params.normal(0.0, 0.22, len(teams))))

    fixtures = [(home, away) for home in teams for away in teams if home != away]
    params.shuffle(fixtures)

    start = pd.Timestamp("2024-08-17")
    per_week = 4
    rows: List[Dict[str, Any]] = []
    for week in range(len(fixtures) // per_week):
        date = start + pd.Timedelta(days=7 * week)
        for home, away in fixtures[week * per_week : (week + 1) * per_week]:
            lam = math.exp(0.15 + attack[home] - defence[away] + 0.26)
            mu = math.exp(0.15 + attack[away] - defence[home])
            matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho, MAX_GOALS)
            home_goals, away_goals = _draw_scoreline(goals, lam, mu, rho)
            row: Dict[str, Any] = {
                "season": "synth",
                "date": date,
                "home_team": home,
                "away_team": away,
                "home_goals": home_goals,
                "away_goals": away_goals,
                "match_id": f"{date.strftime('%Y%m%d')}_{home}_{away}",
            }
            row.update(_price_row(matrix))
            rows.append(row)
    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


class _RecordingFactory:
    """
    A model factory that keeps every frame handed to ``fit``.

    The leakage guard is a property of the LOOP, not of the model, so it cannot
    be unit-tested from either side alone. Capturing the training frames is what
    turns "everything comes from before the round" from a comment into an
    assertion.
    """

    def __init__(self) -> None:
        self.frames: List[pd.DataFrame] = []

    def __call__(self) -> MLEDixonColes:
        model = MLEDixonColes()
        original = model.fit

        def fit(matches: pd.DataFrame, xi=None):
            self.frames.append(matches.copy())
            return original(matches, xi=xi)

        model.fit = fit  # type: ignore[method-assign]
        return model


SYNTHETIC_FRAME = synthetic_closing_frame()

# Built once. Each is 480 fixtures and the grid over them costs ~0.6s, which is
# fine once and is not fine eight times in a setUp.
EXACT_MARKET_CASES = recovery_cases(RECOVERY_SEED, market_is_truth=True)
NOISE_MARKET_CASES = recovery_cases(RECOVERY_SEED, market_is_truth=False)

# One case with a small market/posterior gap, used for the endpoint identities.
# The gap is deliberately inside `blend_log`'s 0.5 residual cap, which is the
# only regime where w = 1 reproduces the market exactly.
NEAR_CASE = FixtureCase(
    match_id="near", season="synthetic", round_label="synthetic-W00",
    home_team="Home", away_team="Away", home_goals=2, away_goals=1,
    lambda_home_dc=1.5, mu_away_dc=1.1, rho=-0.08,
    markets={PROPORTIONAL: _market(1.7, 1.0)},
)


# ── Rounds ───────────────────────────────────────────────────────────────────


class TestRoundBucketing(unittest.TestCase):
    def test_matches_on_one_day_never_split_across_rounds(self):
        """
        The reason rounds are calendar weeks rather than blocks of ten fixtures.
        A block boundary can fall inside a Saturday, and the model fitted
        "before" the later block would then have seen a match kicking off the
        same afternoon.
        """
        labels = round_labels(SYNTHETIC_FRAME)
        by_date = SYNTHETIC_FRAME.assign(label=labels).groupby("date")["label"].nunique()
        self.assertTrue((by_date == 1).all())

    def test_a_round_label_carries_its_season(self):
        """
        Two seasons overlap in ISO week numbers, so a week alone is not a round.
        Without the season the August and May halves of different seasons would
        merge and the walk-forward cutoff would be computed across them.
        """
        frame = pd.DataFrame({
            "season": ["2425", "2526"],
            "date": [pd.Timestamp("2024-09-14"), pd.Timestamp("2025-09-13")],
        })
        self.assertEqual(len(set(round_labels(frame))), 2)


# ── Losses ───────────────────────────────────────────────────────────────────


class TestPrimaryLoss(unittest.TestCase):
    def test_the_loss_is_the_negative_log_of_the_realised_cell(self):
        matrix = BayesianDixonColes.scoreline_matrix(1.6, 1.1, -0.08, MAX_GOALS)
        self.assertAlmostEqual(
            scoreline_log_loss(matrix, 2, 1), -math.log(matrix[2, 1]), places=12
        )

    def test_goals_above_the_grid_edge_are_clipped_not_dropped(self):
        """
        One match in the three-season corpus has an 8-goal score. The grid
        renormalises over 0-7, so its 7 cell already carries the mass at and
        above 7; dropping the match instead would silently shrink the corpus.
        """
        matrix = BayesianDixonColes.scoreline_matrix(1.6, 1.1, -0.08, MAX_GOALS)
        self.assertEqual(
            scoreline_log_loss(matrix, 0, 9), scoreline_log_loss(matrix, 0, 7)
        )

    def test_the_true_rates_beat_perturbed_rates_on_average(self):
        """
        The loss must actually be minimised at the truth, over draws from it.
        This is the property that makes an argmin mean anything; a scoring rule
        that is not proper here would produce a confident wrong weight.
        """
        rng = np.random.default_rng([11, 2])
        lam, mu = 1.55, 1.15
        truth, shifted = 0.0, 0.0
        matrix_truth = BayesianDixonColes.scoreline_matrix(lam, mu, -0.08, MAX_GOALS)
        matrix_shift = BayesianDixonColes.scoreline_matrix(
            lam * 1.35, mu * 0.75, -0.08, MAX_GOALS
        )
        for _ in range(600):
            home_goals, away_goals = _draw_scoreline(rng, lam, mu, -0.08)
            truth += scoreline_log_loss(matrix_truth, home_goals, away_goals)
            shifted += scoreline_log_loss(matrix_shift, home_goals, away_goals)
        self.assertLess(truth, shifted)


class TestSecondaryMetrics(unittest.TestCase):
    def test_crps_is_zero_for_a_point_mass_on_the_realised_total(self):
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        matrix[1, 1] = 1.0
        self.assertAlmostEqual(total_goals_crps(matrix, 2), 0.0, places=12)

    def test_crps_charges_one_unit_per_step_of_a_point_mass_miss(self):
        """Pins the discrete form sum_k (F(k) - 1{y<=k})^2 rather than a rescaling."""
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        matrix[1, 1] = 1.0
        self.assertAlmostEqual(total_goals_crps(matrix, 3), 1.0, places=12)
        self.assertAlmostEqual(total_goals_crps(matrix, 4), 2.0, places=12)

    def test_crps_ignores_the_split_and_sees_only_the_total(self):
        """
        The whole point of reporting it: it isolates the LEVEL, so two grids with
        the same total distribution must score identically however the goals are
        shared out.
        """
        left = BayesianDixonColes.scoreline_matrix(1.8, 1.0, 0.0, MAX_GOALS)
        right = BayesianDixonColes.scoreline_matrix(1.0, 1.8, 0.0, MAX_GOALS)
        for total in range(6):
            self.assertAlmostEqual(
                total_goals_crps(left, total), total_goals_crps(right, total), places=10
            )

    def test_the_outcome_losses_partition_the_probability(self):
        matrix = BayesianDixonColes.scoreline_matrix(1.6, 1.1, -0.08, MAX_GOALS)
        mass = sum(
            math.exp(-outcome_log_loss(matrix, home, away))
            for home, away in ((2, 1), (1, 1), (1, 2))
        )
        self.assertAlmostEqual(mass, 1.0, places=10)

    def test_the_home_clean_sheet_is_the_away_side_failing_to_score(self):
        """
        The side convention, asserted rather than commented. A row/column swap
        here would invert every defender projection while leaving the scoreline
        likelihood untouched, so nothing else in the harness would notice.
        """
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        matrix[:, 0] = 1.0 / (MAX_GOALS + 1)  # the away team never scores
        home_loss, away_loss = clean_sheet_log_losses(matrix, 3, 0)
        self.assertAlmostEqual(home_loss, 0.0, places=9)
        # The away side keeps a clean sheet only in the 0-0 corner of this grid.
        self.assertAlmostEqual(
            away_loss, -math.log(1.0 - 1.0 / (MAX_GOALS + 1)), places=9
        )

    def test_a_conceded_goal_makes_the_home_clean_sheet_loss_large(self):
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        matrix[:, 0] = 1.0 / (MAX_GOALS + 1)
        home_loss, _ = clean_sheet_log_losses(matrix, 1, 1)
        self.assertGreater(home_loss, 20.0)


# ── The grid ─────────────────────────────────────────────────────────────────


class TestGridEndpoints(unittest.TestCase):
    def test_weight_zero_is_the_posterior_untouched(self):
        lam, mu = blended_rates(NEAR_CASE, PROPORTIONAL, 0.0)
        self.assertAlmostEqual(lam, NEAR_CASE.lambda_home_dc, places=12)
        self.assertAlmostEqual(mu, NEAR_CASE.mu_away_dc, places=12)

    def test_weight_one_is_the_market_untouched(self):
        market = NEAR_CASE.markets[PROPORTIONAL]
        lam, mu = blended_rates(NEAR_CASE, PROPORTIONAL, 1.0)
        self.assertAlmostEqual(lam, market.lambda_home, places=12)
        self.assertAlmostEqual(mu, market.mu_away, places=12)

    def test_the_interior_is_the_geometric_interpolation(self):
        market = NEAR_CASE.markets[PROPORTIONAL]
        lam, _ = blended_rates(NEAR_CASE, PROPORTIONAL, 0.4)
        expected = math.exp(
            0.6 * math.log(NEAR_CASE.lambda_home_dc)
            + 0.4 * math.log(market.lambda_home)
        )
        self.assertAlmostEqual(lam, expected, places=12)

    def test_weight_one_stops_short_of_the_market_beyond_the_residual_cap(self):
        """
        Charged rather than claimed. ``blend_log`` caps the applied log deviation
        at 0.5, so on a fixture where the market and the posterior disagree by
        more than that, w = 1 does NOT reproduce the market. Any report reading
        the w = 1 column as "the market alone" is reading it as an upper bound.
        """
        far = FixtureCase(
            match_id="far", season="synthetic", round_label="synthetic-W00",
            home_team="Home", away_team="Away", home_goals=1, away_goals=1,
            lambda_home_dc=1.0, mu_away_dc=1.2, rho=0.0,
            markets={PROPORTIONAL: _market(3.0, 1.2)},
        )
        lam, _ = blended_rates(far, PROPORTIONAL, 1.0)
        self.assertLess(lam, 3.0)
        self.assertAlmostEqual(lam, 1.0 * math.exp(0.5), places=12)

    def test_every_metric_is_finite_at_every_weight_on_the_grid(self):
        """
        Including the corners a real season produces: a goalless draw, a
        seven-goal thrashing, and a score off the edge of the grid.
        """
        for home_goals, away_goals in ((0, 0), (7, 0), (0, 9), (4, 4)):
            case = FixtureCase(
                match_id="edge", season="synthetic", round_label="synthetic-W00",
                home_team="Home", away_team="Away",
                home_goals=home_goals, away_goals=away_goals,
                lambda_home_dc=0.85, mu_away_dc=2.4, rho=0.12,
                markets={PROPORTIONAL: _market(2.1, 0.9)},
            )
            for weight in WEIGHT_GRID:
                metrics = case_metrics(case, PROPORTIONAL, weight)
                for name, value in metrics.items():
                    with self.subTest(score=(home_goals, away_goals),
                                      weight=weight, metric=name):
                        self.assertTrue(math.isfinite(value))

    def test_the_grid_has_both_endpoints_and_a_step_of_five_hundredths(self):
        self.assertEqual(WEIGHT_GRID[0], 0.0)
        self.assertEqual(WEIGHT_GRID[-1], 1.0)
        self.assertEqual(len(WEIGHT_GRID), 21)


class TestTheFlatRegion(unittest.TestCase):
    """
    The argmin alone overstates what the evidence picked out. On the real corpus
    the loss varies by 0.0012 nats across the whole of [0.80, 1.00] — thirty times
    less than the anytime-valid radius — so reporting only "0.95" would present a
    choice inside that span as evidence-driven.
    """

    def test_the_band_is_everything_within_five_percent_of_the_improvement(self):
        grid = (0.0, 0.25, 0.5, 0.75, 1.0)
        curve = np.array([1.0, 0.6, 0.2, 0.04, 0.0])   # improvement 1.0
        self.assertEqual(flat_region(curve, grid), (0.75, 1.0))

    def test_a_curve_with_no_improvement_reports_the_whole_grid(self):
        """
        A market that buys nothing must not be reported as having a narrow
        optimum. With zero improvement the tolerance is zero and only the exact
        minima qualify, which for a flat curve is every weight.
        """
        grid = (0.0, 0.5, 1.0)
        self.assertEqual(flat_region(np.zeros(3), grid), (0.0, 1.0))


class TestRoundAggregation(unittest.TestCase):
    def test_rounds_are_means_not_sums_so_a_big_round_cannot_dominate(self):
        """
        Round sizes run 1 to 20 on the real corpus. Summing would make a
        rearranged midweek programme worth twenty times a single postponed
        fixture in the paired differences the interval is built from.
        """
        cases = [
            FixtureCase(
                match_id=f"m{i}", season="s", round_label="A" if i < 5 else "B",
                home_team="H", away_team="A", home_goals=1, away_goals=1,
                lambda_home_dc=1.4, mu_away_dc=1.2, rho=0.0,
                markets={PROPORTIONAL: _market(1.4, 1.2)},
            )
            for i in range(6)
        ]
        values = np.arange(6, dtype=float).reshape(6, 1)
        labels, means = round_means(cases, values)
        self.assertEqual(labels, ["A", "B"])
        self.assertAlmostEqual(float(means[0, 0]), 2.0)   # mean of 0..4
        self.assertAlmostEqual(float(means[1, 0]), 5.0)


# ── Recovery ─────────────────────────────────────────────────────────────────


class TestTheHarnessCanDistinguish(unittest.TestCase):
    """
    The test the whole harness rests on. Everything else checks arithmetic; this
    checks that the fitted weight tracks the truth rather than the grid's middle.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.exact = build_report(
            EXACT_MARKET_CASES, CorpusDiagnostics(),
            methods=(PROPORTIONAL,), current_value=0.55,
        )
        cls.noise = build_report(
            NOISE_MARKET_CASES, CorpusDiagnostics(),
            methods=(PROPORTIONAL,), current_value=0.55,
        )

    def test_an_exactly_right_market_recovers_a_weight_near_one(self):
        self.assertGreaterEqual(self.exact["headline"]["w_hat"], EXACT_MARKET_FLOOR)
        self.assertTrue(self.exact["intervals"]["vs_w0"]["excludes_zero"])

    def test_a_pure_noise_market_recovers_a_weight_near_zero(self):
        self.assertLessEqual(self.noise["headline"]["w_hat"], NOISE_MARKET_CEILING)
        self.assertTrue(self.noise["intervals"]["vs_w1"]["excludes_zero"])

    def test_the_two_regimes_are_separated_by_more_than_the_grid_can_resolve(self):
        """
        The bound that carries the claim. The two one-sided assertions above can
        each be met by a harness that always answers near the middle; only the
        GAP shows that the fitted weight tracks which input is the truth.
        """
        self.assertGreaterEqual(
            self.exact["headline"]["w_hat"] - self.noise["headline"]["w_hat"],
            MIN_SEPARATION,
        )

    def test_the_loss_curve_is_monotone_toward_the_truth(self):
        """
        Not just the argmin: the whole curve must slope the right way, or an
        argmin at an endpoint could be a numerical artefact at that endpoint.
        """
        curve = np.asarray(self.exact["loss_curve"][PROPORTIONAL])
        self.assertLess(curve[-1], curve[len(curve) // 2])
        self.assertLess(curve[len(curve) // 2], curve[0])
        noisy = np.asarray(self.noise["loss_curve"][PROPORTIONAL])
        self.assertLess(noisy[0], noisy[len(noisy) // 2])
        self.assertLess(noisy[len(noisy) // 2], noisy[-1])


# ── Leakage ──────────────────────────────────────────────────────────────────


class TestNoLeakage(unittest.TestCase):
    def test_the_model_for_a_round_never_saw_that_round(self):
        """
        Asserted by capture, not by reading the loop. The failure this prevents
        is silent and flattering: a model that has seen the results it is being
        scored on makes the statistical component look better, which biases the
        fitted weight DOWNWARD — the mirror image of the stale-refit bias the
        per-round cadence exists to remove.
        """
        spy = _RecordingFactory()
        cases, diagnostics = walk_forward_cases(
            SYNTHETIC_FRAME, methods=(PROPORTIONAL,),
            min_train_matches=20, model_factory=spy,
        )
        self.assertGreater(len(cases), 0)
        self.assertEqual(len(spy.frames), len(diagnostics.fitted_rounds))

        labelled = SYNTHETIC_FRAME.assign(round_label=round_labels(SYNTHETIC_FRAME))
        for label, captured in zip(diagnostics.fitted_rounds, spy.frames):
            target = labelled[labelled["round_label"] == label]
            with self.subTest(round=label):
                self.assertLess(captured["date"].max(), target["date"].min())
                self.assertEqual(
                    set(captured["match_id"]) & set(target["match_id"]), set()
                )

    def test_no_scored_fixture_appears_in_its_own_training_window(self):
        spy = _RecordingFactory()
        cases, diagnostics = walk_forward_cases(
            SYNTHETIC_FRAME, methods=(PROPORTIONAL,),
            min_train_matches=20, model_factory=spy,
        )
        trained = dict(zip(diagnostics.fitted_rounds, spy.frames))
        for case in cases:
            with self.subTest(match=case.match_id):
                self.assertNotIn(
                    case.match_id, set(trained[case.round_label]["match_id"])
                )

    def test_every_round_is_accounted_for(self):
        """
        A round that vanished — skipped for a reason nobody counted — changes the
        corpus the weight is fitted on without changing anything a reader sees.
        """
        _, diagnostics = walk_forward_cases(
            SYNTHETIC_FRAME, methods=(PROPORTIONAL,), min_train_matches=20
        )
        self.assertGreater(diagnostics.n_rounds_burn_in, 0)
        self.assertEqual(
            diagnostics.n_rounds_burn_in
            + diagnostics.n_rounds_unfittable
            + len(diagnostics.fitted_rounds),
            diagnostics.n_rounds_total,
        )


# ── Thin-ness ────────────────────────────────────────────────────────────────


class TestThinnessIsNeutralised(unittest.TestCase):
    def test_the_corpus_hands_the_grid_markets_at_full_weight(self):
        cases, _ = walk_forward_cases(
            SYNTHETIC_FRAME, methods=(PROPORTIONAL,), min_train_matches=20
        )
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(match=case.match_id):
                self.assertEqual(case.markets[PROPORTIONAL].weight, 1.0)

    def test_the_neutralisation_is_doing_real_work(self):
        """
        Not a vacuous assertion: the raw two-book inversion really does come back
        discounted, so without the neutralisation w would absorb the corpus'
        thin coverage and would not transfer to production's ~10 books.
        """
        from pipeline.data.football_data import closing_market

        row = SYNTHETIC_FRAME.iloc[0]
        h2h, totals = closing_market(row)
        raw = invert_fixture(h2h, totals, -0.08, devig_method=PROPORTIONAL)
        self.assertEqual(raw.status, STATUS_CONVERGED)
        self.assertLess(raw.weight, 1.0)


# ── De-vig choice ────────────────────────────────────────────────────────────


class TestDevigComparison(unittest.TestCase):
    def test_identical_markets_keep_proportional_the_simplest(self):
        """
        Zero difference must NOT read as a winner. The interval is exactly
        [0, 0], which does not exclude zero, so the finding has to be "keep
        proportional" rather than a coin-flip between three tied methods.
        """
        cases = [
            FixtureCase(
                match_id=f"m{i}", season="s", round_label=f"R{i // 4:02d}",
                home_team="H", away_team="A", home_goals=i % 3, away_goals=(i + 1) % 3,
                lambda_home_dc=1.4, mu_away_dc=1.2, rho=-0.05,
                markets={method: _market(1.6, 1.05) for method in
                         (PROPORTIONAL, POWER, SHIN)},
            )
            for i in range(48)
        ]
        tables = {
            method: metric_table(cases, method, WEIGHT_GRID)
            for method in (PROPORTIONAL, POWER, SHIN)
        }
        comparison = devig_comparison(cases, tables, WEIGHT_GRID)
        self.assertEqual(comparison["recommended_method"], PROPORTIONAL)
        self.assertIn("simplest", comparison["finding"])
        for pair in comparison["pairs"]:
            self.assertFalse(pair["excludes_zero"])

    def test_the_comparison_needs_the_market_only_endpoint(self):
        """
        At a production weight the de-vig choice is buried under the Dixon-Coles
        component, so a grid without w = 1 cannot identify it and must say so
        rather than compare at whatever endpoint it has.
        """
        cases = recovery_cases(seed=5, market_is_truth=True)[:40]
        tables = {PROPORTIONAL: metric_table(cases, PROPORTIONAL, (0.0, 0.5))}
        with self.assertRaises(ValueError):
            devig_comparison(cases, tables, (0.0, 0.5))


# ── The report ───────────────────────────────────────────────────────────────


class TestTheReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = build_report(
            EXACT_MARKET_CASES,
            CorpusDiagnostics(
                n_rounds_total=46, n_rounds_burn_in=6,
                n_rounds_scored=RECOVERY_ROUNDS,
                n_fixtures_seen=len(EXACT_MARKET_CASES),
            ),
            methods=(PROPORTIONAL,),
            current_value=0.55,
        )

    def test_both_caveats_appear_verbatim(self):
        """
        They bound how the number may be used, so they travel WITH the number.
        A caveat that lives only in a docstring is not attached to the artifact
        somebody reads six months later.
        """
        self.assertIn(CAVEAT_CLOSING_LINE, self.report["caveats"])
        self.assertIn(CAVEAT_THIN_BOOKS, self.report["caveats"])

    def test_the_caveats_name_the_upper_bound_and_the_separation(self):
        blob = " ".join(self.report["caveats"])
        self.assertIn("UPPER BOUND", blob)
        self.assertIn("effective = w * market.weight", blob)
        # The third bias, found by running it rather than by designing it.
        self.assertIn(CAVEAT_MLE_SUBSTITUTE, self.report["caveats"])

    def test_the_report_round_trips_through_json(self):
        """
        An infinite anytime-valid radius is a real answer at fewer than ten
        rounds, and ``json.dumps`` emits a bare ``Infinity`` that no strict
        parser will read back.
        """
        restored = json.loads(json.dumps(self.report), parse_constant=_reject)
        self.assertEqual(restored["n_matches"], self.report["n_matches"])

    def test_the_report_carries_the_grid_the_argmin_and_the_intervals(self):
        self.assertEqual(self.report["weight_grid"], list(WEIGHT_GRID))
        self.assertEqual(
            len(self.report["loss_curve"][PROPORTIONAL]), len(WEIGHT_GRID)
        )
        self.assertIn(self.report["headline"]["w_hat"], WEIGHT_GRID)
        for key in ("vs_w0", "vs_w1"):
            self.assertIn("lower", self.report["intervals"][key])

    def test_the_recommendation_haircuts_the_fitted_weight(self):
        recommendation = self.report["recommendation"]
        self.assertLess(
            recommendation["recommended_value"], recommendation["fitted_argmin"]
        )
        self.assertIn("Haircut", recommendation["note"])

    def test_the_recommendation_snaps_down_and_never_up(self):
        """
        Both known biases push the fitted weight up, so the grid's own resolution
        has to be spent toward the posterior. Rounding to nearest would let a
        0.9x argmin come back ABOVE its own haircut value.
        """
        recommendation = self.report["recommendation"]
        self.assertLessEqual(
            recommendation["recommended_value"],
            recommendation["haircut_before_snapping"],
        )
        self.assertIn(recommendation["recommended_value"], WEIGHT_GRID)

    def test_both_haircuts_are_charged(self):
        recommendation = self.report["recommendation"]
        expected = (
            recommendation["fitted_argmin"]
            * (1.0 - recommendation["closing_line_haircut"])
            * (1.0 - recommendation["mle_substitute_haircut"])
        )
        self.assertAlmostEqual(
            recommendation["haircut_before_snapping"], expected, places=4
        )

    def test_the_indistinguishable_band_contains_the_argmin(self):
        low, high = self.report["headline"]["indistinguishable_band"]
        self.assertLessEqual(low, self.report["headline"]["w_hat"])
        self.assertGreaterEqual(high, self.report["headline"]["w_hat"])

    def test_the_secondary_metrics_are_reported_at_the_argmin_and_the_endpoints(self):
        secondary = self.report["secondary_metrics"]
        for where in ("at_w_hat", "at_w0", "at_w1"):
            self.assertIn("total_crps", secondary[where])
            self.assertIn("home_cs_nll", secondary[where])
        self.assertIn("verdict", secondary["agreement"])

    def test_a_fold_is_reported_per_season(self):
        seasons = {fold["season"] for fold in self.report["per_season"]}
        self.assertEqual(seasons, {"synthetic"})

    def test_an_empty_corpus_is_refused_rather_than_reported(self):
        with self.assertRaises(ValueError):
            build_report([], CorpusDiagnostics(), methods=(PROPORTIONAL,))


def _reject(name: str) -> float:
    raise AssertionError(f"non-finite JSON constant {name!r} in the report")


class TestTheEntryPointProtectsPredictions(unittest.TestCase):
    def test_writing_into_predictions_is_refused(self):
        """
        ``predictions/`` is uploaded to Supabase and read by the frontend, so a
        research artifact dropped there would look like a shipped contract.
        Refused before the fit runs, not after.
        """
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                main(["--out", "predictions/market_blend_weight.json"])
        self.assertIn("predictions", stderr.getvalue())

    def test_the_default_report_path_is_outside_the_repo(self):
        from pipeline.learning.fit_market_blend import DEFAULT_REPORT_PATH

        self.assertNotIn("predictions", DEFAULT_REPORT_PATH.parts)
        self.assertTrue(
            str(DEFAULT_REPORT_PATH).startswith(tempfile.gettempdir())
        )


if __name__ == "__main__":
    unittest.main()
