"""
The value-bet card must be reproducible from its inputs.

Measured 2026-10-25: identical offline replays of the GW8 card at 5,000
simulations moved 1X2/totals probabilities by 1-2pp and flipped 1-2 of ~8
flagged value bets. Cause: ``simulate_from_posterior`` called
``sample_dixon_coles`` without a Generator, which fell back to an UNSEEDED
``np.random.default_rng()`` — so the per-fixture ``np.random.seed`` in
run_pipeline seeded everything except the scoreline draw itself.

These tests pin three things:

* each simulator entry point is bit-for-bit reproducible from a seed and moves
  when the seed moves;
* the whole per-fixture path — posterior draw, blend, simulate, derive markets,
  ``find_value_bets`` — produces an identical bet list twice, and never touches
  numpy's global state or unseeded entropy while doing it;
* the seed derivation is stable (a refactor that silently re-draws every
  fixture fails here) and is common-random-numbers by design: it depends on the
  fixture, not on the model inputs.
"""
import inspect
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from pipeline.config import ENSEMBLE_WEIGHTS, PARAM_REGISTRY, RISK
from pipeline.models.cards_zip import CardsZIPModel
from pipeline.models.corners_negbin import CornersNegBinModel
from pipeline.models.dixon_coles import BayesianDixonColes
from pipeline.risk.kelly import find_value_bets
from pipeline.simulation.fixture_sim import (
    fixture_rng,
    fixture_seed_sequence,
    simulate_fixture,
    value_path_base_seed,
)
from pipeline.simulation.montecarlo import MonteCarloSimulator, sample_dixon_coles

N = 4000
MATCH_ID = "20261025_Arsenal_Everton"


def _sims_equal(test, a, b):
    test.assertEqual(set(a), set(b))
    for key in a:
        np.testing.assert_array_equal(np.asarray(a[key]), np.asarray(b[key]), err_msg=key)


def _sims_differ(a, b):
    return any(
        not np.array_equal(np.asarray(a[k]), np.asarray(b[k]))
        for k in ("home_goals", "away_goals", "total_corners", "total_cards")
    )


def _fake_dc(seed: int = 11, chains: int = 2, draws: int = 600):
    """A BayesianDixonColes with a synthetic posterior, so no PyMC fit is needed."""
    gen = np.random.default_rng(seed)
    teams = ["Arsenal", "Everton", "Chelsea", "Fulham"]
    shape = (chains, draws)

    def var(arr):
        return SimpleNamespace(values=arr)

    model = BayesianDixonColes()
    model.teams = teams
    model.n_teams = len(teams)
    model.team_index = {t: i for i, t in enumerate(teams)}
    model.trace = SimpleNamespace(
        posterior={
            "attack": var(gen.normal([0.3, -0.2, 0.1, 0.0], 0.08, shape + (4,))),
            "defence": var(gen.normal([0.25, -0.15, 0.1, 0.0], 0.08, shape + (4,))),
            "home_adv": var(gen.normal(0.25, 0.05, shape)),
            "intercept": var(gen.normal(0.1, 0.03, shape)),
            "rho": var(gen.normal(-0.063, 0.03, shape)),
        }
    )
    return model


#: Prices chosen so the synthetic fixture flags bets in several markets; the
#: determinism test would be vacuous on an empty card.
ODDS = {
    "odds_home_bet365": 2.4, "odds_draw_bet365": 4.2, "odds_away_bet365": 3.6,
    "bookmaker_home": "a", "bookmaker_draw": "b", "bookmaker_away": "c",
    "totals": {
        "2.5": {"over": 2.3, "under": 1.75},
        "3.5": {"over": 3.6, "under": 1.32},
    },
    "btts": {"yes": 2.1, "no": 1.8},
}
CORNERS_ODDS = {"9.5": {"over": 2.2, "under": 1.75}, "10.5": {"over": 2.6, "under": 1.5}}
CARDS_ODDS = {"3.5": {"over": 1.6, "under": 2.4}, "4.5": {"over": 2.4, "under": 1.6}}


def _run_fixture(rng=None, xgb=(1.9, 1.0), sims=N, match_id=MATCH_ID):
    simulator = MonteCarloSimulator(sims)
    result = simulate_fixture(
        simulator,
        match_id=match_id,
        home="Arsenal",
        away="Everton",
        dc_model=_fake_dc(),
        other_lambdas={"xgboost": xgb, "penaltyblog": (1.7, 1.05)},
        weights=ENSEMBLE_WEIGHTS,
        sim_kwargs=dict(
            corners_model=CornersNegBinModel(),
            cards_model=CardsZIPModel(),
            home_team="Arsenal",
            away_team="Everton",
            referee=None,
            is_derby=False,
        ),
        rng=rng,
    )
    predictions = dict(result.markets)
    predictions["goalscorer_probabilities"] = {}
    bets = find_value_bets(
        predictions=predictions,
        odds_benchmark=ODDS,
        corners_odds=CORNERS_ODDS,
        cards_odds=CARDS_ODDS,
    )
    return result, bets


class SimulatorSeedTests(unittest.TestCase):
    """(a) every simulator entry point: same seed identical, new seed different."""

    def setUp(self):
        self.lam = np.random.default_rng(0).gamma(30, 1.5 / 30, N)
        self.mu = np.random.default_rng(1).gamma(30, 1.1 / 30, N)
        self.rho = np.full(N, -0.063)
        self.sim = MonteCarloSimulator(N)
        self.models = dict(
            corners_model=CornersNegBinModel(),
            cards_model=CardsZIPModel(),
            home_team="Arsenal",
            away_team="Everton",
        )

    def test_sample_dixon_coles(self):
        a = sample_dixon_coles(self.lam, self.mu, self.rho, np.random.default_rng(5))
        b = sample_dixon_coles(self.lam, self.mu, self.rho, np.random.default_rng(5))
        c = sample_dixon_coles(self.lam, self.mu, self.rho, np.random.default_rng(6))
        np.testing.assert_array_equal(a[0], b[0])
        np.testing.assert_array_equal(a[1], b[1])
        self.assertFalse(np.array_equal(a[0], c[0]) and np.array_equal(a[1], c[1]))

    def test_simulate_from_posterior(self):
        def run(seed):
            return self.sim.simulate_from_posterior(
                self.lam, self.mu, rho_samples=self.rho,
                rng=np.random.default_rng(seed), **self.models,
            )

        _sims_equal(self, run(5), run(5))
        self.assertTrue(_sims_differ(run(5), run(6)))

    def test_simulate_match(self):
        def run(seed):
            return self.sim.simulate_match(
                1.6, 1.1, rng=np.random.default_rng(seed), **self.models
            )

        _sims_equal(self, run(5), run(5))
        self.assertTrue(_sims_differ(run(5), run(6)))

    def test_posterior_sampling_is_seeded(self):
        dc = _fake_dc()
        a = dc.get_lambda_mu_samples("Arsenal", "Everton", N, rng=np.random.default_rng(3))
        b = dc.get_lambda_mu_samples("Arsenal", "Everton", N, rng=np.random.default_rng(3))
        c = dc.get_lambda_mu_samples("Arsenal", "Everton", N, rng=np.random.default_rng(4))
        np.testing.assert_array_equal(a[0], b[0])
        np.testing.assert_array_equal(a[1], b[1])
        self.assertFalse(np.array_equal(a[0], c[0]))

    def test_no_rng_fallback_is_seeded_by_global_state_not_os_entropy(self):
        """
        The leak itself. Without a Generator, seeding np.random must be enough;
        before the fix sample_dixon_coles ignored it and drew OS entropy.
        """
        def run():
            np.random.seed(123)
            return self.sim.simulate_from_posterior(self.lam, self.mu, rho_samples=self.rho)

        _sims_equal(self, run(), run())

    def test_legacy_simulate_match_draw_order_is_unchanged(self):
        """
        gameweek_sim seeds np.random and calls simulate_match without a
        Generator; the FPL artifacts are pinned to that draw order.
        """
        n = 500
        np.random.seed(9)
        home = np.random.poisson(1.5, n)
        away = np.random.poisson(1.1, n)
        ht_home = np.random.binomial(home, 0.45)
        ht_away = np.random.binomial(away, 0.45)
        corners = (np.random.poisson(5.5, n), np.random.poisson(4.5, n))
        cards = (np.random.poisson(1.5, n), np.random.poisson(1.8, n))

        np.random.seed(9)
        sims = MonteCarloSimulator(n).simulate_match(1.5, 1.1)
        np.testing.assert_array_equal(sims["home_goals"], home)
        np.testing.assert_array_equal(sims["away_goals"], away)
        np.testing.assert_array_equal(sims["ht_home"], ht_home)
        np.testing.assert_array_equal(sims["ht_away"], ht_away)
        np.testing.assert_array_equal(sims["home_corners"], corners[0])
        np.testing.assert_array_equal(sims["away_corners"], corners[1])
        np.testing.assert_array_equal(sims["home_yellows"], cards[0])
        np.testing.assert_array_equal(sims["away_yellows"], cards[1])


class ValuePathTests(unittest.TestCase):
    """(b) simulate -> derive_all_markets -> find_value_bets, twice."""

    def test_identical_inputs_give_identical_value_bets(self):
        first_result, first = _run_fixture()
        second_result, second = _run_fixture()
        self.assertGreaterEqual(len(first), 2, "vacuous: the synthetic card flagged nothing")
        self.assertEqual(
            {b["market_type"] for b in first} & {"corners", "cards"} != set(), True,
            "the card should exercise the corners/cards draws too",
        )
        self.assertEqual(first, second)
        self.assertEqual(first_result.markets, second_result.markets)

    def test_a_different_seed_is_a_different_draw(self):
        a, _ = _run_fixture(rng=fixture_rng(MATCH_ID, base_seed=1))
        b, _ = _run_fixture(rng=fixture_rng(MATCH_ID, base_seed=2))
        self.assertNotEqual(a.markets["probabilities"], b.markets["probabilities"])

    def test_the_path_never_touches_global_state_or_os_entropy(self):
        """
        Every draw must come from the fixture Generator. Consuming np.random's
        global state would make the card depend on whatever ran before it, and a
        bare default_rng() is the exact leak this replaced.
        """
        real_default_rng = np.random.default_rng

        def guarded(*args, **kwargs):
            if not args and kwargs.get("seed") is None:
                raise AssertionError("unseeded default_rng() on the value-bet path")
            return real_default_rng(*args, **kwargs)

        np.random.seed(2026)
        before = np.random.get_state()
        with mock.patch("numpy.random.default_rng", side_effect=guarded):
            _run_fixture()
        after = np.random.get_state()
        self.assertEqual(before[0], after[0])
        np.testing.assert_array_equal(before[1], after[1])
        self.assertEqual(before[2:], after[2:])

    def test_production_step_9_uses_the_shared_seeded_helper(self):
        """
        run_pipeline must not grow its own inline simulation again: the replay
        harness and the tests above are only evidence about production if
        production calls this same function.
        """
        from pipeline import run_pipeline

        source = inspect.getsource(run_pipeline.run_pipeline)
        self.assertIn("simulate_fixture(", source)
        self.assertNotIn("simulate_from_posterior(", source)
        self.assertNotIn(".simulate_match(", source)
        self.assertNotIn("get_lambda_mu_samples(", source)


class SeedDerivationTests(unittest.TestCase):
    """(c) stable, fixture-keyed, and deliberately blind to model inputs."""

    def test_base_seed_is_a_registered_constant_outside_risk(self):
        entry = PARAM_REGISTRY["simulation.value_path_seed"]
        self.assertEqual(entry["tier"], "C")
        self.assertNotIn("simulation.value_path_seed", RISK)
        self.assertEqual(value_path_base_seed(), 20261025)

    def test_known_value(self):
        """
        Pinned. If this fails, every published fixture's noise realisation has
        changed: that must be a deliberate decision (bump the base seed), never
        the side effect of a refactor.
        """
        state = fixture_seed_sequence(MATCH_ID, 20261025).generate_state(4).tolist()
        self.assertEqual(state, [2243576886, 2956860232, 3206359501, 3456350328])
        draws = fixture_rng(MATCH_ID, 20261025).random(3).tolist()
        self.assertEqual(
            draws, [0.3669425377382457, 0.33277438804931614, 0.2694951024889346]
        )
        # The default base seed is the registry's.
        self.assertEqual(
            fixture_seed_sequence(MATCH_ID).generate_state(4).tolist(), state
        )

    def test_changes_with_fixture_and_base_seed(self):
        base = fixture_seed_sequence(MATCH_ID, 20261025).generate_state(2).tolist()
        other_fixture = fixture_seed_sequence(
            "20261025_Chelsea_Fulham", 20261025
        ).generate_state(2).tolist()
        other_base = fixture_seed_sequence(MATCH_ID, 20261026).generate_state(2).tolist()
        self.assertNotEqual(base, other_fixture)
        self.assertNotEqual(base, other_base)

    def test_common_random_numbers_a_model_change_moves_draws_monotonically(self):
        """
        The seed excludes the model inputs on purpose. Raising one model's home
        rate must reuse the same uniforms, so every simulated home score can only
        rise — the run-to-run difference is the model's effect, not new noise.
        With an input-keyed seed this would be an independent re-draw and the
        elementwise ordering would fail on roughly a third of the draws.
        """
        def home_goals(xgb_home):
            simulator = MonteCarloSimulator(N)
            captured = {}
            original = simulator.simulate_from_posterior

            def capture(*args, **kwargs):
                captured["sims"] = original(*args, **kwargs)
                return captured["sims"]

            simulator.simulate_from_posterior = capture
            simulate_fixture(
                simulator,
                match_id=MATCH_ID,
                home="Arsenal",
                away="Everton",
                dc_model=_fake_dc(),
                other_lambdas={"xgboost": (xgb_home, 1.0)},
                weights=ENSEMBLE_WEIGHTS,
            )
            return captured["sims"]["home_goals"]

        low, high = home_goals(1.6), home_goals(2.0)
        self.assertTrue((high >= low).all())
        self.assertGreater(int((high > low).sum()), 0)


class GoalMethodStakeGuardTests(unittest.TestCase):
    """find_value_bets(require_goal_method=...) is the second lock behind
    simulate_fixture's fail-loud: a fixture priced by any method other than
    the one run_pipeline expects gets no stake at all."""

    def setUp(self):
        result, self.bets = _run_fixture()
        self.predictions = dict(result.markets)
        self.predictions["goalscorer_probabilities"] = {}

    def _bets(self, predictions, method):
        return find_value_bets(
            predictions=predictions, odds_benchmark=ODDS,
            corners_odds=CORNERS_ODDS, cards_odds=CARDS_ODDS,
            require_goal_method=method,
        )

    def test_matching_method_stakes_as_before(self):
        from pipeline.simulation.exact_markets import METHOD_POSTERIOR_GRID

        self.assertTrue(self.bets, "fixture must flag bets or the refusal test is vacuous")
        self.assertEqual(self._bets(self.predictions, METHOD_POSTERIOR_GRID), self.bets)

    def test_poisson_grid_is_refused_when_posterior_was_required(self):
        from pipeline.simulation.exact_markets import METHOD_POISSON_GRID, METHOD_POSTERIOR_GRID

        poisson = dict(self.predictions)
        poisson["goal_markets"] = dict(poisson["goal_markets"], method=METHOD_POISSON_GRID)
        with self.assertLogs("pipeline.risk.kelly", level="ERROR"):
            self.assertEqual(self._bets(poisson, METHOD_POSTERIOR_GRID), [])
        # Corners and cards go too: they are conditioned on the same goals.
        self.assertTrue(any(b["market_type"] in ("corners", "cards") for b in self.bets))

    def test_missing_provenance_is_refused(self):
        from pipeline.simulation.exact_markets import METHOD_POSTERIOR_GRID

        bare = {k: v for k, v in self.predictions.items() if k != "goal_markets"}
        with self.assertLogs("pipeline.risk.kelly", level="ERROR"):
            self.assertEqual(self._bets(bare, METHOD_POSTERIOR_GRID), [])

    def test_run_pipeline_requires_the_posterior_grid_when_dc_is_fitted(self):
        import pipeline.run_pipeline as rp

        src = inspect.getsource(rp.run_pipeline)
        self.assertIn(
            "require_goal_method=METHOD_POSTERIOR_GRID if dc_model is not None else None", src
        )


if __name__ == "__main__":
    unittest.main()
