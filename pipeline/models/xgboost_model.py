"""
XGBoost model for predicting match-level expected goals.
Enhances Dixon-Coles with non-linear feature interactions.
Output: predicted xG (lambda/mu) fed into Poisson simulation.
"""
import logging
import pickle
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import XGBOOST, DATA_PROCESSED

logger = logging.getLogger(__name__)

# Features used by the model
FEATURE_COLS = [
    # Elo
    "home_elo", "away_elo", "elo_diff",
    # Rolling goals
    "home_ewm_goals_for_5", "home_ewm_goals_against_5",
    "away_ewm_goals_for_5", "away_ewm_goals_against_5",
    "home_ewm_goals_for_10", "home_ewm_goals_against_10",
    "away_ewm_goals_for_10", "away_ewm_goals_against_10",
    # Rolling shots
    "home_ewm_shots_for_5", "home_ewm_shots_against_5",
    "away_ewm_shots_for_5", "away_ewm_shots_against_5",
    # Rolling corners
    "home_ewm_corners_for_5", "home_ewm_corners_against_5",
    "away_ewm_corners_for_5", "away_ewm_corners_against_5",
    "home_ewm_corners_for_10", "home_ewm_corners_against_10",
    "away_ewm_corners_for_10", "away_ewm_corners_against_10",
    # Opponent corner concession
    "home_opponent_corners_conceded", "away_opponent_corners_conceded",
    # Rolling fouls & yellows
    "home_ewm_fouls_committed_5", "away_ewm_fouls_committed_5",
    "home_ewm_fouls_committed_10", "away_ewm_fouls_committed_10",
    "home_ewm_yellows_5", "away_ewm_yellows_5",
    "home_ewm_yellows_10", "away_ewm_yellows_10",
    # Referee features
    "referee_avg_yellows", "referee_avg_fouls", "referee_card_rate",
    # Derby indicator
    "is_derby",
    # Form
    "home_form_5", "away_form_5",
    # Rest
    "home_rest_days", "away_rest_days",
    # H2H
    "h2h_home_win_rate", "h2h_draw_rate",
    # FBref xG (if available)
    "home_season_xg", "away_season_xg",
    "home_season_xga", "away_season_xga",
    # FBref passing (if available)
    "home_pass_completion", "away_pass_completion",
    "home_progressive_passes", "away_progressive_passes",
    "home_key_passes", "away_key_passes",
    # Squad availability (if available)
    "home_squad_availability", "away_squad_availability",
]


class XGBoostGoalModel:
    """
    XGBoost regression model predicting home and away goals.
    """

    def __init__(self):
        self.model_home = None
        self.model_away = None
        self.feature_cols = []

    def fit(self, features: pd.DataFrame) -> Dict:
        """
        Train XGBoost models for home and away goals.

        Args:
            features: Feature-engineered match DataFrame

        Returns:
            Dict with training metrics
        """
        try:
            import xgboost as xgb
        except ImportError:
            logger.error("XGBoost not installed.")
            raise

        # Select available features
        self.feature_cols = [c for c in FEATURE_COLS if c in features.columns]
        logger.info(f"XGBoost using {len(self.feature_cols)} features: {self.feature_cols}")

        # Filter to matches with all features
        df = features.dropna(subset=["FTHG", "FTAG"]).copy()

        # Season-aware temporal split: train on all seasons except last,
        # validate on the most recent season. This prevents data leakage
        # (future matches leaking into training set via naive row split).
        if "season" in df.columns and df["season"].nunique() > 1:
            seasons = sorted(df["season"].unique())
            last_season = seasons[-1]
            train = df[df["season"] != last_season]
            val = df[df["season"] == last_season]
            logger.info(
                f"Temporal split: train seasons {seasons[:-1]}, "
                f"val season {last_season}"
            )
        else:
            # Fallback: 80/20 chronological split
            n_train = int(len(df) * 0.8)
            train = df.iloc[:n_train]
            val = df.iloc[n_train:]

        # Fill missing values with column medians instead of 0.
        # Zero is a meaningful value for features like referee_avg_yellows
        # or pass_completion, so fillna(0) introduces bias.
        col_medians = train[self.feature_cols].median()
        X_train = train[self.feature_cols].fillna(col_medians)
        X_val = val[self.feature_cols].fillna(col_medians)
        self._col_medians = col_medians  # Store for prediction time

        # Home goals model
        logger.info("Training home goals model...")
        self.model_home = xgb.XGBRegressor(
            objective="count:poisson",
            n_estimators=XGBOOST["n_estimators"],
            max_depth=XGBOOST["max_depth"],
            learning_rate=XGBOOST["learning_rate"],
            subsample=XGBOOST["subsample"],
            colsample_bytree=XGBOOST["colsample_bytree"],
            reg_alpha=XGBOOST["reg_alpha"],
            reg_lambda=XGBOOST["reg_lambda"],
            early_stopping_rounds=XGBOOST["early_stopping_rounds"],
            random_state=42,
        )
        self.model_home.fit(
            X_train, train["FTHG"],
            eval_set=[(X_val, val["FTHG"])],
            verbose=False,
        )

        # Away goals model
        logger.info("Training away goals model...")
        self.model_away = xgb.XGBRegressor(
            objective="count:poisson",
            n_estimators=XGBOOST["n_estimators"],
            max_depth=XGBOOST["max_depth"],
            learning_rate=XGBOOST["learning_rate"],
            subsample=XGBOOST["subsample"],
            colsample_bytree=XGBOOST["colsample_bytree"],
            reg_alpha=XGBOOST["reg_alpha"],
            reg_lambda=XGBOOST["reg_lambda"],
            early_stopping_rounds=XGBOOST["early_stopping_rounds"],
            random_state=42,
        )
        self.model_away.fit(
            X_train, train["FTAG"],
            eval_set=[(X_val, val["FTAG"])],
            verbose=False,
        )

        # Validation metrics
        pred_home = self.model_home.predict(X_val)
        pred_away = self.model_away.predict(X_val)
        mae_home = np.mean(np.abs(pred_home - val["FTHG"]))
        mae_away = np.mean(np.abs(pred_away - val["FTAG"]))

        metrics = {
            "mae_home": float(mae_home),
            "mae_away": float(mae_away),
            "n_train": len(train),
            "n_val": len(val),
            "n_features": len(self.feature_cols),
        }
        logger.info(f"XGBoost validation: MAE home={mae_home:.3f}, MAE away={mae_away:.3f}")

        return metrics

    def predict(self, features: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        """
        Predict expected goals for matches.

        Returns:
            (lambda_home, mu_away) arrays
        """
        if self.model_home is None:
            raise RuntimeError("Model not fitted")

        # Use stored column medians from training (falls back to 0 if unavailable)
        medians = getattr(self, "_col_medians", None)
        X = features[self.feature_cols].fillna(medians if medians is not None else 0)
        
        # Enforce numeric types to prevent "ValueError: DataFrame.dtypes" in XGBoost > 3.0
        X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
        
        lambda_home = self.model_home.predict(X)
        mu_away = self.model_away.predict(X)

        # Clip to reasonable range
        lambda_home = np.clip(lambda_home, 0.1, 5.0)
        mu_away = np.clip(mu_away, 0.1, 5.0)

        return lambda_home, mu_away

    def predict_single(self, match_features: dict) -> Tuple[float, float]:
        """Predict for a single match."""
        row = pd.DataFrame([match_features])
        lam, mu = self.predict(row)
        return float(lam[0]), float(mu[0])

    def get_feature_importance(self) -> pd.DataFrame:
        """Get feature importance from both models."""
        if self.model_home is None:
            raise RuntimeError("Model not fitted")

        imp_home = dict(zip(self.feature_cols, self.model_home.feature_importances_))
        imp_away = dict(zip(self.feature_cols, self.model_away.feature_importances_))

        df = pd.DataFrame({
            "feature": self.feature_cols,
            "importance_home": [imp_home[f] for f in self.feature_cols],
            "importance_away": [imp_away[f] for f in self.feature_cols],
        })
        df["importance_avg"] = (df["importance_home"] + df["importance_away"]) / 2
        df = df.sort_values("importance_avg", ascending=False)
        return df

    def save(self, path: Optional[Path] = None):
        """Save models to disk."""
        if path is None:
            path = DATA_PROCESSED / "models"
        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)
        pickle.dump(self.model_home, open(path / "xgb_home.pkl", "wb"))
        pickle.dump(self.model_away, open(path / "xgb_away.pkl", "wb"))
        pickle.dump(self.feature_cols, open(path / "xgb_features.pkl", "wb"))

    def load(self, path: Optional[Path] = None):
        """Load models from disk."""
        if path is None:
            path = DATA_PROCESSED / "models"
        path = Path(path)
        self.model_home = pickle.load(open(path / "xgb_home.pkl", "rb"))
        self.model_away = pickle.load(open(path / "xgb_away.pkl", "rb"))
        self.feature_cols = pickle.load(open(path / "xgb_features.pkl", "rb"))
