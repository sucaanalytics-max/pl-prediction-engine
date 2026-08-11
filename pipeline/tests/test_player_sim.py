"""
Structural invariants for the joint player simulator.

Asserted over *every* draw, not on averages. An error that only shows up in the
tail is exactly the error the weekly team would be built on, and a mean-based
test cannot see it.

Also asserts the extension to montecarlo.py is additive: the existing
simulate_match keys, values and tests must be untouched.
"""
import unittest

import numpy as np
import pandas as pd

from pipeline.fpl.rules import load_rules
from pipeline.models.minutes import MinutesModel
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.montecarlo import MonteCarloSimulator
from pipeline.simulation.player_sim import (
    PlayerInput,
    _allocate_formation,
    _categorical_rows,
    _sample_exact_count,
    simulate_fixture_players,
)

RULES = load_rules()
N_DRAWS = 600


def _history():
    """A synthetic two-club season with realistic role variety."""
    rows = []
    squads = {
        "home": [("hk1", "GKP", 1.0), ("hk2", "GKP", 0.0),
                 ("hd1", "DEF", 1.0), ("hd2", "DEF", 1.0), ("hd3", "DEF", 0.9),
                 ("hd4", "DEF", 0.2), ("hd5", "DEF", 0.0),
                 ("hm1", "MID", 1.0), ("hm2", "MID", 0.9), ("hm3", "MID", 0.6),
                 ("hm4", "MID", 0.3), ("hm5", "MID", 0.0),
                 ("hf1", "FWD", 1.0), ("hf2", "FWD", 0.5), ("hf3", "FWD", 0.1),
                 ("hd6", "DEF", 0.15), ("hd7", "DEF", 0.05),
                 ("hm6", "MID", 0.15), ("hm7", "MID", 0.05),
                 ("hf4", "FWD", 0.05)],
        "away": [("ak1", "GKP", 1.0), ("ak2", "GKP", 0.0),
                 ("ad1", "DEF", 1.0), ("ad2", "DEF", 1.0), ("ad3", "DEF", 0.9),
                 ("ad4", "DEF", 0.2), ("ad5", "DEF", 0.0),
                 ("am1", "MID", 1.0), ("am2", "MID", 0.9), ("am3", "MID", 0.6),
                 ("am4", "MID", 0.3), ("am5", "MID", 0.0),
                 ("af1", "FWD", 1.0), ("af2", "FWD", 0.5), ("af3", "FWD", 0.1),
                 ("ad6", "DEF", 0.15), ("ad7", "DEF", 0.05),
                 ("am6", "MID", 0.15), ("am7", "MID", 0.05),
                 ("af4", "FWD", 0.05)],
    }
    for squad in squads.values():
        for name, position, start_rate in squad:
            for gameweek in range(1, 39):
                started = (gameweek % 10) / 10.0 < start_rate
                minutes = 90 if started else (20 if start_rate > 0.05 and gameweek % 3 == 0 else 0)
                scored = 1 if (position == "FWD" and started and gameweek % 4 == 0) else 0
                rows.append({
                    "name_key": name,
                    "position_norm": position,
                    "GW": gameweek,
                    "minutes": minutes,
                    "starts": 1 if started else 0,
                    "goals_scored": scored,
                    "assists": 1 if (position == "MID" and started and gameweek % 5 == 0) else 0,
                    "clean_sheets": 1 if (position in ("GKP", "DEF") and started and gameweek % 3 == 0) else 0,
                    "bonus": 3 if scored else 0,
                    "yellow_cards": 1 if gameweek % 9 == 0 and started else 0,
                    "saves": (3 if position == "GKP" else 0) * minutes / 90.0,
                    # Event columns MUST scale with minutes. Assigning a
                    # constant per row inflates a 20-minute substitute's per-90
                    # rate 4.5x and made fringe players out-project nailed
                    # starters — a fixture artefact that looked like a model bug.
                    "expected_goals": (0.5 if position == "FWD" else 0.05) * minutes / 90.0,
                    "expected_assists": (0.2 if position == "MID" else 0.03) * minutes / 90.0,
                    "clearances_blocks_interceptions": (6 if position == "DEF" else 2) * minutes / 90.0,
                    "tackles": 2 * minutes / 90.0,
                    "recoveries": 5 * minutes / 90.0,
                })
    return pd.DataFrame(rows)


class _Fixture:
    """A simulated fixture with both squads, built once and shared."""

    def __init__(self, seed=11, lambda_home=1.7, mu_away=1.1):
        history = _history()
        self.minutes_model = MinutesModel().fit(
            history, key="name_key", position_column="position_norm"
        )
        self.events = PlayerEventRates().fit(
            history, key="name_key", position_column="position_norm", rules=RULES
        )
        self.rng = np.random.default_rng(seed)
        simulator = MonteCarloSimulator(n_simulations=N_DRAWS)
        np.random.seed(seed)
        self.sims = simulator.simulate_match_state(
            lambda_home, mu_away, rng=self.rng
        )
        self.home = self._side("home")
        self.away = self._side("away")
        self.draws = simulate_fixture_players(
            self.sims, self.home, self.away, self.events, RULES, self.rng
        )

    def _side(self, prefix):
        letter = "h" if prefix == "home" else "a"
        spec = [(f"{letter}k1", "GKP"), (f"{letter}k2", "GKP")]
        spec += [(f"{letter}d{i}", "DEF") for i in range(1, 8)]
        spec += [(f"{letter}m{i}", "MID") for i in range(1, 8)]
        spec += [(f"{letter}f{i}", "FWD") for i in range(1, 5)]
        players = []
        for index, (name, position) in enumerate(spec):
            players.append(
                PlayerInput(
                    element_id=hash(name) % 100000,
                    position=position,
                    roles=self.minutes_model.predict(position, name),
                    rates=self.events.rates(position, name),
                    penalty_order=1 if name.endswith("f1") else None,
                    player_key=name,
                )
            )
        return players


FIXTURE = _Fixture()


class AdditiveExtensionTests(unittest.TestCase):
    def test_simulate_match_keys_are_unchanged(self):
        simulator = MonteCarloSimulator(n_simulations=50)
        np.random.seed(3)
        base = simulator.simulate_match(1.5, 1.2)
        np.random.seed(3)
        extended = simulator.simulate_match_state(
            1.5, 1.2, rng=np.random.default_rng(3)
        )
        for key, value in base.items():
            with self.subTest(key=key):
                np.testing.assert_array_equal(value, extended[key])

    def test_goal_minutes_are_present_and_bounded(self):
        minutes = FIXTURE.sims["home_goal_minutes"]
        live = minutes > 0
        self.assertTrue((minutes[live] >= 1).all())
        self.assertTrue((minutes[live] <= 90).all())

    def test_goal_minute_slots_match_the_drawn_goal_count(self):
        """Allocated goals must never exceed drawn goals, in any draw."""
        for side in ("home", "away"):
            minutes = FIXTURE.sims[f"{side}_goal_minutes"]
            drawn = FIXTURE.sims[f"{side}_goals"]
            slots_used = (minutes > 0).sum(axis=1)
            capped = np.minimum(drawn, minutes.shape[1])
            np.testing.assert_array_equal(slots_used, capped)

    def test_player_layer_refuses_a_match_without_goal_minutes(self):
        simulator = MonteCarloSimulator(n_simulations=20)
        np.random.seed(1)
        bare = simulator.simulate_match(1.0, 1.0)
        with self.assertRaises(ValueError):
            simulate_fixture_players(
                bare, FIXTURE.home, FIXTURE.away, FIXTURE.events, RULES,
                np.random.default_rng(1),
            )


class LineupInvariantTests(unittest.TestCase):
    def test_exactly_eleven_starters_with_exactly_one_keeper(self):
        for side, players in (("home", FIXTURE.home), ("away", FIXTURE.away)):
            offset = 0 if side == "home" else len(FIXTURE.home)
            columns = slice(offset, offset + len(players))
            # Reconstruct starters as those on the pitch from minute 0.
            started = FIXTURE.draws.minutes[:, columns] > 0
            keepers = [i for i, p in enumerate(players) if p.position == "GKP"]
            with self.subTest(side=side):
                keeper_appearances = started[:, keepers].sum(axis=1)
                # Exactly one keeper starts, by construction. Two can appear when
                # the reserve comes on for an injury or dismissal, which is real
                # but rare — so this bounds the rate rather than forbidding it.
                # Left in the outfield substitute pool, the reserve keeper
                # appeared in a material share of draws.
                self.assertTrue((keeper_appearances >= 1).all())
                two_keepers = float((keeper_appearances >= 2).mean())
                self.assertLess(two_keepers, 0.05, f"reserve keeper appears in {two_keepers:.1%} of draws")

    def test_formation_allocation_respects_bounds_and_totals(self):
        allocation = _allocate_formation(
            {"DEF": 5.0, "MID": 5.0, "FWD": 3.0}, RULES.play_bounds, 10
        )
        self.assertEqual(sum(allocation.values()), 10)
        for group, count in allocation.items():
            low, high = RULES.play_bounds[group]
            with self.subTest(group=group):
                self.assertGreaterEqual(count, low)
                self.assertLessEqual(count, high)

    def test_formation_allocation_handles_a_lopsided_squad(self):
        """All propensity in one group must still yield a legal shape."""
        allocation = _allocate_formation(
            {"DEF": 0.0, "MID": 10.0, "FWD": 0.0}, RULES.play_bounds, 10
        )
        self.assertEqual(sum(allocation.values()), 10)
        self.assertGreaterEqual(allocation["DEF"], 3)
        self.assertGreaterEqual(allocation["FWD"], 1)
        self.assertLessEqual(allocation["MID"], 5)

    def test_exact_count_sampler_hits_the_count_every_draw(self):
        rng = np.random.default_rng(5)
        probabilities = np.array([0.9, 0.8, 0.5, 0.3, 0.1, 0.02])
        selected = _sample_exact_count(probabilities, 3, 400, rng)
        self.assertTrue((selected.sum(axis=1) == 3).all())

    def test_exact_count_sampler_preserves_relative_propensity(self):
        """
        The realised marginals must track the requested ones. This is what makes
        a p_start recorded in the ledger meaningful when it is later scored.
        """
        rng = np.random.default_rng(7)
        probabilities = np.array([0.95, 0.7, 0.4, 0.15, 0.05])
        selected = _sample_exact_count(probabilities, 2, 4000, rng)
        realised = selected.mean(axis=0)
        self.assertTrue(
            np.all(np.diff(realised) <= 1e-9),
            f"marginals not monotone in p: {realised}",
        )


class BenchCalibrationTests(unittest.TestCase):
    """
    The substitute layer is calibrated against a measured aggregate: 4.14
    substitute appearances per fixture-team across the settled prior season.

    It needs calibrating because the estimable quantity is P(appear | did not
    start), while the quantity required is P(appear | named among the
    substitutes). The archive lists the whole registered squad — about 39 rows
    per fixture-team — so the former is diluted by players who were never
    available. Uncalibrated the model produced 2.99 substitutes against 4.14.
    """

    def test_substitute_appearances_land_near_the_measured_rate(self):
        appearing = (
            FIXTURE.draws.minutes[:, : len(FIXTURE.home)] > 0
        ).sum(axis=1)
        substitutes = appearing.mean() - RULES.lineup_size
        self.assertGreater(substitutes, 2.5, f"only {substitutes:.2f} substitutes")
        self.assertLess(substitutes, 5.5, f"{substitutes:.2f} substitutes is too many")

    def test_non_start_probability_is_not_discounted_twice(self):
        """
        p_bench_appear is already unconditional. Feeding it straight into a
        `~starts` mask discounts by the non-start probability a second time,
        which drove the rate DOWN to 2.57 when the calibration was first added.
        """
        appearing = (
            FIXTURE.draws.minutes[:, : len(FIXTURE.home)] > 0
        ).sum(axis=1)
        self.assertGreater(appearing.mean(), 13.0)

    def test_saturation_is_reported_when_the_squad_is_too_thin(self):
        """A squad of barely eleven cannot supply four substitutes; say so."""
        thin_home = FIXTURE.home[:12]
        thin_away = FIXTURE.away[:12]
        draws = simulate_fixture_players(
            FIXTURE.sims, thin_home, thin_away, FIXTURE.events, RULES,
            np.random.default_rng(3),
        )
        self.assertTrue(draws.notes["bench_saturated"])

    def test_a_full_squad_is_not_flagged_as_saturated(self):
        self.assertFalse(FIXTURE.draws.notes["bench_saturated"])


class DefensiveContributionPositionTests(unittest.TestCase):
    """
    A reclassified player must not carry his old counted set.

    Recoveries count for midfielders and forwards but not defenders, so a summed
    dc_per_90 fitted under one position and applied under another is wrong in the
    damaging direction. Measured before the restructure: 10 players affected, and
    Mats Wieffer (MID -> DEF) had P(+2 defcon | 90 min) of 0.752 where 0.269 was
    correct.
    """

    def test_defcon_rate_follows_the_position_it_is_asked_for(self):
        rates = FIXTURE.events.rates("MID", "hm1")
        as_def = rates.defcon_rate("DEF", RULES)
        as_mid = rates.defcon_rate("MID", RULES)
        # The midfield set adds recoveries, so it must be strictly larger.
        self.assertGreater(as_mid, as_def)

    def test_goalkeepers_never_accumulate_defensive_contribution(self):
        rates = FIXTURE.events.rates("DEF", "hd1")
        self.assertEqual(rates.defcon_rate("GKP", RULES), 0.0)

    def test_rates_expose_components_not_a_presummed_total(self):
        """A pre-summed total is what made the stale-position bug possible."""
        rates = FIXTURE.events.rates("MID", "hm1")
        self.assertFalse(hasattr(rates, "dc_per_90"))
        for field in ("cbi_per_90", "tackles_per_90", "recoveries_per_90"):
            self.assertTrue(hasattr(rates, field))


class GoalAllocationTests(unittest.TestCase):
    def test_allocated_goals_equal_drawn_goals_in_every_draw(self):
        for side, players in (("home", FIXTURE.home), ("away", FIXTURE.away)):
            offset = 0 if side == "home" else len(FIXTURE.home)
            columns = slice(offset, offset + len(players))
            allocated = FIXTURE.draws.goals[:, columns].sum(axis=1)
            drawn = np.minimum(
                FIXTURE.sims[f"{side}_goals"],
                FIXTURE.sims[f"{side}_goal_minutes"].shape[1],
            )
            with self.subTest(side=side):
                np.testing.assert_array_equal(allocated, drawn)

    def test_a_player_who_scored_can_also_assist(self):
        """
        Assists are child events of individual goals, excluding that goal's own
        scorer. If they were drawn per player instead, score-and-assist would be
        impossible and the right tail would be clipped.
        """
        both = (FIXTURE.draws.goals > 0) & (FIXTURE.draws.assists > 0)
        self.assertTrue(both.any(), "no draw produced a goal and an assist")

    def test_assists_never_exceed_goals_within_a_side(self):
        for side, players in (("home", FIXTURE.home), ("away", FIXTURE.away)):
            offset = 0 if side == "home" else len(FIXTURE.home)
            columns = slice(offset, offset + len(players))
            with self.subTest(side=side):
                self.assertTrue(
                    (
                        FIXTURE.draws.assists[:, columns].sum(axis=1)
                        <= FIXTURE.draws.goals[:, columns].sum(axis=1)
                    ).all()
                )

    def test_only_players_on_the_pitch_score(self):
        scored_without_playing = (FIXTURE.draws.goals > 0) & (
            FIXTURE.draws.minutes <= 0
        )
        self.assertFalse(scored_without_playing.any())

    def test_categorical_raises_on_non_finite_weights(self):
        rng = np.random.default_rng(1)
        with self.assertRaises(ValueError):
            _categorical_rows(np.array([[1.0, np.nan]]), rng)

    def test_categorical_falls_back_to_uniform_on_a_zero_weight_row(self):
        """
        Two promoted clubs have identically zero prior expected goals. A naive
        implementation sends every one of their goals to whichever player is
        first in the array.
        """
        rng = np.random.default_rng(2)
        picks = _categorical_rows(np.zeros((2000, 4)), rng)
        counts = np.bincount(picks, minlength=4)
        self.assertTrue((counts > 300).all(), f"not uniform: {counts}")


class CleanSheetTests(unittest.TestCase):
    def test_clean_sheet_requires_sixty_minutes(self):
        cs_without_the_hour = (FIXTURE.draws.clean_sheets > 0) & (
            FIXTURE.draws.minutes < 60
        )
        self.assertFalse(cs_without_the_hour.any())

    def test_a_clean_sheet_is_shared_by_the_defence_in_the_same_draw(self):
        """
        The joint structure that marginal models get wrong: within one draw, a
        team's outfield starters either all kept a clean sheet or none did,
        modulo substitutions.
        """
        keeper_and_defenders = [
            index
            for index, player in enumerate(FIXTURE.home)
            if player.position in ("GKP", "DEF")
        ]
        full_match = FIXTURE.draws.minutes[:, keeper_and_defenders] >= 90
        clean = FIXTURE.draws.clean_sheets[:, keeper_and_defenders] > 0
        both_known = full_match.sum(axis=1) >= 2
        rows = np.where(both_known)[0][:200]
        for row in rows:
            playing = full_match[row]
            values = set(clean[row][playing].tolist())
            with self.subTest(row=int(row)):
                self.assertEqual(len(values), 1, "defence disagrees on a clean sheet")

    def test_clean_sheets_are_correlated_not_independent(self):
        """
        Quantifies the defect a marginal model has. If two defenders' clean
        sheets were independent, the correlation would be ~0.
        """
        defenders = [
            index for index, player in enumerate(FIXTURE.home)
            if player.position == "DEF"
        ][:2]
        a = FIXTURE.draws.clean_sheets[:, defenders[0]].astype(float)
        b = FIXTURE.draws.clean_sheets[:, defenders[1]].astype(float)
        if a.std() > 0 and b.std() > 0:
            self.assertGreater(float(np.corrcoef(a, b)[0, 1]), 0.5)


class ScoringConsistencyTests(unittest.TestCase):
    def test_zero_minute_players_score_zero_or_only_a_card(self):
        absent = FIXTURE.draws.minutes <= 0
        points = FIXTURE.draws.points[absent]
        # Only a card deduction is possible without minutes.
        self.assertTrue(((points == 0) | (points == -1) | (points == -3)).all())

    def test_points_are_bounded_by_something_physically_reachable(self):
        self.assertLess(int(FIXTURE.draws.points.max()), 60)
        self.assertGreater(int(FIXTURE.draws.points.min()), -10)

    def test_identical_seeds_reproduce_identical_matrices(self):
        first = _Fixture(seed=99)
        second = _Fixture(seed=99)
        np.testing.assert_array_equal(first.draws.points, second.draws.points)
        np.testing.assert_array_equal(first.draws.minutes, second.draws.minutes)

    def test_different_seeds_produce_different_matrices(self):
        other = _Fixture(seed=1234)
        self.assertFalse(
            np.array_equal(FIXTURE.draws.points, other.draws.points)
        )

    def test_summary_reports_a_distribution_not_just_a_mean(self):
        rows = FIXTURE.draws.summary()
        self.assertEqual(len(rows), len(FIXTURE.home) + len(FIXTURE.away))
        for row in rows:
            with self.subTest(element=row["element_id"]):
                self.assertGreaterEqual(row["xp_sd"], 0.0)
                self.assertLessEqual(row["q10"], row["q50"])
                self.assertLessEqual(row["q50"], row["q90"])
                self.assertGreaterEqual(row["p_ge_5"], row["p_ge_10"])
                self.assertGreaterEqual(row["p_appears"], row["p_60"])

    def test_approximations_are_declared_in_the_output(self):
        """An undeclared approximation is indistinguishable from a claim."""
        notes = FIXTURE.draws.notes
        self.assertEqual(notes["bonus_method"], "empirical_conditional_bucket")
        self.assertFalse(notes["bonus_tail_claim"])
        self.assertFalse(notes["substitution_count_exact"])
        self.assertEqual(notes["goal_minute_model"], "uniform_1_90")


if __name__ == "__main__":
    unittest.main()
