"""
Tests for the MLE Dixon-Coles.

The load-bearing test is :meth:`TestParameterRecovery.test_the_whole_parameter_vector_is_recovered`.
Everything else here is a shape or a sanity check that a broken optimiser could
still pass: sum-to-zero holds by construction, a positive home advantage is one
bit of information, and "rates are in a plausible band" would survive a model
that ignored the data and returned the league average for everyone.

Recovery is different. It simulates 1900 matches from a *known* attack, defence,
home advantage, intercept and rho — drawing scorelines through
``BayesianDixonColes.scoreline_matrix``, so the data really carries the
Dixon-Coles low-score dependence and rho is identifiable — refits, and requires
every parameter back. A sign error on defence, a mis-indexed bincount in the
gradient, or a tau derivative inconsistent with tau all move the recovered vector
far outside the tolerances below. That is the test that lets this module fail.

Tolerances are measured, not guessed. Over sixteen seeds at 1900 matches the
worst per-parameter errors were attack 0.194, defence 0.206, home_adv 0.046,
intercept 0.027 and rho 0.040, with rho averaging +0.008 and home_adv -0.003 —
sampling noise, not bias. Raising the match count fivefold to 9500 shrank every
one of them by roughly sqrt(5) (attack 0.194 -> 0.095, rho sd 0.022 -> 0.014),
which is the signature of a consistent estimator rather than a lucky seed.
"""
from __future__ import annotations

import time
import unittest
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from scipy.stats import poisson

from pipeline.config import DATA_RAW, DIXON_COLES
from pipeline.models.dc_mle import (
    LOW_SCORE_CELLS,
    RHO_BOUNDS,
    MLEDixonColes,
    SeparatedDesignError,
    _negative_log_likelihood,
    _tau_vector,
)
from pipeline.models.dixon_coles import BayesianDixonColes

# A single season of real results, cached by pipeline.data.football_data. Not
# committed (data/raw/ is gitignored), so the tests that need real football skip
# rather than reach for the network from a unit test.
REAL_SEASON_CSV = DATA_RAW / "football_data" / "E0_2526.csv"

# Rates outside this are not football scorelines. Stated independently rather
# than imported from dc_mle: a test that asserts against the constant the module
# uses for its own diagnostic cannot notice that constant being widened.
PLAUSIBLE_RATE = (0.2, 5.0)

TRUE_INTERCEPT = 0.15
TRUE_HOME_ADV = 0.26
# Negative, like every real fit in this repo (2526 alone gives -0.164, three
# seasons -0.115). It also keeps tau's 0-0 cell, 1 - lambda*mu*rho, safely
# positive, so the simulation is never sampling from a floored grid and the
# recovery target stays the parameter it says it is.
TRUE_RHO = -0.10
TRUE_STRENGTH_SD = 0.22

N_TEAMS = 20
MAX_SIM_GOALS = 7  # matches MAX_GOALS, so scoreline_matrix's default grid is used


def _league(n_teams: int = N_TEAMS) -> List[str]:
    return [f"Club {i:02d}" for i in range(n_teams)]


def _true_parameters(seed: int, n_teams: int = N_TEAMS) -> Tuple[np.ndarray, np.ndarray]:
    """
    Sum-to-zero attack and defence vectors, so they are directly comparable with
    what a constrained fit can return.

    Drawn from spawn key ``[seed, 1]``; the scorelines use ``[seed, 2]``. Reusing
    one ``default_rng(seed)`` for both would make the results a deterministic
    function of the same raw stream words that produced the parameters, so the
    goals would not be a fresh draw *given* those parameters — and a recovery
    test whose data is coupled to its own answer is not measuring recovery.
    """
    rng = np.random.default_rng([seed, 1])
    attack = rng.normal(0.0, TRUE_STRENGTH_SD, n_teams)
    defence = rng.normal(0.0, TRUE_STRENGTH_SD, n_teams)
    return attack - attack.mean(), defence - defence.mean()


def _simulate_season(
    seed: int, rounds: int = 5, n_teams: int = N_TEAMS
) -> Tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """
    ``rounds`` double round-robins drawn from the Dixon-Coles joint.

    Scorelines come from ``BayesianDixonColes.scoreline_matrix`` rather than two
    independent Poissons. That matters: independent draws carry no low-score
    dependence at all, so rho would be unidentifiable and its "recovered" value
    would be whatever the optimiser's start point happened to be.
    """
    rng = np.random.default_rng([seed, 2])
    teams = _league(n_teams)
    attack, defence = _true_parameters(seed, n_teams)

    fixtures = [(i, j) for i in range(n_teams) for j in range(n_teams) if i != j]
    flat: Dict[Tuple[int, int], np.ndarray] = {}
    for home, away in fixtures:
        lam = np.exp(TRUE_INTERCEPT + attack[home] - defence[away] + TRUE_HOME_ADV)
        mu = np.exp(TRUE_INTERCEPT + attack[away] - defence[home])
        grid = BayesianDixonColes.scoreline_matrix(lam, mu, TRUE_RHO, MAX_SIM_GOALS).ravel()
        flat[(home, away)] = grid / grid.sum()

    side = MAX_SIM_GOALS + 1
    rows = []
    day = 0
    for _ in range(rounds):
        for home, away in fixtures:
            cell = rng.choice(side * side, p=flat[(home, away)])
            rows.append(
                {
                    "home_team": teams[home],
                    "away_team": teams[away],
                    "home_goals": int(cell // side),
                    "away_goals": int(cell % side),
                    "date": pd.Timestamp("2020-08-01") + pd.Timedelta(days=day),
                }
            )
            day += 1
    return pd.DataFrame(rows), attack, defence


def _lopsided_league() -> pd.DataFrame:
    """
    Hand-built, no simulation: Runaway beats everyone, Hapless loses to everyone,
    and three midtable clubs draw. The point is that the ordering is not a
    statistical claim, so a test built on it cannot be flaky.

    Every club both scores and concedes at least once, deliberately. A Hapless
    side that never scored would have no finite MLE at all, and the fixture would
    then be exercising ``SeparatedDesignError`` instead of the ordering it claims
    to test.
    """
    rows = []
    day = 0

    def played(home: str, away: str, home_goals: int, away_goals: int) -> None:
        nonlocal day
        rows.append(
            {
                "home_team": home,
                "away_team": away,
                "home_goals": home_goals,
                "away_goals": away_goals,
                "date": pd.Timestamp("2024-08-01") + pd.Timedelta(days=day),
            }
        )
        day += 1

    midtable = ["Midtable A", "Midtable B", "Midtable C"]
    # Varied midtable results, not four identical 1-1s: a diet of exactly one
    # scoreline drives rho onto its bound, and a fixture whose rho is pinned
    # would make the bound test pass for the wrong reason.
    midtable_results = [(1, 1), (2, 1), (0, 1), (2, 2)]
    for midtable_home, midtable_away in midtable_results:
        for other in midtable:
            played("Runaway FC", other, 3, 1)
            played(other, "Runaway FC", 1, 2)
            played("Hapless FC", other, 1, 2)
            played(other, "Hapless FC", 3, 1)
        played("Runaway FC", "Hapless FC", 4, 1)
        played("Hapless FC", "Runaway FC", 1, 3)
        for first, second in zip(midtable, midtable[1:] + midtable[:1]):
            played(first, second, midtable_home, midtable_away)
    return pd.DataFrame(rows)


def _real_season() -> pd.DataFrame:
    from pipeline.data.football_data import clean_football_data, fetch_season_csv

    return clean_football_data(fetch_season_csv("2526"), "2526")


class TestConstraintsAndShape(unittest.TestCase):
    def setUp(self):
        self.model = MLEDixonColes().fit(_lopsided_league())

    def test_attack_and_defence_each_sum_to_zero(self):
        """
        Without this the intercept, attack and defence are not separately
        identifiable, and the fitted attack numbers could not be compared with
        the Bayesian model's — which is the entire reason for matching its
        parameterisation.
        """
        self.assertAlmostEqual(float(self.model.attack.sum()), 0.0, places=10)
        self.assertAlmostEqual(float(self.model.defence.sum()), 0.0, places=10)

    def test_rho_stays_inside_the_bayesian_models_support(self):
        """
        Strict inequalities: rho resting exactly on a bound would satisfy the
        constraint while telling us the likelihood wanted to keep going, and this
        fixture is built so it does not need to.
        """
        self.assertGreater(self.model.get_rho_mean(), RHO_BOUNDS[0])
        self.assertLess(self.model.get_rho_mean(), RHO_BOUNDS[1])

    def test_a_stronger_attack_out_rates_a_weaker_one_against_the_same_opponent(self):
        """The one directional claim a model has to get right to be worth fitting."""
        strong, _ = self.model.rates("Runaway FC", "Midtable A")
        weak, _ = self.model.rates("Hapless FC", "Midtable A")
        self.assertGreater(strong, weak)
        # Same club, now away: the away rate must move the same way.
        _, strong_away = self.model.rates("Midtable A", "Runaway FC")
        _, weak_away = self.model.rates("Midtable A", "Hapless FC")
        self.assertGreater(strong_away, weak_away)

    def test_an_unfitted_model_refuses_rates_but_still_answers_for_rho(self):
        """
        Mirrors BayesianDixonColes: rates without a fit would be a silent
        league-average forecast, but rho is a correction factor and zero is the
        honest answer for "no correction known".
        """
        fresh = MLEDixonColes()
        self.assertEqual(fresh.get_rho_mean(), 0.0)
        with self.assertRaises(RuntimeError):
            fresh.rates("Runaway FC", "Midtable A")

    def test_the_callable_surface_matches_the_bayesian_model(self):
        """
        The harness swaps one class for the other. If production renames
        get_rho_mean or team_index the swap breaks at a call site far from here,
        so the shared names are asserted rather than assumed.
        """
        # An unfitted instance, not the class: production sets team_index in
        # __init__, so the class object does not carry it.
        production = BayesianDixonColes()
        for name in ("team_index", "get_rho_mean"):
            self.assertTrue(hasattr(self.model, name), f"MLEDixonColes lacks {name}")
            self.assertTrue(hasattr(production, name), f"production lacks {name}")
        self.assertEqual(set(self.model.team_index), set(self.model.teams))


class TestUnknownClubs(unittest.TestCase):
    """
    A promoted club appears in the fixture list with no history. It has to be
    priced, not dropped and not raised on — dropping it puts a hole in a
    walk-forward's coverage on exactly the fixtures whose rate is least certain.
    """

    def setUp(self):
        self.model = MLEDixonColes().fit(_lopsided_league())

    def test_an_unknown_club_is_priced_at_the_league_average(self):
        lam, mu = self.model.rates("Promoted FC", "Midtable A")
        idx = self.model.team_index["Midtable A"]
        expected_lam = np.exp(
            self.model.intercept - self.model.defence[idx] + self.model.home_adv
        )
        expected_mu = np.exp(self.model.intercept + self.model.attack[idx])
        self.assertAlmostEqual(lam, float(expected_lam), places=12)
        self.assertAlmostEqual(mu, float(expected_mu), places=12)

    def test_two_unknown_clubs_give_the_pure_league_average_fixture(self):
        lam, mu = self.model.rates("Promoted FC", "Also Promoted FC")
        self.assertAlmostEqual(
            lam, float(np.exp(self.model.intercept + self.model.home_adv)), places=12
        )
        self.assertAlmostEqual(mu, float(np.exp(self.model.intercept)), places=12)

    def test_an_unknown_club_does_not_erase_its_known_opponent(self):
        """
        The fallback is per club, not per fixture. Replacing the whole fixture
        with flat rates is the measured failure on record: a flat rate for every
        fixture predicted clean sheets at 0.066 against a realised 0.120.
        """
        strong = self.model.rates("Promoted FC", "Hapless FC")[0]
        weak = self.model.rates("Promoted FC", "Runaway FC")[0]
        self.assertGreater(strong, weak)


class TestThinDataFailsLoudly(unittest.TestCase):
    """
    The one place an MLE is strictly worse than the Bayesian model it stands in
    for, so it is the place tested hardest. With a club that has never scored,
    its attack raises the likelihood without bound and the maximum is at
    infinity. L-BFGS-B does not report that — it stops at PARAM_BOUND and returns
    ``success=True``. Measured on real 2526 results, the first 40 matches produced
    ``converged=True`` alongside an implied 48,000-goal home rate.

    An unattended pipeline turning that into a forecast is the failure mode this
    repo is least able to see, so the fit refuses instead.
    """

    def _two_club_league(self, goals: List[Tuple[int, int]]) -> pd.DataFrame:
        return pd.DataFrame(
            [
                {
                    "home_team": "Alpha FC",
                    "away_team": "Beta FC",
                    "home_goals": home,
                    "away_goals": away,
                    "date": pd.Timestamp("2024-08-01") + pd.Timedelta(days=7 * i),
                }
                for i, (home, away) in enumerate(goals)
            ]
        )

    def test_a_club_that_has_never_scored_is_refused_not_pinned_to_a_bound(self):
        matches = self._two_club_league([(2, 0), (3, 0), (1, 0), (2, 0)])
        with self.assertRaises(SeparatedDesignError) as caught:
            MLEDixonColes().fit(matches)
        self.assertIn("Beta FC", str(caught.exception))

    def test_a_club_that_has_never_conceded_is_refused_too(self):
        """
        The mirror case, which a guard written only on goals scored would miss:
        it is ``defence`` that runs away, not ``attack``.

        **The fixture has to isolate the branch, and the obvious one does not.**
        A two-club league where the loser is shut out every time — ``[(0,2),
        (0,3),(0,1),(0,2)]`` — makes that club BOTH scoreless and its opponent
        unbeaten, so ``starved`` is non-empty and the ``airtight`` half of
        ``if starved or airtight`` can be deleted with the suite still green. The
        error message also names the club either way, because the f-string prints
        both lists.

        This is not hypothetical: on the real three-season walk-forward the branch
        that actually fires is ``airtight`` — measured as
        ``conceded nothing: ['Leeds', 'Sunderland']`` on a 770-match window.

        So: three clubs, every one of them scoring, exactly one conceding nothing.
        """
        import pandas as pd

        rows = []
        for _ in range(2):
            rows.extend([
                # Everyone scores, so `starved` is empty.
                ("Alpha FC", "Gamma FC", 1, 1),
                # Beta concedes nothing in either of its matches.
                ("Beta FC", "Alpha FC", 2, 0),
                ("Beta FC", "Gamma FC", 1, 0),
            ])
        matches = pd.DataFrame([
            {
                "home_team": home, "away_team": away,
                "home_goals": hg, "away_goals": ag,
                "date": pd.Timestamp("2026-01-01") + pd.Timedelta(days=index),
            }
            for index, (home, away, hg, ag) in enumerate(rows)
        ])

        with self.assertRaises(SeparatedDesignError) as caught:
            MLEDixonColes().fit(matches)
        message = str(caught.exception)
        self.assertIn("Beta FC", message)
        # The discriminating assertion: NOTHING was starved, so only the airtight
        # branch can have raised this.
        self.assertIn("scored nothing: none", message)

    def test_one_goal_each_way_is_enough_to_make_the_fit_well_posed(self):
        """
        The guard must be the separation condition and nothing stricter — a fit
        it refuses is a gameweek the walk-forward loses.
        """
        matches = self._two_club_league([(2, 1), (1, 2), (1, 1), (3, 1)])
        model = MLEDixonColes().fit(matches)
        self.assertTrue(model.converged)
        for rate in model.rates("Alpha FC", "Beta FC"):
            self.assertTrue(np.isfinite(rate))

    def test_the_error_is_a_value_error_so_existing_callers_still_catch_it(self):
        self.assertTrue(issubclass(SeparatedDesignError, ValueError))

    def test_a_failed_refit_does_not_leave_the_previous_fit_answering(self):
        """
        A walk-forward reusing one instance is the natural way to write the loop.
        If a refit raises and the object still reports fitted, it would answer
        with the old window's parameters under the new window's team index — a
        forecast for the wrong clubs, returned without complaint.
        """
        model = MLEDixonColes().fit(_lopsided_league())
        self.assertIsInstance(model.rates("Runaway FC", "Hapless FC"), tuple)
        with self.assertRaises(SeparatedDesignError):
            model.fit(self._two_club_league([(2, 0), (3, 0), (1, 0)]))
        with self.assertRaises(RuntimeError):
            model.rates("Runaway FC", "Hapless FC")

    def test_a_thin_but_identified_fit_still_says_so_in_the_log(self):
        """
        Separation is provable in advance; wild-but-finite is not. A club with two
        matches played gets a finite estimate that is nonetheless nonsense — on
        real 2526 results a 50-match fit implies a 14.7-goal fixture while
        reporting convergence — so the fit logs the rate span it produced. Logged
        rather than clamped: a clamped rate looks like a real forecast.
        """
        matches = self._two_club_league([(6, 1), (7, 1), (5, 1)])
        with self.assertLogs("pipeline.models.dc_mle", level="WARNING") as captured:
            MLEDixonColes().fit(matches)
        self.assertTrue(
            any("outside the plausible" in line for line in captured.output),
            captured.output,
        )

    def test_a_healthy_fit_logs_no_warning_at_all(self):
        """
        A diagnostic that fires on good fits gets ignored, which is the same as
        not having one.
        """
        with self.assertNoLogs("pipeline.models.dc_mle", level="WARNING"):
            MLEDixonColes().fit(_lopsided_league())

    def test_a_single_club_is_refused(self):
        matches = pd.DataFrame(
            [
                {
                    "home_team": "Alpha FC",
                    "away_team": "Alpha FC",
                    "home_goals": 1,
                    "away_goals": 1,
                    "date": pd.Timestamp("2024-08-01"),
                }
            ]
        )
        with self.assertRaises(ValueError):
            MLEDixonColes().fit(matches)

    def test_an_empty_frame_is_refused(self):
        empty = _lopsided_league().iloc[:0]
        with self.assertRaises(ValueError):
            MLEDixonColes().fit(empty)

    def test_a_missing_column_names_itself(self):
        broken = _lopsided_league().drop(columns=["home_goals"])
        with self.assertRaises(ValueError) as caught:
            MLEDixonColes().fit(broken)
        self.assertIn("home_goals", str(caught.exception))


class TestDeterminism(unittest.TestCase):
    def test_fitting_twice_on_the_same_data_gives_identical_parameters(self):
        """
        The walk-forward refits at every gameweek and its output has to be
        reproducible from the archive alone. L-BFGS-B from a fixed start is
        deterministic, so this is exact equality, not a tolerance — a tolerance
        here would hide the introduction of any randomised start.
        """
        matches = _lopsided_league()
        first = MLEDixonColes().fit(matches)
        second = MLEDixonColes().fit(matches)
        np.testing.assert_array_equal(first.attack, second.attack)
        np.testing.assert_array_equal(first.defence, second.defence)
        self.assertEqual(first.intercept, second.intercept)
        self.assertEqual(first.home_adv, second.home_adv)
        self.assertEqual(first.rho, second.rho)
        self.assertEqual(first.log_likelihood, second.log_likelihood)

    def test_column_naming_convention_does_not_change_the_fit(self):
        """
        Both spellings are live in this repo. If they fitted differently, whether
        a caller renamed its columns would silently change the forecast.
        """
        lower = _lopsided_league()
        upper = lower.rename(
            columns={
                "home_team": "HomeTeam",
                "away_team": "AwayTeam",
                "home_goals": "FTHG",
                "away_goals": "FTAG",
                "date": "Date",
            }
        )
        np.testing.assert_array_equal(
            MLEDixonColes().fit(lower).attack, MLEDixonColes().fit(upper).attack
        )


class TestTheLikelihoodMatchesProduction(unittest.TestCase):
    def test_tau_equals_the_correction_inside_scoreline_matrix(self):
        """
        The vectorised tau must be the same factor the simulator draws through.
        Recovered from the production grid by dividing out the independent
        Poisson product: that leaves ``tau / Z`` per cell, and dividing by a cell
        where tau is 1 cancels the normaliser, giving tau itself.
        """
        control = (3, 2)  # outside the corrected cells, so tau == 1 there
        for lam, mu, rho in ((1.5, 1.1, -0.12), (2.4, 0.7, 0.08), (0.9, 2.2, 0.3)):
            matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho, MAX_SIM_GOALS)

            def ratio(cell):
                i, j = cell
                return matrix[i, j] / (poisson.pmf(i, lam) * poisson.pmf(j, mu))

            for cell in LOW_SCORE_CELLS:
                expected = ratio(cell) / ratio(control)
                actual = _tau_vector(
                    np.array([cell[0]], dtype=float),
                    np.array([cell[1]], dtype=float),
                    np.array([lam]),
                    np.array([mu]),
                    rho,
                )[0]
                self.assertAlmostEqual(
                    actual, float(expected), places=10,
                    msg=f"tau diverged from scoreline_matrix at {cell}, rho={rho}",
                )

    def test_the_analytic_gradient_matches_a_finite_difference(self):
        """
        tau's derivative is written out per cell, so it can disagree with tau
        itself. That disagreement would not crash — it would land the optimiser
        near, but not at, the maximum, and every other test here would still
        pass. Measured worst relative error over this grid: 1.3e-9.
        """
        rng = np.random.default_rng(7)
        n_teams, n = 8, 300
        home = rng.integers(0, n_teams, n).astype(np.intp)
        away = ((home + 1 + rng.integers(0, n_teams - 1, n)) % n_teams).astype(np.intp)
        home_goals = rng.poisson(1.5, n).astype(float)
        away_goals = rng.poisson(1.1, n).astype(float)
        weights = rng.uniform(0.2, 1.0, n)

        for rho in (-0.25, 0.0, 0.18):
            theta = rng.normal(0.0, 0.3, 3 + 2 * (n_teams - 1))
            theta[2] = rho
            args = (home, away, home_goals, away_goals, weights, n_teams, 0.0)
            _, grad = _negative_log_likelihood(theta, *args)

            step = 1e-6
            for i in range(theta.size):
                bump = np.zeros_like(theta)
                bump[i] = step
                up, _ = _negative_log_likelihood(theta + bump, *args)
                down, _ = _negative_log_likelihood(theta - bump, *args)
                self.assertAlmostEqual(
                    grad[i], (up - down) / (2 * step), places=5,
                    msg=f"gradient entry {i} wrong at rho={rho}",
                )

    def test_the_fit_maximises_its_own_likelihood(self):
        """
        A perturbation test rather than a claim about the optimiser: if any
        coordinate can be nudged to a higher likelihood, the reported optimum is
        not one.
        """
        matches, _, _ = _simulate_season(seed=31, rounds=1)
        model = MLEDixonColes().fit(matches, xi=0.0)
        # Scored through the same helper as the perturbations rather than reading
        # model.log_likelihood, which carries the gammaln constant the helper
        # drops. Comparing the two would compare two different quantities.
        best = _log_likelihood_of(model, matches)
        rng = np.random.default_rng(3)
        for _ in range(20):
            probe = MLEDixonColes()
            probe.__dict__.update(model.__dict__)
            probe.attack = model.attack + rng.normal(0.0, 0.05, model.n_teams)
            probe.attack -= probe.attack.mean()
            probe.defence = model.defence + rng.normal(0.0, 0.05, model.n_teams)
            probe.defence -= probe.defence.mean()
            self.assertLessEqual(_log_likelihood_of(probe, matches), best + 1e-9)


def _log_likelihood_of(model: MLEDixonColes, matches: pd.DataFrame) -> float:
    """Weighted DC log-likelihood of an arbitrary parameter set, for the
    perturbation test. Deliberately independent of the fit path."""
    home = matches["home_team"].map(model.team_index).to_numpy(dtype=np.intp)
    away = matches["away_team"].map(model.team_index).to_numpy(dtype=np.intp)
    home_goals = matches["home_goals"].to_numpy(dtype=float)
    away_goals = matches["away_goals"].to_numpy(dtype=float)
    theta = np.concatenate(
        [
            [model.intercept, model.home_adv, model.rho],
            model.attack[:-1],
            model.defence[:-1],
        ]
    )
    negative, _ = _negative_log_likelihood(
        theta,
        home,
        away,
        home_goals,
        away_goals,
        np.ones(len(matches)),
        model.n_teams,
        0.0,
    )
    return -negative


class TestParameterRecovery(unittest.TestCase):
    """
    Simulate from known parameters, refit, require them back. See the module
    docstring for how the tolerances were measured.
    """

    # Worst single-parameter errors over sixteen seeds at 1900 matches, with
    # ~30% headroom on top. Tight enough that a sign error, a mis-indexed
    # gradient, or a tau/dtau inconsistency all breach them by multiples: at
    # these strengths a flipped defence term moves a rate by ~100%, which is
    # roughly five times the loosest bound here.
    #
    #                        worst over 16 seeds    seeds 11/12/13
    ATTACK_MAX_ERROR = 0.25   # 0.194                0.147 / 0.113 / 0.090
    DEFENCE_MAX_ERROR = 0.30  # 0.206                0.124 / 0.203 / 0.120
    STRENGTH_RMS_ERROR = 0.10  # 0.077               0.077 / 0.074 / 0.052
    HOME_ADV_ERROR = 0.08     # 0.046                0.012 / 0.007 / 0.025
    INTERCEPT_ERROR = 0.06    # 0.027                0.027 / 0.015 / 0.020
    RHO_ERROR = 0.09          # 0.040                0.004 / 0.007 / 0.027

    def test_the_whole_parameter_vector_is_recovered(self):
        for seed in (11, 12, 13):
            with self.subTest(seed=seed):
                matches, attack, defence = _simulate_season(seed, rounds=5)
                # xi=0: under time decay there is no single fixed parameter
                # vector generating the data, so recovery would be asking the
                # estimator for something that does not exist.
                model = MLEDixonColes().fit(matches, xi=0.0)
                self.assertTrue(model.converged)

                order = [model.team_index[team] for team in _league()]
                attack_error = model.attack[order] - attack
                defence_error = model.defence[order] - defence

                self.assertLess(np.abs(attack_error).max(), self.ATTACK_MAX_ERROR)
                self.assertLess(np.abs(defence_error).max(), self.DEFENCE_MAX_ERROR)
                self.assertLess(
                    float(np.sqrt(np.mean(attack_error**2))), self.STRENGTH_RMS_ERROR
                )
                self.assertLess(
                    float(np.sqrt(np.mean(defence_error**2))), self.STRENGTH_RMS_ERROR
                )
                self.assertLess(abs(model.home_adv - TRUE_HOME_ADV), self.HOME_ADV_ERROR)
                self.assertLess(abs(model.intercept - TRUE_INTERCEPT), self.INTERCEPT_ERROR)
                self.assertLess(abs(model.rho - TRUE_RHO), self.RHO_ERROR)

    def test_recovered_rates_track_the_rates_the_data_came_from(self):
        """
        Parameters can each be inside tolerance while their combination is not,
        because lambda mixes four of them. This checks the quantity the harness
        actually consumes.

        Judged in RELATIVE error, since the model is log-linear: a fixed
        absolute tolerance would be lax on a 0.5-goal fixture and unreachable on
        a 3-goal one. Over these three seeds and all 760 rates each, the worst
        relative error was 0.292 and the worst RMS 0.093; a sign error on defence
        would put the worst case above 1.0.
        """
        teams = _league()
        for seed in (11, 12, 13):
            with self.subTest(seed=seed):
                matches, attack, defence = _simulate_season(seed, rounds=5)
                model = MLEDixonColes().fit(matches, xi=0.0)
                errors = []
                for home in range(N_TEAMS):
                    for away in range(N_TEAMS):
                        if home == away:
                            continue
                        true_lam = np.exp(
                            TRUE_INTERCEPT + attack[home] - defence[away] + TRUE_HOME_ADV
                        )
                        true_mu = np.exp(TRUE_INTERCEPT + attack[away] - defence[home])
                        lam, mu = model.rates(teams[home], teams[away])
                        errors += [lam / true_lam - 1.0, mu / true_mu - 1.0]
                self.assertLess(np.abs(errors).max(), 0.45)
                self.assertLess(float(np.sqrt(np.mean(np.square(errors)))), 0.13)

    def test_more_data_recovers_the_parameters_more_accurately(self):
        """
        Consistency, which distinguishes "noisy but correct" from "biased". A
        systematic error — a wrong sign in the gradient's defence term, say —
        would not shrink with sample size.
        """
        coarse, attack, defence = _simulate_season(seed=14, rounds=2)
        fine, attack_fine, defence_fine = _simulate_season(seed=14, rounds=12)
        # Same seed, so the true parameters are the same vector.
        np.testing.assert_allclose(attack, attack_fine)

        order_of = lambda m: [m.team_index[t] for t in _league()]
        coarse_model = MLEDixonColes().fit(coarse, xi=0.0)
        fine_model = MLEDixonColes().fit(fine, xi=0.0)
        coarse_rms = np.sqrt(
            np.mean((coarse_model.attack[order_of(coarse_model)] - attack) ** 2)
        )
        fine_rms = np.sqrt(
            np.mean((fine_model.attack[order_of(fine_model)] - attack_fine) ** 2)
        )
        self.assertLess(fine_rms, coarse_rms)


class TestTimeDecay(unittest.TestCase):
    def test_the_default_decay_is_the_one_the_bayesian_model_uses(self):
        """Two decay rates would make the two fits incomparable, which is the
        one thing this module exists to avoid."""
        model = MLEDixonColes().fit(_lopsided_league())
        self.assertEqual(model.xi, DIXON_COLES["xi_decay"])

    def test_decay_pulls_the_fit_toward_recent_results(self):
        """
        A club that was poor and is now excellent. With no decay the fit
        averages the two halves; with decay it has to favour the recent one, or
        the weights are being computed and discarded.
        """
        rows = []
        for day in range(0, 400, 4):
            improved_scored, improved_conceded = (0, 3) if day < 200 else (3, 0)
            rows.append(
                {
                    "home_team": "Improver FC",
                    "away_team": "Steady FC",
                    "home_goals": improved_scored,
                    "away_goals": improved_conceded,
                    "date": pd.Timestamp("2024-01-01") + pd.Timedelta(days=day),
                }
            )
            rows.append(
                {
                    "home_team": "Steady FC",
                    "away_team": "Improver FC",
                    "home_goals": 1,
                    "away_goals": improved_scored,
                    "date": pd.Timestamp("2024-01-03") + pd.Timedelta(days=day),
                }
            )
        matches = pd.DataFrame(rows)
        flat = MLEDixonColes().fit(matches, xi=0.0)
        decayed = MLEDixonColes().fit(matches, xi=0.02)
        improver = flat.team_index["Improver FC"]
        self.assertGreater(
            decayed.attack[decayed.team_index["Improver FC"]], flat.attack[improver]
        )


class TestFitCost(unittest.TestCase):
    """
    The whole justification for this module is that it is fast enough to refit at
    every gameweek. That claim belongs in a test, not only in a docstring.
    """

    def test_a_three_season_fit_is_fast_enough_to_refit_every_gameweek(self):
        """
        Measured on real results: 0.0027 s on 380 matches / 20 teams, 0.0083 s
        on 1140 matches / 25 teams (Apple M-series, scipy 1.18, analytic
        gradient, median of 11). The 1-second ceiling is ~100x headroom for a
        slower CI runner and still five orders of magnitude below the 20+ minute
        NUTS fit — which is the comparison that matters, so the assertion is
        deliberately loose rather than a performance tripwire.
        """
        single, _, _ = _simulate_season(seed=21, rounds=1)
        triple, _, _ = _simulate_season(seed=21, rounds=3)
        self.assertEqual(len(single), 380)
        self.assertEqual(len(triple), 1140)

        for label, matches in (("380", single), ("1140", triple)):
            started = time.perf_counter()
            model = MLEDixonColes().fit(matches)
            elapsed = time.perf_counter() - started
            self.assertTrue(model.converged, f"{label}-match fit did not converge")
            self.assertLess(elapsed, 1.0, f"{label}-match fit took {elapsed:.3f}s")

    def test_a_full_season_of_refits_costs_seconds_not_hours(self):
        """
        The actual walk-forward shape, and the reason this module exists: refit
        before every gameweek on two prior seasons plus the current one to date,
        so windows run 760 -> 1140 matches. 38 NUTS fits at 20 minutes each would
        be over twelve hours; measured here, all 38 take 0.19 s.
        """
        matches, _, _ = _simulate_season(seed=22, rounds=3)
        matches = matches.sort_values("date").reset_index(drop=True)
        windows = np.linspace(760, len(matches), 38).astype(int)
        started = time.perf_counter()
        for window in windows:
            model = MLEDixonColes().fit(matches.iloc[:window])
            self.assertTrue(model.converged)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 10.0, f"38 refits took {elapsed:.2f}s")


@unittest.skipUnless(
    REAL_SEASON_CSV.exists(),
    "data/raw is gitignored; run the pipeline once to populate the season cache",
)
class TestAgainstRealFootball(unittest.TestCase):
    """
    Synthetic data can only confirm the estimator recovers what it was handed.
    These check the numbers real results produce are football numbers.
    """

    @classmethod
    def setUpClass(cls):
        cls.model = MLEDixonColes().fit(_real_season())

    def test_home_advantage_is_positive(self):
        self.assertGreater(self.model.home_adv, 0.0)
        # 2526 measures 0.211; anything outside this is not home advantage.
        self.assertLess(self.model.home_adv, 0.6)

    def test_every_fixture_in_the_league_gets_a_plausible_rate(self):
        low, high = PLAUSIBLE_RATE
        for home in self.model.teams:
            for away in self.model.teams:
                if home == away:
                    continue
                lam, mu = self.model.rates(home, away)
                self.assertTrue(
                    low < lam < high and low < mu < high,
                    f"{home} v {away}: lambda={lam:.3f} mu={mu:.3f}",
                )
                # Premier League fixtures average about 2.8 goals; a 7-goal
                # expectation would mean the intercept has run away.
                self.assertLess(lam + mu, 7.0)

    def test_the_league_wide_rates_reproduce_the_seasons_scoring(self):
        """
        A fitted model whose average rate misses the realised average is
        mis-levelled, and every derived market inherits the error.
        """
        matches = _real_season()
        realised = (matches["FTHG"].mean() + matches["FTAG"].mean()) / 2.0
        rates = [
            value
            for home in self.model.teams
            for away in self.model.teams
            if home != away
            for value in self.model.rates(home, away)
        ]
        self.assertAlmostEqual(float(np.mean(rates)), float(realised), delta=0.25)

    def test_attack_and_defence_sum_to_zero_on_real_data(self):
        self.assertAlmostEqual(float(self.model.attack.sum()), 0.0, places=10)
        self.assertAlmostEqual(float(self.model.defence.sum()), 0.0, places=10)

    def test_rho_is_negative_as_every_real_premier_league_fit_finds(self):
        """
        In this tau convention the 1-1 cell carries ``1 - rho``, so a negative
        rho means draws are slightly more likely than independent Poissons say.
        Measured -0.164 on 2526 and -0.115 on three seasons. A positive fitted
        rho on real data would mean the correction has been wired in backwards —
        which no other test here would catch, because the sign is consistent
        between the likelihood and the grid either way.
        """
        self.assertLess(self.model.get_rho_mean(), 0.0)


if __name__ == "__main__":
    unittest.main()
