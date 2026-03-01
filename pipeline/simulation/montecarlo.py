"""
Monte Carlo simulation engine.
Simulates 10,000 matches per fixture using ensemble-blended parameters.
Generates samples for all random variables (goals, corners, cards).
"""
import logging
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.stats import poisson, nbinom

from pipeline.config import N_SIMULATIONS, MAX_GOALS

logger = logging.getLogger(__name__)


class MonteCarloSimulator:
    """
    10K match simulation engine.
    Uses posterior samples from Dixon-Coles + XGBoost adjustments.
    """

    def __init__(self, n_simulations: int = N_SIMULATIONS):
        self.n_sims = n_simulations

    def simulate_match(
        self,
        lambda_home: float,
        mu_away: float,
        corners_params: Optional[Dict] = None,
        cards_params: Optional[Dict] = None,
    ) -> Dict:
        """
        Simulate a single match n_simulations times.

        Args:
            lambda_home: Expected home goals (Poisson rate)
            mu_away: Expected away goals (Poisson rate)
            corners_params: {home: (n, p), away: (n, p)} for NegBin
            cards_params: {home: (p_zero, lam), away: (p_zero, lam)} for ZIP

        Returns:
            Dict with all simulation results and derived markets
        """
        # Goals simulation
        home_goals = np.random.poisson(lambda_home, self.n_sims)
        away_goals = np.random.poisson(mu_away, self.n_sims)
        total_goals = home_goals + away_goals

        # HT goals (approximate: ~45% of goals in first half)
        ht_home = np.random.poisson(lambda_home * 0.45, self.n_sims)
        ht_away = np.random.poisson(mu_away * 0.45, self.n_sims)

        # Corners simulation
        if corners_params:
            n_h, p_h = corners_params.get("home") or (5, 0.5)
            n_a, p_a = corners_params.get("away") or (4, 0.5)
            home_corners = nbinom.rvs(n_h, p_h, size=self.n_sims)
            away_corners = nbinom.rvs(n_a, p_a, size=self.n_sims)
        else:
            home_corners = np.random.poisson(5.5, self.n_sims)
            away_corners = np.random.poisson(4.5, self.n_sims)
        total_corners = home_corners + away_corners

        # Cards simulation (ZIP)
        if cards_params:
            p0_h, lam_h = cards_params.get("home") or (0.1, 1.5)
            p0_a, lam_a = cards_params.get("away") or (0.1, 1.8)
            home_yellows = np.where(
                np.random.random(self.n_sims) < p0_h, 0,
                np.random.poisson(lam_h, self.n_sims)
            )
            away_yellows = np.where(
                np.random.random(self.n_sims) < p0_a, 0,
                np.random.poisson(lam_a, self.n_sims)
            )
        else:
            home_yellows = np.random.poisson(1.5, self.n_sims)
            away_yellows = np.random.poisson(1.8, self.n_sims)
        total_cards = home_yellows + away_yellows

        return {
            "home_goals": home_goals,
            "away_goals": away_goals,
            "total_goals": total_goals,
            "ht_home": ht_home,
            "ht_away": ht_away,
            "home_corners": home_corners,
            "away_corners": away_corners,
            "total_corners": total_corners,
            "home_yellows": home_yellows,
            "away_yellows": away_yellows,
            "total_cards": total_cards,
        }

    def simulate_from_posterior(
        self,
        lambda_samples: np.ndarray,
        mu_samples: np.ndarray,
        corners_params: Optional[Dict] = None,
        cards_params: Optional[Dict] = None,
    ) -> Dict:
        """
        Simulate using posterior samples of lambda/mu (from PyMC).
        This properly propagates parameter uncertainty.
        """
        n = min(len(lambda_samples), self.n_sims)
        indices = np.random.choice(len(lambda_samples), size=n, replace=True)

        lam = lambda_samples[indices]
        mu = mu_samples[indices]

        home_goals = np.random.poisson(lam)
        away_goals = np.random.poisson(mu)
        total_goals = home_goals + away_goals

        ht_home = np.random.poisson(lam * 0.45)
        ht_away = np.random.poisson(mu * 0.45)

        # Corners and cards same as point estimate version
        if corners_params:
            n_h, p_h = corners_params.get("home") or (5, 0.5)
            n_a, p_a = corners_params.get("away") or (4, 0.5)
            home_corners = nbinom.rvs(n_h, p_h, size=n)
            away_corners = nbinom.rvs(n_a, p_a, size=n)
        else:
            home_corners = np.random.poisson(5.5, n)
            away_corners = np.random.poisson(4.5, n)

        if cards_params:
            p0_h, lam_h = cards_params.get("home") or (0.1, 1.5)
            p0_a, lam_a = cards_params.get("away") or (0.1, 1.8)
            home_yellows = np.where(np.random.random(n) < p0_h, 0, np.random.poisson(lam_h, n))
            away_yellows = np.where(np.random.random(n) < p0_a, 0, np.random.poisson(lam_a, n))
        else:
            home_yellows = np.random.poisson(1.5, n)
            away_yellows = np.random.poisson(1.8, n)

        return {
            "home_goals": home_goals,
            "away_goals": away_goals,
            "total_goals": total_goals,
            "ht_home": ht_home,
            "ht_away": ht_away,
            "home_corners": home_corners,
            "away_corners": away_corners,
            "total_corners": home_corners + away_corners,
            "home_yellows": home_yellows,
            "away_yellows": away_yellows,
            "total_cards": home_yellows + away_yellows,
        }

    def derive_all_markets(self, sims: Dict) -> Dict:
        """
        Derive all betting market probabilities from simulation results.
        """
        n = len(sims["home_goals"])
        hg, ag = sims["home_goals"], sims["away_goals"]
        tg = sims["total_goals"]

        # ── 1X2 ──
        p_home = float(np.mean(hg > ag))
        p_draw = float(np.mean(hg == ag))
        p_away = float(np.mean(hg < ag))

        # ── Over/Under Goals ──
        over_under_goals = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5]:
            over_under_goals[str(line)] = {
                "over": float(np.mean(tg > line)),
                "under": float(np.mean(tg <= line)),
            }

        # ── BTTS ──
        p_btts = float(np.mean((hg > 0) & (ag > 0)))

        # ── Clean Sheet ──
        p_home_cs = float(np.mean(ag == 0))
        p_away_cs = float(np.mean(hg == 0))

        # ── Correct Score ──
        correct_score = {}
        for i in range(7):
            for j in range(7):
                correct_score[f"{i}-{j}"] = float(np.mean((hg == i) & (ag == j)))

        # ── Asian Handicap ──
        asian_handicap = {}
        for line in [-2.5, -1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5, 2.5]:
            gd = hg.astype(float) - ag.astype(float)
            asian_handicap[f"home_{line}"] = float(np.mean(gd > line))

        # ── HT/FT ──
        ht_h, ht_a = sims["ht_home"], sims["ht_away"]
        ht_ft = {}
        for ht_label, ht_cond in [("H", ht_h > ht_a), ("D", ht_h == ht_a), ("A", ht_h < ht_a)]:
            for ft_label, ft_cond in [("H", hg > ag), ("D", hg == ag), ("A", hg < ag)]:
                ht_ft[f"{ht_label}/{ft_label}"] = float(np.mean(ht_cond & ft_cond))

        # ── Corners ──
        tc = sims["total_corners"]
        corners_ou = {}
        for line in [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]:
            corners_ou[str(line)] = {
                "over": float(np.mean(tc > line)),
                "under": float(np.mean(tc <= line)),
            }

        # ── Cards ──
        tcd = sims["total_cards"]
        cards_ou = {}
        for line in [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]:
            cards_ou[str(line)] = {
                "over": float(np.mean(tcd > line)),
                "under": float(np.mean(tcd <= line)),
            }

        # ── Distributions ──
        goals_home_dist = [float(np.mean(hg == k)) for k in range(8)]
        goals_away_dist = [float(np.mean(ag == k)) for k in range(8)]
        corners_dist = [float(np.mean(tc == k)) for k in range(21)]
        cards_dist = [float(np.mean(tcd == k)) for k in range(13)]

        # ── Expected values ──
        e_home = float(np.mean(hg))
        e_away = float(np.mean(ag))
        e_corners = float(np.mean(tc))
        e_cards = float(np.mean(tcd))

        # ── Confidence ──
        from scipy.stats import entropy as sp_entropy
        probs_1x2 = [p_home, p_draw, p_away]
        match_entropy = float(sp_entropy(probs_1x2)) if all(p > 0 for p in probs_1x2) else 0

        return {
            "probabilities": {
                "1x2": {"home": p_home, "draw": p_draw, "away": p_away},
                "over_under": over_under_goals,
                "btts": p_btts,
                "clean_sheet": {"home": p_home_cs, "away": p_away_cs},
                "correct_score": correct_score,
                "asian_handicap": asian_handicap,
                "ht_ft": ht_ft,
                "corners": corners_ou,
                "cards": cards_ou,
            },
            "expected_goals": {"home": e_home, "away": e_away},
            "expected_corners": e_corners,
            "expected_cards": e_cards,
            "distributions": {
                "goals_home": goals_home_dist,
                "goals_away": goals_away_dist,
                "corners": corners_dist,
                "cards": cards_dist,
            },
            "confidence": {
                "entropy": match_entropy,
                "home_goals_ci": [float(np.percentile(hg, 5)), float(np.percentile(hg, 95))],
                "away_goals_ci": [float(np.percentile(ag, 5)), float(np.percentile(ag, 95))],
            },
            "n_simulations": n,
        }
