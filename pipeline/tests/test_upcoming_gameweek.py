"""
The gameweek stamped on a prediction must be the gameweek its FIXTURES belong to.

## Two bugs, mirror images of each other

The scalar `gameweek` was computed in parallel with the fixture list rather than
derived from it, so the two could disagree. They did, twice, in opposite directions.

FIRST: `gameweek = get_current_gameweek(bootstrap)`. FPL keeps an event `is_current`
from its own deadline until the NEXT one, so between a gameweek's last match and the
following deadline the scalar named a week already played while
`get_upcoming_fixtures` — which rolls forward once a week has no unfinished fixtures —
returned the next week's. Every GW2 prediction carried `gameweek: 1`.

SECOND, introduced by the fix: `gameweek = planning_gameweek(bootstrap)`. That rolls
forward at the DEADLINE, which is correct for "what am I picking a squad for" and wrong
here, because a gameweek's fixtures are still upcoming for the two or three days between
its deadline and its last match. Measured on the real archive:

    matchweek_2.json  generated 2026-08-27T16:59Z  gameweek=2  fixtures 28-31 Aug  correct
    matchweek_3.json  generated 2026-08-28T17:51Z  gameweek=3  fixtures 28-31 Aug  WRONG

GW2's deadline was 2026-08-28T17:30Z. The second file was written 21 minutes after it,
so the scalar had rolled to 3 while `get_upcoming_fixtures` was still correctly returning
GW2's unfinished matches.

## The fix is structural, not another resolver

There is no clock rule that makes two independent answers agree. `get_upcoming_fixtures`
already decides which week it is returning, and stamps every row with that week's own
`event`. So the scalar is READ OFF the rows. One source of truth, and the disagreement
becomes impossible rather than unlikely.

`planning_gameweek` remains the fallback for the case the rows cannot answer — no
upcoming fixtures at all — which is the question it is actually good at.
"""
import unittest

import pandas as pd

from pipeline.data.fpl_api import (
    gameweek_of_upcoming,
    get_current_gameweek,
    planning_gameweek,
)

GW2_DEADLINE = "2026-08-28T17:30:00Z"
GW3_DEADLINE = "2026-09-04T17:30:00Z"

#: The real season, as the bootstrap had it during the incident.
SEASON = [
    {"id": 1, "deadline_time": "2026-08-21T17:30:00Z",
     "is_current": False, "is_next": False, "finished": True},
    {"id": 2, "deadline_time": GW2_DEADLINE,
     "is_current": True, "is_next": False, "finished": False},
    {"id": 3, "deadline_time": GW3_DEADLINE,
     "is_current": False, "is_next": True, "finished": False},
]

#: What `get_upcoming_fixtures` returned at 2026-08-28T17:51Z: GW2's remaining matches.
GW2_REMAINING = pd.DataFrame([
    {"gameweek": 2, "home_team": "Liverpool", "away_team": "Nott'm Forest"},
    {"gameweek": 2, "home_team": "Bournemouth", "away_team": "Everton"},
    {"gameweek": 2, "home_team": "Coventry City", "away_team": "Hull City"},
])

GW3_SLATE = pd.DataFrame([
    {"gameweek": 3, "home_team": "Ipswich", "away_team": "Liverpool"},
    {"gameweek": 3, "home_team": "Newcastle", "away_team": "Bournemouth"},
])


class TestTheWindowThatBrokeIt(unittest.TestCase):
    """21 minutes after GW2's deadline, with GW2's matches still to play."""

    WHEN = pd.Timestamp("2026-08-28T17:51:09Z")

    def test_the_two_resolvers_genuinely_disagree_here(self):
        # Not a hypothetical. This is why a parallel scalar cannot be made correct:
        # both answers are right about their own question and only one matches the rows.
        self.assertEqual(get_current_gameweek({"events": SEASON}), 2)
        self.assertEqual(planning_gameweek({"events": SEASON}, self.WHEN), 3)

    def test_the_stamp_follows_the_fixtures_not_the_clock(self):
        self.assertEqual(
            gameweek_of_upcoming(GW2_REMAINING, {"events": SEASON}, self.WHEN), 2,
            "the rows are GW2's fixtures, so the stamp must be 2",
        )

    def test_and_it_does_not_reproduce_the_first_bug_either(self):
        # Between GW2's last match and GW3's deadline the rows become GW3's, and the
        # stamp must follow them there too — the original defect was failing to.
        after = pd.Timestamp("2026-09-01T10:41:19Z")
        self.assertEqual(get_current_gameweek({"events": SEASON}), 2)
        self.assertEqual(gameweek_of_upcoming(GW3_SLATE, {"events": SEASON}, after), 3)


class TestWhenTheRowsCannotAnswer(unittest.TestCase):
    def test_an_empty_frame_falls_back_to_the_planning_week(self):
        empty = pd.DataFrame(columns=["gameweek", "home_team", "away_team"])
        when = pd.Timestamp("2026-08-28T17:51:09Z")
        self.assertEqual(
            gameweek_of_upcoming(empty, {"events": SEASON}, when),
            planning_gameweek({"events": SEASON}, when),
        )

    def test_a_frame_with_no_gameweek_column_falls_back(self):
        odd = pd.DataFrame([{"home_team": "A", "away_team": "B"}])
        when = pd.Timestamp("2026-08-26T08:35:00Z")
        self.assertEqual(gameweek_of_upcoming(odd, {"events": SEASON}, when),
                         planning_gameweek({"events": SEASON}, when))

    def test_all_null_gameweeks_fall_back_rather_than_crashing(self):
        nulls = pd.DataFrame([{"gameweek": None}, {"gameweek": None}])
        when = pd.Timestamp("2026-08-26T08:35:00Z")
        self.assertEqual(gameweek_of_upcoming(nulls, {"events": SEASON}, when),
                         planning_gameweek({"events": SEASON}, when))


class TestAMixedFrame(unittest.TestCase):
    def test_the_dominant_week_wins(self):
        # `get_upcoming_fixtures` filters to one event, so this should not arise — but a
        # postponement rescheduled into another week is the shape that would produce it,
        # and picking the majority is better than picking whichever row sorted first.
        mixed = pd.DataFrame([
            {"gameweek": 3}, {"gameweek": 3}, {"gameweek": 3}, {"gameweek": 2},
        ])
        self.assertEqual(
            gameweek_of_upcoming(mixed, {"events": SEASON},
                                 pd.Timestamp("2026-09-01T10:00:00Z")), 3)


if __name__ == "__main__":
    unittest.main()
