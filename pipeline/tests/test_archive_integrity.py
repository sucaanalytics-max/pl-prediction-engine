"""
Integrity checks on the committed archive.

These run against the real committed seasons, not fixtures. The archive is
irreplaceable training data and every model in the project is fitted on it, so a
silent corruption here is invisible everywhere and wrong everywhere.

The duplicate check exists because the failure it guards is genuinely silent:
upstream emitted ten byte-identical player-fixture rows in 2025-26, so the
scoring replay passed — it compares each row against itself — while every
per-player aggregate double-counted. One player's season total read 24% high.
"""
from __future__ import annotations

import unittest

from pipeline.learning.backfill import load_archive_season

SEASONS = ("2223", "2324", "2425", "2526")

# Seasons whose `starts` column is fully populated. 2022-23 is excluded: the
# FPL API added `starts` mid-season, so GW1-15 are all zero and the minutes
# model would learn that nobody starts.
SEASONS_WITH_STARTS = ("2324", "2425", "2526")


class TestArchiveLoads(unittest.TestCase):
    def test_every_committed_season_loads(self):
        for season in SEASONS:
            frame = load_archive_season(season)
            self.assertGreater(len(frame), 20_000, season)

    def test_model_critical_columns_are_never_null(self):
        required = [
            "element", "minutes", "total_points", "value", "GW", "starts",
            "team_canonical", "fixture", "was_home", "goals_conceded", "selected",
        ]
        for season in SEASONS:
            frame = load_archive_season(season)
            for column in required:
                self.assertIn(column, frame.columns, f"{season}.{column}")
                self.assertEqual(
                    frame[column].isna().sum(), 0, f"{season}.{column} has nulls"
                )


class TestNoDuplicateRows(unittest.TestCase):
    def test_player_fixture_rows_are_unique(self):
        """
        (element, GW, fixture) is the primary key. Duplicates double-count in
        every aggregate while leaving row-wise checks green.
        """
        for season in SEASONS:
            frame = load_archive_season(season)
            duplicated = frame.duplicated(["element", "GW", "fixture"]).sum()
            self.assertEqual(duplicated, 0, f"{season} has {duplicated} duplicate rows")

    def test_double_gameweeks_are_preserved(self):
        """
        The dedup must not mistake a real second fixture for a duplicate. A
        double gameweek shares element and GW but has a DISTINCT fixture, so
        deduping on the full key leaves it intact.
        """
        frame = load_archive_season("2526")
        pairs = frame.groupby(["element", "GW"]).size()
        self.assertGreater(
            (pairs > 1).sum(), 0,
            "no double-gameweek rows survived; the dedup key is too coarse",
        )


class TestStructuralSanity(unittest.TestCase):
    def test_eleven_starters_per_fixture_team(self):
        """
        A football match starts eleven a side. Anything else means `starts` is
        not what it claims to be — which is exactly how 2022-23 fails.
        """
        for season in SEASONS_WITH_STARTS:
            frame = load_archive_season(season)
            per_team = frame.groupby(["fixture", "team_canonical"])["starts"].sum()
            self.assertAlmostEqual(
                float(per_team.mean()), 11.0, places=1,
                msg=f"{season} averages {per_team.mean():.2f} starters per team",
            )

    def test_2223_starts_is_known_broken_and_excluded(self):
        """
        Documents the exclusion rather than leaving it as folklore. If upstream
        ever backfills it, this test fails and the season becomes usable.
        """
        frame = load_archive_season("2223")
        per_gameweek = frame.groupby("GW")["starts"].sum()
        self.assertGreater(
            (per_gameweek == 0).sum(), 0,
            "2022-23 now has starts in every gameweek; it can be promoted to "
            "SEASONS_WITH_STARTS and added to the decision backtest",
        )

    def test_minutes_and_points_are_in_range(self):
        for season in SEASONS:
            frame = load_archive_season(season)
            self.assertGreaterEqual(frame["minutes"].min(), 0, season)
            self.assertLessEqual(frame["minutes"].max(), 90, season)
            # A single-fixture score outside this band would mean the scoring
            # columns are misaligned.
            self.assertGreaterEqual(frame["total_points"].min(), -10, season)
            self.assertLessEqual(frame["total_points"].max(), 40, season)

    def test_every_fixture_has_two_sides(self):
        """
        A one-sided fixture cannot be simulated jointly, and simulating it with
        a synthetic opponent would invent a clean sheet.
        """
        for season in SEASONS:
            frame = load_archive_season(season)
            sides = frame.groupby("fixture")["team_canonical"].nunique()
            self.assertEqual(
                set(sides.unique()), {2},
                f"{season} has fixtures with {sorted(set(sides.unique()))} sides",
            )
