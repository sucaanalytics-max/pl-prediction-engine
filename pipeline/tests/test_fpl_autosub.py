"""
Tests for auto-substitution, captaincy fallback and squad scoring.

Squads here are hand-constructed with hand-computed expected totals, derived
from the published rules. They are not scraped real teams: reproducing a real
manager's gameweek would need that manager's picks, which is a separate data
source. What matters is that each rule is pinned individually.
"""
import unittest

from pipeline.fpl.autosub import (
    CHIP_BENCH_BOOST,
    CHIP_TRIPLE_CAPTAIN,
    appeared,
    formation_is_legal,
    resolve_lineup,
    score_squad,
)
from pipeline.fpl.rules import load_rules

RULES = load_rules()

# A legal 3-4-3: ids 1 (GKP), 2-4 (DEF), 5-8 (MID), 9-11 (FWD).
# Bench in FPL priority order: 12 reserve keeper, then 13, 14, 15.
POSITIONS = {
    1: "GKP",
    2: "DEF", 3: "DEF", 4: "DEF",
    5: "MID", 6: "MID", 7: "MID", 8: "MID",
    9: "FWD", 10: "FWD", 11: "FWD",
    12: "GKP", 13: "DEF", 14: "MID", 15: "FWD",
}
XI = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
BENCH = [12, 13, 14, 15]


def _played_except(*absent: int):
    """Everyone appeared, except the given element ids."""
    return {p: p not in absent for p in POSITIONS}


class AppearedTests(unittest.TestCase):
    def test_minutes_count_as_appearing(self):
        self.assertTrue(appeared(1))
        self.assertTrue(appeared(90))

    def test_no_minutes_and_no_card_is_not_appearing(self):
        self.assertFalse(appeared(0))

    def test_a_card_without_minutes_counts_as_appearing(self):
        """This is why a booked unused substitute is not auto-subbed."""
        self.assertTrue(appeared(0, yellow_cards=1))
        self.assertTrue(appeared(0, red_cards=1))


class FormationTests(unittest.TestCase):
    def test_three_four_three_is_legal(self):
        self.assertTrue(
            formation_is_legal([POSITIONS[p] for p in XI], rules=RULES)
        )

    def test_two_defenders_is_illegal(self):
        lineup = ["GKP", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID",
                  "FWD", "FWD", "FWD"]
        self.assertFalse(formation_is_legal(lineup, rules=RULES))

    def test_two_goalkeepers_is_illegal(self):
        lineup = ["GKP", "GKP", "DEF", "DEF", "DEF", "MID", "MID", "MID",
                  "FWD", "FWD", "FWD"]
        self.assertFalse(formation_is_legal(lineup, rules=RULES))

    def test_ten_players_is_illegal(self):
        self.assertFalse(
            formation_is_legal([POSITIONS[p] for p in XI[:-1]], rules=RULES)
        )


class AutoSubstitutionTests(unittest.TestCase):
    def test_no_substitutions_when_everyone_plays(self):
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=_played_except(), rules=RULES,
        )
        self.assertEqual(resolution.substitutions, ())
        self.assertEqual(set(resolution.counted), set(XI))

    def test_failing_midfielder_is_replaced_by_the_bench_midfielder(self):
        """
        Bench order is 13 (DEF), 14 (MID), 15 (FWD). Promoting 13 would give
        4 DEF / 3 MID / 3 FWD, which is legal, so FPL takes the highest-priority
        bench player that keeps the formation legal — 13, not 14.
        """
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=_played_except(8), rules=RULES,
        )
        self.assertEqual(len(resolution.substitutions), 1)
        self.assertEqual(resolution.substitutions[0].out_id, 8)
        self.assertEqual(resolution.substitutions[0].in_id, 13)
        self.assertNotIn(8, resolution.counted)
        self.assertIn(13, resolution.counted)

    def test_a_substitution_that_would_break_the_formation_is_skipped(self):
        """
        A 3-4-3 losing a defender cannot promote a forward: that leaves 2 DEF,
        below the minimum of 3. With only a forward available the slot stays
        empty rather than producing an illegal XI.
        """
        played = _played_except(2, 12, 13, 14)
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=played, rules=RULES,
        )
        self.assertEqual(resolution.substitutions, ())
        self.assertIn(2, resolution.counted)

    def test_bench_goalkeeper_replaces_the_starting_goalkeeper(self):
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=_played_except(1), rules=RULES,
        )
        self.assertEqual(len(resolution.substitutions), 1)
        self.assertEqual(resolution.substitutions[0].in_id, 12)
        self.assertNotIn(1, resolution.counted)

    def test_a_carded_zero_minute_starter_is_not_substituted(self):
        """He counts as having played, so no bench player comes on."""
        played = _played_except()  # caller derives this via appeared(0, yellow=1)
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=played, rules=RULES,
        )
        self.assertEqual(resolution.substitutions, ())

    def test_bench_player_who_did_not_play_cannot_come_on(self):
        played = _played_except(8, 13)
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=played, rules=RULES,
        )
        self.assertEqual(len(resolution.substitutions), 1)
        self.assertEqual(resolution.substitutions[0].in_id, 14)


class CaptaincyTests(unittest.TestCase):
    def test_captain_doubles(self):
        points = {p: 5 for p in POSITIONS}
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(), rules=RULES,
        )
        self.assertEqual(score.total, 11 * 5 + 5)
        self.assertEqual(score.per_player[9], 10)

    def test_vice_takes_the_armband_when_the_captain_does_not_appear(self):
        points = {p: 5 for p in POSITIONS}
        points[9] = 0
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(9), rules=RULES,
        )
        self.assertTrue(score.resolution.vice_used)
        self.assertEqual(score.resolution.captain, 5)
        self.assertEqual(score.per_player[5], 10)

    def test_a_one_minute_captain_keeps_the_armband(self):
        """
        The vice only inherits if the captain does not appear at all. A cameo —
        even one minute, even for zero points — keeps it, and the double applies
        to that small score.
        """
        points = {p: 5 for p in POSITIONS}
        points[9] = 1
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(), rules=RULES,
        )
        self.assertFalse(score.resolution.vice_used)
        self.assertEqual(score.resolution.captain, 9)
        self.assertEqual(score.per_player[9], 2)

    def test_captain_retains_when_neither_captain_nor_vice_appears(self):
        played = _played_except(9, 5)
        resolution = resolve_lineup(
            XI, BENCH, captain=9, vice_captain=5,
            positions=POSITIONS, played=played, rules=RULES,
        )
        self.assertFalse(resolution.vice_used)
        self.assertEqual(resolution.captain, 9)


class ChipTests(unittest.TestCase):
    def test_bench_boost_counts_all_fifteen_and_makes_no_substitutions(self):
        points = {p: 2 for p in POSITIONS}
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(8), rules=RULES,
            chip=CHIP_BENCH_BOOST,
        )
        self.assertEqual(len(score.resolution.counted), 15)
        self.assertEqual(score.resolution.substitutions, ())
        self.assertEqual(score.total, 15 * 2 + 2)

    def test_triple_captain_triples(self):
        points = {p: 0 for p in POSITIONS}
        points[9] = 10
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(), rules=RULES,
            chip=CHIP_TRIPLE_CAPTAIN,
        )
        self.assertEqual(score.resolution.captain_multiplier, 3)
        self.assertEqual(score.total, 30)

    def test_triple_captain_transfers_to_the_vice_if_the_captain_is_absent(self):
        points = {p: 0 for p in POSITIONS}
        points[5] = 7
        score = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(9), rules=RULES,
            chip=CHIP_TRIPLE_CAPTAIN,
        )
        self.assertEqual(score.total, 21)


class TransferCostTests(unittest.TestCase):
    def test_hit_is_subtracted_at_face_value(self):
        points = {p: 1 for p in POSITIONS}
        base = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(), rules=RULES,
        ).total
        hit = score_squad(
            XI, BENCH, captain=9, vice_captain=5, positions=POSITIONS,
            points=points, played=_played_except(), rules=RULES, transfer_cost=4,
        ).total
        self.assertEqual(base - hit, 4)


if __name__ == "__main__":
    unittest.main()
