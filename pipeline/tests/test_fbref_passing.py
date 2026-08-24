"""
The FBref passing table's column mapping.

This is the first test this source has ever had, and the reason it needs one is
unusual: `fetch_fbref_passing_stats` never completed a single fetch. It imported
a package that does not install on Python 3.13+, and on the interpreter where
that import worked it called `read_team_season_stats(league, season,
stat_type=...)` against a signature of `(stat_type, opponent_stats)` — a
duplicate-argument TypeError, swallowed by a broad `except Exception`. So every
line below the fetch is code that has never run in production.

The frames here are shaped like the real thing: FBref's passing table has a
two-level column index, and the four `Cmp%` columns are the specific trap. A
substring rule matching "cmp%" renamed all four to `pass_completion_pct`, and a
frame with four identically named columns hands `float(row[col])` a Series.

No network. The fetch is not exercised — its failure paths all return None by
design, and asserting that a try/except returns None tests the try/except.
"""
import unittest

import pandas as pd

from pipeline.data.fbref import (
    PASSING_FEATURES, _column_key, select_passing_columns,
)


def fbref_frame():
    """A passing table shaped like fbrefdata's, after `reset_index()`."""
    columns = pd.MultiIndex.from_tuples([
        ("league", ""),
        ("season", ""),
        ("team", ""),
        ("Unnamed: 3_level_0", "# Pl"),
        ("Total", "Cmp"),
        ("Total", "Att"),
        ("Total", "Cmp%"),
        ("Short", "Cmp%"),
        ("Medium", "Cmp%"),
        ("Long", "Cmp%"),
        ("Expected", "xAG"),
        ("", "KP"),
        ("", "1/3"),
        ("", "PPA"),
        ("", "CrsPA"),
        ("", "PrgP"),
    ])
    rows = [
        ["ENG-Premier League", "2627", "Liverpool", 22,
         4123, 4901, 84.1, 91.2, 86.4, 61.3, 1.9, 41, 388, 71, 29, 512],
        ["ENG-Premier League", "2627", "Brighton", 24,
         3990, 4712, 84.7, 92.0, 87.1, 58.9, 1.4, 37, 401, 66, 24, 498],
    ]
    return pd.DataFrame(rows, columns=columns)


class ColumnKeys(unittest.TestCase):
    def test_a_grouped_column_keeps_its_group(self):
        self.assertEqual(_column_key(("Total", "Cmp%")), ("Total", "Cmp%"))

    def test_an_ungrouped_column_has_an_empty_group(self):
        self.assertEqual(_column_key(("", "KP")), ("", "KP"))

    def test_an_unnamed_level_is_not_treated_as_a_group(self):
        # FBref pads its header with "Unnamed: 3_level_0" rather than an empty
        # string, and a mapping keyed on that would break whenever the column
        # ordinal changed.
        self.assertEqual(_column_key(("Unnamed: 3_level_0", "# Pl")), ("", "# Pl"))

    def test_a_flat_column_still_works(self):
        self.assertEqual(_column_key("Squad"), ("", "Squad"))


class Selection(unittest.TestCase):
    def setUp(self):
        self.out = select_passing_columns(fbref_frame())

    def test_the_four_completion_columns_yield_exactly_one(self):
        """The bug this file exists for."""
        matches = [c for c in self.out.columns if c == "pass_completion_pct"]
        self.assertEqual(len(matches), 1)

    def test_it_takes_the_total_completion_rate_not_a_distance_band(self):
        # Short passes complete 91.2% of the time and long ones 61.3%; the
        # feature is meant to be the team's overall rate, 84.1%.
        self.assertAlmostEqual(self.out["pass_completion_pct"].iloc[0], 84.1)

    def test_every_named_feature_is_present_and_singular(self):
        for feature in PASSING_FEATURES:
            self.assertEqual(
                [c for c in self.out.columns if c == feature], [feature],
                f"{feature} is missing or duplicated",
            )

    def test_the_team_comes_from_the_index_level_not_the_first_column(self):
        # After `reset_index()` the leftmost column is the league, and taking it
        # would label every row "ENG-Premier League".
        self.assertEqual(list(self.out["team"]), ["Liverpool", "Brighton"])

    def test_it_carries_nothing_it_was_not_asked_for(self):
        self.assertEqual(
            set(self.out.columns), {"team", *PASSING_FEATURES},
        )

    def test_the_values_are_numbers(self):
        self.assertEqual(self.out["key_passes"].iloc[0], 41)
        self.assertEqual(self.out["progressive_passes"].iloc[1], 498)


class ShapesItDoesNotExpect(unittest.TestCase):
    def test_a_flat_squad_column_is_found(self):
        frame = pd.DataFrame(
            {"Squad": ["Chelsea"], "KP": [30], "PrgP": [400]},
        )
        out = select_passing_columns(frame)
        self.assertEqual(list(out["team"]), ["Chelsea"])
        self.assertEqual(out["key_passes"].iloc[0], 30)

    def test_a_missing_feature_is_absent_rather_than_zero(self):
        # A fabricated zero for a pass-completion percentage is a measurement
        # nobody took. `build_advanced_features` skips absent columns.
        frame = pd.DataFrame({"team": ["Arsenal"], "KP": [33]})
        out = select_passing_columns(frame)
        self.assertNotIn("pass_completion_pct", out.columns)
        self.assertIn("key_passes", out.columns)

    def test_a_non_numeric_cell_becomes_null_not_a_crash(self):
        frame = pd.DataFrame({"team": ["Everton"], "KP": ["—"]})
        out = select_passing_columns(frame)
        self.assertTrue(pd.isna(out["key_passes"].iloc[0]))

    def test_a_frame_with_no_team_column_falls_back_and_warns(self):
        frame = pd.DataFrame({"whatever": ["x"], "KP": [1]})
        with self.assertLogs("pipeline.data.fbref", level="WARNING") as logs:
            out = select_passing_columns(frame)
        self.assertIn("no team column", "\n".join(logs.output))
        self.assertEqual(list(out["team"]), ["x"])


class TheConsumerCanUseIt(unittest.TestCase):
    def test_build_advanced_features_reads_every_feature_as_a_float(self):
        """
        The end of the chain, which is what the duplicate-column bug broke: a
        Series where a float was expected. Asserted here because this is the
        first point at which the two halves have ever met.
        """
        from pipeline.data.fbref import build_advanced_features

        features = build_advanced_features(None, select_passing_columns(fbref_frame()))
        self.assertIn("Liverpool", features)
        for feature in PASSING_FEATURES:
            value = features["Liverpool"][feature]
            self.assertIsInstance(value, float, f"{feature} is {type(value)}")


if __name__ == "__main__":
    unittest.main()
