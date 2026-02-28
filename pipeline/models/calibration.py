"""
Probability calibration using isotonic regression.
Ensures model probabilities are well-calibrated
(e.g., events predicted at 30% actually occur ~30% of the time).
"""
import logging
import pickle
from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.calibration import calibration_curve

from pipeline.config import DATA_PROCESSED

logger = logging.getLogger(__name__)


class ProbabilityCalibrator:
    """
    Isotonic regression calibrator for predicted probabilities.
    Fits separate calibrators for different markets.
    """

    def __init__(self):
        self.calibrators = {}  # market_name -> IsotonicRegression

    def fit(self, predictions: np.ndarray, actuals: np.ndarray, market: str = "1x2_home") -> None:
        """
        Fit isotonic regression for a specific market.

        Args:
            predictions: Model predicted probabilities
            actuals: Binary outcomes (1 if event occurred, 0 otherwise)
            market: Market identifier (e.g., "1x2_home", "over_2.5", "btts")
        """
        # Remove NaN
        mask = ~(np.isnan(predictions) | np.isnan(actuals))
        preds = predictions[mask]
        acts = actuals[mask]

        if len(preds) < 20:
            logger.warning(f"Insufficient data for calibration ({len(preds)} samples). Skipping {market}.")
            return

        calibrator = IsotonicRegression(y_min=0.001, y_max=0.999, out_of_bounds="clip")
        calibrator.fit(preds, acts)
        self.calibrators[market] = calibrator

        # Log calibration quality
        calibrated = calibrator.predict(preds)
        before_ece = self._expected_calibration_error(preds, acts)
        after_ece = self._expected_calibration_error(calibrated, acts)
        logger.info(f"Calibration [{market}]: ECE {before_ece:.4f} -> {after_ece:.4f}")

    def calibrate(self, probability: float, market: str = "1x2_home") -> float:
        """
        Calibrate a single probability.
        Returns original probability if no calibrator fitted for this market.
        """
        calibrator = self.calibrators.get(market)
        if calibrator is None:
            return probability
        return float(calibrator.predict([probability])[0])

    def calibrate_array(self, probabilities: np.ndarray, market: str = "1x2_home") -> np.ndarray:
        """Calibrate an array of probabilities."""
        calibrator = self.calibrators.get(market)
        if calibrator is None:
            return probabilities
        return calibrator.predict(probabilities)

    def calibrate_match(self, match_pred: Dict) -> Dict:
        """
        Calibrate all probabilities in a match prediction dict.
        """
        pred = match_pred.copy()

        # Calibrate 1X2
        if "probabilities" in pred and "1x2" in pred["probabilities"]:
            p = pred["probabilities"]["1x2"]
            p["home"] = self.calibrate(p["home"], "1x2_home")
            p["draw"] = self.calibrate(p["draw"], "1x2_draw")
            p["away"] = self.calibrate(p["away"], "1x2_away")
            # Re-normalize
            total = p["home"] + p["draw"] + p["away"]
            if total > 0:
                p["home"] /= total
                p["draw"] /= total
                p["away"] /= total

        # Calibrate O/U 2.5
        if "probabilities" in pred and "over_under" in pred["probabilities"]:
            ou = pred["probabilities"]["over_under"]
            if "2.5" in ou:
                ou["2.5"]["over"] = self.calibrate(ou["2.5"]["over"], "over_2.5")
                ou["2.5"]["under"] = 1 - ou["2.5"]["over"]

        # Calibrate BTTS
        if "probabilities" in pred and "btts" in pred["probabilities"]:
            pred["probabilities"]["btts"] = self.calibrate(pred["probabilities"]["btts"], "btts")

        return pred

    def fit_from_historical(self, historical_predictions: list, actual_results: pd.DataFrame) -> None:
        """
        Fit calibrators from historical prediction-result pairs.

        Args:
            historical_predictions: List of prediction dicts
            actual_results: DataFrame with match_id, FTR, FTHG, FTAG, etc.
        """
        import pandas as pd

        # Collect (predicted, actual) pairs for each market
        data = {"1x2_home": ([], []), "1x2_draw": ([], []), "1x2_away": ([], []),
                "over_2.5": ([], []), "btts": ([], [])}

        for pred in historical_predictions:
            match_id = pred.get("match_id", "")
            result = actual_results[actual_results["match_id"] == match_id]
            if len(result) == 0:
                continue
            result = result.iloc[0]

            probs = pred.get("probabilities", {})

            # 1X2
            if "1x2" in probs:
                data["1x2_home"][0].append(probs["1x2"]["home"])
                data["1x2_home"][1].append(1 if result["FTR"] == "H" else 0)
                data["1x2_draw"][0].append(probs["1x2"]["draw"])
                data["1x2_draw"][1].append(1 if result["FTR"] == "D" else 0)
                data["1x2_away"][0].append(probs["1x2"]["away"])
                data["1x2_away"][1].append(1 if result["FTR"] == "A" else 0)

            # O/U 2.5
            if "over_under" in probs and "2.5" in probs["over_under"]:
                data["over_2.5"][0].append(probs["over_under"]["2.5"]["over"])
                data["over_2.5"][1].append(1 if result["FTHG"] + result["FTAG"] > 2.5 else 0)

            # BTTS
            if "btts" in probs:
                data["btts"][0].append(probs["btts"])
                data["btts"][1].append(1 if result["FTHG"] > 0 and result["FTAG"] > 0 else 0)

        for market, (preds, acts) in data.items():
            if len(preds) >= 20:
                self.fit(np.array(preds), np.array(acts), market)

    @staticmethod
    def _expected_calibration_error(predictions: np.ndarray, actuals: np.ndarray, n_bins: int = 10) -> float:
        """Compute Expected Calibration Error (ECE)."""
        bin_edges = np.linspace(0, 1, n_bins + 1)
        ece = 0
        for i in range(n_bins):
            mask = (predictions >= bin_edges[i]) & (predictions < bin_edges[i + 1])
            if mask.sum() > 0:
                bin_acc = actuals[mask].mean()
                bin_conf = predictions[mask].mean()
                ece += mask.sum() * abs(bin_acc - bin_conf)
        return ece / len(predictions)

    def get_calibration_curve(self, predictions: np.ndarray, actuals: np.ndarray, n_bins: int = 10) -> Dict:
        """Compute calibration curve for plotting."""
        prob_true, prob_pred = calibration_curve(actuals, predictions, n_bins=n_bins, strategy="uniform")
        return {
            "predicted": prob_pred.tolist(),
            "actual": prob_true.tolist(),
            "ece": self._expected_calibration_error(predictions, actuals, n_bins),
        }

    def save(self, path: Optional[Path] = None):
        """Save calibrators to disk."""
        if path is None:
            path = DATA_PROCESSED / "models" / "calibrators.pkl"
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        pickle.dump(self.calibrators, open(path, "wb"))

    def load(self, path: Optional[Path] = None):
        """Load calibrators from disk."""
        if path is None:
            path = DATA_PROCESSED / "models" / "calibrators.pkl"
        if Path(path).exists():
            self.calibrators = pickle.load(open(path, "rb"))
