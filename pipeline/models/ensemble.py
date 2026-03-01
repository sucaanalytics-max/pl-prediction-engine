"""
Ensemble predictor: blends Dixon-Coles (PyMC), XGBoost, and PenaltyBlog.

Phase 3: Stacking meta-learner replaces hardcoded 60/30/10 weights.
Uses logistic regression on out-of-fold (OOF) predictions to learn
optimal blending weights from historical data.

Fallback to configurable static weights when insufficient training data.
"""
import logging
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.stats import poisson

from pipeline.config import ENSEMBLE_WEIGHTS, MAX_GOALS

logger = logging.getLogger(__name__)


class StackingMetaLearner:
    """
    Logistic regression meta-learner that learns optimal model blending weights
    from out-of-fold predictions.

    Instead of fixed 60/30/10 weights, learns P(home|model_probs), P(draw|...),
    P(away|...) from historical model outputs vs actual results.
    """

    def __init__(self):
        self.model = None  # sklearn LogisticRegression
        self.is_fitted = False
        self.learned_weights = {}  # Model name -> approximate weight
        self.n_training_samples = 0

    def fit(
        self,
        oof_predictions: Dict[str, np.ndarray],
        actuals: np.ndarray,
    ) -> Dict:
        """
        Fit stacking meta-learner on out-of-fold predictions.

        Args:
            oof_predictions: {model_name: np.ndarray of shape (n_matches, 3)}
                Each row = [P(home), P(draw), P(away)] from that model.
                Models: "dixon_coles", "xgboost", "penaltyblog"
            actuals: np.ndarray of shape (n_matches,) with values 0=home, 1=draw, 2=away

        Returns:
            Dict with training metrics and learned weights.
        """
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler

        # Build feature matrix: concatenate all model probabilities
        model_names = sorted(oof_predictions.keys())
        X_parts = [oof_predictions[name] for name in model_names]
        X = np.hstack(X_parts)  # shape: (n_matches, 3 * n_models)
        y = actuals

        # Filter out NaN rows
        valid_mask = ~np.isnan(X).any(axis=1) & ~np.isnan(y)
        X = X[valid_mask]
        y = y[valid_mask]

        if len(X) < 100:
            logger.warning(
                f"Insufficient OOF samples ({len(X)}) for stacking. "
                f"Need ≥100. Falling back to static weights."
            )
            return {"status": "insufficient_data", "n_samples": len(X)}

        self.n_training_samples = len(X)

        # Fit logistic regression (multinomial for 3-class 1X2)
        self.model = LogisticRegression(
            C=1.0,
            solver="lbfgs",
            multi_class="multinomial",
            max_iter=1000,
            random_state=42,
        )
        self.model.fit(X, y)
        self.is_fitted = True

        # Extract approximate model weights from coefficients
        # Coefficients shape: (3 classes, 3 * n_models)
        coefs = np.abs(self.model.coef_)  # (3, 9)
        n_models = len(model_names)
        for i, name in enumerate(model_names):
            # Sum absolute coefficients for this model's 3 probability features
            model_coef_sum = coefs[:, i*3:(i+1)*3].sum()
            self.learned_weights[name] = float(model_coef_sum)

        # Normalize to sum to 1
        total = sum(self.learned_weights.values())
        if total > 0:
            self.learned_weights = {k: v / total for k, v in self.learned_weights.items()}

        # Compute training accuracy
        y_pred = self.model.predict(X)
        accuracy = float(np.mean(y_pred == y))

        # Compute log-loss
        from sklearn.metrics import log_loss
        y_proba = self.model.predict_proba(X)
        logloss = float(log_loss(y, y_proba))

        logger.info(
            f"Stacking meta-learner: {len(X)} samples, accuracy={accuracy:.3f}, "
            f"log_loss={logloss:.4f}, weights={self.learned_weights}"
        )

        return {
            "status": "fitted",
            "n_samples": len(X),
            "accuracy": accuracy,
            "log_loss": logloss,
            "learned_weights": self.learned_weights,
            "model_names": model_names,
        }

    def predict_proba(self, model_probs: Dict[str, np.ndarray]) -> np.ndarray:
        """
        Predict blended 1X2 probabilities using the meta-learner.

        Args:
            model_probs: {model_name: np.ndarray of shape (1, 3) or (3,)}

        Returns:
            np.ndarray of shape (3,): [P(home), P(draw), P(away)]
        """
        if not self.is_fitted:
            raise RuntimeError("Meta-learner not fitted")

        model_names = sorted(model_probs.keys())
        X_parts = []
        for name in model_names:
            p = model_probs[name]
            if p.ndim == 1:
                p = p.reshape(1, -1)
            X_parts.append(p)

        X = np.hstack(X_parts)
        proba = self.model.predict_proba(X)[0]

        # Ensure class ordering is [home=0, draw=1, away=2]
        return proba

    def model_disagreement(self, model_probs: Dict[str, np.ndarray]) -> float:
        """
        Compute model disagreement metric: std of model predictions.
        Higher disagreement → lower confidence.
        """
        probs_list = [np.array(p).flatten()[:3] for p in model_probs.values()]
        if len(probs_list) < 2:
            return 0.0
        stacked = np.array(probs_list)  # (n_models, 3)
        return float(stacked.std(axis=0).mean())


class EnsemblePredictor:
    """
    Combines multiple model predictions via weighted averaging of scoreline matrices.
    Applies calibration if available.

    Phase 3: optionally uses stacking meta-learner for 1X2 probabilities
    while still using weighted scoreline matrices for other markets.
    """

    def __init__(self, weights: Optional[Dict] = None):
        self.weights = weights or ENSEMBLE_WEIGHTS
        self.calibrator = None
        self.meta_learner = None  # StackingMetaLearner (optional)

    def set_calibrator(self, calibrator):
        """Set isotonic calibrator for post-hoc calibration."""
        self.calibrator = calibrator

    def set_meta_learner(self, meta_learner: StackingMetaLearner):
        """Set stacking meta-learner for learned blending weights."""
        self.meta_learner = meta_learner
        if meta_learner.is_fitted:
            logger.info(
                f"Using stacking meta-learner (n={meta_learner.n_training_samples}) "
                f"weights: {meta_learner.learned_weights}"
            )

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

    def predict(
        self,
        matrices: Dict[str, np.ndarray],
        home: str,
        away: str,
        model_1x2_probs: Optional[Dict[str, np.ndarray]] = None,
    ) -> Dict:
        """
        Full ensemble prediction with all markets.

        Args:
            matrices: {model_name: scoreline_matrix} for weighted blending
            home: Home team name
            away: Away team name
            model_1x2_probs: Optional {model_name: [P(H), P(D), P(A)]} for
                stacking meta-learner. If provided and meta-learner is fitted,
                1X2 probabilities come from the meta-learner instead of the
                blended scoreline matrix.
        """
        blended = self.blend_scoreline_matrices(matrices)
        markets = self._derive_all_markets(blended)

        # Override 1X2 with stacking meta-learner if available
        if (self.meta_learner is not None
                and self.meta_learner.is_fitted
                and model_1x2_probs is not None):
            try:
                stacked_proba = self.meta_learner.predict_proba(model_1x2_probs)
                markets["probabilities"]["1x2"] = {
                    "home": float(stacked_proba[0]),
                    "draw": float(stacked_proba[1]),
                    "away": float(stacked_proba[2]),
                }
                markets["model"] = "ensemble_stacked"
                markets["model_disagreement"] = self.meta_learner.model_disagreement(model_1x2_probs)
            except Exception as e:
                logger.warning(f"Meta-learner prediction failed, using blended: {e}")

        markets["home_team"] = home
        markets["away_team"] = away
        if "model" not in markets:
            markets["model"] = "ensemble"
        markets["weights_used"] = (
            self.meta_learner.learned_weights
            if self.meta_learner and self.meta_learner.is_fitted
            else {k: v for k, v in self.weights.items() if k in matrices}
        )

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
                "btts": {"yes": float(p_btts), "no": float(1 - p_btts)},
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
        Compute HT/FT probabilities via separate Poisson simulation.

        The previous analytical formula (p_ht * p_ft / p_ft * p_ft) was incorrect
        — it reduced to p_ht * p_ft (product of marginals), which ignores the
        conditional relationship between half-time and full-time results.

        Now simulates HT and FT goals jointly: HT goals ~ Poisson(λ*0.45),
        second-half goals ~ Poisson(λ*0.55), FT = HT + 2H. This correctly
        captures P(HT=X, FT=Y) as a joint distribution.

        NOTE: The Monte Carlo simulator (montecarlo.py derive_all_markets)
        already computes correct HT/FT from simulated match samples.
        When MC output is available, prefer that over this approximation.
        """
        n_sims = 20000
        ht_lambda_h = e_home * 0.45
        ht_lambda_a = e_away * 0.45
        sh_lambda_h = e_home * 0.55  # second half
        sh_lambda_a = e_away * 0.55

        # Simulate HT goals
        ht_h = np.random.poisson(ht_lambda_h, n_sims)
        ht_a = np.random.poisson(ht_lambda_a, n_sims)

        # Simulate 2nd-half goals
        sh_h = np.random.poisson(sh_lambda_h, n_sims)
        sh_a = np.random.poisson(sh_lambda_a, n_sims)

        # Full-time = HT + 2H
        ft_h = ht_h + sh_h
        ft_a = ht_a + sh_a

        def result_label(g_home, g_away):
            """Vectorized result: H/D/A"""
            return np.where(g_home > g_away, "H", np.where(g_home == g_away, "D", "A"))

        ht_results = result_label(ht_h, ht_a)
        ft_results = result_label(ft_h, ft_a)

        combos = {}
        for ht_r in ["H", "D", "A"]:
            for ft_r in ["H", "D", "A"]:
                key = f"{ht_r}/{ft_r}"
                combos[key] = float(np.mean((ht_results == ht_r) & (ft_results == ft_r)))

        return combos

    def _calibrate(self, markets: Dict) -> Dict:
        """Apply isotonic calibration to 1X2 probabilities."""
        # Calibration is applied in the calibration module
        return markets


def build_oof_predictions(
    matches: "pd.DataFrame",
    seasons: List[str],
    model_builders: Dict[str, callable],
) -> Tuple[Dict[str, np.ndarray], np.ndarray]:
    """
    Build out-of-fold (OOF) predictions for stacking meta-learner.

    For each season, trains models on all OTHER seasons and generates
    predictions on the held-out season. This prevents data leakage
    while providing training data for the meta-learner.

    Args:
        matches: Full match DataFrame with 'season', 'HomeTeam', 'AwayTeam',
                 'FTHG', 'FTAG', 'FTR' columns
        seasons: List of season labels (e.g. ["2021-22", "2022-23", "2023-24"])
        model_builders: {model_name: callable(train_df) -> predictor}
            Each callable trains a model and returns an object with
            .predict_scoreline(home, away) -> np.ndarray method

    Returns:
        (oof_predictions, actuals)
        oof_predictions: {model_name: np.ndarray of shape (n_matches, 3)}
        actuals: np.ndarray with 0=H, 1=D, 2=A

    Example usage:
        def build_dc(train_df):
            dc = BayesianDixonColes()
            dc.fit(train_df)
            return dc

        oof, actuals = build_oof_predictions(
            all_matches, seasons,
            {"dixon_coles": build_dc, "xgboost": build_xgb}
        )
        meta = StackingMetaLearner()
        meta.fit(oof, actuals)
    """
    import pandas as pd

    oof_preds = {name: [] for name in model_builders}
    all_actuals = []

    for held_out_season in seasons:
        logger.info(f"OOF fold: holding out {held_out_season}")
        train = matches[matches["season"] != held_out_season]
        val = matches[matches["season"] == held_out_season]

        if len(val) == 0:
            continue

        # Train each model on non-held-out data
        trained_models = {}
        for name, builder in model_builders.items():
            try:
                trained_models[name] = builder(train)
            except Exception as e:
                logger.warning(f"Failed to train {name} for fold {held_out_season}: {e}")

        # Generate predictions on held-out season
        for _, match in val.iterrows():
            home = match["HomeTeam"]
            away = match["AwayTeam"]
            ftr = match.get("FTR", "")

            # Convert FTR to numeric: H=0, D=1, A=2
            if ftr == "H":
                actual = 0
            elif ftr == "D":
                actual = 1
            elif ftr == "A":
                actual = 2
            else:
                continue

            all_actuals.append(actual)

            for name, model in trained_models.items():
                try:
                    matrix = model.predict_scoreline(home, away)
                    n = matrix.shape[0]
                    p_home = sum(matrix[i, j] for i in range(n) for j in range(i))
                    p_draw = sum(matrix[i, i] for i in range(n))
                    p_away = max(0, 1 - p_home - p_draw)
                    oof_preds[name].append([p_home, p_draw, p_away])
                except Exception:
                    # Unknown team in this fold — use uniform
                    oof_preds[name].append([1/3, 1/3, 1/3])

    # Convert to numpy arrays
    actuals_arr = np.array(all_actuals)
    oof_arrays = {name: np.array(preds) for name, preds in oof_preds.items()}

    logger.info(f"OOF predictions: {len(all_actuals)} matches, {len(model_builders)} models")
    return oof_arrays, actuals_arr
