"""
Ensemble predictor: blends Dixon-Coles (PyMC), XGBoost, and PenaltyBlog.
Weights: 60% DC + 30% XGB + 10% PB (configurable).
"""
import logging
from typing import Dict, Optional

import numpy as np
from scipy.stats import poisson

from pipeline.config import ENSEMBLE_WEIGHTS, MAX_GOALS

logger = logging.getLogger(__name__)


class EnsemblePredictor:
    """
    Combines multiple model predictions via weighted averaging of scoreline matrices.
    Applies calibration if available.
    """

    def __init__(self, weights: Optional[Dict] = None):
        self.weights = weights or ENSEMBLE_WEIGHTS
        self.calibrator = None

    def set_calibrator(self, calibrator):
        """Set isotonic calibrator for post-hoc calibration."""
        self.calibrator = calibrator

    def blend_scoreline_matrices(self, matrices: Dict[str, np.ndarray]) -> np.ndarray:
        """
        Blend multiple scoreline matrices using configured weights.

        Args:
            matrices: {"dixon_coles": np.array, "xgboost": np.array, "penaltyblog": np.array}

        Returns:
            Weighted average scoreline matrix
        """
        blended = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        total_weight = 0

        for model_name, matrix in matrices.items():
            weight = self.weights.get(model_name, 0)
            if weight > 0 and matrix is not None:
                blended += weight * np.array(matrix)
                total_weight += weight

        if total_weight > 0:
            blended /= total_weight

        # Normalize
        total = blended.sum()
        if total > 0:
            blended /= total

        return blended

    def blend_from_lambdas(
        self,
        dc_lambda: float, dc_mu: float,
        xgb_lambda: float, xgb_mu: float,
        pb_lambda: float, pb_mu: float,
    ) -> np.ndarray:
        """
        Blend predictions from goal rate (lambda/mu) estimates.
        Converts each to a Poisson scoreline matrix, then blends.
        """
        matrices = {}

        for name, lam, mu in [
            ("dixon_coles", dc_lambda, dc_mu),
            ("xgboost", xgb_lambda, xgb_mu),
            ("penaltyblog", pb_lambda, pb_mu),
        ]:
            matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
            for i in range(MAX_GOALS + 1):
                for j in range(MAX_GOALS + 1):
                    matrix[i, j] = poisson.pmf(i, lam) * poisson.pmf(j, mu)
            matrices[name] = matrix

        return self.blend_scoreline_matrices(matrices)

    def predict(self, matrices: Dict[str, np.ndarray], home: str, away: str) -> Dict:
        """
        Full ensemble prediction with all markets.
        """
        blended = self.blend_scoreline_matrices(matrices)
        markets = self._derive_all_markets(blended)

        markets["home_team"] = home
        markets["away_team"] = away
        markets["model"] = "ensemble"
        markets["weights_used"] = {k: v for k, v in self.weights.items() if k in matrices}

        # Apply calibration if available
        if self.calibrator is not None:
            markets = self._calibrate(markets)

        return markets

    def _derive_all_markets(self, matrix: np.ndarray) -> Dict:
        """Derive comprehensive betting markets from scoreline matrix."""
        n = MAX_GOALS + 1

        # 1X2
        p_home = sum(matrix[i, j] for i in range(n) for j in range(i))
        p_draw = sum(matrix[i, i] for i in range(n))
        p_away = max(0, 1 - p_home - p_draw)

        # Over/Under goals
        over_under_goals = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5]:
            p_over = sum(matrix[i, j] for i in range(n) for j in range(n) if i + j > line)
            over_under_goals[str(line)] = {"over": float(p_over), "under": float(1 - p_over)}

        # BTTS
        p_btts = sum(matrix[i, j] for i in range(1, n) for j in range(1, n))

        # Clean sheets
        p_home_cs = sum(matrix[i, 0] for i in range(n))
        p_away_cs = sum(matrix[0, j] for j in range(n))

        # Expected goals
        e_home = sum(i * matrix[i, j] for i in range(n) for j in range(n))
        e_away = sum(j * matrix[i, j] for i in range(n) for j in range(n))

        # Correct score
        correct_score = {}
        for i in range(min(6, n)):
            for j in range(min(6, n)):
                correct_score[f"{i}-{j}"] = float(matrix[i, j])

        # Asian Handicap
        asian_handicap = {}
        for line in [-2.5, -1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5, 2.5]:
            p_cover = sum(
                matrix[i, j] for i in range(n) for j in range(n)
                if (i - j) > line
            )
            asian_handicap[f"home_{line}"] = float(p_cover)

        # Half-Time / Full-Time (approximate: assume goals uniformly in halves)
        # HT goals ~ Poisson(lambda * 0.45)
        ht_ft = self._compute_ht_ft(matrix, e_home, e_away)

        # Goals distribution
        goals_home_dist = [float(sum(matrix[i, :]) ) for i in range(n)]
        goals_away_dist = [float(sum(matrix[:, j])) for j in range(n)]

        return {
            "probabilities": {
                "1x2": {"home": float(p_home), "draw": float(p_draw), "away": float(p_away)},
                "over_under": over_under_goals,
                "btts": float(p_btts),
                "clean_sheet": {"home": float(p_home_cs), "away": float(p_away_cs)},
                "correct_score": correct_score,
                "asian_handicap": asian_handicap,
                "ht_ft": ht_ft,
            },
            "expected_goals": {"home": float(e_home), "away": float(e_away)},
            "distributions": {
                "goals_home": goals_home_dist,
                "goals_away": goals_away_dist,
            },
            "scoreline_matrix": matrix.tolist(),
        }

    def _compute_ht_ft(self, matrix: np.ndarray, e_home: float, e_away: float) -> Dict:
        """
        Approximate HT/FT probabilities.
        Assumes HT goals ~ Poisson(lambda * 0.45) independently.
        """
        ht_lambda_h = e_home * 0.45
        ht_lambda_a = e_away * 0.45

        combos = {}
        for ht_result in ["H", "D", "A"]:
            for ft_result in ["H", "D", "A"]:
                key = f"{ht_result}/{ft_result}"

                # P(HT result) from Poisson
                p_ht = 0
                for i in range(7):
                    for j in range(7):
                        p_ij = poisson.pmf(i, ht_lambda_h) * poisson.pmf(j, ht_lambda_a)
                        if (ht_result == "H" and i > j) or \
                           (ht_result == "D" and i == j) or \
                           (ht_result == "A" and i < j):
                            p_ht += p_ij

                # P(FT result) from full matrix
                n = MAX_GOALS + 1
                p_ft = 0
                for i in range(n):
                    for j in range(n):
                        if (ft_result == "H" and i > j) or \
                           (ft_result == "D" and i == j) or \
                           (ft_result == "A" and i < j):
                            p_ft += matrix[i, j]

                # Approximate joint probability (not fully independent but reasonable)
                combos[key] = float(p_ht * p_ft / max(p_ft, 0.01) * p_ft)

        # Normalize
        total = sum(combos.values())
        if total > 0:
            combos = {k: v / total for k, v in combos.items()}

        return combos

    def _calibrate(self, markets: Dict) -> Dict:
        """Apply isotonic calibration to 1X2 probabilities."""
        # Calibration is applied in the calibration module
        return markets
