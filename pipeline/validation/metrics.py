"""
Model evaluation metrics: Brier score, log loss, calibration error, RPS.
"""
import logging
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def brier_score(predictions: np.ndarray, actuals: np.ndarray) -> float:
    """
    Brier Score: mean squared error between predicted probabilities and outcomes.
    Lower is better. Benchmark: ~0.20 for bookmaker 1X2.
    """
    return float(np.mean((predictions - actuals) ** 2))


def log_loss(predictions: np.ndarray, actuals: np.ndarray, eps: float = 1e-15) -> float:
    """Cross-entropy loss. Lower is better."""
    preds = np.clip(predictions, eps, 1 - eps)
    return float(-np.mean(actuals * np.log(preds) + (1 - actuals) * np.log(1 - preds)))


def ranked_probability_score(pred_probs: List[float], actual_outcome: int) -> float:
    """
    RPS for ordered outcomes (e.g., H/D/A mapped to 0/1/2).
    Lower is better.
    """
    n = len(pred_probs)
    actual_cdf = [0.0] * n
    actual_cdf[actual_outcome] = 1.0
    for i in range(1, n):
        actual_cdf[i] += actual_cdf[i - 1]

    pred_cdf = [0.0] * n
    pred_cdf[0] = pred_probs[0]
    for i in range(1, n):
        pred_cdf[i] = pred_cdf[i - 1] + pred_probs[i]

    rps = sum((pred_cdf[i] - actual_cdf[i]) ** 2 for i in range(n)) / (n - 1)
    return float(rps)


def _bin_masks(predictions: np.ndarray, n_bins: int) -> List[np.ndarray]:
    """
    Half-open bins ``[edge_i, edge_i+1)``, except the final bin which is closed
    so a probability of exactly 1.0 is counted.

    Left half-open everywhere else would drop ``p == 1.0`` from every bin. That
    matters more than it sounds: the ECE numerator sums only over binned rows
    while the denominator counts all of them, so dropped rows bias ECE
    *downward* — and they are precisely the most confident predictions, the ones
    whose miscalibration is most costly. The same omission silently deleted
    those rows from the calibration curve.
    """
    predictions = np.asarray(predictions, dtype=float)
    if predictions.size and (
        predictions.min() < -1e-9 or predictions.max() > 1 + 1e-9
    ):
        raise ValueError(
            "predictions must be probabilities in [0, 1]; got range "
            f"[{predictions.min()}, {predictions.max()}]"
        )
    predictions = np.clip(predictions, 0.0, 1.0)

    edges = np.linspace(0, 1, n_bins + 1)
    masks = []
    for i in range(n_bins):
        lower = predictions >= edges[i]
        upper = (
            predictions <= edges[i + 1]
            if i == n_bins - 1
            else predictions < edges[i + 1]
        )
        masks.append(lower & upper)
    return masks


def expected_calibration_error(
    predictions: np.ndarray, actuals: np.ndarray, n_bins: int = 10
) -> float:
    """
    ECE: weighted average of |accuracy - confidence| per bin.
    Target: < 0.05.
    """
    predictions = np.asarray(predictions, dtype=float)
    actuals = np.asarray(actuals, dtype=float)
    if predictions.size == 0:
        return 0.0

    ece = 0.0
    binned = 0
    for mask in _bin_masks(predictions, n_bins):
        count = int(mask.sum())
        if count:
            ece += count * abs(actuals[mask].mean() - predictions[mask].mean())
            binned += count

    # Every row now lands in exactly one bin, so this equals len(predictions).
    # Asserting it keeps the numerator and denominator from silently diverging
    # again if the binning changes.
    if binned != len(predictions):
        raise AssertionError(
            f"binning dropped {len(predictions) - binned} of "
            f"{len(predictions)} predictions"
        )
    return float(ece / binned)


def calibration_curve_data(
    predictions: np.ndarray, actuals: np.ndarray, n_bins: int = 10
) -> Dict:
    """Generate calibration curve data for plotting."""
    predictions = np.asarray(predictions, dtype=float)
    actuals = np.asarray(actuals, dtype=float)

    edges = np.linspace(0, 1, n_bins + 1)
    bins = []
    for i, mask in enumerate(_bin_masks(predictions, n_bins)):
        if mask.sum() > 0:
            bins.append({
                "bin_center": float((edges[i] + edges[i + 1]) / 2),
                "predicted_mean": float(predictions[mask].mean()),
                "actual_mean": float(actuals[mask].mean()),
                "count": int(mask.sum()),
            })
    return {"bins": bins, "ece": expected_calibration_error(predictions, actuals, n_bins)}


def evaluate_predictions(
    predictions: List[Dict], actuals: pd.DataFrame
) -> Dict:
    """
    Comprehensive evaluation of model predictions against actual results.
    """
    # Collect data
    pred_home, pred_draw, pred_away = [], [], []
    act_home, act_draw, act_away = [], [], []
    pred_over25, act_over25 = [], []
    pred_btts, act_btts = [], []
    rps_scores = []

    for pred in predictions:
        match_id = pred.get("match_id", "")
        result = actuals[actuals["match_id"] == match_id]
        if len(result) == 0:
            continue
        r = result.iloc[0]

        probs = pred.get("probabilities", {})
        p1x2 = probs.get("1x2", {})

        ph = p1x2.get("home", 0.33)
        pd_ = p1x2.get("draw", 0.33)
        pa = p1x2.get("away", 0.33)

        pred_home.append(ph)
        pred_draw.append(pd_)
        pred_away.append(pa)

        ftr = r["FTR"]
        act_home.append(1 if ftr == "H" else 0)
        act_draw.append(1 if ftr == "D" else 0)
        act_away.append(1 if ftr == "A" else 0)

        # RPS
        outcome = {"H": 0, "D": 1, "A": 2}.get(ftr, 1)
        rps_scores.append(ranked_probability_score([ph, pd_, pa], outcome))

        # O/U 2.5
        ou = probs.get("over_under", {}).get("2.5", {})
        if "over" in ou:
            pred_over25.append(ou["over"])
            act_over25.append(1 if r["FTHG"] + r["FTAG"] > 2.5 else 0)

        # BTTS
        if "btts" in probs:
            btts_value = probs["btts"]
            if isinstance(btts_value, dict):
                btts_value = btts_value.get("yes")
            if btts_value is None:
                continue
            pred_btts.append(btts_value)
            act_btts.append(1 if r["FTHG"] > 0 and r["FTAG"] > 0 else 0)

    if not pred_home:
        return {"n_matches": 0}

    metrics = {
        "n_matches": len(pred_home),
        "1x2": {
            "brier_home": brier_score(np.array(pred_home), np.array(act_home)),
            "brier_draw": brier_score(np.array(pred_draw), np.array(act_draw)),
            "brier_away": brier_score(np.array(pred_away), np.array(act_away)),
            "log_loss_home": log_loss(np.array(pred_home), np.array(act_home)),
            "rps_mean": float(np.mean(rps_scores)) if rps_scores else None,
            "calibration": calibration_curve_data(np.array(pred_home), np.array(act_home)),
        },
    }

    if pred_over25:
        metrics["over_2.5"] = {
            "brier": brier_score(np.array(pred_over25), np.array(act_over25)),
            "calibration": calibration_curve_data(np.array(pred_over25), np.array(act_over25)),
        }

    if pred_btts:
        metrics["btts"] = {
            "brier": brier_score(np.array(pred_btts), np.array(act_btts)),
            "calibration": calibration_curve_data(np.array(pred_btts), np.array(act_btts)),
        }

    return metrics
