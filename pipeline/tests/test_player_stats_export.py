"""
`player_stats.json`'s exported columns must be the ones `build_player_stats` writes.

## The bug

`chance_of_playing` shipped as `null` for all 651 rows, every run, since the field was
added. The comment above it in `run_pipeline` states the intent exactly:

    `available` is `status in {"a", "d"}` — available OR DOUBTFUL. A 75% doubt has always
    read here as fit, and the frontend had nothing finer to filter on. The two fields
    below are what FPL actually says, exported so a consumer can tell a doubt from a fit
    player and from a player who is out.

`status` delivers that. `chance_of_playing` did not, because of a one-word column-name
mismatch: `build_player_stats` renames FPL's `chance_of_playing_next_round` to
`chance_of_playing` (fpl_api.py:366), and the exporter went on asking for the original
name. `row.get(...)` returned None, `pd.notna(None)` was False, and the field took its
else-branch on every row forever.

Measured against the live bootstrap: the DataFrame column holds 218 non-null values —
147 at 0, 54 at 100, 15 at 75, one each at 50 and 25 — and none of them reached the file.

## Why a name mismatch deserves its own test

Nothing could catch it. The producer was right, the exporter was syntactically valid, the
artifact was well-formed, and the field's own type allows null — so a null read as "FPL
told us nothing" rather than "we asked the wrong question". The only detectable signature
is that a column the producer populates is empty in the output, which is what this asserts.
"""
import json
import unittest
from pathlib import Path

import pandas as pd

from pipeline.data.fpl_api import build_player_stats

#: Everything `build_player_stats` reads beyond the availability fields under test.
#: Kept in one place so the fixture stays about availability and nothing else.
BASE = {
    "total_points": 0, "goals_scored": 0, "assists": 0, "clean_sheets": 0,
    "goals_conceded": 0, "own_goals": 0, "penalties_saved": 0, "penalties_missed": 0,
    "yellow_cards": 0, "red_cards": 0, "saves": 0, "bonus": 0, "bps": 0,
    "influence": "0.0", "creativity": "0.0", "threat": "0.0", "ict_index": "0.0",
    "expected_goals": "0.00", "expected_assists": "0.00",
    "expected_goal_involvements": "0.00", "expected_goals_conceded": "0.00",
    "form": "0.0", "points_per_game": "0.0", "starts": 0, "news": "",
    "value_form": "0.0", "value_season": "0.0", "transfers_in": 0, "transfers_out": 0,
}

#: A bootstrap fragment carrying every availability shape FPL emits.
BOOTSTRAP = {
    "teams": [{"id": 1, "name": "Arsenal", "short_name": "ARS"}],
    "element_types": [{"id": 1, "singular_name_short": "GKP"},
                      {"id": 3, "singular_name_short": "MID"}],
    "elements": [
        {**BASE, "id": 1, "first_name": "A", "second_name": "Fit", "web_name": "Fit",
         "team": 1, "element_type": 3, "status": "a",
         # FPL sends null for a player with no doubt at all.
         "chance_of_playing_next_round": None,
         "minutes": 270, "now_cost": 60, "selected_by_percent": "10.0"},
        {**BASE, "id": 2, "first_name": "B", "second_name": "Doubt", "web_name": "Doubt",
         "team": 1, "element_type": 3, "status": "d",
         "chance_of_playing_next_round": 75,
         "minutes": 180, "now_cost": 55, "selected_by_percent": "5.0"},
        {**BASE, "id": 3, "first_name": "C", "second_name": "Out", "web_name": "Out",
         "team": 1, "element_type": 3, "status": "i",
         "chance_of_playing_next_round": 0,
         "minutes": 0, "now_cost": 50, "selected_by_percent": "1.0"},
        {**BASE, "id": 4, "first_name": "D", "second_name": "Confirmed",
         "web_name": "Confirmed", "team": 1, "element_type": 1, "status": "a",
         "chance_of_playing_next_round": 100,
         "minutes": 270, "now_cost": 45, "selected_by_percent": "20.0"},
    ],
}


class TestTheProducerColumn(unittest.TestCase):
    def setUp(self):
        self.df = build_player_stats(BOOTSTRAP)

    def test_the_column_is_named_chance_of_playing(self):
        # The exporter must ask for THIS name. If the producer is ever renamed back to
        # FPL's `chance_of_playing_next_round`, this fails and the exporter is updated
        # with it rather than silently returning null again.
        self.assertIn("chance_of_playing", self.df.columns)
        self.assertNotIn("chance_of_playing_next_round", self.df.columns)

    def test_it_carries_every_value_fpl_sent(self):
        by_id = self.df.set_index("player_id")["chance_of_playing"].to_dict()
        self.assertTrue(pd.isna(by_id[1]))       # FPL said nothing
        self.assertEqual(by_id[2], 75)
        self.assertEqual(by_id[3], 0)
        self.assertEqual(by_id[4], 100)


class TestTheExportedArtifact(unittest.TestCase):
    """
    The artifact on disk. This is where the bug was visible and nothing looked.

    Skips rather than fails when the file is absent, because a clean checkout has no
    predictions — but when it IS present, a producer column that is empty in the output
    is the signature of exactly this defect.
    """

    def setUp(self):
        path = Path("predictions/player_stats.json")
        if not path.is_file():
            self.skipTest("no player_stats.json in this checkout")
        payload = json.loads(path.read_text())
        self.rows = payload if isinstance(payload, list) else payload.get("players") or []
        if not self.rows:
            self.skipTest("player_stats.json holds no rows")

    def test_status_reaches_the_artifact(self):
        codes = {r.get("status") for r in self.rows}
        self.assertTrue(codes - {None}, "no status code reached the artifact")
        self.assertTrue(codes <= {"a", "d", "i", "s", "u", "n", None}, f"odd codes: {codes}")

    def test_chance_of_playing_is_not_null_for_every_single_row(self):
        # The precise signature of the mismatch. FPL always has SOME player carrying a
        # doubt or an injury, so an all-null column means the export asked the wrong
        # question rather than that the league is fully fit.
        values = [r.get("chance_of_playing") for r in self.rows]
        self.assertTrue(
            any(v is not None for v in values),
            f"chance_of_playing is null for all {len(values)} rows — the exporter is "
            "reading a column the producer does not write",
        )

    def test_it_agrees_with_status_where_both_are_present(self):
        # A player FPL calls unavailable cannot also be a 100% chance. This catches a
        # future mismatch that happens to populate the field with the WRONG column.
        contradictions = [
            r.get("web_name") for r in self.rows
            if r.get("status") in {"i", "u", "s"} and r.get("chance_of_playing") not in (None, 0)
        ]
        self.assertEqual(contradictions, [],
                         "a player is out per `status` but not per `chance_of_playing`")


if __name__ == "__main__":
    unittest.main()
