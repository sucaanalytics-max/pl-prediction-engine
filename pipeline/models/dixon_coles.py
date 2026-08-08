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
    Dixon-Coles low-score correction factor (scalar version for post-hoc use).
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


def _log_tau_vectorized(home_goals, away_goals, lambda_h, mu_a, rho):
    """
    Vectorized log(tau) for use in PyMC Potential.

    Returns log(tau(x, y, λ, μ, ρ)) for each observation, where tau is the
    Dixon-Coles low-score adjustment. For scorelines not in {(0,0),(1,0),(0,1),(1,1)},
    log(tau) = 0 (i.e. tau = 1, no adjustment).

    Uses PyMC-compatible tensor operations.
    """
    import pytensor.tensor as pt

    # Build tau for each observation based on scoreline
    is_00 = pt.eq(home_goals, 0) * pt.eq(away_goals, 0)
    is_10 = pt.eq(home_goals, 1) * pt.eq(away_goals, 0)
    is_01 = pt.eq(home_goals, 0) * pt.eq(away_goals, 1)
    is_11 = pt.eq(home_goals, 1) * pt.eq(away_goals, 1)

    # tau values for each scoreline type
    tau_00 = 1 - lambda_h * mu_a * rho
    tau_10 = 1 + mu_a * rho
    tau_01 = 1 + lambda_h * rho
    tau_11 = 1 - rho

    # Combine: log(tau) for each obs, defaulting to 0 for non-low-scoring
    log_tau = (
        is_00 * pt.log(pt.maximum(tau_00, 1e-10))
        + is_10 * pt.log(pt.maximum(tau_10, 1e-10))
        + is_01 * pt.log(pt.maximum(tau_01, 1e-10))
        + is_11 * pt.log(pt.maximum(tau_11, 1e-10))
    )
    return log_tau


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
            import pytensor.tensor as pt

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

            # ρ (rho) — Dixon-Coles low-score dependence parameter
            # Typically small and negative (draws slightly less likely than
            # bivariate Poisson would suggest). Bounded to keep tau > 0.
            rho = pm.Uniform("rho", lower=-0.5, upper=0.5)

            # Goal rates
            log_lambda = intercept + attack[home_idx] - defence[away_idx] + home_adv
            log_mu = intercept + attack[away_idx] - defence[home_idx]

            lambda_h = pm.math.exp(log_lambda)
            mu_a = pm.math.exp(log_mu)

            # ── Weighted log-likelihood via pm.Potential ──────────────────────
            # Instead of pm.Poisson (which doesn't support observation weights),
            # we compute the weighted log-likelihood manually.
            #
            # log L = Σ_i w_i * [logp(home_goals_i | λ_i) + logp(away_goals_i | μ_i)
            #                    + log τ(home_goals_i, away_goals_i, λ_i, μ_i, ρ)]
            #
            # where w_i = exp(-ξ * days_since_match_i) are the time-decay weights.

            # Poisson log-pmf: k*log(μ) - μ - log(k!)
            home_logp = (
                home_goals * pt.log(lambda_h)
                - lambda_h
                - pt.gammaln(home_goals + 1)
            )
            away_logp = (
                away_goals * pt.log(mu_a)
                - mu_a
                - pt.gammaln(away_goals + 1)
            )

            # Dixon-Coles low-score correction
            log_tau = _log_tau_vectorized(home_goals, away_goals, lambda_h, mu_a, rho)

            # Time-decay weighted total log-likelihood
            weights_tensor = pt.as_tensor_variable(weights.astype(np.float64))
            total_logp = pt.sum(weights_tensor * (home_logp + away_logp + log_tau))

            pm.Potential("weighted_dc_likelihood", total_logp)

            # Sample
            self.trace = pm.sample(
                draws=DIXON_COLES["pymc_draws"],
                tune=DIXON_COLES["pymc_tune"],
                chains=DIXON_COLES["pymc_chains"],
                target_accept=DIXON_COLES["pymc_target_accept"],
                random_seed=42,
                return_inferencedata=True,
                progressbar=True,
            )

        # Check convergence
        summary = az.summary(self.trace, var_names=["attack", "defence", "home_adv", "intercept", "rho"])
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

    @staticmethod
    def scoreline_matrix(
        lam: float, mu: float, rho: float, max_goals: int = MAX_GOALS
    ) -> np.ndarray:
        """
        Scoreline probabilities for ONE (lambda, mu, rho), with the Dixon-Coles
        low-score correction.

        Extracted so the market-implied rate inversion can run the *same* forward
        model the simulator draws from. Inverting prices through a different
        distribution than we later simulate would make the two disagree by
        construction, and the disagreement would be invisible.

        Deliberately NOT used by ``predict_scoreline``, whose vectorised path is
        on the daily prediction route: refactoring it to loop over this would risk
        moving ``latest.json``. Equivalence is pinned by a test that feeds a
        single-sample trace instead, which buys the same guarantee at no risk.
        """
        from scipy.stats import poisson

        goals = np.arange(max_goals + 1)
        i_grid, j_grid = np.meshgrid(goals, goals, indexing="ij")

        pmf_home = poisson.pmf(i_grid, lam)
        pmf_away = poisson.pmf(j_grid, mu)

        tau = np.ones_like(pmf_home, dtype=float)
        tau = np.where((i_grid == 0) & (j_grid == 0), 1 - lam * mu * rho, tau)
        tau = np.where((i_grid == 1) & (j_grid == 0), 1 + mu * rho, tau)
        tau = np.where((i_grid == 0) & (j_grid == 1), 1 + lam * rho, tau)
        tau = np.where((i_grid == 1) & (j_grid == 1), 1 - rho, tau)

        matrix = np.maximum(pmf_home * pmf_away * tau, 0.0)
        total = matrix.sum()
        # The floor plus renormalisation is what keeps tau positivity from needing
        # a hard constraint on rho: for large lambda*mu and positive rho the 0-0
        # correction can go negative, and flooring it is what predict_scoreline
        # already does.
        return matrix / total if total > 0 else matrix

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
        rho_samples = self.trace.posterior["rho"].values.flatten()

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
        rho_vals = rho_samples[indices % len(rho_samples)]

        # Build scoreline matrix with ρ correction using NumPy broadcasting
        # lam and mu have shape (n_samples,). We want matrix of shape (MAX_GOALS+1, MAX_GOALS+1)
        # Vectorized over samples (s), home goals (i), and away goals (j)
        from scipy.stats import poisson as poisson_dist
        
        # Ranges
        goals_range = np.arange(MAX_GOALS + 1)
        i_grid, j_grid = np.meshgrid(goals_range, goals_range, indexing='ij')
        
        # Reshape for broadcasting:
        # lambda_h, mu_a, rho_vals -> (n_samples, 1, 1)
        lam_3d = lambda_h[:, np.newaxis, np.newaxis]
        mu_3d = mu_a[:, np.newaxis, np.newaxis]
        rho_3d = rho_vals[:, np.newaxis, np.newaxis]
        
        # i_grid, j_grid -> (1, MAX_GOALS+1, MAX_GOALS+1)
        i_3d = i_grid[np.newaxis, :, :]
        j_3d = j_grid[np.newaxis, :, :]
        
        # Calculate Poisson PMFs
        pmf_h = poisson_dist.pmf(i_3d, lam_3d)
        pmf_a = poisson_dist.pmf(j_3d, mu_3d)
        
        # Calculate Tau
        # Default is 1.0
        tau_3d = np.ones_like(pmf_h)
        
        # Masks for specific scorelines
        mask_00 = (i_3d == 0) & (j_3d == 0)
        mask_10 = (i_3d == 1) & (j_3d == 0)
        mask_01 = (i_3d == 0) & (j_3d == 1)
        mask_11 = (i_3d == 1) & (j_3d == 1)
        
        # Apply corrections using np.where to handle broadcasting safely
        tau_3d = np.where(mask_00, 1 - lam_3d * mu_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_10, 1 + mu_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_01, 1 + lam_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_11, 1 - rho_3d, tau_3d)
        
        # Compute joint probabilities for all samples and sum over samples
        p_ij_3d = pmf_h * pmf_a * tau_3d
        p_ij_3d = np.maximum(p_ij_3d, 0) # Ensure no negative probabilities
        
        matrix = p_ij_3d.sum(axis=0)

        total = matrix.sum()
        if total > 0:
            matrix /= total
        return matrix

    def predict_match(self, home: str, away: str) -> Dict:
        """Full match prediction with all markets."""
        matrix = self.predict_scoreline(home, away)
        return self._derive_markets(matrix, home, away)

    def get_rho_samples(self) -> np.ndarray:
        """
        Posterior samples of the low-score dependence parameter.

        Flattened in the same order as the arrays `get_lambda_mu_samples`
        builds, so a caller can pair them elementwise and the correction carries
        the same parameter uncertainty as the goal rates. Returning a mean would
        throw that away, and rho's posterior is wide enough that it matters.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")
        return self.trace.posterior["rho"].values.flatten()

    def get_lambda_mu_samples(self, home: str, away: str, n_samples: int = 10000) -> Tuple[np.ndarray, np.ndarray]:
        """
        Get posterior samples of (lambda, mu) for Monte Carlo simulation.
        Used by the simulation engine.

        Returns:
            (lambda_home, mu_away) arrays of posterior samples.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        home_adv = self.trace.posterior["home_adv"].values
        intercept = self.trace.posterior["intercept"].values
        ha = home_adv.flatten()
        inter = intercept.flatten()

        h_idx = self.team_index.get(home)
        a_idx = self.team_index.get(away)
        neutral = np.zeros_like(inter)

        # Promoted/unseen clubs use the hierarchical league-average prior
        # (attack=defence=0) while known opponents retain their posterior
        # strength. This is materially more informative than replacing the
        # entire fixture with fixed 1.4/1.1 rates.
        att_h = attack[:, :, h_idx].flatten() if h_idx is not None else neutral
        att_a = attack[:, :, a_idx].flatten() if a_idx is not None else neutral
        def_h = defence[:, :, h_idx].flatten() if h_idx is not None else neutral
        def_a = defence[:, :, a_idx].flatten() if a_idx is not None else neutral

        if h_idx is None or a_idx is None:
            logger.info(
                f"Using neutral promoted-team prior for {home} vs {away} "
                f"(unknown: {[t for t, idx in ((home, h_idx), (away, a_idx)) if idx is None]})"
            )

        n_total = len(inter)
        indices = np.random.choice(n_total, size=n_samples, replace=True)

        lambda_h = np.exp(inter[indices] + att_h[indices] - def_a[indices] + ha[indices])
        mu_a = np.exp(inter[indices] + att_a[indices] - def_h[indices])

        return lambda_h, mu_a

    def get_rho_mean(self) -> float:
        """Get posterior mean of ρ for use in scoreline correction."""
        if self.trace is None:
            return 0.0
        return float(self.trace.posterior["rho"].values.mean())

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
