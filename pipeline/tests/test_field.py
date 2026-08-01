"""
Tests for the field model.

The most important assertion in this file is that the gate starts CLOSED. A
modelled tail presented as a measured one is worse than no weekly team, because
it would be acted on with confidence it has not earned — and nothing in the
archive can currently open the gate.
"""
from __future__ import annotations

import unittest

import numpy as np

from pipeline.decide.field import (
    REQUIRED_CALIBRATED_GAMEWEEKS,
    check_calibration,
    effective_ownership,
    field_is_usable,
    ownership_share,
    sample_rivals,
)
from pipeline.fpl.rules import load_rules

RULES = load_rules()
CLUBS = ["Arsenal", "Chelsea", "Everton", "Fulham", "Liverpool", "Newcastle"]
COUNTS = {"GKP": 6, "DEF": 15, "MID": 15, "FWD": 9}


def _universe():
    positions, teams, prices, selected = {}, {}, {}, {}
    pid = 1
    for position, count in COUNTS.items():
        for i in range(count):
            positions[pid] = position
            teams[pid] = CLUBS[pid % len(CLUBS)]
            prices[pid] = 40 + (i % 6) * 5
            selected[pid] = 100 * (i + 1)
            pid += 1
    return positions, teams, prices, selected


class TestOwnershipShare(unittest.TestCase):
    def test_manager_count_is_recovered_from_the_fifteen_identity(self):
        """
        Every manager picks exactly fifteen, so the total of `selected` is
        fifteen times the entrant count. That gives the denominator exactly,
        with no guess about how many people play.
        """
        # 1,000 managers picking 15 each => 15,000 total selections.
        # Player 1 is owned by half of them, player 2 by a quarter, and the
        # remaining 11,250 selections are spread over a realistic bench of
        # other players. A two-player universe would be degenerate: the
        # identity only recovers the entrant count over a full player pool.
        selected = {1: 500, 2: 250}
        selected.update({p: 25 for p in range(3, 573)})  # 570 * 25 = 14,250
        self.assertEqual(sum(selected.values()), 15_000)

        share = ownership_share(selected)
        self.assertAlmostEqual(share[1], 0.50, places=6)
        self.assertAlmostEqual(share[2], 0.25, places=6)
        self.assertAlmostEqual(share[1] / share[2], 2.0)

    def test_shares_are_capped_at_one(self):
        self.assertLessEqual(ownership_share({1: 10_000, 2: 1})[1], 1.0)

    def test_empty_input_is_safe(self):
        self.assertEqual(ownership_share({}), {})
        self.assertEqual(ownership_share({1: 0}), {1: 0.0})


class TestEffectiveOwnership(unittest.TestCase):
    def test_captaincy_mass_totals_one_armband(self):
        """
        One captain per manager, so captaincy share across all players must sum
        to 1.0. A total above one would inflate every differential's weight.
        """
        ownership = {1: 0.5, 2: 0.3, 3: 0.2, 4: 0.1}
        xp = {1: 9.0, 2: 7.0, 3: 5.0, 4: 3.0}
        eo = effective_ownership(ownership, xp)
        captaincy = sum(eo[p] - ownership[p] for p in ownership)
        self.assertAlmostEqual(captaincy, 1.0, places=6)

    def test_effective_ownership_exceeds_raw_for_the_top_pick(self):
        ownership = {1: 0.5, 2: 0.3}
        eo = effective_ownership(ownership, {1: 9.0, 2: 7.0})
        self.assertGreater(eo[1], ownership[1])

    def test_an_unowned_player_gains_no_captaincy(self):
        eo = effective_ownership({1: 0.5, 2: 0.0}, {1: 3.0, 2: 99.0})
        self.assertEqual(eo[2], 0.0)


class TestSampleRivals(unittest.TestCase):
    def setUp(self):
        self.positions, self.teams, self.prices, selected = _universe()
        self.ownership = ownership_share(selected)
        self.rng = np.random.default_rng(0)

    def test_every_rival_is_a_legal_squad(self):
        """
        A field of illegal teams has the wrong tail, which is the only property
        this module exists to get right.
        """
        squads = sample_rivals(
            self.ownership, self.positions, self.teams, self.prices,
            RULES, 25, self.rng,
        )
        self.assertGreater(len(squads), 0)
        for squad in squads:
            self.assertEqual(len(squad), RULES.squad_size)
            self.assertEqual(len(set(squad)), RULES.squad_size)
            for position, quota in RULES.quotas.items():
                got = sum(1 for p in squad if self.positions[p] == position)
                self.assertEqual(got, quota)
            clubs: dict = {}
            for p in squad:
                clubs[self.teams[p]] = clubs.get(self.teams[p], 0) + 1
            self.assertLessEqual(max(clubs.values()), RULES.club_limit)
            self.assertLessEqual(
                sum(self.prices[p] for p in squad), RULES.budget_tenths
            )

    def test_rivals_differ_from_one_another(self):
        """A field of identical squads has no tail at all."""
        squads = sample_rivals(
            self.ownership, self.positions, self.teams, self.prices,
            RULES, 20, self.rng,
        )
        distinct = {tuple(sorted(s)) for s in squads}
        self.assertGreater(len(distinct), 1)

    def test_a_pool_too_thin_yields_no_rivals_rather_than_illegal_ones(self):
        thin = {p: v for p, v in self.ownership.items() if self.positions[p] == "MID"}
        squads = sample_rivals(
            thin, self.positions, self.teams, self.prices, RULES, 5, self.rng,
        )
        self.assertEqual(squads, [])


class TestCalibrationGate(unittest.TestCase):
    def test_the_gate_starts_closed(self):
        """
        Nothing in the archive can open it: average_entry_score and
        highest_score are published on the live bootstrap per gameweek, and are
        empty before a season starts.
        """
        self.assertFalse(field_is_usable(0))
        for n in range(REQUIRED_CALIBRATED_GAMEWEEKS):
            self.assertFalse(field_is_usable(n))
        self.assertTrue(field_is_usable(REQUIRED_CALIBRATED_GAMEWEEKS))

    def test_missing_observations_never_count_as_a_pass(self):
        ok, reason = check_calibration([50.0] * 10, None, None)
        self.assertFalse(ok)
        self.assertIn("no observed", reason)

    def test_a_field_matching_the_gameweek_passes(self):
        scores = list(np.linspace(30, 90, 200))
        ok, reason = check_calibration(scores, float(np.mean(scores)), 90.0)
        self.assertTrue(ok, reason)

    def test_a_wrong_mean_fails(self):
        ok, reason = check_calibration([50.0] * 50, 80.0, 50.0)
        self.assertFalse(ok)
        self.assertIn("mean", reason)

    def test_a_wrong_tail_fails_even_when_the_mean_is_right(self):
        """
        highest_score is the only direct observable of the right tail, which is
        exactly what the weekly objective maximises against — so it is checked
        separately rather than folded into one score.
        """
        scores = [60.0] * 50
        ok, reason = check_calibration(scores, 60.0, 120.0)
        self.assertFalse(ok)
        self.assertIn("tail", reason)

    def test_an_empty_field_fails(self):
        ok, reason = check_calibration([], 60.0, 100.0)
        self.assertFalse(ok)
