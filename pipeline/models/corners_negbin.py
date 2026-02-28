"""
Negative Binomial regression model for match corners.
Handles overdispersion better than Poisson (corners have higher variance).
"""
import logging
from typing import Dict, Tuple

import numpy as np
import pandas as pd
from scipy.stats import nbinom

from pipeline.config import CORNERS, MAX_GOALS

logger = logging.getLogger(__name__)


class CornersNegBinModel:
    """
    Negative Binomial model for home and away corners.
    Uses team-level rolling corner stats + opponent defensive metrics.
    """

    def __init__(self):
        self.params_home = {}  # team -> (mu, alpha)
        self.params_away = {}
        self.league_avg_home = 5.5
        self.league_avg_away = 4.5

    def fit(self, matches: pd.DataFrame) -> None:
        """
        Fit NegBin parameters for each team using MLE.

        Uses rolling corner averages as team-level rates.
        """
        df = matches.dropna(subset=["HC", "AC"]).copy()

        # League averages
        self.league_avg_home = df["HC"].mean()
        self.league_avg_away = df["AC"].mean()
        league_var_home = df["HC"].var()
        league_var_away = df["AC"].var()

        logger.info(f"League avg corners: home={self.league_avg_home:.1f}, away={self.league_avg_away:.1f}")

        # Per-team corner rates (rolling last N matches)
        window = CORNERS["rolling_window"]
        teams = set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique())

        for team in teams:
            # Home corners when playing at home
            home_games = df[df["HomeTeam"] == team]["HC"]
            if len(home_games) >= 3:
                mu_h = home_games.tail(window).mean()
                var_h = max(home_games.tail(window).var(), mu_h + 0.1)
            else:
                mu_h = self.league_avg_home
                var_h = league_var_home

            # Away corners when playing away
            away_games = df[df["AwayTeam"] == team]["AC"]
            if len(away_games) >= 3:
                mu_a = away_games.tail(window).mean()
                var_a = max(away_games.tail(window).var(), mu_a + 0.1)
            else:
                mu_a = self.league_avg_away
                var_a = league_var_away

            # NegBin parameterization: n, p from mu, var
            # var = mu + mu^2/n => n = mu^2 / (var - mu)
            self.params_home[team] = self._fit_negbin_params(mu_h, var_h)
            self.params_away[team] = self._fit_negbin_params(mu_a, var_a)

        logger.info(f"Corners NegBin model fitted for {len(teams)} teams")

    def _fit_negbin_params(self, mu: float, var: float) -> Tuple[float, float]:
        """Convert (mean, variance) to NegBin (n, p) parameters."""
        mu = max(mu, 0.5)
        var = max(var, mu + 0.01)
        n = mu ** 2 / (var - mu)
        n = max(n, 0.5)
        p = n / (n + mu)
        return (n, p)

    def predict(self, home: str, away: str) -> Dict:
        """
        Predict corner distributions for a match.

        Returns probabilities for over/under corner lines.
        """
        n_h, p_h = self.params_home.get(home, self._fit_negbin_params(self.league_avg_home, self.league_avg_home * 1.5))
        n_a, p_a = self.params_away.get(away, self._fit_negbin_params(self.league_avg_away, self.league_avg_away * 1.5))

        # Expected corners
        e_home = n_h * (1 - p_h) / p_h
        e_away = n_a * (1 - p_a) / p_a
        e_total = e_home + e_away

        # Simulate total corners (convolution of two NegBin)
        n_sims = 10000
        sim_home = nbinom.rvs(n_h, p_h, size=n_sims)
        sim_away = nbinom.rvs(n_a, p_a, size=n_sims)
        sim_total = sim_home + sim_away

        # Over/Under lines
        over_under = {}
        for line in [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]:
            p_over = np.mean(sim_total > line)
            over_under[f"over_{line}"] = float(p_over)
            over_under[f"under_{line}"] = float(1 - p_over)

        # Distribution
        max_corners = 20
        distribution = [float(np.mean(sim_total == k)) for k in range(max_corners + 1)]

        return {
            "expected_home": float(e_home),
            "expected_away": float(e_away),
            "expected_total": float(e_total),
            "over_under": over_under,
            "distribution": distribution,
            "simulated_home": sim_home.tolist(),
            "simulated_away": sim_away.tolist(),
        }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.football_data import load_all_seasons

    matches = load_all_seasons()
    model = CornersNegBinModel()
    model.fit(matches)

    pred = model.predict("Arsenal", "Tottenham")
    print(f"\nArsenal vs Tottenham corners:")
    print(f"  Expected: home={pred['expected_home']:.1f}, away={pred['expected_away']:.1f}, total={pred['expected_total']:.1f}")
    print(f"  O/U 10.5: O={pred['over_under']['over_10.5']:.3f}")
