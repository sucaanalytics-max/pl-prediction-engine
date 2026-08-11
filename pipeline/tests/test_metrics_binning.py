"""
Regression tests for calibration binning and module importability.

Two defects motivated these. Both were silent, and both flattered the model.

1. ECE bins were half-open on both sides, so ``p == 1.0`` fell in no bin. The
   numerator summed only over binned rows while the denominator counted every
   row, biasing ECE *downward* — and the dropped rows were the most confident
   predictions, whose miscalibration costs the most. The calibration curve
   dropped them entirely.

2. ``calibration.py`` annotated a parameter ``pd.DataFrame`` without importing
   pandas at module scope. Python 3.13 and earlier evaluate annotations eagerly,
   so importing the module raised ``NameError`` on CI's 3.11 while working on a
   3.14 developer machine.
"""
import importlib.util
import unittest
from pathlib import Path

import numpy as np

from pipeline.validation.metrics import (
    calibration_curve_data,
    expected_calibration_error,
)

CALIBRATION_SOURCE = (
    Path(__file__).resolve().parents[1] / "models" / "calibration.py"
)


class ExpectedCalibrationErrorTests(unittest.TestCase):
    def test_ece_counts_probability_of_exactly_one(self):
        """A confident, wrong prediction must not be silently discarded."""
        predictions = np.array([1.0, 1.0])
        actuals = np.array([0.0, 0.0])
        # Predicted 1.0, happened never: maximally miscalibrated.
        self.assertAlmostEqual(
            expected_calibration_error(predictions, actuals), 1.0
        )

    def test_ece_counts_probability_of_exactly_zero(self):
        predictions = np.array([0.0, 0.0])
        actuals = np.array([1.0, 1.0])
        self.assertAlmostEqual(
            expected_calibration_error(predictions, actuals), 1.0
        )

    def test_confident_wrong_predictions_are_not_diluted(self):
        """
        Half the rows at p=1.0 and wrong, half at p=0.0 and right.

        Under the old left-half-open binning the p=1.0 rows vanished from the
        numerator but stayed in the denominator, halving the reported error.
        """
        predictions = np.array([1.0, 1.0, 0.0, 0.0])
        actuals = np.array([0.0, 0.0, 0.0, 0.0])
        self.assertAlmostEqual(
            expected_calibration_error(predictions, actuals), 0.5
        )

    def test_perfect_calibration_scores_zero(self):
        rng = np.random.default_rng(7)
        predictions = np.full(1000, 0.25)
        actuals = (rng.random(1000) < 0.25).astype(float)
        self.assertLess(expected_calibration_error(predictions, actuals), 0.05)

    def test_every_prediction_lands_in_exactly_one_bin(self):
        """The numerator and denominator must not be able to diverge again."""
        predictions = np.linspace(0.0, 1.0, 101)
        actuals = (predictions > 0.5).astype(float)
        # Raises an AssertionError from inside if any row is unbinned.
        expected_calibration_error(predictions, actuals)

    def test_empty_input_is_zero_not_a_crash(self):
        self.assertEqual(
            expected_calibration_error(np.array([]), np.array([])), 0.0
        )

    def test_out_of_range_probabilities_raise(self):
        """Silently dropping them would understate error, as before."""
        with self.assertRaises(ValueError):
            expected_calibration_error(np.array([1.5]), np.array([1.0]))
        with self.assertRaises(ValueError):
            expected_calibration_error(np.array([-0.2]), np.array([0.0]))


class CalibrationCurveTests(unittest.TestCase):
    def test_calibration_curve_counts_probability_of_exactly_one(self):
        predictions = np.array([1.0, 1.0, 1.0])
        actuals = np.array([1.0, 0.0, 1.0])
        curve = calibration_curve_data(predictions, actuals)
        self.assertEqual(len(curve["bins"]), 1)
        self.assertEqual(curve["bins"][0]["count"], 3)
        self.assertAlmostEqual(curve["bins"][0]["predicted_mean"], 1.0)

    def test_curve_counts_sum_to_the_sample_size(self):
        rng = np.random.default_rng(11)
        predictions = np.clip(rng.random(500), 0.0, 1.0)
        # Force some exact-boundary values.
        predictions[:20] = 1.0
        predictions[20:40] = 0.0
        actuals = (rng.random(500) < predictions).astype(float)
        curve = calibration_curve_data(predictions, actuals)
        self.assertEqual(sum(b["count"] for b in curve["bins"]), 500)

    def test_curve_reports_the_same_ece_as_the_scalar_function(self):
        predictions = np.array([0.1, 0.4, 0.9, 1.0])
        actuals = np.array([0.0, 1.0, 1.0, 0.0])
        curve = calibration_curve_data(predictions, actuals)
        self.assertAlmostEqual(
            curve["ece"], expected_calibration_error(predictions, actuals)
        )


class CalibrationModuleImportTests(unittest.TestCase):
    """
    The rest of the suite deliberately never imports ``pipeline.models.*`` so it
    runs without the heavy ML dependencies. The source-level check below honours
    that and is the actual regression guard; the import checks add end-to-end
    confirmation wherever scikit-learn is installed, which includes CI — the
    Python 3.11 environment where the bug actually bit.
    """

    def test_future_annotations_import_is_present(self):
        """
        Guards the fix without importing anything.

        ``fit_from_historical`` annotates ``pd.DataFrame`` while pandas is
        imported only inside the function body, so eager annotation evaluation
        (Python <= 3.13, including CI's 3.11) raises NameError at import time.
        """
        source = CALIBRATION_SOURCE.read_text()
        self.assertIn("from __future__ import annotations", source)

        future_line = next(
            i
            for i, line in enumerate(source.splitlines())
            if line.strip() == "from __future__ import annotations"
        )
        other_imports = [
            i
            for i, line in enumerate(source.splitlines())
            if line.startswith(("import ", "from "))
            and "__future__" not in line
        ]
        # A __future__ import must precede every other import or it is a
        # SyntaxError, so this also pins it in a valid position.
        self.assertTrue(all(future_line < i for i in other_imports))

    @unittest.skipUnless(
        importlib.util.find_spec("sklearn"), "scikit-learn not installed"
    )
    def test_module_imports(self):
        import pipeline.models.calibration as calibration

        self.assertTrue(hasattr(calibration, "ProbabilityCalibrator"))

    @unittest.skipUnless(
        importlib.util.find_spec("sklearn"), "scikit-learn not installed"
    )
    def test_annotations_are_deferred_so_py311_can_import(self):
        """A string annotation proves the ``__future__`` import is in effect."""
        from pipeline.models.calibration import ProbabilityCalibrator

        annotations = ProbabilityCalibrator.fit_from_historical.__annotations__
        self.assertEqual(annotations["actual_results"], "pd.DataFrame")


if __name__ == "__main__":
    unittest.main()
