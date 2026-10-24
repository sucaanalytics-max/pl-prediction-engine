"""
XGBoost model for predicting match-level expected goals.
Enhances Dixon-Coles with non-linear feature interactions.
Output: predicted xG (lambda/mu) fed into Poisson simulation.
"""
import logging
import math
import pickle
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import XGBOOST, DATA_PROCESSED, PARAM_REGISTRY

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


def holdout_settings() -> Dict[str, float]:
    """Registered early-stopping holdout: fraction, minimum rows, refit flag."""
    return {
        "fraction": float(PARAM_REGISTRY["xgboost.holdout_fraction"]["value"]),
        "min_rows": int(PARAM_REGISTRY["xgboost.holdout_min_rows"]["value"]),
        "refit_all": bool(PARAM_REGISTRY["xgboost.refit_on_all_rows"]["value"]),
    }


def temporal_holdout_split(
    df: pd.DataFrame, fraction: float, min_rows: int
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Split played matches into (train, holdout) by kickoff date.

    The holdout is the chronologically last ``max(ceil(fraction * n), min_rows)``
    matches, extended backwards to include every match sharing the cut-off date,
    so every holdout match is STRICTLY later than every training match — no
    same-day row on both sides. Seasons play no part: the holdout may span a
    season boundary, and in-season rows sit in training whenever they precede
    the cut.

    Raises ValueError when fewer than ``min_rows`` rows would remain for
    training. Early stopping on a handful of matches selects the tree count by
    noise, and that is the failure this function exists to prevent, so it
    refuses rather than shrinking the holdout.
    """
    if not 0.0 < fraction < 1.0:
        raise ValueError(f"holdout fraction must be in (0, 1), got {fraction}")
    df = df.sort_values("Date", kind="stable")
    n = len(df)
    n_hold = max(int(math.ceil(fraction * n)), int(min_rows))
    if n - n_hold < min_rows:
        raise ValueError(
            f"{n} played matches cannot support a {n_hold}-row early-stopping "
            f"holdout plus at least {min_rows} training rows"
        )
    cutoff = df["Date"].iloc[n - n_hold]
    train = df[df["Date"] < cutoff]
    holdout = df[df["Date"] >= cutoff]
    if len(train) < min_rows:
        raise ValueError(
            f"only {len(train)} matches precede the holdout cut-off {cutoff}"
        )
    return train, holdout


class XGBoostGoalModel:
    """
    XGBoost regression model predicting home and away goals.
    """

    def __init__(self):
        self.model_home = None
        self.model_away = None
        self.feature_cols = []

    def _regressor(self, n_estimators: int, early_stopping: bool):
        """One Poisson goals regressor. Separate so tests can substitute it."""
        try:
            import xgboost as xgb
        except ImportError:
            logger.error("XGBoost not installed.")
            raise

        return xgb.XGBRegressor(
            objective="count:poisson",
            n_estimators=n_estimators,
            max_depth=XGBOOST["max_depth"],
            learning_rate=XGBOOST["learning_rate"],
            subsample=XGBOOST["subsample"],
            colsample_bytree=XGBOOST["colsample_bytree"],
            reg_alpha=XGBOOST["reg_alpha"],
            reg_lambda=XGBOOST["reg_lambda"],
            early_stopping_rounds=XGBOOST["early_stopping_rounds"] if early_stopping else None,
            random_state=42,
        )

    def fit(self, features: pd.DataFrame) -> Dict:
        """
        Train XGBoost models for home and away goals.

        Tree count is chosen by early stopping on a time-ordered holdout — the
        chronologically last ``xgboost.holdout_fraction`` of played matches, at
        least ``xgboost.holdout_min_rows``, strictly later than every training
        match (``temporal_holdout_split``). With ``xgboost.refit_on_all_rows``
        the models are then refitted on EVERY played match at the selected tree
        count, so the most recent results — the in-season ones that matter most
        for the next fixture — are in the model that predicts it.

        This replaces a season split (train on every season but the last,
        early-stop on the last), which once the in-progress season joined the
        training data early-stopped on that season's 10-80 rows and kept every
        in-season match out of training. Evidence: PARAM_REGISTRY "xgboost.*".

        Args:
            features: Feature-engineered match DataFrame

        Returns:
            Dict with training metrics. ``mae_*`` are measured on the holdout by
            the early-stopped models, before any refit, so they stay
            out-of-sample.
        """
        settings = holdout_settings()

        # Select available features
        self.feature_cols = [c for c in FEATURE_COLS if c in features.columns]
        logger.info(f"XGBoost using {len(self.feature_cols)} features: {self.feature_cols}")

        df = features.dropna(subset=["FTHG", "FTAG"]).copy()
        train, val = temporal_holdout_split(df, settings["fraction"], settings["min_rows"])
        logger.info(
            f"Temporal holdout: train {len(train)} matches to "
            f"{train['Date'].max().date()}, early-stop on {len(val)} from "
            f"{val['Date'].min().date()} to {val['Date'].max().date()}"
        )

        # Fill missing values with column medians instead of 0.
        # Zero is a meaningful value for features like referee_avg_yellows
        # or pass_completion, so fillna(0) introduces bias. Medians come from
        # the rows being fitted, never from the holdout.
        col_medians = train[self.feature_cols].median()
        X_train = train[self.feature_cols].fillna(col_medians)
        X_val = val[self.feature_cols].fillna(col_medians)

        n_max = XGBOOST["n_estimators"]
        best = {}
        for side, target in (("home", "FTHG"), ("away", "FTAG")):
            logger.info(f"Training {side} goals model...")
            model = self._regressor(n_max, early_stopping=True)
            model.fit(X_train, train[target], eval_set=[(X_val, val[target])], verbose=False)
            setattr(self, f"model_{side}", model)
            best[side] = int(getattr(model, "best_iteration", n_max - 1)) + 1

        # Validation metrics, from the early-stopped models on the holdout
        pred_home = self.model_home.predict(X_val)
        pred_away = self.model_away.predict(X_val)
        mae_home = np.mean(np.abs(pred_home - val["FTHG"]))
        mae_away = np.mean(np.abs(pred_away - val["FTAG"]))

        self._col_medians = col_medians  # Store for prediction time
        refit = settings["refit_all"]
        if refit:
            # Same tree count, all played rows. The holdout has done its one
            # job (choosing the tree count); leaving it out of the final model
            # would leave out exactly the most recent matches.
            all_medians = df[self.feature_cols].median()
            X_all = df[self.feature_cols].fillna(all_medians)
            for side, target in (("home", "FTHG"), ("away", "FTAG")):
                model = self._regressor(best[side], early_stopping=False)
                model.fit(X_all, df[target], verbose=False)
                setattr(self, f"model_{side}", model)
            self._col_medians = all_medians

        metrics = {
            "mae_home": float(mae_home),
            "mae_away": float(mae_away),
            "n_train": len(train),
            "n_val": len(val),
            "n_fit": len(df) if refit else len(train),
            "n_trees_home": best["home"],
            "n_trees_away": best["away"],
            "refit_on_all_rows": refit,
            "holdout_start": str(val["Date"].min().date()),
            "n_features": len(self.feature_cols),
        }
        logger.info(
            f"XGBoost holdout: MAE home={mae_home:.3f}, MAE away={mae_away:.3f}; "
            f"trees home={best['home']}, away={best['away']}; "
            f"final fit on {metrics['n_fit']} matches"
        )

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
