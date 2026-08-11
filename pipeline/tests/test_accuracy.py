"""
The accuracy rollup, and the ceiling that makes it readable.

## What these tests defend

**The perfect-model ceiling is the root-mean-square of the spreads, not their
mean.** A forecaster that knows a player's true distribution predicts its mean
and incurs its variance, so the aggregate is `sqrt(mean(Var))`. Averaging the
standard deviations instead — the obvious mistake — understates it, because the
mean of square roots is not the square root of the mean. An implementation
making that error produces a plausible number that is wrong in the direction
that flatters us.

**It is computable with no outcomes at all.** That is why the screen has real
content on day one while `measured` is still null, and it is worth pinning: a
future refactor that made the ceiling depend on settled data would silently
blank the only number this file can currently publish.

**Bands are cut on the realised score, not the prediction.** The question is
"how well do we predict hauls". Bucketing by our own forecast instead would
answer "how well do we predict what we predicted", which is always excellent.

**Beating the ceiling is reported, not hidden.** A negative excess is evidence
of a bug — most likely a look-ahead leak — and clamping it at zero would hide
the most important thing this file could ever say.
"""

from __future__ import annotations

import math
import unittest

from pipeline.learning.accuracy import (
    MIN_OBSERVATIONS,
    PREDICTED_XI_BENCHMARK,
    band_of,
    build,
    measure,
    perfect_model_rmse,
)


def settled(n: int, *, predicted: float = 4.0, actual: float = 4.0,
            position: str = "MID", horizon: int = 1, gameweek: int = 1):
    return [
        {
            "gameweek": gameweek, "element_id": i, "position": position,
            "predicted": predicted, "actual": actual, "horizon": horizon,
        }
        for i in range(n)
    ]


class CeilingTests(unittest.TestCase):
    def test_it_is_the_root_mean_square_of_the_spreads(self):
        spreads = [3.0, 4.0]
        # sqrt((9 + 16) / 2) = 3.5355..., NOT the mean of 3.5.
        self.assertAlmostEqual(perfect_model_rmse(spreads), math.sqrt(12.5), places=6)

    def test_it_is_not_the_mean_of_the_spreads(self):
        """
        The mistake that flatters us.

        The mean of square roots is not the square root of the mean, and getting
        it wrong lowers the ceiling — making our own error look worse relative
        to it, or, if used the other way, making a bad model look skilful.
        """
        spreads = [1.0, 5.0]
        mean_of_spreads = sum(spreads) / len(spreads)
        self.assertNotAlmostEqual(perfect_model_rmse(spreads), mean_of_spreads, places=3)
        self.assertGreater(perfect_model_rmse(spreads), mean_of_spreads)

    def test_it_needs_no_outcomes(self):
        # The reason the screen has content on day one.
        payload = build(
            settled=[], spreads=[3.0, 4.0], gameweeks_sealed=0, generated_at="t",
        )
        self.assertIsNotNone(payload["perfect_model_rmse"])
        self.assertIsNone(payload["measured"])

    def test_an_empty_population_has_no_ceiling(self):
        # Zero would claim a perfect model makes no errors, which is the
        # opposite of what this number says.
        self.assertIsNone(perfect_model_rmse([]))

    def test_it_ignores_non_numeric_and_negative_spreads(self):
        self.assertAlmostEqual(
            perfect_model_rmse([3.0, None, "x", -1.0, 4.0]), math.sqrt(12.5), places=6,
        )

    def test_a_deterministic_population_has_a_zero_ceiling(self):
        # Every outcome certain: a perfect model really does make no errors.
        self.assertEqual(perfect_model_rmse([0.0, 0.0]), 0.0)


class BandTests(unittest.TestCase):
    def test_the_three_bands(self):
        self.assertEqual(band_of(0), "blank")
        self.assertEqual(band_of(1), "blank")
        self.assertEqual(band_of(2), "return")
        self.assertEqual(band_of(9), "return")
        self.assertEqual(band_of(10), "haul")
        self.assertEqual(band_of(24), "haul")

    def test_a_negative_score_is_a_blank(self):
        # A red card. Still not a return.
        self.assertEqual(band_of(-2), "blank")

    def test_bands_cut_on_the_realised_score(self):
        """
        Not on the prediction.

        Every record here is predicted 2 and realised 12: a badly missed haul.
        It must land in the `haul` bucket — which is the bucket that moves rank
        — rather than in `return` where our own forecast put it.
        """
        rows = settled(MIN_OBSERVATIONS + 5, predicted=2.0, actual=12.0)
        result = measure(rows)
        assert result is not None
        self.assertIn("haul", result["by_band"])
        self.assertNotIn("return", result["by_band"])
        self.assertAlmostEqual(result["by_band"]["haul"]["rmse"], 10.0, places=6)


class MeasureTests(unittest.TestCase):
    def test_too_few_observations_measures_nothing(self):
        self.assertIsNone(measure(settled(MIN_OBSERVATIONS - 1)))

    def test_a_perfect_forecast_has_zero_rmse(self):
        result = measure(settled(MIN_OBSERVATIONS + 1, predicted=4.0, actual=4.0))
        assert result is not None
        self.assertEqual(result["overall"]["rmse"], 0.0)

    def test_it_reports_bias_separately_from_error(self):
        """
        A model 3 points optimistic every week is biased, not noisy.

        RMSE alone conflates the two, and they have different fixes.
        """
        result = measure(settled(MIN_OBSERVATIONS + 1, predicted=7.0, actual=4.0))
        assert result is not None
        self.assertAlmostEqual(result["overall"]["rmse"], 3.0, places=6)
        self.assertAlmostEqual(result["overall"]["bias"], -3.0, places=6)

    def test_it_splits_by_position(self):
        rows = (
            settled(MIN_OBSERVATIONS + 1, position="DEF", predicted=4.0, actual=4.0)
            + settled(MIN_OBSERVATIONS + 1, position="FWD", predicted=4.0, actual=9.0)
        )
        result = measure(rows)
        assert result is not None
        self.assertEqual(result["by_position"]["DEF"]["rmse"], 0.0)
        self.assertAlmostEqual(result["by_position"]["FWD"]["rmse"], 5.0, places=6)

    def test_a_thin_position_is_omitted_rather_than_reported_noisily(self):
        rows = settled(MIN_OBSERVATIONS + 1, position="MID") + settled(3, position="GKP")
        result = measure(rows)
        assert result is not None
        self.assertIn("MID", result["by_position"])
        self.assertNotIn("GKP", result["by_position"])

    def test_it_splits_by_horizon(self):
        rows = (
            settled(MIN_OBSERVATIONS + 1, horizon=1, predicted=4.0, actual=4.0)
            + settled(MIN_OBSERVATIONS + 1, horizon=6, predicted=4.0, actual=10.0)
        )
        result = measure(rows)
        assert result is not None
        # A six-week-ahead forecast being worse than a one-week one is the
        # expected shape; the point is that the screen can show it.
        self.assertEqual(result["by_horizon"]["1"]["rmse"], 0.0)
        self.assertAlmostEqual(result["by_horizon"]["6"]["rmse"], 6.0, places=6)

    def test_non_numeric_rows_are_skipped(self):
        rows = settled(MIN_OBSERVATIONS + 1)
        rows.append({"position": "MID", "predicted": None, "actual": "4"})
        result = measure(rows)
        assert result is not None
        self.assertEqual(result["overall"]["n"], MIN_OBSERVATIONS + 1)


class RollupTests(unittest.TestCase):
    def test_the_day_one_payload_is_honest(self):
        payload = build(
            settled=[], spreads=[3.7] * 100, gameweeks_sealed=0, generated_at="t",
        )
        self.assertIsNone(payload["measured"])
        self.assertIsNone(payload["excess_over_ceiling"])
        self.assertEqual(payload["gameweeks_sealed"], 0)
        assert payload["reason"] is not None
        self.assertIn("sealed", payload["reason"])
        # ...and still carries the one number that is real.
        self.assertAlmostEqual(payload["perfect_model_rmse"], 3.7, places=4)

    def test_predicted_xi_names_the_bar_without_claiming_it(self):
        payload = build(settled=[], spreads=[3.0], gameweeks_sealed=0, generated_at="t")
        self.assertIsNone(payload["predicted_xi"]["ours"])
        self.assertEqual(payload["predicted_xi"]["benchmark"], PREDICTED_XI_BENCHMARK)
        self.assertIn("SportMonks", payload["predicted_xi"]["benchmark_source"])

    def test_excess_over_ceiling_is_the_only_part_that_is_skill(self):
        # Measured 5.0 against a ceiling of 3.0: 2.0 of the error is ours.
        payload = build(
            settled=settled(MIN_OBSERVATIONS + 1, predicted=4.0, actual=9.0),
            spreads=[3.0] * 50, gameweeks_sealed=1, generated_at="t",
        )
        self.assertAlmostEqual(payload["excess_over_ceiling"], 2.0, places=4)

    def test_beating_the_ceiling_is_reported_not_clamped(self):
        """
        A negative excess is evidence of a bug, most likely a look-ahead leak.

        Clamping it at zero would hide the most important thing this file could
        ever say.
        """
        payload = build(
            settled=settled(MIN_OBSERVATIONS + 1, predicted=4.0, actual=4.0),
            spreads=[3.0] * 50, gameweeks_sealed=1, generated_at="t",
        )
        self.assertLess(payload["excess_over_ceiling"], 0.0)

    def test_it_publishes_aggregates_only(self):
        # Never a per-player row: the rollup is public and the ledger is not.
        payload = build(
            settled=settled(MIN_OBSERVATIONS + 1), spreads=[3.0] * 10,
            gameweeks_sealed=1, generated_at="t",
        )
        serialised = repr(payload)
        self.assertNotIn("element_id", serialised)

    def test_the_ceiling_basis_is_stated_in_the_artifact(self):
        # A number whose derivation is not published invites the reader to
        # assume the flattering interpretation.
        payload = build(settled=[], spreads=[3.0], gameweeks_sealed=0, generated_at="t")
        self.assertIn("random", payload["perfect_model_basis"])


if __name__ == "__main__":
    unittest.main()
