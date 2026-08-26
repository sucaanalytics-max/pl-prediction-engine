"""
`config.EVAL`, and the fact that something now compares against it.

The block named four targets — Brier, log loss, calibration error, and the minimum
match count the first three are stated for — and had no importer anywhere in the
repo. It read like the model's pass/fail bar and was four inert numbers, so an unmet
target was indistinguishable from a met one. Every quantity it names was already
being computed and written into `health.json`.

The gate is the part worth pinning: below `backtest_min_matches` the verdict must be
"insufficient sample", not a failure. With ten matches evaluated an ECE of 0.26 says
almost nothing, and reporting that as a failure is how a reader learns to ignore the
block — which is the state this started in.
"""
import unittest

from pipeline.config import EVAL
from pipeline.validation.run_validation import assess_eval_targets


def health(n_matches, *, brier=0.20, log_loss=0.9, ece=0.04):
    return {
        "model_metrics": {
            "n_evaluated_matches": n_matches,
            "brier_1x2_home": brier,
            "brier_1x2_draw": brier / 2,
            "brier_1x2_away": brier / 2,
            "log_loss_home": log_loss,
            "ece": ece,
        },
    }


class TestTheSampleGate(unittest.TestCase):
    def test_below_the_minimum_nothing_is_judged(self):
        v = assess_eval_targets(health(EVAL["backtest_min_matches"] - 1))
        self.assertFalse(v["assessable"])
        self.assertIn("below", v["note"])
        # And no per-target verdict is invented.
        self.assertNotIn("brier", v)
        self.assertNotIn("all_targets_met", v)

    def test_at_the_minimum_it_is_assessable(self):
        v = assess_eval_targets(health(EVAL["backtest_min_matches"]))
        self.assertTrue(v["assessable"])

    def test_missing_metrics_are_absent_not_zero(self):
        # A zero Brier would read as a perfect model. "not computed" reads as what it
        # is, which is the same refusal the frontend's artifact envelope makes.
        v = assess_eval_targets({"model_metrics": {
            "n_evaluated_matches": EVAL["backtest_min_matches"],
        }})
        self.assertEqual(v["log_loss"], "not computed")
        self.assertEqual(v["calibration_error"], "not computed")
        self.assertFalse(v["all_targets_met"])

    def test_no_metrics_block_at_all(self):
        v = assess_eval_targets({})
        self.assertFalse(v["assessable"])


class TestTheTargets(unittest.TestCase):
    def test_a_model_inside_every_target_passes(self):
        v = assess_eval_targets(health(200))
        self.assertTrue(v["all_targets_met"], v)

    def test_the_worst_1x2_brier_is_the_one_judged(self):
        # A mean would let a well-predicted draw column hide a badly-predicted home
        # column, which is exactly the column a reader cares about.
        v = assess_eval_targets(health(200, brier=EVAL["brier_target"] + 0.05))
        self.assertFalse(v["brier"]["meets_target"])
        self.assertAlmostEqual(v["brier"]["actual"], EVAL["brier_target"] + 0.05)

    def test_one_missed_target_fails_the_whole_verdict(self):
        v = assess_eval_targets(health(200, ece=EVAL["calibration_error_target"] * 5))
        self.assertFalse(v["calibration_error"]["meets_target"])
        self.assertTrue(v["log_loss"]["meets_target"])
        self.assertFalse(v["all_targets_met"])

    def test_a_metric_exactly_on_target_passes(self):
        # `<=`, not `<`: a target is a bar to reach, not one to beat.
        v = assess_eval_targets(health(200, log_loss=EVAL["log_loss_target"]))
        self.assertTrue(v["log_loss"]["meets_target"])


if __name__ == "__main__":
    unittest.main()
