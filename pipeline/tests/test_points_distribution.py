"""
The mode and the points decomposition.

## Why these two fields exist

FPL points are wildly right-skewed and seven of eight competitors lead with a
mean. Given that the best public models already sit at the theoretical ceiling,
"6.4 points" is not just uninformative — it is **misleading**, because the
player it describes most often returns 2 and the mean is carried by a haul that
lands one week in six. "mode 2, mean 6.4, P(10+) 15%" is the honest statement of
the same forecast.

The decomposition answers the other half: 6.4 built from appearance points and a
clean sheet is a completely different holding from 6.4 built from a 15% chance
of a hat-trick, and no product in the category shows which one you have.

## The properties that matter

**The parts must sum to the headline.** `other` is computed by subtraction
precisely so this holds by construction — a decomposition whose parts do not add
up to `xp` is worse than none, because a reader who checks once and finds it
wrong cannot trust any of it again.

**A tie in the mode breaks downward.** FPL distributions are bimodal at the
bottom — 0 for not playing, 1 or 2 for playing without returning — and breaking
a tie upward would report the optimistic half of a coin flip as typical.

**A forward is never credited with clean-sheet points.** They are worth 4 to a
defender and 0 to a forward, so a decomposition computed without the position
would hand strikers points they cannot score. That is why `position_by_element`
is retained through the simulation rather than recovered later.
"""

from __future__ import annotations

import unittest

import numpy as np

from pipeline.fpl.rules import load_rules
from pipeline.simulation.gameweek_sim import GameweekDraws, _mode_of


def draws_with(points, minutes=None, goals=None, assists=None, clean_sheets=None,
               positions=None, element_ids=None):
    """A GameweekDraws built directly from arrays, with no simulator."""
    points = np.asarray(points, dtype=np.int64)
    n_draws, n_players = points.shape
    zeros = lambda dtype: np.zeros((n_draws, n_players), dtype=dtype)  # noqa: E731
    ids = element_ids or list(range(1, n_players + 1))
    return GameweekDraws(
        gameweek=1,
        element_ids=ids,
        points=points,
        minutes=np.asarray(minutes, dtype=np.int32) if minutes is not None else zeros(np.int32),
        goals=np.asarray(goals, dtype=np.int16) if goals is not None else zeros(np.int16),
        assists=np.asarray(assists, dtype=np.int16) if assists is not None else zeros(np.int16),
        clean_sheets=(
            np.asarray(clean_sheets, dtype=np.int16)
            if clean_sheets is not None else zeros(np.int16)
        ),
        fixtures_by_element={i: ["m1"] for i in ids},
        position_by_element=positions or {},
    )


class ModeTests(unittest.TestCase):
    def test_the_mode_is_the_most_frequent_total(self):
        column = np.array([2, 2, 2, 9, 13], dtype=np.int64)
        self.assertEqual(_mode_of(column), 2)

    def test_the_mode_can_differ_sharply_from_the_mean(self):
        """The whole reason for publishing it."""
        column = np.array([2] * 5 + [30], dtype=np.int64)
        self.assertEqual(_mode_of(column), 2)
        self.assertGreater(column.mean(), 6.0)

    def test_a_tie_breaks_downward(self):
        # 0 (did not play) against 2 (played, no return). Breaking upward would
        # report the optimistic half of a coin flip as the typical outcome.
        self.assertEqual(_mode_of(np.array([0, 0, 2, 2], dtype=np.int64)), 0)

    def test_an_empty_column_has_no_mode(self):
        self.assertIsNone(_mode_of(np.array([], dtype=np.int64)))

    def test_negative_totals_are_handled(self):
        # A red card and an own goal put a player below zero; bincount would
        # raise on this and a naive argmax would be wrong.
        self.assertEqual(_mode_of(np.array([-2, -2, 1], dtype=np.int64)), -2)

    def test_the_row_carries_it(self):
        rows = draws_with([[2], [2], [9]]).summary_rows()
        self.assertEqual(rows[0]["mode"], 2)


class DecompositionTests(unittest.TestCase):
    RULES = load_rules()

    def test_absent_without_rules(self):
        # No rules means no clean-sheet value, and guessing one would be wrong
        # by four points for every defender.
        rows = draws_with([[5], [5]]).summary_rows()
        self.assertIsNone(rows[0]["decomposition"])

    def test_absent_without_a_position(self):
        rows = draws_with([[5], [5]]).summary_rows(self.RULES)
        self.assertIsNone(rows[0]["decomposition"])

    def test_the_parts_sum_to_the_headline(self):
        """
        Computed by subtraction so this holds by construction.

        A reader who checks the arithmetic once and finds it wrong cannot trust
        any of the numbers afterwards.
        """
        draws = draws_with(
            points=[[6], [2], [12], [1]],
            minutes=[[90], [70], [90], [15]],
            goals=[[1], [0], [2], [0]],
            assists=[[0], [1], [0], [0]],
            clean_sheets=[[1], [0], [1], [0]],
            positions={1: "MID"},
        )
        row = draws.summary_rows(self.RULES)[0]
        parts = row["decomposition"]
        self.assertAlmostEqual(sum(parts.values()), row["xp"], places=6)

    def test_a_forward_gets_no_clean_sheet_points(self):
        draws = draws_with(
            points=[[6]], minutes=[[90]], clean_sheets=[[1]], positions={1: "FWD"},
        )
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        self.assertEqual(parts["clean_sheets"], 0.0)

    def test_a_defender_does(self):
        draws = draws_with(
            points=[[6]], minutes=[[90]], clean_sheets=[[1]], positions={1: "DEF"},
        )
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        self.assertEqual(parts["clean_sheets"], 4.0)

    def test_appearance_points_respect_the_sixty_minute_threshold(self):
        draws = draws_with(
            points=[[2], [1]], minutes=[[90], [30]], positions={1: "MID"},
        )
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        # One draw at 2 points for 60+, one at 1 for a cameo.
        self.assertAlmostEqual(parts["appearance"], 1.5, places=6)

    def test_a_player_who_never_plays_earns_no_appearance_points(self):
        draws = draws_with(points=[[0], [0]], minutes=[[0], [0]], positions={1: "MID"})
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        self.assertEqual(parts["appearance"], 0.0)

    def test_goals_are_valued_by_position(self):
        for position, expected in (("FWD", 4.0), ("MID", 5.0), ("DEF", 6.0)):
            draws = draws_with(
                points=[[10]], minutes=[[90]], goals=[[1]], positions={1: position},
            )
            parts = draws.summary_rows(self.RULES)[0]["decomposition"]
            self.assertEqual(
                parts["goals"], expected, f"{position} goal should be {expected}",
            )

    def test_other_absorbs_bonus_and_cards(self):
        # 90 minutes and nothing else scores 2. A total of 5 means 3 points came
        # from somewhere this decomposition does not model, and `other` must say
        # so rather than the parts quietly not adding up.
        draws = draws_with(points=[[5]], minutes=[[90]], positions={1: "MID"})
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        self.assertAlmostEqual(parts["other"], 3.0, places=6)

    def test_other_can_be_negative(self):
        # A red card. Clamping it at zero would break the sum.
        draws = draws_with(points=[[-1]], minutes=[[90]], positions={1: "MID"})
        parts = draws.summary_rows(self.RULES)[0]["decomposition"]
        self.assertLess(parts["other"], 0.0)


class PositionRetentionTests(unittest.TestCase):
    """The plumbing the decomposition depends on."""

    def test_positions_default_to_empty_not_missing(self):
        draws = GameweekDraws(gameweek=1)
        self.assertEqual(draws.position_by_element, {})

    def test_summary_rows_still_works_with_no_players(self):
        self.assertEqual(GameweekDraws(gameweek=1).summary_rows(), [])


if __name__ == "__main__":
    unittest.main()
