"""
XGBoost early-stopping holdout and the promoted-club Elo start.

Both changes move the XGBoost leg of the value-bet ensemble (30% of the blended
goal rates that size Kelly stakes), so the properties that make them safe are
asserted here rather than assumed:

  holdout  — time-ordered, strictly after every training row, never a handful
             of rows, and in-season results reach the final model;
  Elo      — promoted clubs start below average, returning clubs are not lifted
             toward average while out of the league, an offset of 0 is exactly
             the old rule, and no row's features see its own or a later result.

XGBoost itself is not needed: the regressor is substituted, so these run on the
repo interpreter whether or not xgboost is installed there.
"""
import math
import unittest
from contextlib import contextmanager

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.features.engineer import (
    EloRating,
    compute_elo_ratings,
    engineer_features,
)
from pipeline.models.xgboost_model import (
    XGBoostGoalModel,
    holdout_settings,
    temporal_holdout_split,
)


@contextmanager
def registry(**values):
    """Temporarily override PARAM_REGISTRY values (keys use '__' for '.')."""
    saved = {}
    try:
        for key, value in values.items():
            name = key.replace("__", ".")
            saved[name] = PARAM_REGISTRY[name]["value"]
            PARAM_REGISTRY[name]["value"] = value
        yield
    finally:
        for name, value in saved.items():
            PARAM_REGISTRY[name]["value"] = value


def _season_frame(season, clubs, start, rounds=2, seed=0, played=True):
    """Each ordered pair ``rounds`` times, one match every three days."""
    rng = np.random.default_rng(seed)
    rows = []
    day = pd.Timestamp(start)
    pairs = [(h, a) for h in clubs for a in clubs if h != a] * rounds
    for i, (h, a) in enumerate(pairs):
        hg, ag = (int(rng.poisson(1.5)), int(rng.poisson(1.1))) if played else (np.nan, np.nan)
        rows.append({
            "Date": day, "HomeTeam": h, "AwayTeam": a, "FTHG": hg, "FTAG": ag,
            "FTR": (("H" if hg > ag else "D" if hg == ag else "A") if played else np.nan),
            "HS": 10, "AS": 8, "HF": 11, "AF": 12, "HC": 5, "AC": 4, "HY": 2, "AY": 2,
            "season": season, "match_id": f"{season}_{i}_{h}_{a}",
        })
        day += pd.Timedelta(days=3)
    return pd.DataFrame(rows)


def _dated_frame(n, per_day=10, season_of=None):
    """n played rows, ``per_day`` sharing each date, so cut-offs fall on ties."""
    dates = [pd.Timestamp("2023-08-12") + pd.Timedelta(days=7 * (i // per_day)) for i in range(n)]
    df = pd.DataFrame({
        "Date": dates,
        "HomeTeam": [f"H{i % 20}" for i in range(n)],
        "AwayTeam": [f"A{i % 20}" for i in range(n)],
        "FTHG": np.arange(n) % 4,
        "FTAG": np.arange(n) % 3,
        "elo_diff": np.linspace(-200, 200, n),
        "home_elo": 1500.0,
        "away_elo": 1500.0,
    })
    df["season"] = [season_of(i) if season_of else "2324" for i in range(n)]
    return df


class TestTemporalHoldoutSplit(unittest.TestCase):
    def test_holdout_is_strictly_later_than_every_training_row(self):
        # 10 rows share each date, and 15% of 1210 is not a multiple of 10:
        # the cut lands inside a date, which must move wholly to the holdout.
        df = _dated_frame(1210).sample(frac=1.0, random_state=1)  # unsorted input
        train, hold = temporal_holdout_split(df, 0.15, 190)
        self.assertLess(train["Date"].max(), hold["Date"].min())
        self.assertEqual(len(train) + len(hold), len(df))
        self.assertGreaterEqual(len(hold), 190)
        self.assertEqual(train["Date"].nunique() + hold["Date"].nunique(), df["Date"].nunique())

    def test_holdout_is_the_chronological_tail_not_a_season(self):
        # 1140 completed rows + 70 in-season rows: the old split early-stopped on
        # exactly those 70. The new holdout is the tail by date, crossing seasons.
        df = _dated_frame(1210, season_of=lambda i: "2526" if i < 1140 else "2627")
        train, hold = temporal_holdout_split(df, 0.15, 190)
        self.assertEqual(set(hold["season"]), {"2526", "2627"})
        self.assertTrue((hold["Date"] >= df.sort_values("Date")["Date"].iloc[-190]).all())

    def test_in_season_rows_enter_training_once_the_season_is_long_enough(self):
        df = _dated_frame(1520, season_of=lambda i: "2526" if i < 1140 else "2627")
        train, hold = temporal_holdout_split(df, 0.15, 190)
        self.assertGreater((train["season"] == "2627").sum(), 0)
        # ceil(15% of 1520) = 228, plus the rest of the cut-off date (10 per day).
        self.assertGreaterEqual(len(hold), math.ceil(0.15 * 1520))
        self.assertLess(len(hold), math.ceil(0.15 * 1520) + 10)

    def test_minimum_rows_guard_overrides_a_small_fraction(self):
        df = _dated_frame(1140)
        _, hold = temporal_holdout_split(df, 0.05, 190)
        self.assertEqual(len(hold), 190)  # 5% would be 57

    def test_too_few_rows_is_refused_not_shrunk(self):
        with self.assertRaises(ValueError):
            temporal_holdout_split(_dated_frame(300), 0.15, 190)
        with self.assertRaises(ValueError):
            temporal_holdout_split(_dated_frame(1000), 0.0, 190)

    def test_registered_settings_are_sane(self):
        s = holdout_settings()
        self.assertGreater(s["fraction"], 0)
        self.assertLess(s["fraction"], 0.5)
        self.assertGreaterEqual(s["min_rows"], 100)
        for name in ("xgboost.holdout_fraction", "xgboost.holdout_min_rows",
                     "xgboost.refit_on_all_rows", "elo.promoted_start_offset"):
            self.assertNotEqual(PARAM_REGISTRY[name]["source"].strip(), "PENDING", name)


class _FakeRegressor:
    """Records what it was fitted on; stands in for xgb.XGBRegressor."""

    log = []

    def __init__(self, n_estimators, early_stopping):
        self.n_estimators = n_estimators
        self.early_stopping = early_stopping
        self.best_iteration = 36  # -> 37 trees

    def fit(self, X, y, eval_set=None, verbose=False):
        self.fit_index = list(X.index)
        self.eval_index = list(eval_set[0][0].index) if eval_set else None
        _FakeRegressor.log.append(self)
        return self

    def predict(self, X):
        return np.full(len(X), 1.3)


class _FakeXGB(XGBoostGoalModel):
    def _regressor(self, n_estimators, early_stopping):
        return _FakeRegressor(n_estimators, early_stopping)


class TestXGBoostFit(unittest.TestCase):
    def setUp(self):
        _FakeRegressor.log = []
        self.df = _dated_frame(1210, season_of=lambda i: "2526" if i < 1140 else "2627")
        # Two unplayed fixtures must never be fitted or used for early stopping.
        extra = self.df.tail(2).copy()
        extra["Date"] = extra["Date"] + pd.Timedelta(days=7)
        extra[["FTHG", "FTAG"]] = np.nan
        self.df = pd.concat([self.df, extra], ignore_index=True)
        self.played = self.df.dropna(subset=["FTHG", "FTAG"])

    def test_refit_puts_every_played_row_including_in_season_into_the_final_model(self):
        with registry(xgboost__refit_on_all_rows=1.0, xgboost__holdout_fraction=0.15,
                      xgboost__holdout_min_rows=190):
            metrics = _FakeXGB().fit(self.df)
        stop_home, stop_away, final_home, final_away = _FakeRegressor.log
        # Early-stopping fits: training strictly before the holdout.
        for m in (stop_home, stop_away):
            self.assertTrue(m.early_stopping)
            fit_dates = self.df.loc[m.fit_index, "Date"]
            eval_dates = self.df.loc[m.eval_index, "Date"]
            self.assertLess(fit_dates.max(), eval_dates.min())
            self.assertGreaterEqual(len(m.eval_index), 190)
        # Final fits: all played rows, the selected tree count, no early stopping.
        for m in (final_home, final_away):
            self.assertFalse(m.early_stopping)
            self.assertEqual(m.n_estimators, 37)
            self.assertEqual(sorted(m.fit_index), sorted(self.played.index))
        in_season = set(self.played.index[self.played["season"] == "2627"])
        self.assertTrue(in_season <= set(final_home.fit_index))
        self.assertEqual(metrics["n_fit"], len(self.played))
        self.assertTrue(metrics["refit_on_all_rows"])
        self.assertEqual(metrics["n_trees_home"], 37)

    def test_without_refit_the_early_stopped_models_are_kept(self):
        with registry(xgboost__refit_on_all_rows=0.0):
            model = _FakeXGB()
            metrics = model.fit(self.df)
        self.assertEqual(len(_FakeRegressor.log), 2)
        self.assertIs(model.model_home, _FakeRegressor.log[0])
        self.assertEqual(metrics["n_fit"], metrics["n_train"])

    def test_unplayed_rows_are_never_fitted(self):
        _FakeXGB().fit(self.df)
        unplayed = set(self.df.index[self.df["FTHG"].isna()])
        for m in _FakeRegressor.log:
            self.assertFalse(unplayed & set(m.fit_index))
            if m.eval_index:
                self.assertFalse(unplayed & set(m.eval_index))


class TestPromotedClubElo(unittest.TestCase):
    def _three_seasons(self):
        # S1: A B C D ; S2: A B C E (D relegated, E promoted, new) ;
        # S3: A B C D (E relegated, D returns).
        s1 = _season_frame("2324", ["A", "B", "C", "D"], "2023-08-12", seed=1)
        s2 = _season_frame("2425", ["A", "B", "C", "E"], "2024-08-17", seed=2)
        s3 = _season_frame("2526", ["A", "B", "C", "D"], "2025-08-16", seed=3)
        return pd.concat([s1, s2, s3], ignore_index=True)

    @staticmethod
    def _first_rating(frame, team, season):
        rows = frame[(frame["season"] == season) & ((frame["HomeTeam"] == team) | (frame["AwayTeam"] == team))]
        row = rows.iloc[0]
        return row["home_elo"] if row["HomeTeam"] == team else row["away_elo"]

    def test_registered_offset_is_negative(self):
        self.assertLess(PARAM_REGISTRY["elo.promoted_start_offset"]["value"], 0)

    def test_first_season_clubs_start_at_1500_and_promoted_club_below(self):
        frame, _ = compute_elo_ratings(self._three_seasons(), promoted_offset=-110)
        for team in "ABCD":
            self.assertEqual(self._first_rating(frame, team, "2324"), 1500)
        self.assertEqual(self._first_rating(frame, "E", "2425"), 1390)

    def test_offset_zero_is_the_original_rule(self):
        data = self._three_seasons()
        frame, _ = compute_elo_ratings(data, promoted_offset=0.0)
        self.assertEqual(self._first_rating(frame, "E", "2425"), 1500)
        # Original rule, by hand: every rated club regresses 1/3 toward 1500 at
        # every boundary, and an unrated club starts at 1500.
        elo = EloRating(promoted_offset=0.0)
        expected = []
        prev = None
        for _, r in data.iterrows():
            if prev and r["season"] != prev:
                for t in elo.ratings:
                    elo.ratings[t] = elo.ratings[t] * (1 - elo.mean_reversion) + 1500 * elo.mean_reversion
            prev = r["season"]
            expected.append(elo.ratings.get(r["HomeTeam"], 1500))
            elo.update(r["HomeTeam"], r["AwayTeam"], int(r["FTHG"]), int(r["FTAG"]))
        np.testing.assert_allclose(frame["home_elo"].to_numpy(), expected)

    def test_returning_club_regresses_toward_the_promoted_anchor(self):
        data = self._three_seasons()
        off = -110.0
        frame, _ = compute_elo_ratings(data, promoted_offset=off)
        # D's rating at the end of S1, by replaying S1 alone.
        _, elo_s1 = compute_elo_ratings(data[data["season"] == "2324"], promoted_offset=off)
        end = elo_s1.ratings["D"]
        r = 0.33
        anchor = 1500 + off
        after_two = anchor + (end - anchor) * (1 - r) ** 2  # absent in S2, returning in S3
        self.assertAlmostEqual(self._first_rating(frame, "D", "2526"), after_two, places=6)
        # Established clubs still regress toward 1500.
        a_end_s2 = compute_elo_ratings(data[data["season"] != "2526"], promoted_offset=off)[1].ratings["A"]
        self.assertAlmostEqual(
            self._first_rating(frame, "A", "2526"), 1500 + (a_end_s2 - 1500) * (1 - r), places=6
        )

    def test_promoted_club_in_upcoming_fixtures_gets_the_anchor(self):
        history = _season_frame("2526", ["A", "B", "C", "D"], "2025-08-16", seed=4)
        upcoming = _season_frame("2627", ["A", "B", "C", "P"], "2026-08-22", rounds=1, played=False)
        frame, _ = compute_elo_ratings(pd.concat([history, upcoming], ignore_index=True), promoted_offset=-110)
        self.assertEqual(self._first_rating(frame, "P", "2627"), 1390)

    def test_features_never_see_their_own_or_a_later_result(self):
        data = self._three_seasons()
        base = engineer_features(data.copy())
        cut = len(data) // 2
        altered = data.copy()
        rng = np.random.default_rng(99)
        altered.loc[cut:, "FTHG"] = rng.integers(0, 7, len(altered) - cut)
        altered.loc[cut:, "FTAG"] = rng.integers(0, 7, len(altered) - cut)
        altered["FTR"] = np.where(altered["FTHG"] > altered["FTAG"], "H",
                                  np.where(altered["FTHG"] == altered["FTAG"], "D", "A"))
        changed = engineer_features(altered)
        cols = ["home_elo", "away_elo", "elo_diff", "home_ewm_goals_for_5", "away_ewm_goals_against_5",
                "home_form_5", "away_form_5", "h2h_home_win_rate"]
        a = base.set_index("match_id").loc[data["match_id"].iloc[: cut + 1], cols]
        b = changed.set_index("match_id").loc[data["match_id"].iloc[: cut + 1], cols]
        pd.testing.assert_frame_equal(a, b)


if __name__ == "__main__":
    unittest.main()
