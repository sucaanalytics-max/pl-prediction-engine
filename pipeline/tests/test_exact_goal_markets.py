"""
Goals markets on the value-bet path are exact, not simulated.

Measured 2026-10-25 on the GW8 fixtures: at the CI setting of 5,000 simulations
the Monte Carlo standard error of a 1X2/totals probability was ~0.69pp against a
5pp minimum edge, and the card changed with the seed. The goals markets are now
the Dixon-Coles scoreline grid averaged over every posterior draw
(``pipeline/simulation/exact_markets.py``); only corners and cards, which are
conditioned on simulated goals, are still simulated.

These tests pin:

* the exact grid is the expectation of what the simulator draws: it agrees with
  a high-n simulation of the same posterior, market by market, within MC error;
* every market's outcomes sum to 1, with no renormalisation hiding a bug;
* the goals markets do not depend on the seed or on ``n_sims``;
* the rho contract: the core takes aligned (lam, mu, rho) triples, so pairing
  versus independence is the caller's choice, and the independent-rho shortcut
  equals the brute-force Cartesian product, floored draws included;
* corners and cards stay seeded and reproducible;
* failures raise instead of falling back to simulated numbers.
"""
import math
import unittest

import numpy as np
from scipy.stats import poisson

from pipeline.config import ENSEMBLE_WEIGHTS
from pipeline.models.cards_zip import CardsZIPModel
from pipeline.models.corners_negbin import CornersNegBinModel
from pipeline.simulation.exact_markets import (
    METHOD_POISSON_GRID,
    METHOD_POSTERIOR_GRID,
    ExactMarketsError,
    goal_markets_from_grid,
    independent_poisson_grid,
    independent_rho_scoreline_grid,
    scoreline_grid_mixture,
)
from pipeline.simulation.fixture_sim import fixture_rng, simulate_fixture
from pipeline.simulation.montecarlo import (
    DC_SAMPLING_MAX_GOALS,
    MonteCarloSimulator,
    dc_joint_flat,
)
from pipeline.tests.test_value_path_determinism import MATCH_ID, _fake_dc
from pipeline.validation.artifacts import validate_prediction_output

WIDTH = DC_SAMPLING_MAX_GOALS + 1
GOAL_KEYS = ("1x2", "over_under", "btts", "clean_sheet", "correct_score", "asian_handicap", "ht_ft")


def _goal_probability_cells(markets):
    """Every goals-only probability as {(market, outcome): p}."""
    p = markets["probabilities"]
    cells = {("1x2", k): v for k, v in p["1x2"].items()}
    for line, d in p["over_under"].items():
        cells[("ou", line)] = d["over"]
    cells[("btts", "yes")] = p["btts"]["yes"]
    for key in ("clean_sheet", "correct_score", "asian_handicap", "ht_ft"):
        cells.update({(key, k): v for k, v in p[key].items()})
    return cells


def _synthetic_posterior(n=2000, seed=7):
    gen = np.random.default_rng(seed)
    lam = np.exp(gen.normal(np.log(1.55), 0.12, n))
    mu = np.exp(gen.normal(np.log(1.05), 0.12, n))
    rho = gen.normal(-0.07, 0.07, n)
    return lam, mu, rho


class GridAgainstSimulationTests(unittest.TestCase):
    """The exact grid is the expectation of the simulator, not a new model."""

    N_SIMS = 60_000

    def test_exact_markets_match_a_high_n_simulation_of_the_same_posterior(self):
        lam, mu, rho = _synthetic_posterior()
        exact = goal_markets_from_grid(independent_rho_scoreline_grid(lam, mu, rho))

        # The simulator's own path: resample the posterior, rho on its own
        # indices (today's semantics), draw scorelines, count.
        idx = np.random.default_rng(1).choice(lam.size, self.N_SIMS, replace=True)
        sim = MonteCarloSimulator(self.N_SIMS)
        mc = sim.derive_all_markets(
            sim.simulate_from_posterior(
                lam[idx], mu[idx], rho_samples=rho, rng=np.random.default_rng(2)
            )
        )

        e_cells, m_cells = _goal_probability_cells(exact), _goal_probability_cells(mc)
        self.assertEqual(set(e_cells), set(m_cells))
        worst = 0.0
        for key, pe in e_cells.items():
            se = math.sqrt(max(pe * (1 - pe), 1e-12) / self.N_SIMS)
            z = abs(m_cells[key] - pe) / se
            worst = max(worst, z)
            # Deterministic seeds, so this cannot flake; 4.5 SE over ~90 cells
            # would fail only on a real discrepancy.
            self.assertLess(z, 4.5, f"{key}: exact {pe:.5f} vs MC {m_cells[key]:.5f}")
        self.assertGreater(worst, 0.0)
        for side in ("home", "away"):
            self.assertAlmostEqual(
                exact["expected_goals"][side], mc["expected_goals"][side], delta=0.02
            )

    def test_fixture_path_matches_the_simulated_path_it_replaced(self):
        """
        The whole wiring: DC point rate, blend, recentring and rho semantics.
        Reconstruct the pre-change goals path by hand at high n and compare.
        """
        dc = _fake_dc()
        other = {"xgboost": (1.9, 1.0), "penaltyblog": (1.7, 1.05)}
        result = simulate_fixture(
            MonteCarloSimulator(200), match_id=MATCH_ID, home="Arsenal", away="Everton",
            dc_model=dc, other_lambdas=other, weights=ENSEMBLE_WEIGHTS,
        )
        self.assertTrue(result.from_posterior)
        self.assertEqual(result.goal_markets_method, METHOD_POSTERIOR_GRID)

        lam_s, mu_s = dc.get_lambda_mu_samples("Arsenal", "Everton", self.N_SIMS, rng=np.random.default_rng(3))
        rates = {"dixon_coles": (lam_s.mean(), mu_s.mean()), **other}
        w = sum(ENSEMBLE_WEIGHTS[m] for m in rates)
        lam_b = sum(ENSEMBLE_WEIGHTS[m] * r[0] for m, r in rates.items()) / w
        mu_b = sum(ENSEMBLE_WEIGHTS[m] * r[1] for m, r in rates.items()) / w
        self.assertAlmostEqual(result.lambda_h, lam_b, delta=0.01)
        self.assertAlmostEqual(result.mu_a, mu_b, delta=0.01)

        sim = MonteCarloSimulator(self.N_SIMS)
        mc = sim.derive_all_markets(sim.simulate_from_posterior(
            lam_s * (lam_b / lam_s.mean()), mu_s * (mu_b / mu_s.mean()),
            rho_samples=dc.get_rho_samples(), rng=np.random.default_rng(4),
        ))
        for key, pe in _goal_probability_cells(result.markets).items():
            se = math.sqrt(max(pe * (1 - pe), 1e-12) / self.N_SIMS)
            self.assertLess(abs(_goal_probability_cells(mc)[key] - pe) / se, 4.5, key)

    def test_no_posterior_grid_is_the_expectation_of_simulate_match(self):
        grid = independent_poisson_grid(1.6, 1.1)
        goals = np.arange(grid.shape[0])
        expected_draw = float((poisson.pmf(goals, 1.6) * poisson.pmf(goals, 1.1)).sum())
        markets = goal_markets_from_grid(grid)
        self.assertAlmostEqual(markets["probabilities"]["1x2"]["draw"], expected_draw, places=12)
        self.assertAlmostEqual(markets["expected_goals"]["home"], 1.6, places=9)


class ProbabilityContractTests(unittest.TestCase):
    def setUp(self):
        lam, mu, rho = _synthetic_posterior()
        self.markets = goal_markets_from_grid(independent_rho_scoreline_grid(lam, mu, rho))
        self.p = self.markets["probabilities"]

    def test_each_market_sums_to_one(self):
        self.assertAlmostEqual(sum(self.p["1x2"].values()), 1.0, places=12)
        for line, d in self.p["over_under"].items():
            self.assertAlmostEqual(d["over"] + d["under"], 1.0, places=12, msg=line)
        self.assertAlmostEqual(self.p["btts"]["yes"] + self.p["btts"]["no"], 1.0, places=12)
        self.assertAlmostEqual(sum(self.p["ht_ft"].values()), 1.0, places=12)
        # goals_home is the 0..7 export, as in derive_all_markets: the 8+ tail
        # is left out, not folded in. Its sum is 1 - P(home >= 8), exactly.
        lam, mu, rho = _synthetic_posterior()
        grid = independent_rho_scoreline_grid(lam, mu, rho)
        self.assertAlmostEqual(
            sum(self.markets["distributions"]["goals_home"]), 1.0 - grid[8:].sum(), places=12
        )

    def test_internally_consistent_with_one_grid(self):
        """1X2, totals and BTTS are functionals of the same grid."""
        self.assertAlmostEqual(self.p["asian_handicap"]["home_0"], self.p["1x2"]["home"], places=12)
        self.assertAlmostEqual(
            sum(v for k, v in self.p["ht_ft"].items() if k.endswith("/D")), self.p["1x2"]["draw"], places=12
        )
        self.assertAlmostEqual(self.p["over_under"]["0.5"]["under"], self.p["correct_score"]["0-0"], places=12)
        values = [self.p["asian_handicap"][f"home_{x}"] for x in (-2.5, -1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5, 2.5)]
        self.assertEqual(values, sorted(values))

    def test_a_fixture_output_passes_the_artifact_validator(self):
        result = simulate_fixture(
            MonteCarloSimulator(300), match_id=MATCH_ID, home="Arsenal", away="Everton",
            dc_model=_fake_dc(), other_lambdas={}, weights=ENSEMBLE_WEIGHTS,
        )
        output = {
            "metadata": {"season": "2026-27", "n_simulations": 300},
            "predictions": [{"match_id": MATCH_ID, **result.markets, "value_bets": []}],
        }
        self.assertEqual(validate_prediction_output(output), [])
        self.assertEqual(result.markets["n_simulations"], 300)
        self.assertEqual(result.markets["goal_markets"]["method"], METHOD_POSTERIOR_GRID)
        self.assertEqual(result.markets["goal_markets"]["n_posterior_draws"], 1200)
        self.assertEqual(result.markets["goal_markets"]["rho"], "independent")


def _run(n_sims=500, base_seed=None, dc=None):
    return simulate_fixture(
        MonteCarloSimulator(n_sims), match_id=MATCH_ID, home="Arsenal", away="Everton",
        dc_model=_fake_dc() if dc is None else dc,
        other_lambdas={"xgboost": (1.9, 1.0), "penaltyblog": (1.7, 1.05)},
        weights=ENSEMBLE_WEIGHTS,
        sim_kwargs=dict(
            corners_model=CornersNegBinModel(), cards_model=CardsZIPModel(),
            home_team="Arsenal", away_team="Everton", referee=None, is_derby=False,
        ),
        rng=None if base_seed is None else fixture_rng(MATCH_ID, base_seed),
    )


class DeterminismTests(unittest.TestCase):
    def test_goals_markets_do_not_depend_on_seed_or_n_sims(self):
        runs = [_run(500), _run(500, base_seed=1), _run(500, base_seed=2), _run(4000)]
        base = runs[0].markets
        for other in runs[1:]:
            for key in GOAL_KEYS:
                self.assertEqual(base["probabilities"][key], other.markets["probabilities"][key], key)
            self.assertEqual(base["expected_goals"], other.markets["expected_goals"])
            self.assertEqual(base["confidence"], other.markets["confidence"])
            self.assertEqual(runs[0].lambda_h, other.lambda_h)
            self.assertEqual(runs[0].mu_a, other.mu_a)

    def test_corners_and_cards_stay_seeded_and_reproducible(self):
        a, b = _run(2000), _run(2000)
        self.assertEqual(a.markets, b.markets)
        c = _run(2000, base_seed=99)
        self.assertNotEqual(a.markets["probabilities"]["corners"], c.markets["probabilities"]["corners"])
        self.assertNotEqual(a.markets["probabilities"]["cards"], c.markets["probabilities"]["cards"])
        self.assertEqual(a.markets["probabilities"]["1x2"], c.markets["probabilities"]["1x2"])
        self.assertEqual(a.markets["n_simulations"], 2000)

    def test_posterior_accessor_agrees_with_the_resampler_draw_for_draw(self):
        dc = _fake_dc()
        for home, away in (("Arsenal", "Everton"), ("Arsenal", "Promoted FC")):
            lam_all, mu_all = dc.get_lambda_mu_posterior(home, away)
            self.assertEqual(lam_all.size, dc.get_rho_samples().size)
            idx = np.random.default_rng(5).choice(lam_all.size, 700, replace=True)
            lam_s, mu_s = dc.get_lambda_mu_samples(home, away, 700, rng=np.random.default_rng(5))
            np.testing.assert_array_equal(lam_s, lam_all[idx])
            np.testing.assert_array_equal(mu_s, mu_all[idx])


class RhoContractTests(unittest.TestCase):
    """Aligned triples in; pairing versus independence is the caller's choice."""

    def setUp(self):
        gen = np.random.default_rng(11)
        self.lam = np.exp(gen.normal(np.log(1.5), 0.2, 40))
        self.mu = np.exp(gen.normal(np.log(1.1), 0.2, 40))
        self.rho = gen.normal(-0.07, 0.08, 25)

    def test_paired_is_the_mean_of_per_draw_grids(self):
        rho = self.rho[np.arange(40) % 25]
        brute = dc_joint_flat(self.lam, self.mu, rho).mean(axis=0).reshape(WIDTH, WIDTH)
        np.testing.assert_allclose(scoreline_grid_mixture(self.lam, self.mu, rho), brute, atol=1e-15)

    def _cartesian(self, lam, mu, rho):
        return scoreline_grid_mixture(
            np.repeat(lam, rho.size), np.repeat(mu, rho.size), np.tile(rho, lam.size)
        )

    def test_independent_equals_the_cartesian_product(self):
        np.testing.assert_allclose(
            independent_rho_scoreline_grid(self.lam, self.mu, self.rho),
            self._cartesian(self.lam, self.mu, self.rho), atol=1e-14,
        )

    def test_independent_is_exact_where_the_zero_floor_binds(self):
        """
        tau(0,0) = 1 - lam*mu*rho < 0 for lam*mu = 12 and rho = 0.2; 1 + mu*rho
        < 0 for mu = 4.5 and rho = -0.3. Floored draws are not affine in rho, so
        the mean-rho shortcut would be wrong for them; they must be expanded.
        """
        lam = np.concatenate([self.lam, [4.0, 1.2]])
        mu = np.concatenate([self.mu, [3.0, 4.5]])
        rho = np.concatenate([self.rho, [0.2, -0.3]])
        floored = dc_joint_flat(np.full(rho.size, 4.0), np.full(rho.size, 3.0), rho)
        self.assertTrue(np.any((1 - 12.0 * rho) < 0), "vacuous: no floor binds")
        brute = self._cartesian(lam, mu, rho)
        np.testing.assert_allclose(independent_rho_scoreline_grid(lam, mu, rho), brute, atol=1e-14)
        # The naive mean-rho shortcut is NOT exact here, which is why it is not used.
        naive = scoreline_grid_mixture(lam, mu, np.full(lam.size, rho.mean()))
        self.assertGreater(np.abs(naive - brute).max(), 1e-6)
        self.assertEqual(floored.shape[0], rho.size)

    def test_without_a_floor_the_grid_is_affine_in_rho(self):
        """The property the independent shortcut relies on, verified not assumed."""
        lam, mu = np.full(25, 1.7), np.full(25, 1.2)
        per_rho = dc_joint_flat(lam, mu, self.rho).mean(axis=0)
        at_mean = dc_joint_flat(lam[:1], mu[:1], np.array([self.rho.mean()]))[0]
        np.testing.assert_allclose(per_rho, at_mean, atol=1e-15)

    def test_pairing_is_a_real_choice_when_rho_correlates_with_the_rates(self):
        rho = -0.2 + 0.1 * (self.lam - self.lam.mean()) / self.lam.std()
        paired = scoreline_grid_mixture(self.lam, self.mu, rho)
        independent = independent_rho_scoreline_grid(self.lam, self.mu, rho)
        self.assertGreater(np.abs(paired - independent).max(), 1e-5)

    def test_misaligned_triples_are_rejected(self):
        with self.assertRaises(ExactMarketsError):
            scoreline_grid_mixture(self.lam, self.mu, self.rho)


class FailLoudlyTests(unittest.TestCase):
    def test_non_finite_rates_raise(self):
        lam, mu, rho = _synthetic_posterior(50)
        lam[3] = np.nan
        with self.assertRaises(ExactMarketsError):
            independent_rho_scoreline_grid(lam, mu, rho)

    def test_a_posterior_without_rho_raises_rather_than_simulating(self):
        dc = _fake_dc()
        dc.get_rho_samples = lambda: np.array([])
        with self.assertRaises(ExactMarketsError):
            _run(200, dc=dc)

    def test_no_posterior_is_logged_and_recorded(self):
        with self.assertLogs("pipeline.simulation.fixture_sim", level="WARNING") as logs:
            result = simulate_fixture(
                MonteCarloSimulator(300), match_id=MATCH_ID, home="Arsenal", away="Everton",
                dc_model=None, other_lambdas={"xgboost": (1.6, 1.1)}, weights=ENSEMBLE_WEIGHTS,
            )
        self.assertTrue(any("no Dixon-Coles posterior" in line for line in logs.output))
        self.assertFalse(result.from_posterior)
        self.assertEqual(result.goal_markets_method, METHOD_POISSON_GRID)
        self.assertEqual(result.markets["goal_markets"]["method"], METHOD_POISSON_GRID)
        expected = goal_markets_from_grid(independent_poisson_grid(1.6, 1.1))
        self.assertEqual(result.markets["probabilities"]["1x2"], expected["probabilities"]["1x2"])


if __name__ == "__main__":
    unittest.main()
