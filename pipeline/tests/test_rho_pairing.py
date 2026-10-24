"""
rho must come from the SAME posterior draw as the (lambda, mu) it corrects.

The value-bet predictive is ``E_theta[DC(score | lambda(theta), mu(theta),
rho(theta))]`` over the joint posterior of ``theta = (attack, defence,
home_adv, intercept, rho)``. Until 2026-10-25 ``simulate_from_posterior`` drew
rho with its own indices over the raw trace, which integrates over the product
of the marginals ``p(lambda, mu) p(rho)`` instead — wrong whenever rho is
correlated with the rates, and contrary to the ``get_rho_samples`` docstring,
which promised elementwise pairing nobody did. Measured on the GW8 posterior the
correlation is small (|r| <= 0.07) and the card-level effect is below Monte
Carlo noise, so this is a correctness fix, not a re-tune.

These tests pin:

* the pairing itself — with a trace where rho and the rates both encode the
  draw index, every simulated draw's rho is the rho of its own draw;
* the pairing is explicit, never inferred from equal lengths;
* lambda and mu are untouched by pairing, and the unpaired and legacy
  (np.random) paths keep their draw order bit-for-bit;
* the six child streams keep their identity, so a paired-vs-unpaired diff is
  the rho change and nothing else (common random numbers);
* ``get_lambda_mu_samples``'s two-value return, which ``fixture_rates`` unpacks.
"""
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from pipeline.config import ENSEMBLE_WEIGHTS
from pipeline.models.cards_zip import CardsZIPModel
from pipeline.models.corners_negbin import CornersNegBinModel
from pipeline.models.dixon_coles import BayesianDixonColes
from pipeline.simulation import montecarlo
from pipeline.simulation.fixture_sim import fixture_rng, simulate_fixture
from pipeline.simulation.montecarlo import MonteCarloSimulator, resolve_rng, sample_dixon_coles

MATCH_ID = "20261025_Arsenal_Everton"
CHAINS, DRAWS = 2, 600
N_DRAWS = CHAINS * DRAWS
#: intercept[k] = STEP * k with every other rate parameter 0, so
#: lambda = mu = exp(STEP * k) and the draw index is recoverable from a rate.
STEP = 1e-4


def _var(arr):
    return SimpleNamespace(values=arr)


def _indexed_dc():
    """A posterior where the draw index k is readable from both the rates and rho."""
    k = np.arange(N_DRAWS, dtype=float).reshape(CHAINS, DRAWS)
    teams = ["Arsenal", "Everton"]
    model = BayesianDixonColes()
    model.teams = teams
    model.n_teams = len(teams)
    model.team_index = {t: i for i, t in enumerate(teams)}
    model.trace = SimpleNamespace(posterior={
        "attack": _var(np.zeros((CHAINS, DRAWS, 2))),
        "defence": _var(np.zeros((CHAINS, DRAWS, 2))),
        "home_adv": _var(np.zeros((CHAINS, DRAWS))),
        "intercept": _var(STEP * k),
        # rho a strictly monotone function of the draw: perfectly correlated
        # with intercept, the case where product-of-marginals is most wrong.
        "rho": _var(-0.2 + 0.4 * k / (N_DRAWS - 1)),
    })
    return model


def _draw_of(rate):
    return np.rint(np.log(rate) / STEP).astype(int)


def _rho_of_draw(k):
    return -0.2 + 0.4 * k / (N_DRAWS - 1)


class PairedPosteriorSamplesTests(unittest.TestCase):
    def setUp(self):
        self.dc = _indexed_dc()

    def test_rho_is_from_the_same_draw_as_lambda_and_mu(self):
        lam, mu, rho = self.dc.get_paired_posterior_samples(
            "Arsenal", "Everton", 3000, rng=np.random.default_rng(1)
        )
        k = _draw_of(lam)
        np.testing.assert_array_equal(k, _draw_of(mu))
        np.testing.assert_allclose(rho, _rho_of_draw(k), atol=1e-12)
        # Non-vacuous: the samples span many distinct draws.
        self.assertGreater(len(np.unique(k)), 500)

    def test_pairing_does_not_move_lambda_or_mu(self):
        lam, mu, _ = self.dc.get_paired_posterior_samples(
            "Arsenal", "Everton", 3000, rng=np.random.default_rng(1)
        )
        lam2, mu2 = self.dc.get_lambda_mu_samples(
            "Arsenal", "Everton", 3000, rng=np.random.default_rng(1)
        )
        np.testing.assert_array_equal(lam, lam2)
        np.testing.assert_array_equal(mu, mu2)

    def test_return_indices_matches_the_rates(self):
        lam, mu, idx = self.dc.get_lambda_mu_samples(
            "Arsenal", "Everton", 500, rng=np.random.default_rng(2), return_indices=True
        )
        np.testing.assert_array_equal(idx, _draw_of(lam))
        np.testing.assert_array_equal(self.dc.get_rho_samples()[idx], _rho_of_draw(idx))

    def test_default_return_is_two_arrays_on_legacy_global_state(self):
        """fixture_rates unpacks ``lam, mu = get_lambda_mu_samples(h, a, n)``."""
        np.random.seed(77)
        out = self.dc.get_lambda_mu_samples("Arsenal", "Everton", 400)
        self.assertEqual(len(out), 2)
        np.random.seed(77)
        expected_idx = np.random.choice(N_DRAWS, size=400, replace=True)
        np.testing.assert_array_equal(_draw_of(out[0]), expected_idx)

    def test_misaligned_rho_trace_fails_loudly(self):
        self.dc.trace.posterior["rho"] = _var(np.zeros((CHAINS, DRAWS + 1)))
        with self.assertRaises(ValueError):
            self.dc.get_paired_posterior_samples(
                "Arsenal", "Everton", 100, rng=np.random.default_rng(0)
            )


def _capture_dc_draws():
    """Patch sample_dixon_coles to record the (lam, mu, rho) it was given."""
    captured = {}
    real = sample_dixon_coles

    def spy(lam, mu, rho, rng=None, **kw):
        captured.update(lam=np.array(lam), mu=np.array(mu), rho=np.array(rho))
        return real(lam, mu, rho, rng=rng, **kw)

    return captured, mock.patch.object(montecarlo, "sample_dixon_coles", side_effect=spy)


class SimulateFromPosteriorPairingTests(unittest.TestCase):
    def setUp(self):
        self.dc = _indexed_dc()
        self.lam, self.mu, self.rho = self.dc.get_paired_posterior_samples(
            "Arsenal", "Everton", 2000, rng=np.random.default_rng(4)
        )
        self.sim = MonteCarloSimulator(2000)

    def test_paired_path_uses_each_draws_own_rho(self):
        captured, patch = _capture_dc_draws()
        with patch:
            self.sim.simulate_from_posterior(
                self.lam, self.mu, rho_samples=self.rho, rho_paired=True,
                rng=np.random.default_rng(9),
            )
        k = _draw_of(captured["lam"])
        np.testing.assert_allclose(captured["rho"], _rho_of_draw(k), atol=1e-12)

    def test_equal_length_alone_is_not_pairing(self):
        """rho_paired defaults to False: same-length rho is still drawn on its own indices."""
        self.assertEqual(len(self.rho), len(self.lam))
        captured, patch = _capture_dc_draws()
        with patch:
            self.sim.simulate_from_posterior(
                self.lam, self.mu, rho_samples=self.rho, rng=np.random.default_rng(9),
            )
        k = _draw_of(captured["lam"])
        matched = np.isclose(captured["rho"], _rho_of_draw(k), atol=1e-12).mean()
        self.assertLess(matched, 0.05)

    def test_paired_requires_one_rho_per_rate_sample(self):
        with self.assertRaises(ValueError):
            self.sim.simulate_from_posterior(
                self.lam, self.mu, rho_samples=self.rho[:-1], rho_paired=True,
                rng=np.random.default_rng(9),
            )
        with self.assertRaises(ValueError):
            self.sim.simulate_from_posterior(
                self.lam, self.mu, rho_samples=None, rho_paired=True,
                rng=np.random.default_rng(9),
            )

    def test_unpaired_generator_path_draw_order_is_unchanged(self):
        """Bit-for-bit the pre-pairing stream layout: index, rho, goals, ..."""
        rho_trace = self.dc.get_rho_samples()
        n = len(self.lam)
        index_rng, rho_rng, goal_rng, *_ = np.random.default_rng(13).spawn(6)
        idx = index_rng.choice(n, size=n, replace=True)
        rho_idx = rho_rng.choice(len(rho_trace), size=n, replace=True)
        expected = sample_dixon_coles(self.lam[idx], self.mu[idx], rho_trace[rho_idx], rng=goal_rng)

        sims = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=rho_trace, rng=np.random.default_rng(13)
        )
        np.testing.assert_array_equal(sims["home_goals"], expected[0])
        np.testing.assert_array_equal(sims["away_goals"], expected[1])

    def test_unpaired_legacy_global_state_draw_order_is_unchanged(self):
        rho_trace = self.dc.get_rho_samples()
        n = len(self.lam)
        np.random.seed(21)
        idx = np.random.choice(n, size=n, replace=True)
        rho_idx = np.random.choice(len(rho_trace), size=n, replace=True)
        expected = sample_dixon_coles(self.lam[idx], self.mu[idx], rho_trace[rho_idx], rng=resolve_rng(None))

        np.random.seed(21)
        sims = self.sim.simulate_from_posterior(self.lam, self.mu, rho_samples=rho_trace)
        np.testing.assert_array_equal(sims["home_goals"], expected[0])
        np.testing.assert_array_equal(sims["away_goals"], expected[1])

    def test_paired_legacy_global_state_takes_no_rho_draw(self):
        n = len(self.lam)
        np.random.seed(21)
        idx = np.random.choice(n, size=n, replace=True)
        expected = sample_dixon_coles(self.lam[idx], self.mu[idx], self.rho[idx], rng=resolve_rng(None))

        np.random.seed(21)
        sims = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=self.rho, rho_paired=True
        )
        np.testing.assert_array_equal(sims["home_goals"], expected[0])
        np.testing.assert_array_equal(sims["away_goals"], expected[1])

    def test_pairing_changes_rho_and_nothing_else(self):
        """
        With a constant rho, paired and unpaired see identical rho values, so if
        the six child streams kept their identity every output is bit-identical —
        goals, half-time, corners and cards. A reshuffled stream layout would make
        a paired-vs-unpaired card diff mix the pairing effect with new noise.
        """
        rho_const = np.full(len(self.lam), -0.07)
        kw = dict(corners_model=CornersNegBinModel(), cards_model=CardsZIPModel(),
                  home_team="Arsenal", away_team="Everton")
        a = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=rho_const, rng=np.random.default_rng(5), **kw)
        b = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=rho_const, rho_paired=True,
            rng=np.random.default_rng(5), **kw)
        self.assertEqual(set(a), set(b))
        for key in a:
            np.testing.assert_array_equal(a[key], b[key], err_msg=key)


class FixtureSimPairingTests(unittest.TestCase):
    """The production value-bet path pairs, deterministically per fixture."""

    def _run(self, rng=None):
        captured, patch = _capture_dc_draws()
        simulator = MonteCarloSimulator(3000)
        with patch:
            # Dixon-Coles alone in the blend, so the recentring scale is 1 and the
            # draw index stays readable from the simulated rates.
            result = simulate_fixture(
                simulator, match_id=MATCH_ID, home="Arsenal", away="Everton",
                dc_model=self.dc, other_lambdas={}, weights=ENSEMBLE_WEIGHTS, rng=rng,
            )
        return result, captured

    def setUp(self):
        self.dc = _indexed_dc()

    def test_simulate_fixture_pairs_rho_with_the_draw(self):
        result, captured = self._run()
        self.assertTrue(result.from_posterior)
        k = _draw_of(captured["lam"])
        np.testing.assert_array_equal(k, _draw_of(captured["mu"]))
        np.testing.assert_allclose(captured["rho"], _rho_of_draw(k), atol=1e-12)

    def test_paired_path_is_deterministic_per_fixture(self):
        a, ca = self._run()
        b, cb = self._run()
        self.assertEqual(a.markets, b.markets)
        np.testing.assert_array_equal(ca["rho"], cb["rho"])
        c, _ = self._run(rng=fixture_rng(MATCH_ID, base_seed=1))
        self.assertNotEqual(a.markets["probabilities"], c.markets["probabilities"])


if __name__ == "__main__":
    unittest.main()
