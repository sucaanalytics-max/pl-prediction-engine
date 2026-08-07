"""
Tests for the minutes/role model, the parameter registry and the backtest.

The backtest's job is to be able to fail, so the leakage guard is tested
directly rather than assumed from reading the loop: a walk-forward harness that
quietly sees the future would make every downstream acceptance number
meaningless while looking healthy.

The full-season acceptance run takes ~20s and is gated behind FPL_SLOW_TESTS so
it runs in the weekly validation workflow rather than in the gate that blocks
the daily prediction commit. A fast subset always runs.
"""
import os
import unittest

import pandas as pd

from pipeline.config import PARAM_REGISTRY, RISK
from pipeline.models.minutes import (
    HARD_GATE_STATUSES,
    MinutesModel,
    availability,
)

SLOW = os.environ.get("FPL_SLOW_TESTS") == "1"


def _history(rows):
    """Build per-fixture history: (name, position, gameweek, minutes, started)."""
    return pd.DataFrame(
        [
            {
                "name_key": name,
                "position_norm": position,
                "GW": gameweek,
                "minutes": minutes,
                "starts": 1 if started else 0,
            }
            for name, position, gameweek, minutes, started in rows
        ]
    )


def _regular_starter(name="nailed on", position="MID", n=30):
    return [(name, position, gw, 88, True) for gw in range(1, n + 1)]


def _never_plays(name="squad filler", position="MID", n=30):
    return [(name, position, gw, 0, False) for gw in range(1, n + 1)]


class ParameterRegistryTests(unittest.TestCase):
    def test_registry_and_risk_are_disjoint(self):
        """Nothing the learning loop can move may touch staking."""
        self.assertEqual(set(PARAM_REGISTRY) & set(RISK), set())

    def test_every_parameter_declares_provenance_bounds_and_tier(self):
        for name, spec in PARAM_REGISTRY.items():
            with self.subTest(parameter=name):
                self.assertIn("source", spec)
                self.assertGreater(len(spec["source"]), 40, "source is too thin")
                self.assertIn("bounds", spec)
                self.assertIn(spec["tier"], {"F", "S", "C"})

    def test_every_value_lies_within_its_bounds(self):
        for name, spec in PARAM_REGISTRY.items():
            low, high = spec["bounds"]
            with self.subTest(parameter=name):
                self.assertGreaterEqual(spec["value"], low)
                self.assertLessEqual(spec["value"], high)


class AvailabilityTests(unittest.TestCase):
    def test_available_status_is_fully_available(self):
        self.assertEqual(availability("a", None), (1.0, None))

    def test_hard_gate_statuses_are_zero(self):
        for status in HARD_GATE_STATUSES:
            with self.subTest(status=status):
                probability, reason = availability(status, None)
                self.assertEqual(probability, 0.0)
                self.assertIsNotNone(reason)

    def test_hard_gate_beats_an_optimistic_chance_field(self):
        """A removed player cannot play, whatever the chance field says."""
        self.assertEqual(availability("u", 100)[0], 0.0)

    def test_explicit_chance_is_believed(self):
        self.assertAlmostEqual(availability("d", 25)[0], 0.25)
        self.assertAlmostEqual(availability("i", 50)[0], 0.50)

    def test_zero_chance_is_a_gate(self):
        probability, reason = availability("d", 0)
        self.assertEqual(probability, 0.0)
        self.assertEqual(reason, "chance_of_playing_zero")

    def test_missing_chance_never_means_fully_available(self):
        """
        FPL's chance_of_playing field is sparse and lags. Treating an absent
        value as 100% would quietly restore every flagged player to full
        availability.
        """
        for status in ("d", "i", "s"):
            with self.subTest(status=status):
                probability, reason = availability(status, None)
                self.assertLess(probability, 1.0)
                self.assertIsNotNone(reason)

    def test_a_stale_note_stops_suppressing_availability(self):
        fresh, _ = availability("d", None, news_age_days=1)
        stale, reason = availability("d", None, news_age_days=999)
        self.assertLess(fresh, 1.0)
        self.assertEqual(stale, 1.0)
        self.assertEqual(reason, "news_stale")

    def test_unrecognised_status_is_gated_not_assumed_fit(self):
        probability, reason = availability("zzz", None)
        self.assertEqual(probability, 0.0)
        self.assertIn("unrecognised", reason)


class RoleProbabilityTests(unittest.TestCase):
    def setUp(self):
        self.model = MinutesModel().fit(
            _history(
                _regular_starter()
                + _never_plays()
                + [("rotated", "MID", gw, 60 if gw % 2 else 0, gw % 2 == 1)
                   for gw in range(1, 31)]
            ),
            key="name_key",
            position_column="position_norm",
        )

    def test_role_probabilities_sum_to_one(self):
        for player in ("nailed on", "squad filler", "rotated", "unknown player"):
            with self.subTest(player=player):
                roles = self.model.predict("MID", player)
                total = (
                    roles.p_start + roles.p_bench_appear
                    + roles.p_unused + roles.p_unavailable
                )
                self.assertAlmostEqual(total, 1.0, places=6)

    def test_all_probabilities_lie_in_the_unit_interval(self):
        roles = self.model.predict("MID", "nailed on")
        for name, value in roles.as_dict().items():
            if name.startswith("p_") or name == "availability":
                with self.subTest(field=name):
                    self.assertGreaterEqual(value, 0.0)
                    self.assertLessEqual(value, 1.0)

    def test_a_regular_starter_is_predicted_to_start(self):
        self.assertGreater(self.model.predict("MID", "nailed on").p_start, 0.9)

    def test_a_player_who_never_plays_is_predicted_not_to(self):
        """
        This is the case an initial shrinkage of 8.0 got badly wrong: it
        predicted 0.068 appearance against a realised 0.012 across 5,356 rows.
        """
        roles = self.model.predict("MID", "squad filler")
        self.assertLess(roles.p_appears, 0.10)

    def test_an_unknown_player_falls_back_to_the_position_prior(self):
        roles = self.model.predict("MID", "nobody has heard of him")
        self.assertEqual(roles.evidence_fixtures, 0)
        self.assertEqual(roles.evidence_weight, 0.0)
        self.assertGreater(roles.p_start, 0.0)

    def test_evidence_weight_rises_with_history(self):
        """A prior-driven 0.9 and an evidence-backed 0.9 must be distinguishable."""
        sparse = MinutesModel().fit(
            _history(_regular_starter(n=2) + _never_plays()),
            key="name_key", position_column="position_norm",
        )
        self.assertLess(
            sparse.predict("MID", "nailed on").evidence_weight,
            self.model.predict("MID", "nailed on").evidence_weight,
        )

    def test_zero_minute_players_are_modelled_not_excluded(self):
        """
        No minimum-minutes filter. Excluding low-sample players would delete
        exactly the rotation risks the optimiser needs an honest number for.
        """
        self.assertIn("squad filler", self.model.by_player)

    def test_availability_gate_scales_the_appearing_branches(self):
        """
        The mass identity is now FOUR-way. ``p_unused`` used to absorb both "in
        the squad and not picked" and "not available to be picked"; the second is
        now ``p_unavailable``, because the simulator's substitute layer
        renormalises over the first and was handing bench-appearance mass to
        injured players.
        """
        gated = self.model.predict("MID", "nailed on", status="d", chance_of_playing=50)
        ungated = self.model.predict("MID", "nailed on")
        self.assertLess(gated.p_start, ungated.p_start)
        self.assertAlmostEqual(
            gated.p_start + gated.p_bench_appear + gated.p_unused
            + gated.p_unavailable,
            1.0, places=6,
        )
        # Half the mass is unavailability, and none of it leaks into "unused".
        self.assertAlmostEqual(gated.p_unavailable, 0.5, places=6)

    def test_a_hard_gated_player_cannot_appear(self):
        roles = self.model.predict("MID", "nailed on", status="u")
        self.assertEqual(roles.p_appears, 0.0)
        # All the mass is UNAVAILABLE, not "unused". A `u` player is not a
        # benched player, and the substitute layer must not consider him.
        self.assertAlmostEqual(roles.p_unavailable, 1.0)
        self.assertAlmostEqual(roles.p_unused, 0.0)

    def test_preseason_fallback_start_rate_cannot_exceed_one(self):
        """
        Guards a real defect: dividing prior-season `starts` by the wrong
        denominator produced p_start above 8. The fallback is clipped and the
        role sum is asserted.
        """
        roles = self.model.predict(
            "GKP", "unknown keeper", fallback_start_rate=8.1
        )
        self.assertLessEqual(roles.p_start, 1.0)
        self.assertAlmostEqual(
            roles.p_start + roles.p_bench_appear + roles.p_unused
            + roles.p_unavailable,
            1.0, places=6,
        )

    def test_unknown_position_raises(self):
        with self.assertRaises(ValueError):
            self.model.predict("AM", "nailed on")

    def test_fit_requires_the_columns_it_uses(self):
        with self.assertRaises(ValueError):
            MinutesModel().fit(
                pd.DataFrame({"name_key": ["x"]}),
                key="name_key", position_column="position_norm",
            )


class BacktestLeakageTests(unittest.TestCase):
    def test_the_fit_never_sees_the_gameweek_being_scored(self):
        """
        Asserted directly rather than inferred from the loop. A harness that
        quietly saw the future would make every acceptance number below
        meaningless while still looking healthy.
        """
        from pipeline.learning import backtest as backtest_module

        seen = []
        original = MinutesModel.fit

        def recording_fit(self, history, *args, **kwargs):
            seen.append(int(pd.to_numeric(history["GW"]).max()))
            return original(self, history, *args, **kwargs)

        backtest_module.MinutesModel.fit = recording_fit
        self.addCleanup(
            setattr, backtest_module.MinutesModel, "fit", original
        )

        backtest_module.backtest_minutes(
            "2526", prior_season=None, first_gameweek=34
        )

        # Scored gameweeks are 34..38; each fit must end strictly before its own.
        self.assertTrue(seen, "no fits were recorded")
        for index, max_gameweek_in_fit in enumerate(seen):
            scored = 34 + index
            with self.subTest(scored_gameweek=scored):
                self.assertLess(max_gameweek_in_fit, scored)


class BacktestAcceptanceTests(unittest.TestCase):
    """
    Pre-registered acceptance criteria from the build plan.

    Parameters were selected on 2024-25; 2025-26 is held out. Selecting on the
    season these numbers are reported for would make them meaningless.
    """

    @classmethod
    def setUpClass(cls):
        from pipeline.learning.backtest import backtest_minutes

        first = 1 if SLOW else 30
        cls.result = backtest_minutes(
            "2526", prior_season="2425", first_gameweek=first
        )
        cls.model = cls.result.metrics["model"]

    def test_zero_band_mae_meets_the_bar(self):
        self.assertLessEqual(
            self.model["zero_band_mae"], 0.30, self.result.summary()
        )

    def test_appearance_probability_is_calibrated(self):
        self.assertLessEqual(
            self.model["ece_appears"], 0.05, self.result.summary()
        )

    def test_model_beats_every_baseline_on_brier(self):
        """
        The `last5` baseline was crippled until its ordering was fixed: `past`
        concatenates two seasons, so sorting on gameweek NUMBER alone put last
        season's GW34-38 after this season's GW1-9, and 470 of 472 dual-season
        players had a tail(5) drawn entirely from the prior season. Against the
        corrected baseline the model initially LOST on Brier, 0.1313 to 0.1069.

        That was a real deficiency, not a metric artefact: the model weighted a
        player's whole history uniformly, so a benched regular still projected as
        a starter. Recency weighting fixed it — Brier 0.1313 -> 0.0931.
        """
        for name, metric in self.result.metrics.items():
            if name == "model":
                continue
            with self.subTest(baseline=name):
                self.assertLess(
                    self.model["brier_appears"],
                    metric["brier_appears"],
                    self.result.summary(),
                )

    def test_recency_baseline_still_wins_on_raw_absolute_error(self):
        """
        Recorded rather than hidden. `last5` is a sharper POINT predictor — it
        emits near 0/1 — so it posts lower MAE on each band while being far worse
        calibrated (ECE roughly 2.7x) and worse on Brier. The simulator SAMPLES
        from these numbers, so calibration and Brier are the binding
        requirements; absolute error on a thresholded band is not.

        If this test ever fails because the model also wins MAE, that is good
        news and the test should be deleted, not adjusted.
        """
        model = self.model
        last5 = self.result.metrics["last5"]
        self.assertLess(last5["zero_band_mae"], model["zero_band_mae"])
        self.assertLess(model["brier_appears"], last5["brier_appears"])
        self.assertLess(model["ece_appears"], last5["ece_appears"])

    def test_model_beats_every_baseline_on_calibration_except_the_constants(self):
        """
        A constant predictor is trivially well calibrated in aggregate while
        being useless, so it is exempt. The comparison that matters is against
        `last5`, the only baseline that varies by player.
        """
        self.assertLess(
            self.model["ece_appears"],
            self.result.metrics["last5"]["ece_appears"],
            self.result.summary(),
        )


class HorizonAvailabilityTests(unittest.TestCase):
    """
    Availability must decay with forecast horizon.

    Measured in our own archive over both seasons: players who started gameweek
    g average 69.4 minutes at g+1 and 56.3 at g+9. Without this the horizon
    treats a GW+6 projection as being as certain as a GW+1 one, overstating
    far-horizon availability by ~15% and making distant fixtures look better
    than they are.
    """

    def setUp(self):
        self.model = MinutesModel().fit(
            _history(_regular_starter() + _never_plays()),
            key="name_key", position_column="position_norm",
        )

    def test_the_immediate_gameweek_is_undiscounted(self):
        from pipeline.models.minutes import horizon_availability_factor

        self.assertEqual(horizon_availability_factor(0), 1.0)

    def test_availability_falls_monotonically_with_horizon(self):
        from pipeline.models.minutes import horizon_availability_factor

        values = [horizon_availability_factor(h) for h in range(8)]
        self.assertTrue(all(b <= a for a, b in zip(values, values[1:])), values)

    def test_the_decay_flattens_rather_than_compounding_to_zero(self):
        """Risk accumulates toward a base rate; it does not compound forever."""
        from pipeline.models.minutes import horizon_availability_factor

        far = horizon_availability_factor(30)
        self.assertGreater(far, 0.5)
        self.assertLess(
            horizon_availability_factor(6) - horizon_availability_factor(7),
            horizon_availability_factor(0) - horizon_availability_factor(1),
        )

    def test_a_distant_projection_is_less_confident_than_a_near_one(self):
        near = self.model.predict("MID", "nailed on", horizon=0)
        far = self.model.predict("MID", "nailed on", horizon=6)
        self.assertLess(far.p_appears, near.p_appears)
        self.assertAlmostEqual(
            far.p_start + far.p_bench_appear + far.p_unused + far.p_unavailable,
            1.0, places=6,
        )

    def test_a_permanently_departed_player_stays_gated_at_every_horizon(self):
        """
        Narrowed from "hard gated" to name what the invariant is actually about.

        A `u`/`n` status means FPL has removed the player from the squad, and in
        the committed pre-season snapshot all five such players have left the club
        (loan, permanent transfer, free agent, returned to parent club). For those
        the projection must be zero at every horizon, and the `permanent`
        persistence class is what preserves that.

        The invariant is real and must not be widened back: without it, the
        reversion path would resurrect a departed player at week three. But it is
        also NOT what asserts the suspension behaviour — a suspended player
        reaches zero through `chance_of_playing == 0`, not through this gate, and
        he must come back. See test_minutes_horizon.DatedAbsenceTests.
        """
        for horizon in (0, 3, 6, 12):
            with self.subTest(horizon=horizon):
                roles = self.model.predict(
                    "MID", "nailed on", status="u", horizon=horizon
                )
                self.assertEqual(roles.p_appears, 0.0)
                self.assertAlmostEqual(roles.p_unavailable, 1.0)


if __name__ == "__main__":
    unittest.main()
