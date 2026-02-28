"""
Zero-Inflated Poisson model for match yellow/red cards.
Accounts for clean-discipline matches (excess zeros).
"""
import logging
from typing import Dict, Tuple

import numpy as np
import pandas as pd
from scipy.stats import poisson

from pipeline.config import CARDS

logger = logging.getLogger(__name__)


class CardsZIPModel:
    """
    Zero-Inflated Poisson for yellow cards per team.
    ZIP = p_zero * I(0) + (1 - p_zero) * Poisson(lambda)
    """

    def __init__(self):
        self.params_home = {}  # team -> (p_zero, lambda)
        self.params_away = {}
        self.league_avg_home_y = 1.5
        self.league_avg_away_y = 1.8

    def fit(self, matches: pd.DataFrame) -> None:
        """Fit ZIP parameters for each team."""
        df = matches.dropna(subset=["HY", "AY"]).copy()

        self.league_avg_home_y = df["HY"].mean()
        self.league_avg_away_y = df["AY"].mean()

        window = CARDS["rolling_window"]
        teams = set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique())

        for team in teams:
            # Home yellows
            home_games = df[df["HomeTeam"] == team]["HY"].tail(window)
            self.params_home[team] = self._fit_zip_params(home_games, self.league_avg_home_y)

            # Away yellows
            away_games = df[df["AwayTeam"] == team]["AY"].tail(window)
            self.params_away[team] = self._fit_zip_params(away_games, self.league_avg_away_y)

        logger.info(f"Cards ZIP model fitted for {len(teams)} teams")

    def _fit_zip_params(self, data: pd.Series, fallback_mean: float) -> Tuple[float, float]:
        """Estimate ZIP parameters using method of moments."""
        if len(data) < 3:
            return (0.1, fallback_mean)

        mean = data.mean()
        var = data.var()
        prop_zero = (data == 0).mean()

        # ZIP: E[X] = (1-p)*lambda, Var[X] = lambda*(1-p)*(1+p*lambda)
        # Method of moments estimate
        if mean <= 0:
            return (0.1, fallback_mean)

        # Estimate p_zero from excess zeros
        # For Poisson, P(0) = exp(-lambda), so excess = observed_zeros - exp(-mean)
        expected_zeros = np.exp(-mean)
        p_zero = max(0, min(0.5, prop_zero - expected_zeros))

        # Adjust lambda
        if p_zero < 1:
            lam = mean / (1 - p_zero)
        else:
            lam = fallback_mean

        lam = max(lam, 0.3)
        return (p_zero, lam)

    def predict(self, home: str, away: str) -> Dict:
        """Predict card distributions for a match."""
        p0_h, lam_h = self.params_home.get(home, (0.1, self.league_avg_home_y))
        p0_a, lam_a = self.params_away.get(away, (0.1, self.league_avg_away_y))

        # Expected cards
        e_home = (1 - p0_h) * lam_h
        e_away = (1 - p0_a) * lam_a
        e_total = e_home + e_away

        # Simulate
        n_sims = 10000
        # ZIP sampling: with prob p_zero, emit 0; otherwise sample Poisson
        sim_home = np.where(
            np.random.random(n_sims) < p0_h,
            0,
            np.random.poisson(lam_h, n_sims)
        )
        sim_away = np.where(
            np.random.random(n_sims) < p0_a,
            0,
            np.random.poisson(lam_a, n_sims)
        )
        sim_total = sim_home + sim_away

        # Over/Under lines
        over_under = {}
        for line in [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]:
            p_over = np.mean(sim_total > line)
            over_under[f"over_{line}"] = float(p_over)
            over_under[f"under_{line}"] = float(1 - p_over)

        # Distribution
        max_cards = 12
        distribution = [float(np.mean(sim_total == k)) for k in range(max_cards + 1)]

        return {
            "expected_home": float(e_home),
            "expected_away": float(e_away),
            "expected_total": float(e_total),
            "over_under": over_under,
            "distribution": distribution,
            "simulated_home": sim_home.tolist(),
            "simulated_away": sim_away.tolist(),
        }
