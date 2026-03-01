"""
Zero-Inflated Poisson model for match yellow/red cards.
Accounts for clean-discipline matches (excess zeros).

Phase 2 upgrade:
- Referee as primary predictor (referee_avg_yellows as prior)
- Foul rate features (HF, AF rolling)
- Derby indicator (systematically +0.5-1.0 cards in derbies)
- Match-state conditioning (trailing teams foul more)
- Opponent foul-drawing tendency
"""
import logging
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.stats import poisson

from pipeline.config import CARDS, DERBIES

logger = logging.getLogger(__name__)


class CardsZIPModel:
    """
    Referee-adjusted Zero-Inflated Poisson for yellow cards per team.

    ZIP = p_zero * I(0) + (1 - p_zero) * Poisson(lambda)

    Features used for rate estimation:
    - Team's own rolling card rate (attack discipline)
    - Opponent's foul-drawing tendency
    - Referee historical card rate (strongest predictor)
    - Derby indicator (derbies produce more cards)
    """

    def __init__(self):
        self.params_home = {}   # team -> (p_zero, lambda)
        self.params_away = {}
        self.league_avg_home_y = 1.5
        self.league_avg_away_y = 1.8
        self.team_card_rates = {}    # team -> cards received per game
        self.team_foul_rates = {}    # team -> fouls committed per game
        self.team_foul_drawn = {}    # team -> fouls drawn per game (opponent tendency)
        self.league_avg_referee_yellows = 3.5  # typical total yellows per match
        self.trailing_foul_boost = CARDS.get("trailing_foul_boost", 0.15)
        self.derby_boost = CARDS.get("derby_boost", 0.8)

    def fit(self, matches: pd.DataFrame, referee_profiles: Optional[Dict] = None) -> None:
        """
        Fit referee-adjusted ZIP parameters for each team.

        Args:
            matches: Historical match DataFrame with HY, AY, HF, AF, Referee columns
            referee_profiles: Dict[referee_name -> RefereeProfile] from referee_profiles.py
        """
        df = matches.dropna(subset=["HY", "AY"]).copy()

        self.league_avg_home_y = df["HY"].mean()
        self.league_avg_away_y = df["AY"].mean()
        self.league_avg_referee_yellows = (df["HY"] + df["AY"]).mean()

        window = CARDS["rolling_window"]
        teams = set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique())

        # Build team-level discipline profiles
        for team in teams:
            # Cards received (discipline weakness)
            home_cards = df[df["HomeTeam"] == team]["HY"]
            away_cards = df[df["AwayTeam"] == team]["AY"]
            all_cards = pd.concat([home_cards, away_cards])
            self.team_card_rates[team] = (
                all_cards.tail(window).mean()
                if len(all_cards) >= 3
                else (self.league_avg_home_y + self.league_avg_away_y) / 2
            )

            # Fouls committed (aggression tendency)
            if "HF" in df.columns and "AF" in df.columns:
                home_fouls = df[df["HomeTeam"] == team]["HF"]
                away_fouls = df[df["AwayTeam"] == team]["AF"]
                all_fouls = pd.concat([home_fouls, away_fouls]).dropna()
                self.team_foul_rates[team] = (
                    all_fouls.tail(window).mean() if len(all_fouls) >= 3 else 12.0
                )

                # Fouls drawn by opponents when playing against this team
                home_drawn = df[df["HomeTeam"] == team]["AF"]  # away team fouls = home team drew them
                away_drawn = df[df["AwayTeam"] == team]["HF"]
                all_drawn = pd.concat([home_drawn, away_drawn]).dropna()
                self.team_foul_drawn[team] = (
                    all_drawn.tail(window).mean() if len(all_drawn) >= 3 else 12.0
                )

            # Base ZIP params from rolling card data
            home_games_recent = home_cards.tail(window)
            self.params_home[team] = self._fit_zip_params(
                home_games_recent, self.league_avg_home_y
            )

            away_games_recent = away_cards.tail(window)
            self.params_away[team] = self._fit_zip_params(
                away_games_recent, self.league_avg_away_y
            )

        # Store referee profiles for prediction-time adjustment
        self._referee_profiles = referee_profiles or {}

        logger.info(
            f"Cards ZIP model fitted for {len(teams)} teams "
            f"(referee-adjusted, derby boost={self.derby_boost:.1f}, "
            f"trailing boost={self.trailing_foul_boost:.0%})"
        )

    def _fit_zip_params(
        self, data: pd.Series, fallback_mean: float
    ) -> Tuple[float, float]:
        """Estimate ZIP parameters using method of moments."""
        if len(data) < 3:
            return (0.1, fallback_mean)

        mean = data.mean()
        var = data.var()
        prop_zero = (data == 0).mean()

        if mean <= 0:
            return (0.1, fallback_mean)

        # Estimate p_zero from excess zeros
        expected_zeros = np.exp(-mean)
        p_zero = max(0.0, min(0.5, prop_zero - expected_zeros))

        # Adjust lambda
        if p_zero < 1:
            lam = mean / (1 - p_zero)
        else:
            lam = fallback_mean

        lam = max(lam, 0.3)
        return (p_zero, lam)

    def _referee_adjusted_lambda(
        self,
        team: str,
        opponent: str,
        is_home: bool,
        referee: Optional[str] = None,
        is_derby: bool = False,
    ) -> Tuple[float, float]:
        """
        Compute referee-adjusted card lambda for a team.

        Adjustment factors:
        1. Referee card tendency vs league average
        2. Opponent foul-drawing tendency
        3. Derby boost
        """
        # Base params
        if is_home:
            p_zero, lam_base = self.params_home.get(
                team, (0.1, self.league_avg_home_y)
            )
        else:
            p_zero, lam_base = self.params_away.get(
                team, (0.1, self.league_avg_away_y)
            )

        # 1. Referee adjustment: scale by referee's card rate vs league avg
        ref_multiplier = 1.0
        if referee and self._referee_profiles:
            profile = self._referee_profiles.get(referee)
            if profile is not None:
                ref_avg = getattr(profile, "avg_yellows_per_match", None)
                if ref_avg and self.league_avg_referee_yellows > 0:
                    # Referee who gives 4.0 yellows/match vs league avg 3.5 → multiplier = 1.14
                    ref_multiplier = ref_avg / self.league_avg_referee_yellows
                    ref_multiplier = np.clip(ref_multiplier, 0.6, 1.6)

        # 2. Opponent foul-drawing adjustment
        opp_factor = 1.0
        if self.team_foul_drawn:
            opp_drawn = self.team_foul_drawn.get(opponent, 12.0)
            league_avg_drawn = np.mean(list(self.team_foul_drawn.values()))
            if league_avg_drawn > 0:
                opp_factor = opp_drawn / league_avg_drawn
                opp_factor = np.clip(opp_factor, 0.7, 1.4)

        # 3. Derby boost (additive, not multiplicative)
        derby_add = self.derby_boost / 2 if is_derby else 0.0  # Split between two teams

        # Combine
        lam_adj = lam_base * ref_multiplier * opp_factor + derby_add
        lam_adj = max(lam_adj, 0.3)

        # Note: p_zero is NOT adjusted for referee. Zero-inflation reflects
        # structural team behavior (clean discipline games), not referee tendency.
        # Only λ (the Poisson rate) should vary with referee strictness.

        return (p_zero, lam_adj)

    def predict(
        self,
        home: str,
        away: str,
        referee: Optional[str] = None,
        is_derby: bool = False,
        goal_sims: Optional[np.ndarray] = None,
    ) -> Dict:
        """
        Predict card distributions for a match.

        Args:
            home: Home team name
            away: Away team name
            referee: Referee name for card-rate adjustment
            is_derby: Whether this is a derby match
            goal_sims: Optional (n_sims, 2) array of [home_goals, away_goals]
                        for match-state correlation (trailing teams foul more)

        Returns:
            Probabilities for over/under card lines + distributions.
        """
        # Referee-adjusted parameters
        p0_h, lam_h = self._referee_adjusted_lambda(
            home, away, is_home=True, referee=referee, is_derby=is_derby
        )
        p0_a, lam_a = self._referee_adjusted_lambda(
            away, home, is_home=False, referee=referee, is_derby=is_derby
        )

        # Expected cards
        e_home = (1 - p0_h) * lam_h
        e_away = (1 - p0_a) * lam_a

        # Simulate
        n_sims = 10000
        # ZIP sampling: with prob p_zero, emit 0; otherwise sample Poisson
        sim_home = np.where(
            np.random.random(n_sims) < p0_h,
            0,
            np.random.poisson(lam_h, n_sims),
        )
        sim_away = np.where(
            np.random.random(n_sims) < p0_a,
            0,
            np.random.poisson(lam_a, n_sims),
        )

        # Match-state correlation: trailing teams foul more → more cards
        if goal_sims is not None and len(goal_sims) == n_sims:
            home_goals = goal_sims[:, 0] if goal_sims.ndim == 2 else goal_sims
            away_goals = goal_sims[:, 1] if goal_sims.ndim == 2 else np.zeros(n_sims)

            # Home team trailing → more desperate → more fouls → more cards
            home_trailing = home_goals < away_goals
            home_boost = np.where(home_trailing, 1 + self.trailing_foul_boost, 1.0)
            sim_home = np.round(sim_home * home_boost).astype(int)

            # Away team trailing → same effect
            away_trailing = away_goals < home_goals
            away_boost = np.where(away_trailing, 1 + self.trailing_foul_boost, 1.0)
            sim_away = np.round(sim_away * away_boost).astype(int)

        sim_total = sim_home + sim_away
        e_total = float(np.mean(sim_total))

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
            "expected_home": float(np.mean(sim_home)),
            "expected_away": float(np.mean(sim_away)),
            "expected_total": e_total,
            "over_under": over_under,
            "distribution": distribution,
            "simulated_home": sim_home.tolist(),
            "simulated_away": sim_away.tolist(),
            "referee_adjustment": {
                "referee": referee,
                "is_derby": is_derby,
                "home_lambda_adj": float(lam_h),
                "away_lambda_adj": float(lam_a),
            },
        }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.football_data import load_all_seasons

    matches = load_all_seasons()
    model = CardsZIPModel()
    model.fit(matches)

    pred = model.predict("Arsenal", "Tottenham", is_derby=True)
    print(f"\nArsenal vs Tottenham cards (derby):")
    print(f"  Expected: home={pred['expected_home']:.1f}, away={pred['expected_away']:.1f}, total={pred['expected_total']:.1f}")
    print(f"  O/U 3.5: O={pred['over_under']['over_3.5']:.3f}")
    print(f"  Referee adjustment: {pred['referee_adjustment']}")

    pred2 = model.predict("Brentford", "Fulham")
    print(f"\nBrentford vs Fulham cards (non-derby):")
    print(f"  Expected: home={pred2['expected_home']:.1f}, away={pred2['expected_away']:.1f}, total={pred2['expected_total']:.1f}")
