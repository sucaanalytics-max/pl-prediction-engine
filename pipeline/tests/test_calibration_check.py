"""
Tests for the distribution calibration check.

The check exists because the distribution is our claimed edge over mean-only
models, and an untested claimed edge is a liability. These tests protect the
check itself — particularly its handling of ties, since FPL points are integers
heavily massed at zero and a naive coverage number can be made to say anything.
"""
import unittest

import numpy as np

from pipeline.learning.calibration_check import check_calibration, summarise


def _row(q10=0.0, q50=2.0, q90=6.0, q99=12.0, **tails):
    row = {"q10": q10, "q50": q50, "q90": q90, "q99": q99,
           "p_ge_2": 0.5, "p_ge_5": 0.2, "p_ge_10": 0.05, "p_ge_15": 0.01}
    row.update(tails)
    return row


class CoverageTests(unittest.TestCase):
    def test_a_perfectly_calibrated_forecast_reports_no_miss(self):
        rng = np.random.default_rng(3)
        actual = rng.integers(0, 13, 4000).astype(float)
        forecasts = [
            _row(q10=float(np.quantile(actual, 0.10)),
                 q50=float(np.quantile(actual, 0.50)),
                 q90=float(np.quantile(actual, 0.90)),
                 q99=float(np.quantile(actual, 0.99)))
            for _ in actual
        ]
        report = check_calibration(forecasts, actual)
        for name, row in report.coverage.items():
            with self.subTest(quantile=name):
                self.assertLess(row["miss"], 0.02, row)

    def test_ties_are_reported_as_an_interval_not_a_single_number(self):
        """
        Every actual is 0 and q10 is 0. Closed coverage is 1.0, open is 0.0.
        A single number would claim either perfect or catastrophic calibration;
        the interval says honestly that ties make it indeterminate.
        """
        actual = np.zeros(500)
        report = check_calibration([_row(q10=0.0) for _ in actual], actual)
        row = report.coverage["q10"]
        self.assertEqual(row["closed"], 1.0)
        self.assertEqual(row["open"], 0.0)
        self.assertEqual(row["miss"], 0.0)

    def test_a_quantile_that_is_too_low_is_flagged(self):
        actual = np.full(500, 10.0)
        report = check_calibration([_row(q90=3.0) for _ in actual], actual)
        self.assertGreater(report.coverage["q90"]["miss"], 0.5)
        self.assertFalse(report.coverage["q90"]["calibrated"])


class TailTests(unittest.TestCase):
    def test_tail_bias_is_measured_against_realised_frequency(self):
        actual = np.array([0.0] * 90 + [12.0] * 10)   # 10% score 10+
        report = check_calibration([_row(p_ge_10=0.05) for _ in actual], actual)
        tail = report.tails["p_ge_10"]
        self.assertAlmostEqual(tail["actual"], 0.10)
        self.assertAlmostEqual(tail["predicted"], 0.05)
        self.assertAlmostEqual(tail["bias"], -0.05)

    def test_worst_ratio_uses_a_ratio_not_a_difference(self):
        """0.02 against 0.04 is a 2x error that a difference would trivialise."""
        actual = np.array([0.0] * 96 + [12.0] * 4)
        report = check_calibration([_row(p_ge_10=0.02) for _ in actual], actual)
        self.assertGreater(report.worst_tail_ratio(), 1.9)

    def test_empty_input_is_safe(self):
        report = check_calibration([], [])
        self.assertEqual(report.n, 0)
        self.assertEqual(report.worst_tail_ratio(), 1.0)

    def test_summary_renders(self):
        actual = np.array([0.0, 2.0, 7.0])
        self.assertIn("calibration over 3", summarise(check_calibration(
            [_row() for _ in actual], actual)))


if __name__ == "__main__":
    unittest.main()
