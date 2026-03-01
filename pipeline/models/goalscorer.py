"""
Player-level goalscorer probability model.

Uses FPL API data (xG, goals, minutes) to estimate per-player probability of
scoring in a given match. Distributes team-level expected goals (from the
ensemble model) among squad players based on xG share.

Markets supported:
- Anytime goalscorer: P(player scores ≥ 1 goal)
- First goalscorer: ~anytime / n_starters (approximate)
- 2+ goals: P(player scores ≥ 2 goals)

Mathematical specification:
  λ_player = (player_xG_share) × (team_match_xG)
  P(≥1 goal) = 1 - exp(-λ_player)  (Poisson complement)
  P(≥2 goals) = 1 - exp(-λ_player) - λ_player * exp(-λ_player)
"""
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Minimum minutes for a player to be included in goalscorer model
MIN_MINUTES = 270  # ~3 full matches
# Minimum xG share for a player to be considered a goalscorer candidate
MIN_XG_SHARE = 0.01

# Position-based goal rate multipliers (applied to players with insufficient xG data)
# Reflects that forwards score ~60% of goals, midfielders ~30%, defenders ~10%
POSITION_GOAL_SHARE = {
    "GKP": 0.002,
    "DEF": 0.04,
    "MID": 0.12,
    "FWD": 0.25,
}


@dataclass
class GoalscorerProfile:
    """Profile for a single player's goalscoring tendency."""
    player_id: int
    name: str
    web_name: str
    team: str
    position: str
    minutes: int
    goals_scored: int
    expected_goals: float
    xg_per_90: float
    goals_per_90: float
    xg_share: float  # Share of team's total xG
    available: bool


class GoalscorerModel:
    """
    Player-level goalscorer probability model.

    Distributes team expected goals among squad players based on their
    xG share, then converts to per-match scoring probabilities.
    """

    def __init__(self):
        self.profiles: Dict[str, List[GoalscorerProfile]] = {}  # team -> [profiles]
        self.team_total_xg: Dict[str, float] = {}  # team -> total season xG

    def fit(self, player_stats: pd.DataFrame) -> Dict:
        """
        Build goalscorer profiles from FPL player data.

        Args:
            player_stats: DataFrame from fpl_api.build_player_stats()

        Returns:
            Dict with summary metrics.
        """
        df = player_stats.copy()

        # Filter to available players with meaningful minutes
        df = df[df["minutes"] >= MIN_MINUTES].copy()
        if "available" in df.columns:
            df = df[df["available"]].copy()

        if len(df) == 0:
            logger.warning("No players with sufficient minutes for goalscorer model")
            return {"n_players": 0}

        # Compute per-90 rates
        df["xg_per_90"] = df.apply(
            lambda r: r["expected_goals"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
            axis=1,
        )
        df["goals_per_90"] = df.apply(
            lambda r: r["goals_scored"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
            axis=1,
        )

        # Compute team-level xG totals and per-player xG share
        self.team_total_xg = df.groupby("team")["expected_goals"].sum().to_dict()

        self.profiles = {}
        for team, group in df.groupby("team"):
            team_xg = self.team_total_xg.get(team, 1.0)
            team_profiles = []

            for _, row in group.iterrows():
                # xG share: this player's xG / team's total xG
                if team_xg > 0:
                    xg_share = row["expected_goals"] / team_xg
                else:
                    # Fallback to position-based share if no team xG data
                    xg_share = POSITION_GOAL_SHARE.get(row["position"], 0.05)

                # For players with very low xG but significant minutes,
                # use a weighted blend of xG share and position-based prior
                if row["expected_goals"] < 0.5 and row["minutes"] >= MIN_MINUTES:
                    pos_prior = POSITION_GOAL_SHARE.get(row["position"], 0.05)
                    # Blend: more weight to prior when xG data is sparse
                    weight = min(row["expected_goals"] / 2.0, 1.0)  # 0-1 scale
                    xg_share = weight * xg_share + (1 - weight) * pos_prior

                if xg_share < MIN_XG_SHARE and row["position"] != "GKP":
                    xg_share = MIN_XG_SHARE

                profile = GoalscorerProfile(
                    player_id=row["player_id"],
                    name=row["name"],
                    web_name=row["web_name"],
                    team=team,
                    position=row["position"],
                    minutes=row["minutes"],
                    goals_scored=row["goals_scored"],
                    expected_goals=row["expected_goals"],
                    xg_per_90=row["xg_per_90"],
                    goals_per_90=row["goals_per_90"],
                    xg_share=xg_share,
                    available=True,
                )
                team_profiles.append(profile)

            # Renormalize xG shares within team to sum to ~1.0
            total_share = sum(p.xg_share for p in team_profiles)
            if total_share > 0:
                for p in team_profiles:
                    p.xg_share = p.xg_share / total_share

            # Sort by xG share descending
            team_profiles.sort(key=lambda p: p.xg_share, reverse=True)
            self.profiles[team] = team_profiles

        total_players = sum(len(v) for v in self.profiles.values())
        logger.info(
            f"Goalscorer model: {total_players} players across "
            f"{len(self.profiles)} teams"
        )

        return {
            "n_players": total_players,
            "n_teams": len(self.profiles),
            "top_scorers": self._get_top_scorers(10),
        }

    def predict_match(
        self,
        home: str,
        away: str,
        home_xg: float,
        away_xg: float,
        top_n: int = 8,
    ) -> Dict:
        """
        Predict goalscorer probabilities for a match.

        Distributes team-level expected goals (from ensemble model) among
        squad players based on their xG share. Uses Poisson model:
          λ_player = xG_share × team_match_xG
          P(≥1 goal) = 1 - exp(-λ_player)

        Args:
            home: Home team name
            away: Away team name
            home_xg: Team expected goals for home (from ensemble model)
            away_xg: Team expected goals for away
            top_n: Return top N scorers per team

        Returns:
            Dict with per-player scoring probabilities.
        """
        home_players = self.profiles.get(home, [])
        away_players = self.profiles.get(away, [])

        if not home_players and not away_players:
            logger.warning(f"No goalscorer profiles for {home} vs {away}")
            return {"home_scorers": [], "away_scorers": [], "top_scorers": []}

        all_scorers = []

        for players, team, team_xg, side in [
            (home_players, home, home_xg, "home"),
            (away_players, away, away_xg, "away"),
        ]:
            for player in players:
                # Player's expected goals for this match
                lambda_player = player.xg_share * team_xg

                # Poisson probabilities
                p_score_1_plus = 1.0 - np.exp(-lambda_player)
                p_score_2_plus = 1.0 - np.exp(-lambda_player) - lambda_player * np.exp(-lambda_player)
                p_score_2_plus = max(p_score_2_plus, 0.0)

                # First goalscorer: approximate as anytime / n_outfield_starters
                n_outfield = max(len([p for p in players if p.position != "GKP"]), 1)
                # Weight by xG share instead of uniform
                p_first = p_score_1_plus * player.xg_share / max(
                    sum(p.xg_share for p in players if p.position != "GKP"), 0.01
                )

                all_scorers.append({
                    "player_id": player.player_id,
                    "name": player.name,
                    "web_name": player.web_name,
                    "team": player.team,
                    "position": player.position,
                    "side": side,
                    "lambda_player": float(lambda_player),
                    "anytime_prob": float(p_score_1_plus),
                    "two_plus_prob": float(p_score_2_plus),
                    "first_scorer_prob": float(p_first),
                    "xg_per_90": float(player.xg_per_90),
                    "goals_scored": player.goals_scored,
                    "xg_share": float(player.xg_share),
                    "minutes": player.minutes,
                })

        # Sort by anytime probability
        all_scorers.sort(key=lambda x: x["anytime_prob"], reverse=True)

        home_scorers = [s for s in all_scorers if s["side"] == "home"]
        away_scorers = [s for s in all_scorers if s["side"] == "away"]

        return {
            "home_scorers": home_scorers[:top_n],
            "away_scorers": away_scorers[:top_n],
            "top_scorers": all_scorers[:top_n],
            "match_xg": {"home": float(home_xg), "away": float(away_xg)},
        }

    def get_anytime_probabilities(
        self, home: str, away: str, home_xg: float, away_xg: float
    ) -> Dict[str, float]:
        """
        Get {player_name: anytime_scorer_probability} for all players.
        Used by Kelly criterion scanner in kelly.py.
        """
        result = self.predict_match(home, away, home_xg, away_xg, top_n=50)
        probs = {}
        for s in result.get("home_scorers", []) + result.get("away_scorers", []):
            probs[s["web_name"]] = s["anytime_prob"]
        return probs

    def _get_top_scorers(self, n: int = 10) -> List[Dict]:
        """Get top N players by xG per 90 across all teams."""
        all_players = []
        for team, players in self.profiles.items():
            for p in players:
                if p.position != "GKP":
                    all_players.append({
                        "name": p.name,
                        "web_name": p.web_name,
                        "team": p.team,
                        "position": p.position,
                        "xg_per_90": p.xg_per_90,
                        "goals_per_90": p.goals_per_90,
                        "goals_scored": p.goals_scored,
                        "xg_share": p.xg_share,
                        "minutes": p.minutes,
                    })
        all_players.sort(key=lambda x: x["xg_per_90"], reverse=True)
        return all_players[:n]

    def get_team_scorers(self, team: str, top_n: int = 5) -> List[Dict]:
        """Get top scorers for a specific team."""
        players = self.profiles.get(team, [])
        return [
            {
                "name": p.name,
                "web_name": p.web_name,
                "position": p.position,
                "xg_per_90": p.xg_per_90,
                "goals_per_90": p.goals_per_90,
                "goals_scored": p.goals_scored,
                "xg_share": p.xg_share,
            }
            for p in players[:top_n]
            if p.position != "GKP"
        ]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.fpl_api import fetch_bootstrap_static, build_player_stats

    bootstrap = fetch_bootstrap_static()
    player_stats = build_player_stats(bootstrap)

    model = GoalscorerModel()
    metrics = model.fit(player_stats)
    print(f"\nModel metrics: {metrics}")

    # Show top scorers
    top = metrics.get("top_scorers", [])
    print(f"\nTop 10 scorers by xG/90:")
    for s in top:
        print(f"  {s['web_name']} ({s['team']}, {s['position']}): "
              f"xG/90={s['xg_per_90']:.3f}, goals={s['goals_scored']}, "
              f"share={s['xg_share']:.1%}")

    # Predict for a match
    pred = model.predict_match("Man City", "Arsenal", home_xg=1.8, away_xg=1.3)
    print(f"\nMan City vs Arsenal — Top goalscorer picks:")
    for s in pred["top_scorers"]:
        print(f"  {s['web_name']} ({s['team']}, {s['position']}): "
              f"P(score)={s['anytime_prob']:.1%}, "
              f"P(first)={s['first_scorer_prob']:.1%}, "
              f"λ={s['lambda_player']:.3f}")
