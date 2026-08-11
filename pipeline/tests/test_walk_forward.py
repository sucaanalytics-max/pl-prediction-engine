"""
Tests for the walk-forward calibration harness.

This module exists because two earlier measurements were wrong in ways that
produced plausible numbers, so the tests target those two failures directly
rather than the happy path:

* ``test_no_future_data_reaches_the_projection`` — everything must be fitted on
  data strictly before the target gameweek. Fitting team strengths on the whole
  archive makes the defence ratings a partial readout of the results being
  forecast, and the resulting calibration looks better than the model is.
* ``test_universe_covers_everyone_who_played`` — coverage. The previous harness
  matched 48% of player rows and reported on the remainder as though it were
  the population.
"""
from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from pipeline.learning.walk_forward import (
    ELEMENT_TYPE_IDS,
    fixture_specs,
    synthetic_bootstrap,
    walk_forward,
)


def _archive(n_gameweeks: int = 4) -> pd.DataFrame:
    """
    A tiny but structurally faithful archive: two clubs, one fixture a week.

    Faithful in the ways that matter here — both sides of every fixture present,
    prices that move, and a player who only appears late, which is what a
    universe built from the wrong season gets wrong.
    """
    rows = []
    for gw in range(1, n_gameweeks + 1):
        for element, (team, home, position) in enumerate(
            [
                (("Arsenal", True, "GKP")),
                (("Arsenal", True, "DEF")),
                (("Arsenal", True, "MID")),
                (("Chelsea", False, "GKP")),
                (("Chelsea", False, "DEF")),
                (("Chelsea", False, "FWD")),
            ],
            start=1,
        ):
            rows.append(
                {
                    "element": element, "name": f"player{element}",
                    # build_fpl_inputs joins on name_key, which
                    # load_archive_season adds to the real archive.
                    "name_key": f"player{element}",
                    "position": position, "team_canonical": team,
                    "was_home": home, "fixture": gw,
                    "GW": gw, "minutes": 90 if element % 2 else 45,
                    "total_points": 2 + (element % 3),
                    "value": 50 + gw, "starts": 1,
                    "goals_scored": 0, "assists": 0, "clean_sheets": 0,
                    "goals_conceded": 1, "yellow_cards": 0, "red_cards": 0,
                    "saves": 0, "bonus": 0, "bps": 10,
                    "team_h_score": 1, "team_a_score": 1,
                    "opponent_team": 2 if home else 1,
                }
            )
    return pd.DataFrame(rows)


class TestSyntheticBootstrap(unittest.TestCase):
    def test_universe_is_the_target_gameweeks_squads(self):
        """
        Built from the season's own rows. A bootstrap from a different season
        matches barely half the players, because clubs are promoted, players are
        sold and element ids are re-issued.
        """
        archive = _archive()
        bootstrap = synthetic_bootstrap(archive, 3)
        ids = {e["id"] for e in bootstrap["elements"]}
        expected = set(archive[archive["GW"] == 3]["element"])
        self.assertEqual(ids, expected)

    def test_prices_come_from_the_target_gameweek(self):
        archive = _archive()
        bootstrap = synthetic_bootstrap(archive, 3)
        self.assertTrue(all(e["now_cost"] == 53 for e in bootstrap["elements"]))

    def test_positions_map_to_element_types(self):
        archive = _archive()
        bootstrap = synthetic_bootstrap(archive, 2)
        by_id = {e["id"]: e["element_type"] for e in bootstrap["elements"]}
        rows = archive[archive["GW"] == 2].drop_duplicates(subset=["element"])
        for row in rows.itertuples():
            self.assertEqual(by_id[row.element], ELEMENT_TYPE_IDS[row.position])

    def test_every_club_has_a_team_entry(self):
        bootstrap = synthetic_bootstrap(_archive(), 2)
        team_ids = {t["id"] for t in bootstrap["teams"]}
        self.assertTrue({e["team"] for e in bootstrap["elements"]} <= team_ids)

    def test_missing_gameweek_raises(self):
        with self.assertRaises(ValueError):
            synthetic_bootstrap(_archive(), 99)


class TestFixtureSpecs(unittest.TestCase):
    def test_both_sides_are_resolved(self):
        specs = fixture_specs(_archive(), 2)
        self.assertEqual(len(specs), 1)
        self.assertEqual({specs[0].home_team, specs[0].away_team},
                         {"Arsenal", "Chelsea"})

    def test_one_sided_fixture_is_dropped_not_invented(self):
        """
        Simulating a fixture with a synthetic opponent would invent a clean
        sheet for a defence that never faced anyone.
        """
        archive = _archive()
        archive = archive[~((archive["GW"] == 2) & (archive["team_canonical"] == "Chelsea"))]
        self.assertEqual(fixture_specs(archive, 2), [])

    def test_flat_rates_are_labelled_when_no_strengths_given(self):
        specs = fixture_specs(_archive(), 2, strengths=None)
        self.assertAlmostEqual(specs[0].lambda_home, 1.45)
        self.assertAlmostEqual(specs[0].mu_away, 1.20)


class TestLeakage(unittest.TestCase):
    def test_no_future_data_reaches_the_projection(self):
        """
        The leakage guard, asserted at the seam rather than by inspection.

        project_gameweek is run against an archive whose FUTURE rows have been
        replaced with absurd values. If any of them influenced the fit, the
        projection would change; it must not.
        """
        from pipeline.learning.walk_forward import project_gameweek

        archive = _archive(6)
        target = 3

        poisoned = archive.copy()
        future = poisoned["GW"] > target
        poisoned.loc[future, "total_points"] = 999
        poisoned.loc[future, "goals_scored"] = 50
        poisoned.loc[future, "minutes"] = 1
        poisoned.loc[future, "goals_conceded"] = 99

        clean_rows, clean_actuals, _ = project_gameweek(poisoned, target, n_draws=200)
        truncated = archive[archive["GW"] <= target]
        trunc_rows, trunc_actuals, _ = project_gameweek(truncated, target, n_draws=200)

        self.assertEqual(len(clean_rows), len(trunc_rows))
        self.assertEqual(clean_actuals, trunc_actuals)
        for a, b in zip(clean_rows, trunc_rows):
            self.assertEqual(a["element_id"], b["element_id"])
            self.assertAlmostEqual(
                a["xp"], b["xp"], places=9,
                msg=f"element {a['element_id']}: future data changed the projection",
            )


class TestWalkForward(unittest.TestCase):
    def test_universe_covers_everyone_who_played(self):
        """
        Coverage is the number that made the previous attempt worthless: at 0.48
        the report described a different population from the one it claimed.
        """
        result = walk_forward(_archive(6), gameweeks=[3, 4, 5], n_draws=200)
        self.assertEqual(result.n_unmatched, 0)
        self.assertEqual(result.coverage, 1.0)

    def test_forecasts_and_actuals_stay_aligned(self):
        result = walk_forward(_archive(6), gameweeks=[4, 5], n_draws=200)
        self.assertEqual(len(result.forecasts), len(result.actuals))
        self.assertEqual(len(result.gameweeks), len(result.actuals))

    def test_rate_source_is_recorded(self):
        """
        A report that does not say which rates produced it cannot be compared
        against another one.
        """
        fitted = walk_forward(_archive(6), gameweeks=[4], n_draws=200)
        flat = walk_forward(_archive(6), gameweeks=[4], n_draws=200, use_fitted_rates=False)
        self.assertEqual(flat.rate_source, "flat_default")
        self.assertNotEqual(fitted.rate_source, flat.rate_source)

    def test_early_gameweeks_are_excluded_by_default(self):
        """
        A projection built on one or two rounds is dominated by its priors, so
        including them measures the prior rather than the model.
        """
        result = walk_forward(_archive(6), n_draws=200)
        self.assertEqual(result.actuals, [])

    def test_coverage_is_zero_safe_on_an_empty_run(self):
        result = walk_forward(_archive(6), gameweeks=[], n_draws=200)
        self.assertEqual(result.coverage, 0.0)
        self.assertEqual(result.as_dict()["n"], 0)


if __name__ == "__main__":
    unittest.main()


class TestBlankGameweekUniverse(unittest.TestCase):
    """
    A player whose club blanks has no archive row that gameweek. Restricting the
    universe to rows deletes him from the game, so a squad holding him shrinks
    below fifteen and, on an empty bank, becomes genuinely unsolvable — which is
    what silently truncated a season backtest at GW31.
    """

    def _archive_with_blank(self):
        archive = _archive(6)
        # Chelsea does not play in GW4.
        return archive[~((archive["GW"] == 4) & (archive["team_canonical"] == "Chelsea"))]

    def test_blanking_players_stay_in_the_universe(self):
        archive = self._archive_with_blank()
        bootstrap = synthetic_bootstrap(archive, 4)
        ids = {e["id"] for e in bootstrap["elements"]}
        chelsea = set(archive[archive["team_canonical"] == "Chelsea"]["element"])
        self.assertTrue(
            chelsea <= ids,
            "players whose club blanked were deleted from the universe",
        )

    def test_blanking_players_keep_their_last_observed_price(self):
        archive = self._archive_with_blank()
        bootstrap = synthetic_bootstrap(archive, 4)
        by_id = {e["id"]: e["now_cost"] for e in bootstrap["elements"]}
        chelsea = sorted(archive[archive["team_canonical"] == "Chelsea"]["element"])
        # Their last row is GW3, where value is 50 + 3.
        self.assertEqual(by_id[chelsea[0]], 53)
        # A club that did play carries this gameweek's price.
        arsenal = sorted(archive[archive["team_canonical"] == "Arsenal"]["element"])
        self.assertEqual(by_id[arsenal[0]], 54)

    def test_the_blank_fixture_itself_is_not_simulated(self):
        """
        The player stays ownable, but his club's non-existent fixture must not
        be invented — that would hand him a clean sheet he never played for.
        """
        archive = self._archive_with_blank()
        self.assertEqual(fixture_specs(archive, 4), [])

    def test_future_players_do_not_leak_into_an_earlier_universe(self):
        """
        The universe is everyone up to and including the gameweek, never after.
        A player who debuts in GW5 must not be buyable in GW3.
        """
        archive = _archive(6)
        late = archive[archive["GW"] >= 5].copy()
        late["element"] = 99
        late["name"] = "debutant"
        late["name_key"] = "debutant"
        archive = pd.concat([archive, late])

        early = {e["id"] for e in synthetic_bootstrap(archive, 3)["elements"]}
        later = {e["id"] for e in synthetic_bootstrap(archive, 5)["elements"]}
        self.assertNotIn(99, early)
        self.assertIn(99, later)
