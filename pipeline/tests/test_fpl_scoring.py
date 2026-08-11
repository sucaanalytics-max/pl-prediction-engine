"""
Unit tests for the FPL scoring function.

The replay oracle (test_fpl_replay) proves the function reproduces 29,757 real
settled rows. These tests pin the individual rules so that when a future change
breaks one, the failure names the rule rather than reporting a drop in an
aggregate match rate.
"""
import unittest

import numpy as np

from pipeline.fpl.rules import POSITIONS, load_rules
from pipeline.fpl.scoring import (
    PlayerMatch,
    defcon_count,
    score_arrays,
    score_player,
)

RULES = load_rules()


def _score(position="MID", **kwargs) -> int:
    return score_player(PlayerMatch(position=position, **kwargs), RULES).total


class AppearanceTests(unittest.TestCase):
    def test_zero_minutes_scores_zero(self):
        self.assertEqual(_score(minutes=0), 0)

    def test_one_minute_earns_the_short_appearance_point(self):
        self.assertEqual(_score(minutes=1), 1)

    def test_fifty_nine_minutes_is_still_the_short_appearance(self):
        """The 60th minute runs 59:00-59:59, so 59 does not qualify."""
        self.assertEqual(_score(minutes=59), 1)

    def test_sixty_minutes_earns_the_long_appearance(self):
        # goals_conceded=1 suppresses the midfielder clean-sheet point so this
        # isolates the appearance term.
        self.assertEqual(_score(minutes=60, goals_conceded=1), 2)

    def test_carded_without_playing_still_costs(self):
        """
        Verified against real settled data: one row with 0 minutes, one yellow
        card and -1 point. Playing a Gameweek means appearing OR being carded.
        """
        self.assertEqual(_score(minutes=0, yellow_cards=1), -1)
        self.assertEqual(_score(minutes=0, red_cards=1), -3)


class GoalAndAssistTests(unittest.TestCase):
    def test_goal_points_by_position(self):
        expected = {"GKP": 10, "DEF": 6, "MID": 5, "FWD": 4}
        for position, points in expected.items():
            with self.subTest(position=position):
                self.assertEqual(
                    _score(position, minutes=90, goals_scored=1),
                    2 + points + RULES.clean_sheet_points[position],
                )

    def test_assists_are_three_regardless_of_position(self):
        for position in POSITIONS:
            with self.subTest(position=position):
                bare = _score(position, minutes=90, goals_conceded=2)
                with_assist = _score(
                    position, minutes=90, goals_conceded=2, assists=1
                )
                self.assertEqual(with_assist - bare, 3)

    def test_own_goal_costs_two(self):
        self.assertEqual(
            _score(minutes=90, own_goals=1) - _score(minutes=90), -2
        )


class CleanSheetTests(unittest.TestCase):
    def test_clean_sheet_points_by_position(self):
        expected = {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0}
        for position, points in expected.items():
            with self.subTest(position=position):
                self.assertEqual(_score(position, minutes=90), 2 + points)

    def test_no_clean_sheet_below_sixty_minutes(self):
        self.assertEqual(_score("DEF", minutes=59), 1)

    def test_clean_sheet_survives_a_substitution_before_the_goal(self):
        """
        goals_conceded is per-player and on-pitch only, so a defender withdrawn
        at 60 minutes at 0-0 keeps the clean sheet even if his team then
        concedes. The input encodes that; this pins the interpretation.
        """
        self.assertEqual(_score("DEF", minutes=60, goals_conceded=0), 2 + 4)

    def test_conceding_removes_the_clean_sheet(self):
        self.assertEqual(_score("DEF", minutes=90, goals_conceded=1), 2 + 0)


class GoalsConcededTests(unittest.TestCase):
    def test_penalty_is_one_per_two_conceded_for_keepers_and_defenders(self):
        for position in ("GKP", "DEF"):
            with self.subTest(position=position):
                self.assertEqual(_score(position, minutes=90, goals_conceded=1), 2)
                self.assertEqual(_score(position, minutes=90, goals_conceded=2), 1)
                self.assertEqual(_score(position, minutes=90, goals_conceded=3), 1)
                self.assertEqual(_score(position, minutes=90, goals_conceded=4), 0)

    def test_midfielders_and_forwards_are_never_penalised_for_conceding(self):
        self.assertEqual(_score("MID", minutes=90, goals_conceded=4), 2)
        self.assertEqual(_score("FWD", minutes=90, goals_conceded=4), 2)


class KeeperTests(unittest.TestCase):
    def test_saves_are_one_point_per_three(self):
        for saves, expected in ((0, 0), (1, 0), (2, 0), (3, 1), (5, 1), (6, 2), (9, 3)):
            with self.subTest(saves=saves):
                self.assertEqual(
                    _score("GKP", minutes=90, goals_conceded=2, saves=saves),
                    1 + expected,
                )

    def test_penalty_save_is_five(self):
        self.assertEqual(
            _score("GKP", minutes=90, penalties_saved=1)
            - _score("GKP", minutes=90),
            5,
        )

    def test_penalty_miss_costs_two(self):
        self.assertEqual(
            _score("FWD", minutes=90, penalties_missed=1)
            - _score("FWD", minutes=90),
            -2,
        )


class CardTests(unittest.TestCase):
    def test_yellow_costs_one(self):
        self.assertEqual(_score(minutes=90, yellow_cards=1), 2 + 1 - 1)

    def test_straight_red_costs_three(self):
        self.assertEqual(_score(minutes=90, red_cards=1), 2 + 1 - 3)

    def test_second_yellow_costs_three_not_four(self):
        """"Red card deductions include any points deducted for yellow cards.\""""
        self.assertEqual(
            _score(minutes=90, yellow_cards=1, red_cards=1), 2 + 1 - 3
        )


class DefensiveContributionTests(unittest.TestCase):
    def test_defender_threshold_is_ten_and_excludes_recoveries(self):
        self.assertEqual(
            defcon_count("DEF", clearances_blocks_interceptions=8, tackles=1,
                         recoveries=20, rules=RULES),
            9,
        )
        self.assertEqual(_score("DEF", minutes=90,
                                clearances_blocks_interceptions=8, tackles=1,
                                recoveries=20), 2 + 4)
        self.assertEqual(_score("DEF", minutes=90,
                                clearances_blocks_interceptions=8, tackles=2,
                                recoveries=0), 2 + 4 + 2)

    def test_midfielder_threshold_is_twelve_and_includes_recoveries(self):
        self.assertEqual(
            defcon_count("MID", clearances_blocks_interceptions=4, tackles=3,
                         recoveries=5, rules=RULES),
            12,
        )
        self.assertEqual(_score("MID", minutes=90,
                                clearances_blocks_interceptions=4, tackles=3,
                                recoveries=4), 2 + 1)
        self.assertEqual(_score("MID", minutes=90,
                                clearances_blocks_interceptions=4, tackles=3,
                                recoveries=5), 2 + 1 + 2)

    def test_forward_uses_the_midfielder_rule(self):
        self.assertEqual(_score("FWD", minutes=90,
                                clearances_blocks_interceptions=6, tackles=6,
                                recoveries=0), 2 + 2)

    def test_goalkeepers_never_earn_defensive_contribution(self):
        self.assertEqual(
            defcon_count("GKP", clearances_blocks_interceptions=37, tackles=1,
                         recoveries=304, rules=RULES),
            0,
        )
        self.assertEqual(
            _score("GKP", minutes=90, clearances_blocks_interceptions=37,
                   tackles=1, recoveries=304),
            2 + 4,
        )

    def test_defensive_contribution_does_not_stack(self):
        """20 qualifying actions still pays 2, not 4."""
        self.assertEqual(_score("DEF", minutes=90,
                                clearances_blocks_interceptions=20, tackles=0),
                         2 + 4 + 2)


class BreakdownTests(unittest.TestCase):
    def test_components_sum_to_total(self):
        breakdown = score_player(
            PlayerMatch("DEF", minutes=90, goals_scored=1, assists=1,
                        goals_conceded=0, yellow_cards=1, bonus=3,
                        clearances_blocks_interceptions=11),
            RULES,
        )
        self.assertEqual(
            breakdown.total,
            sum(v for k, v in breakdown.as_dict().items() if k != "total"),
        )

    def test_bonus_is_passed_through(self):
        self.assertEqual(_score(minutes=90, bonus=3) - _score(minutes=90), 3)

    def test_unknown_position_raises(self):
        with self.assertRaises(ValueError):
            PlayerMatch(position="AM", minutes=90)


class VectorisedAgreementTests(unittest.TestCase):
    def test_vectorised_matches_scalar_on_randomised_input(self):
        """
        The simulator scores a (draws, players) matrix and cannot afford a Python
        loop, so a second implementation exists. If they disagree the scalar one
        is authoritative — it is the one the replay oracle validated.
        """
        rng = np.random.default_rng(7)
        n = 4000
        position_index = rng.integers(0, 4, n)
        minutes = rng.choice([0, 1, 30, 59, 60, 75, 90], n)
        goals = rng.poisson(0.15, n)
        assists = rng.poisson(0.12, n)
        conceded = rng.poisson(1.1, n)
        own_goals = (rng.random(n) < 0.01).astype(int)
        pens_saved = (rng.random(n) < 0.01).astype(int)
        pens_missed = (rng.random(n) < 0.01).astype(int)
        yellows = (rng.random(n) < 0.12).astype(int)
        reds = (rng.random(n) < 0.02).astype(int)
        saves = rng.poisson(1.2, n)
        bonus = rng.choice([0, 1, 2, 3], n, p=[0.85, 0.06, 0.05, 0.04])
        cbi = rng.poisson(4.0, n)
        tackles = rng.poisson(1.5, n)
        recoveries = rng.poisson(5.0, n)

        actions = np.array([
            defcon_count(POSITIONS[position_index[i]], cbi[i], tackles[i],
                         recoveries[i], RULES)
            for i in range(n)
        ])

        vectorised = score_arrays(
            position_index=position_index, minutes=minutes, goals_scored=goals,
            assists=assists, goals_conceded=conceded, own_goals=own_goals,
            penalties_saved=pens_saved, penalties_missed=pens_missed,
            yellow_cards=yellows, red_cards=reds, saves=saves, bonus=bonus,
            defcon_actions=actions, rules=RULES,
        )

        scalar = np.array([
            score_player(
                PlayerMatch(
                    position=POSITIONS[position_index[i]], minutes=int(minutes[i]),
                    goals_scored=int(goals[i]), assists=int(assists[i]),
                    goals_conceded=int(conceded[i]), own_goals=int(own_goals[i]),
                    penalties_saved=int(pens_saved[i]),
                    penalties_missed=int(pens_missed[i]),
                    yellow_cards=int(yellows[i]), red_cards=int(reds[i]),
                    saves=int(saves[i]), bonus=int(bonus[i]),
                    clearances_blocks_interceptions=int(cbi[i]),
                    tackles=int(tackles[i]), recoveries=int(recoveries[i]),
                ),
                RULES,
            ).total
            for i in range(n)
        ])

        mismatches = int((vectorised != scalar).sum())
        self.assertEqual(mismatches, 0, f"{mismatches}/{n} rows disagree")


if __name__ == "__main__":
    unittest.main()
