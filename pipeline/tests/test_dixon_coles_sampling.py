"""
The Dixon-Coles correction, finally applied to the path that sizes bets.

## What was wrong

The model fits ``rho`` — the entire reason to prefer Dixon-Coles over
independent Poisson — and `BayesianDixonColes.scoreline_matrix` applies the
``tau`` correction. But `simulate_from_posterior`, which is what produces
`latest.json`'s probabilities and therefore every Kelly stake, drew two
independent Poissons and ignored ``rho`` completely.

## Why it was worth fixing rather than tolerating

Measured over 840 selections priced across the 5% minimum-edge band on twenty
fixtures: **64 phantom bets** (published as value, are not) and **55 missed**.
The error is systematic, not noise — phantoms land on home and away, misses land
on the draw, which is exactly what understating draws produces.

The largest single probability shift is 1.93pp against a 5pp threshold, so the
defect cannot manufacture a bet from nothing. What it does is decide every
selection whose true edge sits within ~2pp of the line, and those are precisely
the marginal bets where being wrong is cheapest to do and hardest to notice.

## What these tests pin

* **rho = 0 reproduces independent Poisson.** Without this the correction could
  be silently mis-signed and still look plausible.
* **Negative rho raises P(0-0) and P(draw).** The direction is the whole point,
  and a sign error would systematically bet the wrong side of every close market.
* **The marginals survive.** The correction redistributes mass between
  scorelines; it must not move expected goals, or it would be re-fitting the
  model rather than correcting its joint.
* **No NaN reaches the Kelly path.** A degenerate grid is the one way this could
  emit garbage into staking, and it is handled rather than assumed away.
"""

from __future__ import annotations

import unittest

import numpy as np
from scipy.stats import poisson

from pipeline.simulation.montecarlo import (
    DC_SAMPLING_MAX_GOALS,
    MonteCarloSimulator,
    sample_dixon_coles,
)

#: Historical posterior mean. Named so the tests read as statements about the
#: model rather than about an arbitrary constant.
HISTORICAL_RHO = -0.063

N = 200_000


def draw(lam: float, mu: float, rho: float, seed: int = 1, n: int = N):
    rng = np.random.default_rng(seed)
    return sample_dixon_coles(
        np.full(n, lam), np.full(n, mu), np.full(n, rho), rng,
    )


class IndependenceTests(unittest.TestCase):
    """rho = 0 must be exactly the old behaviour."""

    def test_zero_rho_matches_independent_poisson(self):
        home, away = draw(1.5, 1.2, 0.0)
        expected = poisson.pmf(0, 1.5) * poisson.pmf(0, 1.2)
        observed = float(((home == 0) & (away == 0)).mean())
        self.assertAlmostEqual(observed, expected, delta=0.003)

    def test_zero_rho_leaves_the_draw_rate_alone(self):
        _, base_draw = self._rates(0.0)
        # An independent-Poisson draw rate for these parameters is ~25.5%.
        self.assertAlmostEqual(base_draw, 0.255, delta=0.01)

    @staticmethod
    def _rates(rho: float):
        home, away = draw(1.5, 1.2, rho)
        return (
            float(((home == 0) & (away == 0)).mean()),
            float((home == away).mean()),
        )


class DirectionTests(unittest.TestCase):
    """
    Negative rho boosts low scores. A sign error here would systematically bet
    the wrong side of every close market, so it is asserted rather than assumed.
    """

    def test_negative_rho_raises_p_nil_nil(self):
        base = float(((lambda hw: (hw[0] == 0) & (hw[1] == 0))(draw(1.5, 1.2, 0.0))).mean())
        corrected = float(((lambda hw: (hw[0] == 0) & (hw[1] == 0))(draw(1.5, 1.2, HISTORICAL_RHO))).mean())
        self.assertGreater(corrected, base)

    def test_the_measured_lift_matches_what_was_documented(self):
        h0, a0 = draw(1.5, 1.2, 0.0)
        h1, a1 = draw(1.5, 1.2, HISTORICAL_RHO)
        base = float(((h0 == 0) & (a0 == 0)).mean())
        corrected = float(((h1 == 0) & (a1 == 0)).mean())
        lift = corrected / base - 1.0
        # The defect note claimed 10.6%-11.3%. Reproducing it is what confirms
        # the correction is the one that was missing.
        self.assertGreater(lift, 0.08)
        self.assertLess(lift, 0.14)

    def test_negative_rho_raises_the_draw_rate(self):
        h0, a0 = draw(1.5, 1.2, 0.0)
        h1, a1 = draw(1.5, 1.2, HISTORICAL_RHO)
        self.assertGreater(float((h1 == a1).mean()), float((h0 == a0).mean()))

    def test_positive_rho_moves_the_other_way(self):
        h0, a0 = draw(1.5, 1.2, 0.0)
        h1, a1 = draw(1.5, 1.2, 0.05)
        self.assertLess(
            float(((h1 == 0) & (a1 == 0)).mean()),
            float(((h0 == 0) & (a0 == 0)).mean()),
        )


class MarginalTests(unittest.TestCase):
    """
    The correction redistributes mass between scorelines.

    It must not move expected goals: doing so would be re-fitting the model
    rather than correcting its joint, and the goal rates are what the ensemble
    blend spent its effort producing.
    """

    def test_expected_goals_are_preserved(self):
        for lam, mu in ((1.5, 1.2), (2.1, 0.7), (0.9, 1.6)):
            home, away = draw(lam, mu, HISTORICAL_RHO, seed=4)
            self.assertAlmostEqual(float(home.mean()), lam, delta=0.02)
            self.assertAlmostEqual(float(away.mean()), mu, delta=0.02)

    def test_truncation_loses_almost_no_mass(self):
        # The sampling grid is wider than the 7x7 export grid on purpose.
        self.assertGreater(DC_SAMPLING_MAX_GOALS, 7)
        tail = 1.0 - poisson.cdf(DC_SAMPLING_MAX_GOALS, 2.5)
        self.assertLess(tail, 1e-3)

    def test_scorelines_stay_inside_the_grid(self):
        home, away = draw(2.5, 2.5, HISTORICAL_RHO, seed=6)
        self.assertLessEqual(int(home.max()), DC_SAMPLING_MAX_GOALS)
        self.assertGreaterEqual(int(home.min()), 0)


class RobustnessTests(unittest.TestCase):
    def test_no_nan_reaches_the_caller(self):
        home, away = draw(1.5, 1.2, HISTORICAL_RHO)
        self.assertFalse(np.isnan(home).any())
        self.assertFalse(np.isnan(away).any())

    def test_an_extreme_rho_does_not_produce_garbage(self):
        """
        For a large lambda*mu and positive rho the 0-0 correction goes negative.

        `scoreline_matrix` floors it; so does this. Without the floor the grid
        would carry negative probabilities into a cumulative sum and emit
        arbitrary scorelines into the Kelly path.
        """
        home, away = draw(3.0, 3.0, 0.45, seed=8, n=20_000)
        self.assertFalse(np.isnan(home).any())
        self.assertGreaterEqual(int(home.min()), 0)

    def test_per_draw_rho_is_honoured(self):
        # Half the draws uncorrected, half strongly corrected: the pooled P(0-0)
        # must sit between the two pure cases, which it cannot if rho is being
        # collapsed to a scalar somewhere.
        rng = np.random.default_rng(3)
        n = 200_000
        rho = np.where(np.arange(n) % 2 == 0, 0.0, -0.15)
        home, away = sample_dixon_coles(np.full(n, 1.5), np.full(n, 1.2), rho, rng)
        mixed = float(((home == 0) & (away == 0)).mean())
        h0, a0 = draw(1.5, 1.2, 0.0)
        h1, a1 = draw(1.5, 1.2, -0.15)
        self.assertGreater(mixed, float(((h0 == 0) & (a0 == 0)).mean()))
        self.assertLess(mixed, float(((h1 == 0) & (a1 == 0)).mean()))


class SimulatorWiringTests(unittest.TestCase):
    """The correction has to reach the function that feeds Kelly."""

    def setUp(self):
        self.sim = MonteCarloSimulator(n_simulations=40_000)
        self.lam = np.full(40_000, 1.5)
        self.mu = np.full(40_000, 1.2)

    def test_without_rho_it_is_independent_poisson(self):
        """The documented default, for callers with no fitted trace."""
        sims = self.sim.simulate_from_posterior(self.lam, self.mu)
        p00 = float(((sims["home_goals"] == 0) & (sims["away_goals"] == 0)).mean())
        self.assertAlmostEqual(p00, poisson.pmf(0, 1.5) * poisson.pmf(0, 1.2), delta=0.006)

    def test_with_rho_the_correction_is_applied(self):
        sims = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=np.full(40_000, HISTORICAL_RHO),
        )
        p00 = float(((sims["home_goals"] == 0) & (sims["away_goals"] == 0)).mean())
        self.assertGreater(p00, poisson.pmf(0, 1.5) * poisson.pmf(0, 1.2))

    def test_an_empty_rho_array_falls_back_rather_than_crashing(self):
        sims = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=np.array([]),
        )
        self.assertIn("home_goals", sims)

    def test_derived_markets_still_sum_to_one(self):
        sims = self.sim.simulate_from_posterior(
            self.lam, self.mu, rho_samples=np.full(40_000, HISTORICAL_RHO),
        )
        markets = self.sim.derive_all_markets(sims)
        trio = markets["probabilities"]["1x2"]
        self.assertAlmostEqual(
            trio["home"] + trio["draw"] + trio["away"], 1.0, places=6,
        )


if __name__ == "__main__":
    unittest.main()
