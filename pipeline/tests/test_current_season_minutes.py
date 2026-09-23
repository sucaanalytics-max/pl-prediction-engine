"""
The minutes model must see the season it is projecting.

`MinutesModel` says it consumes "the linked season archive, and in-season the
current campaign's rows appended", and every harness that ever validated it did
exactly that: `backtest.walk_forward_minutes` refits on `prior_season +
current[GW < gameweek]`, and `walk_forward.project_gameweek` trains on
`archive[GW < gameweek]`. The 1.5-fixture recency half-life was selected there.

Production appended nothing. Both live callers fitted on last season alone, so
with a 1.5-fixture half-life every player was projected from roughly how he was
used in the last three matches of LAST season. Measured 2026-09-23: Wissa, five
starts and 441 minutes this season, projected p_start 0.010 because he came off
the bench at Newcastle in May; and the sealed GW4 and GW5 scorecards put the
minutes components' calibration error an order of magnitude above the scoring
components' (p_60 0.133 / 0.108 against p_goal 0.013).
"""
from __future__ import annotations

import unittest

import pandas as pd

from pipeline.models.fpl_inputs import (
    build_fpl_inputs,
    current_season_rows,
    load_current_season_rows,
)


def _bootstrap(elements, events=()):
    return {
        "teams": [{"id": 1, "name": "Arsenal", "short_name": "ARS"}],
        "element_types": [
            {"id": 1, "singular_name_short": "GKP"},
            {"id": 2, "singular_name_short": "DEF"},
            {"id": 3, "singular_name_short": "MID"},
            {"id": 4, "singular_name_short": "FWD"},
        ],
        "elements": list(elements),
        "events": list(events),
    }


def _element(element_id, second_name, element_type=4, first_name=""):
    return {
        "id": element_id, "first_name": first_name, "second_name": second_name,
        "element_type": element_type, "team": 1, "status": "a",
        "chance_of_playing_next_round": None, "news": "", "news_added": None,
    }


def _live(*players):
    """An `event/{gw}/live/` payload. Each player is (id, starts, [minutes per fixture])."""
    return {
        "elements": [
            {
                "id": element_id,
                "stats": {"minutes": sum(minutes), "starts": starts},
                "explain": [
                    {
                        "fixture": 100 + index,
                        "stats": [{"identifier": "minutes", "value": m, "points": 0}],
                    }
                    for index, m in enumerate(minutes)
                ],
            }
            for element_id, starts, minutes in players
        ]
    }


class CurrentSeasonRowsTests(unittest.TestCase):
    def test_one_row_per_player_per_fixture_keyed_as_the_model_keys(self):
        bootstrap = _bootstrap([_element(7, "Yoane Wissa", first_name="")])
        rows = current_season_rows(bootstrap, {5: _live((7, 1, [90]))}, season="2627")

        self.assertEqual(len(rows), 1)
        row = rows.iloc[0]
        # build_fpl_inputs keys players by _normalise_name(first + " " + second);
        # a different key here would append rows nobody ever reads.
        self.assertEqual(row["name_key"], "yoane wissa")
        self.assertEqual(row["position_norm"], "FWD")
        self.assertEqual((row["minutes"], row["starts"], row["GW"]), (90, 1, 5))
        self.assertEqual(row["season"], "2627")

    def test_an_unused_substitute_is_a_row_because_he_was_available_and_not_used(self):
        bootstrap = _bootstrap([_element(9, "Dubravka", element_type=1)])
        rows = current_season_rows(bootstrap, {5: _live((9, 0, [0]))})
        self.assertEqual(rows[["minutes", "starts"]].values.tolist(), [[0, 0]])

    def test_a_blank_gameweek_is_not_a_non_appearance(self):
        """No fixture is not the same as not picked, and must not read as a benching."""
        bootstrap = _bootstrap([_element(7, "Wissa")])
        payload = {"elements": [{"id": 7, "stats": {"minutes": 0, "starts": 0}, "explain": []}]}
        rows = current_season_rows(bootstrap, {5: payload})
        self.assertTrue(rows.empty)

    def test_a_double_gameweek_splits_and_gives_the_start_to_the_longer_fixture(self):
        bootstrap = _bootstrap([_element(7, "Wissa")])
        rows = current_season_rows(bootstrap, {6: _live((7, 1, [20, 90]))})

        self.assertEqual(len(rows), 2)
        by_minutes = dict(zip(rows["minutes"], rows["starts"]))
        self.assertEqual(by_minutes, {90: 1, 20: 0})

    def test_a_player_not_in_the_bootstrap_is_skipped(self):
        bootstrap = _bootstrap([_element(7, "Wissa")])
        rows = current_season_rows(bootstrap, {5: _live((999, 1, [90]))})
        self.assertTrue(rows.empty)


class LoadCurrentSeasonRowsTests(unittest.TestCase):
    def test_reads_only_settled_gameweeks(self):
        """An unsettled gameweek's minutes can still change; only settled ones are evidence."""
        events = [
            {"id": 4, "finished": True, "data_checked": True},
            {"id": 5, "finished": True, "data_checked": False},
            {"id": 6, "finished": False, "data_checked": False},
        ]
        bootstrap = _bootstrap([_element(7, "Wissa")], events)
        asked = []

        def fetch(gameweek):
            asked.append(gameweek)
            return _live((7, 1, [90]))

        rows = load_current_season_rows(bootstrap, fetch=fetch)
        self.assertEqual(asked, [4])
        self.assertEqual(sorted(rows["GW"].unique()), [4])

    def test_before_any_gameweek_settles_there_is_nothing_to_read(self):
        bootstrap = _bootstrap([_element(7, "Wissa")], [{"id": 1, "finished": False}])
        rows = load_current_season_rows(bootstrap, fetch=lambda gw: self.fail("fetched"))
        self.assertTrue(rows.empty)


class ModelSeesTheCurrentSeasonTests(unittest.TestCase):
    """Against the real committed archive, so the effect is the production effect."""

    @classmethod
    def setUpClass(cls):
        from pipeline.learning.backfill import load_archive_season
        from pipeline.learning.walk_forward import synthetic_bootstrap

        from pipeline.fpl.rules import load_rules

        cls.archive = load_archive_season("2526")
        cls.bootstrap = synthetic_bootstrap(cls.archive, 38)
        # A synthetic bootstrap has no game_settings, so rules come from the signed
        # file — as walk_forward does.
        cls.rules = load_rules()
        baseline = build_fpl_inputs(cls.bootstrap, cls.archive, rules=cls.rules)
        cls.baseline = baseline

        # A regular who was benched at the end of last season, and a player who
        # started the run-in: the two directions a summer can move a role.
        by_player = baseline.minutes_model.by_player
        id_by_key = {
            " ".join(str(e["second_name"]).lower().split()): e for e in cls.bootstrap["elements"]
        }

        def rate(key):
            stats = by_player[key]
            return stats["n_starts"] / max(stats["n_fixtures"], 1e-9)

        candidates = [
            k for k, v in by_player.items()
            if v["raw_fixtures"] >= 30 and k in id_by_key
            and id_by_key[k]["element_type"] in (3, 4)
        ]
        cls.benched = min(candidates, key=rate)
        cls.starter = max(candidates, key=rate)
        cls.benched_id = int(id_by_key[cls.benched]["id"])
        cls.starter_id = int(id_by_key[cls.starter]["id"])

    def _roles(self, inputs, element_id):
        for players in inputs.squads.values():
            for player in players:
                if player.element_id == element_id:
                    return player.roles
        self.fail(f"element {element_id} not projected")

    def _with_season(self, benched_starts, starter_starts):
        live = {
            gw: _live(
                (self.benched_id, benched_starts, [90 if benched_starts else 0]),
                (self.starter_id, starter_starts, [90 if starter_starts else 0]),
            )
            for gw in range(1, 6)
        }
        season = current_season_rows(self.bootstrap, live, season="2627")
        return build_fpl_inputs(
            self.bootstrap, self.archive, rules=self.rules, current_season=season
        )

    def test_five_starts_this_season_outweigh_last_seasons_bench(self):
        before = self._roles(self.baseline, self.benched_id).p_start
        after = self._roles(self._with_season(1, 1), self.benched_id).p_start
        self.assertLess(before, 0.3, "fixture player was not a bench player last season")
        self.assertGreater(after, 0.7)

    def test_five_benchings_this_season_outweigh_last_seasons_starts(self):
        before = self._roles(self.baseline, self.starter_id).p_start
        after = self._roles(self._with_season(0, 0), self.starter_id).p_start
        self.assertGreater(before, 0.6, "fixture player was not a starter last season")
        self.assertLess(after, 0.3)

    def test_the_scoring_model_is_untouched(self):
        """
        Only minutes changes. The scoring components are the calibrated ones
        (p_goal ECE 0.013 on GW4 and GW5), and the current-season rows carry no
        event columns to fit them on.
        """
        after = self._with_season(1, 1)
        for key in (self.benched, self.starter):
            position = self.baseline.minutes_model.by_player[key]["position"]
            self.assertEqual(
                repr(self.baseline.events.rates(position, key)),
                repr(after.events.rates(position, key)),
            )

    def test_the_build_says_which_gameweeks_it_saw(self):
        after = self._with_season(1, 1)
        self.assertEqual(
            after.diagnostics["current_season"],
            {"season": "2627", "gameweeks": [1, 2, 3, 4, 5], "n_rows": 10},
        )
        self.assertEqual(
            self.baseline.diagnostics["current_season"],
            {"season": None, "gameweeks": [], "n_rows": 0},
        )

    def test_an_unlabelled_archive_cannot_be_combined(self):
        """
        Without a season column, last season's GW38 sorts after this season's GW5
        and the recency weights point backwards — the exact defect
        `_fixture_index` documents fixing once already.
        """
        season = current_season_rows(self.bootstrap, {1: _live((self.benched_id, 1, [90]))})
        with self.assertRaises(ValueError):
            build_fpl_inputs(
                self.bootstrap, self.archive.drop(columns=["season"]),
                rules=self.rules, current_season=season,
            )


if __name__ == "__main__":
    unittest.main()
