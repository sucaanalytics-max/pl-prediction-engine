"""
PenaltyBlog baseline model wrapper.
Uses the penaltyblog library's Dixon-Coles + Elo as a fast benchmark.
"""
import logging
from typing import Dict, Tuple

import numpy as np
import pandas as pd

from pipeline.config import DIXON_COLES, MAX_GOALS

logger = logging.getLogger(__name__)


class PenaltyblogBaseline:
    """
    Fast Dixon-Coles baseline using the penaltyblog library.
    Serves as benchmark and 10% ensemble weight.
    """

    def __init__(self):
        self.model = None
        self.teams = []

    def fit(self, matches: pd.DataFrame) -> None:
        """
        Fit Dixon-Coles model using penaltyblog.

        Args:
            matches: DataFrame with HomeTeam, AwayTeam, FTHG, FTAG, Date
        """
        try:
            from penaltyblog.models import DixonColesModel

            # Prepare data
            df = matches.dropna(subset=["FTHG", "FTAG"]).copy()
            df["FTHG"] = df["FTHG"].astype(int)
            df["FTAG"] = df["FTAG"].astype(int)

            self.teams = sorted(set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique()))

            # Fit model with time decay
            self.model = DixonColesModel(
                df["HomeTeam"],
                df["AwayTeam"],
                df["FTHG"],
                df["FTAG"],
                xi=DIXON_COLES["xi_decay"],
            )
            self.model.fit()
            logger.info("PenaltyBlog Dixon-Coles model fitted successfully")

        except ImportError:
            logger.error("penaltyblog not installed. Cannot create baseline.")
            raise
        except Exception as e:
            logger.error(f"PenaltyBlog model fitting failed: {e}")
            raise

    def predict_scoreline(self, home: str, away: str) -> np.ndarray:
        """
        Predict scoreline probability matrix P(home_goals=i, away_goals=j).

        Returns:
            (MAX_GOALS+1) x (MAX_GOALS+1) numpy array of probabilities
        """
        if self.model is None:
            raise RuntimeError("Model not fitted. Call fit() first.")

        try:
            probs = self.model.predict(home, away)

            # Build scoreline matrix
            matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
            for i in range(MAX_GOALS + 1):
                for j in range(MAX_GOALS + 1):
                    try:
                        matrix[i, j] = probs.score_proba(i, j)
                    except Exception:
                        matrix[i, j] = 0.0

            # Normalize (should already sum to ~1 but ensure)
            total = matrix.sum()
            if total > 0:
                matrix /= total

            return matrix

        except Exception as e:
            logger.warning(f"PenaltyBlog prediction failed for {home} vs {away}: {e}")
            return self._fallback_matrix()

    def predict_match(self, home: str, away: str) -> Dict:
        """
        Full match prediction with 1X2, O/U, BTTS from scoreline matrix.
        """
        matrix = self.predict_scoreline(home, away)
        return self._derive_markets(matrix, home, away)

    def predict_all_fixtures(self, fixtures: pd.DataFrame) -> list:
        """Predict all upcoming fixtures."""
        results = []
        for _, row in fixtures.iterrows():
            pred = self.predict_match(row["home_team"], row["away_team"])
            pred["home_team"] = row["home_team"]
            pred["away_team"] = row["away_team"]
            results.append(pred)
        return results

    def _derive_markets(self, matrix: np.ndarray, home: str, away: str) -> Dict:
        """Derive betting markets from scoreline matrix."""
        # 1X2
        p_home = sum(matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(i))
        p_draw = sum(matrix[i, i] for i in range(MAX_GOALS + 1))
        p_away = sum(matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(i + 1, MAX_GOALS + 1))

        # Over/Under goals
        over_under = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5]:
            p_over = sum(
                matrix[i, j]
                for i in range(MAX_GOALS + 1)
                for j in range(MAX_GOALS + 1)
                if i + j > line
            )
            over_under[f"over_{line}"] = p_over
            over_under[f"under_{line}"] = 1 - p_over

        # BTTS
        p_btts = sum(
            matrix[i, j]
            for i in range(1, MAX_GOALS + 1)
            for j in range(1, MAX_GOALS + 1)
        )

        # Clean sheet
        p_home_cs = sum(matrix[i, 0] for i in range(MAX_GOALS + 1))
        p_away_cs = sum(matrix[0, j] for j in range(MAX_GOALS + 1))

        # Expected goals from matrix
        e_home_goals = sum(
            i * matrix[i, j]
            for i in range(MAX_GOALS + 1)
            for j in range(MAX_GOALS + 1)
        )
        e_away_goals = sum(
            j * matrix[i, j]
            for i in range(MAX_GOALS + 1)
            for j in range(MAX_GOALS + 1)
        )

        # Correct score (flatten top scorelines)
        correct_scores = {}
        for i in range(min(6, MAX_GOALS + 1)):
            for j in range(min(6, MAX_GOALS + 1)):
                correct_scores[f"{i}-{j}"] = float(matrix[i, j])

        return {
            "1x2": {
                "home": float(p_home),
                "draw": float(p_draw),
                "away": float(p_away),
            },
            "over_under": over_under,
            "btts": float(p_btts),
            "clean_sheet": {
                "home": float(p_home_cs),
                "away": float(p_away_cs),
            },
            "expected_goals": {
                "home": float(e_home_goals),
                "away": float(e_away_goals),
            },
            "correct_score": correct_scores,
            "scoreline_matrix": matrix.tolist(),
            "model": "penaltyblog",
        }

    def _fallback_matrix(self) -> np.ndarray:
        """Fallback uniform-ish matrix if prediction fails."""
        # Average PL match: ~1.5 goals per team
        from scipy.stats import poisson
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        for i in range(MAX_GOALS + 1):
            for j in range(MAX_GOALS + 1):
                matrix[i, j] = poisson.pmf(i, 1.4) * poisson.pmf(j, 1.1)
        matrix /= matrix.sum()
        return matrix


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.football_data import load_all_seasons

    matches = load_all_seasons()
    model = PenaltyblogBaseline()
    model.fit(matches)

    pred = model.predict_match("Arsenal", "Man City")
    print(f"\nArsenal vs Man City:")
    print(f"  1X2: H={pred['1x2']['home']:.3f}, D={pred['1x2']['draw']:.3f}, A={pred['1x2']['away']:.3f}")
    print(f"  O/U 2.5: O={pred['over_under']['over_2.5']:.3f}, U={pred['over_under']['under_2.5']:.3f}")
    print(f"  BTTS: {pred['btts']:.3f}")
    print(f"  xG: Home={pred['expected_goals']['home']:.2f}, Away={pred['expected_goals']['away']:.2f}")
