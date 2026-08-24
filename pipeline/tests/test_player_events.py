"""
The player-events artifact: shape, provenance, and the per-90 floor.

The per-90 tests are the ones with teeth. An eight-minute substitute with one
shot extrapolates to eleven shots per ninety, and a screen cannot tell that from
a striker who genuinely takes eleven. So the floor is asserted, not assumed.
"""
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.fpl.player_events import (
    NOT_AVAILABLE, SCHEMA_VERSION, UNMATCHED_CAP, build, write,
)

STAMP = "2026-08-24T18:00:00Z"

MATCHED = {
    1: {"player": "Alexander Isak", "team": "Liverpool", "minutes": 90,
        "shots": 4, "key_passes": 1, "goals": 0, "assists": 0,
        "xg": 1.41066, "xa": 0.040461, "np_xg": 1.41066, "np_goals": 0,
        "xg_chain": 0.161198, "xg_buildup": 0.0, "matches": 1},
    2: {"player": "Sub Stitute", "team": "Liverpool", "minutes": 8,
        "shots": 1, "key_passes": 0, "goals": 0, "assists": 0,
        "xg": 0.2, "xa": 0.0, "np_xg": 0.2, "xg_chain": 0.2, "xg_buildup": 0.0},
}
NAMES = {1: "Isak", 2: "Stitute"}
TEAMS = {1: "Liverpool", 2: "Liverpool"}


def artifact(matched=None, unmatched=(), universe=609, source_rows=None):
    m = MATCHED if matched is None else matched
    return build(
        matched=m,
        unmatched=list(unmatched),
        names=NAMES, teams=TEAMS,
        universe_size=universe, season="2627",
        source_rows=len(m) + len(unmatched) if source_rows is None else source_rows,
        generated_at=STAMP,
    )


class Shape(unittest.TestCase):
    def test_it_carries_its_schema_and_stamp(self):
        a = artifact()
        self.assertEqual(a["schema_version"], SCHEMA_VERSION)
        self.assertEqual(a["generated_at"], STAMP)
        self.assertEqual(a["season"], "2627")

    def test_it_names_its_source(self):
        # A second xG model must say which one it is, or a reader will assume
        # it is the same number FPL published.
        self.assertEqual(artifact()["source"], "understat")
        self.assertIn("independent", artifact()["source_note"])

    def test_rows_are_keyed_by_fpl_element_id(self):
        rows = artifact()["players"]
        self.assertEqual([r["element_id"] for r in rows], [1, 2])
        self.assertEqual(rows[0]["name"], "Isak")

    def test_it_is_json_serialisable(self):
        json.dumps(artifact())


class Coverage(unittest.TestCase):
    def test_it_separates_join_quality_from_league_scope(self):
        """
        The two fractions must not be conflated. The first live run reported
        45% and warned, when the name join had actually matched 277 of 279
        offered rows — 99.3%. Understat lists players who have played; FPL lists
        everyone who could. Dividing by the wrong one turns a healthy join into
        an alarm.
        """
        c = artifact()["coverage"]
        self.assertEqual(c["matched"], 2)
        self.assertEqual(c["understat_rows"], 2)
        self.assertEqual(c["fpl_universe"], 609)
        self.assertAlmostEqual(c["join_fraction"], 1.0, places=4)
        self.assertAlmostEqual(c["league_fraction"], 2 / 609, places=4)

    def test_a_partial_join_shows_in_the_join_fraction_only(self):
        c = artifact(unmatched=[{"player": "X", "team": "Y", "reason": "z"}])["coverage"]
        self.assertEqual(c["understat_rows"], 3)
        self.assertAlmostEqual(c["join_fraction"], 2 / 3, places=4)

    def test_unmatched_players_are_published_not_discarded(self):
        a = artifact(unmatched=[{"player": "X", "team": "Y", "reason": "z"}])
        self.assertEqual(a["coverage"]["unmatched"], 1)
        self.assertEqual(a["unmatched"][0]["player"], "X")

    def test_a_flood_of_unmatched_is_capped_and_says_so(self):
        many = [{"player": f"P{i}", "team": "T", "reason": "r"} for i in range(120)]
        a = artifact(unmatched=many)
        self.assertEqual(len(a["unmatched"]), UNMATCHED_CAP)
        self.assertEqual(a["unmatched_truncated"], 120 - UNMATCHED_CAP)
        # The count is the true one, not the capped one.
        self.assertEqual(a["coverage"]["unmatched"], 120)

    def test_neither_fraction_divides_by_zero(self):
        self.assertIsNone(artifact(universe=0)["coverage"]["league_fraction"])
        self.assertIsNone(artifact(source_rows=0)["coverage"]["join_fraction"])


class WhatItCannotAnswer(unittest.TestCase):
    def test_it_names_the_fields_it_does_not_have(self):
        a = artifact()
        self.assertEqual(a["not_available"], list(NOT_AVAILABLE))

    def test_shots_on_target_is_among_them(self):
        # The specific one a reader is most likely to expect from a shots feed.
        self.assertIn("shots_on_target", artifact()["not_available"])

    def test_no_player_row_carries_an_unavailable_field(self):
        row = artifact()["players"][0]
        for field in NOT_AVAILABLE:
            self.assertNotIn(field, row)


class Per90Floor(unittest.TestCase):
    def test_a_full_match_gets_a_rate(self):
        row = artifact()["players"][0]
        self.assertAlmostEqual(row["shots_per_90"], 4.0, places=3)

    def test_below_ninety_minutes_the_rate_is_withheld(self):
        row = artifact()["players"][1]
        self.assertEqual(row["minutes"], 8)
        self.assertIsNone(row["shots_per_90"])
        self.assertIsNone(row["xg_per_90"])

    def test_the_totals_survive_even_when_the_rate_does_not(self):
        row = artifact()["players"][1]
        self.assertEqual(row["shots"], 1)
        self.assertAlmostEqual(row["xg"], 0.2, places=6)


class Coercion(unittest.TestCase):
    def test_strings_become_numbers(self):
        a = artifact({9: {"minutes": "90", "shots": "3", "xg": "0.5"}})
        row = a["players"][0]
        self.assertEqual(row["shots"], 3.0)
        self.assertAlmostEqual(row["xg"], 0.5)

    def test_nan_becomes_null_rather_than_a_number(self):
        a = artifact({9: {"minutes": 90, "shots": float("nan")}})
        self.assertIsNone(a["players"][0]["shots"])

    def test_a_missing_field_is_null_not_zero(self):
        # Zero shots and "we were not told" are different claims.
        a = artifact({9: {"minutes": 90}})
        self.assertIsNone(a["players"][0]["shots"])


class Writing(unittest.TestCase):
    def test_it_writes_where_it_says_and_reads_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write(artifact(), Path(tmp))
            self.assertEqual(path.name, "player_events.json")
            back = json.loads(path.read_text())
            self.assertEqual(back["schema_version"], SCHEMA_VERSION)
            self.assertEqual(len(back["players"]), 2)

    def test_it_creates_the_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "does" / "not" / "exist"
            path = write(artifact(), target)
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
