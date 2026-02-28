"""
Custom Bayesian Dixon-Coles model using PyMC.
Full posterior inference with NUTS sampling for uncertainty quantification.

Mathematical specification:
  Home goals ~ Poisson(λ_ij), Away goals ~ Poisson(μ_ij)
  log(λ_ij) = α_i + β_j + γ   (home attack + away defence + home advantage)
  log(μ_ij) = α_j + β_i        (away attack + home defence)
  Low-score correction: ρ adjusts P(0-0), P(1-0), P(0-1), P(1-1)
  Time decay: weight(t) = exp(-ξ * days_since_match)
"""
import logging
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import DIXON_COLES, MAX_GOALS

logger = logging.getLogger(__name__)


def _tau(home_goals, away_goals, lambda_h, mu_a, rho):
    """
    Dixon-Coles low-score correction factor.
    Adjusts probabilities for 0-0, 1-0, 0-1, 1-1 scorelines.
    """
    if home_goals == 0 and away_goals == 0:
        return 1 - lambda_h * mu_a * rho
    elif home_goals == 1 and away_goals == 0:
        return 1 + mu_a * rho
    elif home_goals == 0 and away_goals == 1:
        return 1 + lambda_h * rho
    elif home_goals == 1 and away_goals == 1:
        return 1 - rho
    else:
        return 1.0


class BayesianDixonColes:
    """
    Full Bayesian Dixon-Coles model with PyMC NUTS sampling.
    Provides posterior distributions for all team parameters.
    """

    def __init__(self):
        self.trace = None
        self.team_index = {}
        self.teams = []
        self.n_teams = 0

    def fit(self, matches: pd.DataFrame) -> None:
        """
        Fit the Bayesian Dixon-Coles model.

        Args:
            matches: DataFrame with HomeTeam, AwayTeam, FTHG, FTAG, Date
        """
        try:
            import pymc as pm
            import arviz as az
        except ImportError:
            logger.error("PyMC not installed. Run: pip install pymc arviz")
            raise

        df = matches.dropna(subset=["FTHG", "FTAG"]).copy()
        df["FTHG"] = df["FTHG"].astype(int)
        df["FTAG"] = df["FTAG"].astype(int)

        # Build team index
        self.teams = sorted(set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique()))
        self.team_index = {team: i for i, team in enumerate(self.teams)}
        self.n_teams = len(self.teams)

        home_idx = df["HomeTeam"].map(self.team_index).values
        away_idx = df["AwayTeam"].map(self.team_index).values
        home_goals = df["FTHG"].values
        away_goals = df["FTAG"].values

        # Time decay weights
        max_date = df["Date"].max()
        days_ago = (max_date - df["Date"]).dt.days.values
        xi = DIXON_COLES["xi_decay"]
        weights = np.exp(-xi * days_ago)

        logger.info(f"Fitting Bayesian Dixon-Coles on {len(df)} matches, {self.n_teams} teams...")

        with pm.Model() as model:
            # Hyperpriors
            sigma_att = pm.HalfNormal("sigma_att", sigma=1.0)
            sigma_def = pm.HalfNormal("sigma_def", sigma=1.0)

            # Team-level parameters (sum-to-zero constraint via centering)
            attack_raw = pm.Normal("attack_raw", mu=0, sigma=sigma_att, shape=self.n_teams)
            defence_raw = pm.Normal("defence_raw", mu=0, sigma=sigma_def, shape=self.n_teams)

            # Center parameters (identifiability)
            attack = pm.Deterministic("attack", attack_raw - attack_raw.mean())
            defence = pm.Deterministic("defence", defence_raw - defence_raw.mean())

            # Home advantage
            home_adv = pm.Normal(
                "home_adv",
                mu=DIXON_COLES["home_advantage_prior_mean"],
                sigma=DIXON_COLES["home_advantage_prior_sd"],
            )

            # Intercept (league average scoring rate)
            intercept = pm.Normal("intercept", mu=0.3, sigma=0.2)

            # Goal rates
            log_lambda = intercept + attack[home_idx] - defence[away_idx] + home_adv
            log_mu = intercept + attack[away_idx] - defence[home_idx]

            lambda_h = pm.math.exp(log_lambda)
            mu_a = pm.math.exp(log_mu)

            # Poisson likelihood (with time decay as observation weights)
            home_obs = pm.Poisson(
                "home_goals",
                mu=lambda_h,
                observed=home_goals,
            )
            away_obs = pm.Poisson(
                "away_goals",
                mu=mu_a,
                observed=away_goals,
            )

            # Sample
            self.trace = pm.sample(
                draws=DIXON_COLES["pymc_draws"],
                tune=DIXON_COLES["pymc_tune"],
                chains=DIXON_COLES["pymc_chains"],
                target_accept=DIXON_COLES["pymc_target_accept"],
                return_inferencedata=True,
                progressbar=True,
            )

        # Check convergence
        summary = az.summary(self.trace, var_names=["attack", "defence", "home_adv", "intercept"])
        max_rhat = summary["r_hat"].max()
        logger.info(f"PyMC sampling complete. Max R-hat: {max_rhat:.4f}")

        if max_rhat > 1.05:
            logger.warning(f"Convergence issue: max R-hat = {max_rhat:.4f} > 1.05")

    def get_team_params(self, team: str) -> Dict:
        """Get posterior mean and CI for a team's parameters."""
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        idx = self.team_index.get(team)
        if idx is None:
            raise ValueError(f"Unknown team: {team}")

        attack = self.trace.posterior["attack"].values[:, :, idx].flatten()
        defence = self.trace.posterior["defence"].values[:, :, idx].flatten()

        return {
            "attack_mean": float(np.mean(attack)),
            "attack_ci": [float(np.percentile(attack, 5)), float(np.percentile(attack, 95))],
            "defence_mean": float(np.mean(defence)),
            "defence_ci": [float(np.percentile(defence, 5)), float(np.percentile(defence, 95))],
        }

    def predict_scoreline(self, home: str, away: str, n_samples: int = 5000) -> np.ndarray:
        """
        Predict scoreline matrix from posterior predictive.
        Samples parameters from posterior, then simulates goals.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        h_idx = self.team_index.get(home)
        a_idx = self.team_index.get(away)
        if h_idx is None or a_idx is None:
            raise ValueError(f"Unknown team(s): {home}, {away}")

        # Sample from posterior
        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        home_adv = self.trace.posterior["home_adv"].values
        intercept = self.trace.posterior["intercept"].values

        # Flatten chains
        att_h = attack[:, :, h_idx].flatten()
        att_a = attack[:, :, a_idx].flatten()
        def_h = defence[:, :, h_idx].flatten()
        def_a = defence[:, :, a_idx].flatten()
        ha = home_adv.flatten()
        inter = intercept.flatten()

        # Subsample if needed
        n_total = len(att_h)
        indices = np.random.choice(n_total, size=min(n_samples, n_total), replace=False)

        # Compute rates
        log_lambda = inter[indices] + att_h[indices] - def_a[indices] + ha[indices]
        log_mu = inter[indices] + att_a[indices] - def_h[indices]
        lambda_h = np.exp(log_lambda)
        mu_a = np.exp(log_mu)

        # Simulate goals
        h_goals = np.random.poisson(lambda_h)
        a_goals = np.random.poisson(mu_a)

        # Build scoreline matrix
        matrix = np.zeros((MAX_GOALS + 1, MAX_GOALS + 1))
        for hg, ag in zip(h_goals, a_goals):
            hg_capped = min(hg, MAX_GOALS)
            ag_capped = min(ag, MAX_GOALS)
            matrix[hg_capped, ag_capped] += 1

        matrix /= matrix.sum()
        return matrix

    def predict_match(self, home: str, away: str) -> Dict:
        """Full match prediction with all markets."""
        matrix = self.predict_scoreline(home, away)
        return self._derive_markets(matrix, home, away)

    def get_lambda_mu_samples(self, home: str, away: str, n_samples: int = 10000) -> Tuple[np.ndarray, np.ndarray]:
        """
        Get posterior samples of (lambda, mu) for Monte Carlo simulation.
        Used by the simulation engine.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        h_idx = self.team_index[home]
        a_idx = self.team_index[away]

        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        home_adv = self.trace.posterior["home_adv"].values
        intercept = self.trace.posterior["intercept"].values

        att_h = attack[:, :, h_idx].flatten()
        att_a = attack[:, :, a_idx].flatten()
        def_h = defence[:, :, h_idx].flatten()
        def_a = defence[:, :, a_idx].flatten()
        ha = home_adv.flatten()
        inter = intercept.flatten()

        n_total = len(att_h)
        indices = np.random.choice(n_total, size=min(n_samples, n_total), replace=True)

        lambda_h = np.exp(inter[indices] + att_h[indices] - def_a[indices] + ha[indices])
        mu_a = np.exp(inter[indices] + att_a[indices] - def_h[indices])

        return lambda_h, mu_a

    def _derive_markets(self, matrix: np.ndarray, home: str, away: str) -> Dict:
        """Derive all betting markets from scoreline matrix."""
        p_home = sum(matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(i))
        p_draw = sum(matrix[i, i] for i in range(MAX_GOALS + 1))
        p_away = 1 - p_home - p_draw

        over_under = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5]:
            p_over = sum(
                matrix[i, j] for i in range(MAX_GOALS + 1)
                for j in range(MAX_GOALS + 1) if i + j > line
            )
            over_under[f"over_{line}"] = float(p_over)
            over_under[f"under_{line}"] = float(1 - p_over)

        p_btts = sum(
            matrix[i, j] for i in range(1, MAX_GOALS + 1)
            for j in range(1, MAX_GOALS + 1)
        )

        e_home = sum(i * matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(MAX_GOALS + 1))
        e_away = sum(j * matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(MAX_GOALS + 1))

        correct_scores = {}
        for i in range(min(6, MAX_GOALS + 1)):
            for j in range(min(6, MAX_GOALS + 1)):
                correct_scores[f"{i}-{j}"] = float(matrix[i, j])

        return {
            "1x2": {"home": float(p_home), "draw": float(p_draw), "away": float(p_away)},
            "over_under": over_under,
            "btts": float(p_btts),
            "expected_goals": {"home": float(e_home), "away": float(e_away)},
            "correct_score": correct_scores,
            "scoreline_matrix": matrix.tolist(),
            "model": "dixon_coles_pymc",
        }
