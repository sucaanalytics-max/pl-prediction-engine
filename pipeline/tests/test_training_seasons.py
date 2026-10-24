"""
The in-progress season is always in the training set.

`config.SEASONS` was ["2324", "2425", "2526"] from the initial commit and was never
rolled forward, so on 2026-10-25 — eight gameweeks into 2026-27 — Dixon-Coles,
PenaltyBlog and XGBoost had seen zero 2026-27 matches. Arsenal, conceding 0.95
npxG a game with five clean sheets in eight, were rated on last season's form and
priced out of the recommended wildcard. The same ratings carry 60% of the
ensemble that sizes Kelly stakes.

The fix derives the list instead of relying on someone to append a string each
August. These tests fail if the current season can ever fall out of training.
"""
import unittest
from unittest import mock

import pandas as pd

from pipeline import config
from pipeline.data import football_data


class CurrentSeasonIsTrained(unittest.TestCase):
    def test_current_season_is_in_the_training_set(self):
        self.assertIn(config.CURRENT_SEASON, config.TRAINING_SEASONS)

    def test_completed_seasons_are_all_kept(self):
        for s in config.SEASONS:
            self.assertIn(s, config.TRAINING_SEASONS)

    def test_current_season_appended_when_not_yet_completed(self):
        self.assertEqual(
            config.training_seasons(["2425", "2526"], "2627"),
            ["2425", "2526", "2627"],
        )

    def test_not_duplicated_once_rolled_into_completed(self):
        # The day someone adds 2627 to SEASONS, it must not be trained on twice.
        self.assertEqual(
            config.training_seasons(["2526", "2627"], "2627"), ["2526", "2627"]
        )

    def test_loader_default_is_the_training_set(self):
        loaded = []

        def fake_fetch(code, force=False):
            loaded.append(code)
            return pd.DataFrame({
                "Date": ["10/08/2026"], "HomeTeam": ["Arsenal"],
                "AwayTeam": ["Chelsea"], "FTHG": [1], "FTAG": [0],
            })

        with mock.patch.object(football_data, "fetch_season_csv", fake_fetch):
            football_data.load_all_seasons()
        self.assertEqual(
            loaded,
            [config.FOOTBALL_DATA_SEASONS.get(s, s) for s in config.TRAINING_SEASONS],
        )
        self.assertIn(config.CURRENT_SEASON, loaded)

    def test_current_season_failure_is_loud(self):
        # A completed season failing is logged and skipped; the current one
        # failing would silently re-freeze every rating, so it must raise.
        def fake_fetch(code, force=False):
            if code == config.CURRENT_SEASON:
                raise ConnectionError("no network, no cache")
            return pd.DataFrame({
                "Date": ["10/08/2025"], "HomeTeam": ["Arsenal"],
                "AwayTeam": ["Chelsea"], "FTHG": [1], "FTAG": [0],
            })

        with mock.patch.object(football_data, "fetch_season_csv", fake_fetch):
            with self.assertRaises(RuntimeError):
                football_data.load_all_seasons()


if __name__ == "__main__":
    unittest.main()
