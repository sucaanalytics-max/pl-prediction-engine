"""
Monte Carlo simulation engine.
Simulates 10,000 matches per fixture using ensemble-blended parameters.
Generates samples for all random variables (goals, corners, cards).

Phase 2 upgrade:
- Correlated simulation: corners and cards conditioned on match state (goals)
- Uses upgraded CornersNegBin and CardsZIP models directly
- Referee-adjusted card simulation
- Derby-aware card boost
"""
import logging
from typing import Dict, List, Optional, Tuple

import numpy as np

from pipeline.config import N_SIMULATIONS, MAX_GOALS

logger = logging.getLogger(__name__)


#: Goal ceiling for the Dixon-Coles joint grid.
#:
#: Higher than ``MAX_GOALS`` (the 7x7 export grid) on purpose. Truncating the
#: joint and renormalising redistributes the lost tail across every scoreline,
#: so the grid used for *sampling* must be wide enough that the loss is
#: negligible. At the highest lambda this pipeline produces, P(X > 10) is under
#: 1e-4 per side.
DC_SAMPLING_MAX_GOALS = 10


def sample_dixon_coles(
    lam: np.ndarray,
    mu: np.ndarray,
    rho: np.ndarray,
    rng: Optional[np.random.Generator] = None,
    max_goals: int = DC_SAMPLING_MAX_GOALS,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Draw scorelines from the Dixon-Coles joint, one per posterior sample.

    Two independent Poissons cannot produce the low-score dependence the model
    fits ``rho`` for. This builds the corrected joint per draw and samples from
    it directly, rather than drawing independently and correcting afterwards:
    a rejection scheme would silently change the effective sample size, and
    reweighting after the fact would leave the corners and cards models
    conditioned on the uncorrected match state.

    ``rho`` is per-draw, so parameter uncertainty in the correction propagates
    exactly as it does for the goal rates.

    The joint is floored at zero before renormalising, matching
    ``scoreline_matrix``: for a large ``lambda*mu`` and positive ``rho`` the
    0-0 correction can go negative, and flooring is what keeps tau positivity
    from needing a hard constraint on the prior.
    """
    from scipy.stats import poisson

    generator = rng if rng is not None else np.random.default_rng()
    n = len(lam)
    goals = np.arange(max_goals + 1)

    pmf_home = poisson.pmf(goals[None, :], lam[:, None])
    pmf_away = poisson.pmf(goals[None, :], mu[:, None])
    joint = pmf_home[:, :, None] * pmf_away[:, None, :]

    # The four cells Dixon-Coles corrects. Everything else keeps tau = 1.
    joint[:, 0, 0] *= 1.0 - lam * mu * rho
    joint[:, 1, 0] *= 1.0 + mu * rho
    joint[:, 0, 1] *= 1.0 + lam * rho
    joint[:, 1, 1] *= 1.0 - rho
    np.maximum(joint, 0.0, out=joint)

    flat = joint.reshape(n, -1)
    totals = flat.sum(axis=1, keepdims=True)
    # A draw whose whole grid floored to zero is not recoverable by
    # renormalisation; fall back to the uncorrected joint for it rather than
    # dividing by zero and emitting NaN scorelines into the Kelly path.
    degenerate = (totals[:, 0] <= 0.0)
    if degenerate.any():
        fallback = (pmf_home[degenerate][:, :, None] * pmf_away[degenerate][:, None, :])
        flat[degenerate] = fallback.reshape(degenerate.sum(), -1)
        totals[degenerate, 0] = flat[degenerate].sum(axis=1)
    flat = flat / totals

    cdf = np.cumsum(flat, axis=1)
    draws = generator.random(n)[:, None]
    index = (cdf < draws).sum(axis=1)
    index = np.minimum(index, flat.shape[1] - 1)
    width = max_goals + 1
    return (index // width).astype(np.int64), (index % width).astype(np.int64)


class MonteCarloSimulator:
    """
    10K match simulation engine.
    Uses posterior samples from Dixon-Coles + XGBoost adjustments.
    Corners and cards now correlated with goals (match-state conditioning).
    """

    def __init__(self, n_simulations: int = N_SIMULATIONS):
        self.n_sims = n_simulations

    def simulate_match(
        self,
        lambda_home: float,
        mu_away: float,
        corners_model=None,
        cards_model=None,
        home_team: str = "",
        away_team: str = "",
        referee: Optional[str] = None,
        is_derby: bool = False,
    ) -> Dict:
        """
        Simulate a single match n_simulations times.

        If corners_model/cards_model are provided, uses them for correlated
        simulation (conditioned on goal results).
        Falls back to uncorrelated sampling if models not available.
        """
        # Goals simulation
        home_goals = np.random.poisson(lambda_home, self.n_sims)
        away_goals = np.random.poisson(mu_away, self.n_sims)
        total_goals = home_goals + away_goals

        # Allocate simulated full-time goals to the first half. This preserves
        # HT <= FT for each team while retaining the full-time goal samples.
        ht_home = np.random.binomial(home_goals, 0.45)
        ht_away = np.random.binomial(away_goals, 0.45)

        # Goal sims array for match-state conditioning
        goal_sims = np.column_stack([home_goals, away_goals])

        # Corners simulation (correlated with goals)
        if corners_model is not None and home_team and away_team:
            corners_pred = corners_model.predict(home_team, away_team, goal_sims=goal_sims)
            home_corners = np.array(corners_pred["simulated_home"])
            away_corners = np.array(corners_pred["simulated_away"])
        else:
            home_corners = np.random.poisson(5.5, self.n_sims)
            away_corners = np.random.poisson(4.5, self.n_sims)
        total_corners = home_corners + away_corners

        # Cards simulation (correlated with goals, referee-adjusted)
        if cards_model is not None and home_team and away_team:
            cards_pred = cards_model.predict(
                home_team, away_team,
                referee=referee,
                is_derby=is_derby,
                goal_sims=goal_sims,
            )
            home_yellows = np.array(cards_pred["simulated_home"])
            away_yellows = np.array(cards_pred["simulated_away"])
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

    # ── Player-level extension ─────────────────────────────────────────────
    # Additive: simulate_match above is untouched, returns the same keys, and
    # its existing tests still pass. simulate_match_state wraps it and adds the
    # per-goal timings the player layer needs.

    def simulate_match_state(
        self,
        lambda_home: float,
        mu_away: float,
        rng: Optional[np.random.Generator] = None,
        max_goals: int = MAX_GOALS,
        **kwargs,
    ) -> Dict:
        """
        As :meth:`simulate_match`, plus a drawn minute for every simulated goal.

        Goal timings are what make the player layer correct rather than
        approximate. With them, "goals conceded while this player was on the
        pitch" is exact for a substituted defender, a penalty is awarded to
        whoever was on the pitch *at that minute*, and scoring eligibility
        respects the same interval. Without them all three are fudged.

        Returned as ``home_goal_minutes`` / ``away_goal_minutes``, each
        ``(n_sims, max_goals)``. A slot holds 0 where that draw produced no such
        goal, so ``minute > 0`` identifies a real goal — minute 0 is not a valid
        match minute, which makes the sentinel unambiguous.

        Minutes are drawn uniformly over 1..90. Goals genuinely cluster late, so
        this slightly misprices concessions for players withdrawn around the
        hour; the model used is recorded as ``goal_minute_model`` so the
        assumption travels with the output rather than living only here.
        """
        sims = self.simulate_match(lambda_home, mu_away, **kwargs)
        generator = rng if rng is not None else np.random.default_rng()

        sims["home_goal_minutes"] = self._goal_minutes(
            sims["home_goals"], generator, max_goals
        )
        sims["away_goal_minutes"] = self._goal_minutes(
            sims["away_goals"], generator, max_goals
        )
        sims["goal_minute_model"] = "uniform_1_90"
        sims["max_goals"] = max_goals
        return sims

    @staticmethod
    def _goal_minutes(
        goal_counts: np.ndarray, rng: np.random.Generator, max_goals: int
    ) -> np.ndarray:
        """
        Draw a minute for each goal. ``(n_sims, max_goals)``, 0 where no goal.

        Goals beyond ``max_goals`` in a single draw are dropped rather than
        silently folded into the last slot; that costs a negligible amount of
        probability mass (a 7-goal haul by one team) and keeps the invariant
        "allocated goals never exceed drawn goals" exact.
        """
        n_sims = len(goal_counts)
        minutes = rng.integers(1, 91, size=(n_sims, max_goals))
        slots = np.arange(max_goals)[None, :]
        active = slots < np.minimum(goal_counts, max_goals)[:, None]
        return np.where(active, minutes, 0).astype(np.int16)

    def simulate_from_posterior(
        self,
        lambda_samples: np.ndarray,
        mu_samples: np.ndarray,
        corners_model=None,
        cards_model=None,
        home_team: str = "",
        away_team: str = "",
        referee: Optional[str] = None,
        is_derby: bool = False,
        rho_samples: Optional[np.ndarray] = None,
    ) -> Dict:
        """
        Simulate using posterior samples of lambda/mu (from PyMC).
        This properly propagates parameter uncertainty.

        ## The Dixon-Coles correction

        With ``rho_samples`` supplied, scorelines are drawn from the corrected
        joint via :func:`sample_dixon_coles`. Without it they are two
        independent Poissons — which is what this function did unconditionally
        until the correction was wired, and what it still does for callers that
        have no fitted ``rho`` (the ensemble path with no PyMC trace).

        That default is not a fallback anyone should rely on. Independent
        Poisson cannot produce the low-score dependence the model spends its
        time fitting ``rho`` for, and at the historical mean ``rho`` of −0.063
        it understates ``P(0-0)`` by around 11% with draws understated
        correspondingly.

        **Measured impact on staking**, over 840 selections priced across the
        5% minimum-edge band on twenty fixtures: 64 phantom bets — published as
        value, not value — and 55 missed. The direction is systematic rather
        than noisy, and it is exactly what understating draws predicts:
        phantoms land on home and away, misses land on the draw. The largest
        single probability shift is 1.93pp, which is 39% of the edge threshold,
        so the defect cannot manufacture a bet on its own but decides every
        selection whose true edge sits within about 2pp of the line.
        """
        n = min(len(lambda_samples), self.n_sims)
        indices = np.random.choice(len(lambda_samples), size=n, replace=True)

        lam = lambda_samples[indices]
        mu = mu_samples[indices]

        if rho_samples is not None and len(rho_samples) > 0:
            # Paired to the same posterior draws as lambda and mu, so the
            # correction carries its own uncertainty rather than a point value.
            rho = np.asarray(rho_samples)[
                np.random.choice(len(rho_samples), size=n, replace=True)
            ]
            home_goals, away_goals = sample_dixon_coles(lam, mu, rho)
        else:
            home_goals = np.random.poisson(lam)
            away_goals = np.random.poisson(mu)
        total_goals = home_goals + away_goals

        ht_home = np.random.binomial(home_goals, 0.45)
        ht_away = np.random.binomial(away_goals, 0.45)

        goal_sims = np.column_stack([home_goals, away_goals])

        # Correlated corners
        if corners_model is not None and home_team and away_team:
            corners_pred = corners_model.predict(home_team, away_team, goal_sims=goal_sims)
            home_corners = np.array(corners_pred["simulated_home"])[:n]
            away_corners = np.array(corners_pred["simulated_away"])[:n]
        else:
            home_corners = np.random.poisson(5.5, n)
            away_corners = np.random.poisson(4.5, n)

        # Correlated cards
        if cards_model is not None and home_team and away_team:
            cards_pred = cards_model.predict(
                home_team, away_team,
                referee=referee,
                is_derby=is_derby,
                goal_sims=goal_sims,
            )
            home_yellows = np.array(cards_pred["simulated_home"])[:n]
            away_yellows = np.array(cards_pred["simulated_away"])[:n]
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
        p_btts_yes = float(np.mean((hg > 0) & (ag > 0)))
        p_btts_no = 1.0 - p_btts_yes

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
            # The quoted line is applied to the home score:
            # home goals + handicap > away goals.
            asian_handicap[f"home_{line}"] = float(np.mean(gd + line > 0))

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
        probs_1x2 = [p_home, p_draw, p_away]
        match_entropy = (
            float(-sum(p * np.log(p) for p in probs_1x2))
            if all(p > 0 for p in probs_1x2)
            else 0
        )

        return {
            "probabilities": {
                "1x2": {"home": p_home, "draw": p_draw, "away": p_away},
                "over_under": over_under_goals,
                "btts": {"yes": p_btts_yes, "no": p_btts_no},
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
