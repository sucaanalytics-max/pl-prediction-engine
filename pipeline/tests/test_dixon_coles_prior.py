"""
The Dixon-Coles team-strength prior: fixed sigma and the promoted-club offset.

## What was wrong

Two things kept the best defence in the league rated near average.

* **Every club's prior mean was 0.** A promoted club with seven matches was
  pulled toward the league average, although promoted clubs historically sit
  about 0.30 below it in log attack and 0.24 in log defence (24 club-seasons,
  2018-19 to 2025-26). A club the posterior had never seen got exactly 0.
* **The shrinkage was too tight.** The HalfNormal(1) hyperprior learned
  sigma 0.16 / 0.12 on 2023-27, and the posterior-mean defence effects had an SD
  of 0.06. sigma is now fixed at the value the walk-forward selected.

## What these tests pin, without PyMC

* Promoted clubs are identified from the ``season`` column by date order, and a
  pre-season or single-season frame applies no offset rather than a wrong one.
* Only promoted clubs get a non-zero prior mean; a club with no Premier League
  data in the window gets the shrunk offset, a returning club the full one.
* The model reads all four values from ``PARAM_REGISTRY`` and nowhere else.
* An unseen club at predict time gets the shrunk offset, while a model pickled
  before ``unseen_prior`` existed keeps its old (0, 0).
* ``predict_scoreline`` on a one-draw trace equals ``scoreline_matrix``, so the
  vectorised path the pipeline uses and the single-fixture forward model agree.
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.models.dixon_coles import (
    BayesianDixonColes,
    classify_promoted_clubs,
    promoted_prior_means,
    promoted_prior_settings,
)

KEYS = (
    "dixon_coles.team_effect_sigma",
    "dixon_coles.promoted_attack_offset",
    "dixon_coles.promoted_defence_offset",
    "dixon_coles.promoted_new_club_shrink",
)


def _season(label: str, start: str, clubs, played: bool = True) -> pd.DataFrame:
    """A round robin of ``clubs`` in one season, one match a day."""
    rows = []
    day = pd.Timestamp(start)
    for i, home in enumerate(clubs):
        for away in clubs[i + 1:]:
            rows.append({
                "Date": day, "HomeTeam": home, "AwayTeam": away,
                "FTHG": 1.0 if played else np.nan, "FTAG": 0.0 if played else np.nan,
                "season": label,
            })
            day += pd.Timedelta(days=1)
    return pd.DataFrame(rows)


# Labels deliberately sort the wrong way as strings: "b" < "z" alphabetically,
# but "z" is the earlier season. Order must come from dates.
OLD = _season("z", "2020-08-01", ["Alpha", "Beta", "Gamma", "Yo-Yo"])
PREV = _season("b", "2021-08-01", ["Alpha", "Beta", "Gamma", "Delta"])
CUR = _season("m", "2022-08-01", ["Alpha", "Beta", "Yo-Yo", "Newcomer"])


class ClassifyPromotedClubsTests(unittest.TestCase):
    def test_promoted_are_current_clubs_missing_from_the_previous_season(self):
        promoted, new = classify_promoted_clubs(pd.concat([OLD, PREV, CUR]), season="m")
        self.assertEqual(promoted, {"Yo-Yo", "Newcomer"})
        # Yo-Yo played in the window two seasons ago; Newcomer never did.
        self.assertEqual(new, {"Newcomer"})

    def test_season_order_comes_from_dates_not_labels(self):
        # Asking about "b" must compare against "z" (earlier by date), finding
        # Delta promoted — string order would make "b" the first season.
        promoted, _ = classify_promoted_clubs(pd.concat([OLD, PREV, CUR]), season="b")
        self.assertEqual(promoted, {"Delta"})

    def test_pre_season_applies_no_offset(self):
        """Fixtures listed but unplayed: the promoted clubs are simply unseen."""
        unplayed = _season("m", "2022-08-01", ["Alpha", "Beta", "Yo-Yo", "Newcomer"], played=False)
        self.assertEqual(
            classify_promoted_clubs(pd.concat([OLD, PREV, unplayed]), season="m"), (set(), set())
        )

    def test_missing_previous_season_applies_no_offset(self):
        """Otherwise every club in a lone season would look promoted."""
        with self.assertLogs("pipeline.models.dixon_coles", level="WARNING"):
            self.assertEqual(classify_promoted_clubs(CUR, season="m"), (set(), set()))

    def test_defaults_to_the_current_season(self):
        frame = pd.concat([OLD, PREV, CUR])
        with mock.patch("pipeline.models.dixon_coles.CURRENT_SEASON", "m"):
            self.assertEqual(classify_promoted_clubs(frame)[0], {"Yo-Yo", "Newcomer"})
        with mock.patch("pipeline.models.dixon_coles.CURRENT_SEASON", "absent"):
            self.assertEqual(classify_promoted_clubs(frame), (set(), set()))


class PromotedPriorMeansTests(unittest.TestCase):
    def test_only_promoted_clubs_move_and_new_ones_are_shrunk(self):
        teams = ["Alpha", "Newcomer", "Yo-Yo", "Zeta"]
        att, dfc = promoted_prior_means(
            teams, {"Newcomer", "Yo-Yo"}, {"Newcomer"},
            attack_offset=-0.30, defence_offset=-0.24, new_club_shrink=0.5,
        )
        np.testing.assert_allclose(att, [0.0, -0.15, -0.30, 0.0])
        np.testing.assert_allclose(dfc, [0.0, -0.12, -0.24, 0.0])

    def test_no_promoted_clubs_is_the_old_zero_prior(self):
        att, dfc = promoted_prior_means(["A", "B"], set(), set(), -0.3, -0.24, 0.5)
        self.assertFalse(att.any() or dfc.any())


class RegistryIsTheSingleSourceTests(unittest.TestCase):
    def test_entries_exist_with_sources(self):
        for key in KEYS:
            self.assertIn(key, PARAM_REGISTRY)
            self.assertNotEqual(PARAM_REGISTRY[key]["source"].strip(), "DRAFT", key)

    def test_offsets_are_negative_and_shrink_is_partial(self):
        prior = promoted_prior_settings()
        self.assertLess(prior["attack_offset"], 0.0)
        self.assertLess(prior["defence_offset"], 0.0)
        self.assertGreater(prior["new_club_shrink"], 0.0)
        self.assertLess(prior["new_club_shrink"], 1.0)

    def test_model_prior_follows_the_registry(self):
        frame = pd.concat([OLD, PREV, CUR])
        patched = {k: dict(v) for k, v in PARAM_REGISTRY.items()}
        patched["dixon_coles.team_effect_sigma"]["value"] = 0.123
        patched["dixon_coles.promoted_attack_offset"]["value"] = -0.5
        patched["dixon_coles.promoted_defence_offset"]["value"] = -0.4
        patched["dixon_coles.promoted_new_club_shrink"]["value"] = 0.25
        with mock.patch.dict("pipeline.models.dixon_coles.PARAM_REGISTRY", patched):
            model = _model_for(frame)
            att, dfc, sigma = model._configure_prior(frame, {"Yo-Yo", "Newcomer"}, {"Newcomer"})
        self.assertEqual(sigma, 0.123)
        self.assertAlmostEqual(att[model.team_index["Newcomer"]], -0.125)
        self.assertAlmostEqual(dfc[model.team_index["Yo-Yo"]], -0.4)
        self.assertEqual(model.unseen_prior, (-0.125, -0.1))


def _model_for(frame: pd.DataFrame) -> BayesianDixonColes:
    model = BayesianDixonColes()
    played = frame.dropna(subset=["FTHG", "FTAG"])
    model.teams = sorted(set(played.HomeTeam) | set(played.AwayTeam))
    model.team_index = {t: i for i, t in enumerate(model.teams)}
    model.n_teams = len(model.teams)
    return model


class ConfigurePriorTests(unittest.TestCase):
    def test_default_detection_uses_the_current_season(self):
        frame = pd.concat([OLD, PREV, CUR])
        model = _model_for(frame)
        with mock.patch("pipeline.models.dixon_coles.CURRENT_SEASON", "m"):
            att, dfc, sigma = model._configure_prior(frame)
        prior = promoted_prior_settings()
        self.assertEqual(model.promoted_clubs, {"Yo-Yo", "Newcomer"})
        self.assertEqual(model.new_promoted_clubs, {"Newcomer"})
        self.assertAlmostEqual(att[model.team_index["Yo-Yo"]], prior["attack_offset"])
        self.assertAlmostEqual(
            dfc[model.team_index["Newcomer"]],
            prior["new_club_shrink"] * prior["defence_offset"],
        )
        self.assertEqual(att[model.team_index["Alpha"]], 0.0)
        self.assertEqual(sigma, PARAM_REGISTRY["dixon_coles.team_effect_sigma"]["value"])

    def test_override_without_new_subset_derives_it_from_the_latest_season(self):
        frame = pd.concat([OLD, PREV, CUR])
        model = _model_for(frame)
        model._configure_prior(frame, promoted_clubs={"Yo-Yo", "Newcomer"})
        self.assertEqual(model.new_promoted_clubs, {"Newcomer"})

    def test_override_ignores_clubs_absent_from_the_data(self):
        frame = pd.concat([OLD, PREV, CUR])
        model = _model_for(frame)
        model._configure_prior(frame, promoted_clubs={"Ghost"}, new_promoted_clubs={"Ghost"})
        self.assertEqual(model.promoted_clubs, set())


def _fake_trace(teams, attack, defence, intercept=0.2, home_adv=0.25, rho=-0.08):
    """A one-chain, one-draw stand-in for an arviz trace."""
    var = lambda a: SimpleNamespace(values=np.asarray(a, dtype=float))
    posterior = {
        "attack": var(np.asarray(attack, dtype=float)[None, None, :]),
        "defence": var(np.asarray(defence, dtype=float)[None, None, :]),
        "intercept": var([[intercept]]),
        "home_adv": var([[home_adv]]),
        "rho": var([[rho]]),
    }
    return SimpleNamespace(posterior=posterior)


def _fitted(unseen_prior=None) -> BayesianDixonColes:
    model = BayesianDixonColes()
    model.teams = ["Arsenal", "Brentford"]
    model.team_index = {"Arsenal": 0, "Brentford": 1}
    model.n_teams = 2
    model.trace = _fake_trace(model.teams, attack=[0.3, -0.1], defence=[0.4, -0.2])
    if unseen_prior is None:
        del model.unseen_prior  # as a model pickled before the attribute existed
    else:
        model.unseen_prior = unseen_prior
    return model


class UnseenClubTests(unittest.TestCase):
    def test_unseen_club_gets_the_shrunk_promoted_offset(self):
        model = _fitted(unseen_prior=(-0.15, -0.12))
        lam, mu = model.get_lambda_mu_samples("Arsenal", "Promoted FC", n_samples=10)
        # log lam = c + att_Arsenal - def_unseen + h ; log mu = c + att_unseen - def_Arsenal
        np.testing.assert_allclose(lam, np.exp(0.2 + 0.3 + 0.12 + 0.25))
        np.testing.assert_allclose(mu, np.exp(0.2 - 0.15 - 0.4))

    def test_old_pickle_keeps_the_league_average(self):
        model = _fitted(unseen_prior=None)
        lam, mu = model.get_lambda_mu_samples("Promoted FC", "Arsenal", n_samples=10)
        np.testing.assert_allclose(lam, np.exp(0.2 + 0.0 - 0.4 + 0.25))
        np.testing.assert_allclose(mu, np.exp(0.2 + 0.3 - 0.0))

    def test_known_clubs_are_untouched_by_the_unseen_prior(self):
        with_prior = _fitted(unseen_prior=(-0.15, -0.12)).get_lambda_mu_samples("Arsenal", "Brentford", 5)
        without = _fitted(unseen_prior=None).get_lambda_mu_samples("Arsenal", "Brentford", 5)
        np.testing.assert_array_equal(with_prior[0], without[0])
        np.testing.assert_array_equal(with_prior[1], without[1])

    def test_fresh_instance_defaults_to_zero(self):
        self.assertEqual(BayesianDixonColes().unseen_prior, (0.0, 0.0))


class ScorelineEquivalenceTests(unittest.TestCase):
    def test_predict_scoreline_matches_scoreline_matrix_on_one_draw(self):
        model = _fitted(unseen_prior=(-0.15, -0.12))
        matrix = model.predict_scoreline("Arsenal", "Brentford", n_samples=1)
        lam = np.exp(0.2 + 0.3 - (-0.2) + 0.25)
        mu = np.exp(0.2 + (-0.1) - 0.4)
        expected = BayesianDixonColes.scoreline_matrix(lam, mu, -0.08)
        np.testing.assert_allclose(matrix, expected, rtol=1e-10, atol=1e-12)
        self.assertAlmostEqual(float(matrix.sum()), 1.0, places=12)


if __name__ == "__main__":
    unittest.main()
