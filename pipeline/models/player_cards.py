"""
Player-level booking (yellow card) probability model.

Uses FPL API data for player card history and adjusts for:
- Player's base card rate (yellows per 90 minutes)
- Referee card tendency (multiplier vs league average)
- Opponent foul-drawing tendency
- Derby factor (derbies produce more cards)
- Position weighting (midfielders/defenders carded more)

Output: top N players most likely to be booked per match.
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import CARDS, DERBIES

logger = logging.getLogger(__name__)

# Position-based card rate multipliers (relative to league average)
# Midfielders and defenders commit more tactical fouls
POSITION_MULTIPLIERS = {
    "GKP": 0.05,   # Goalkeepers rarely booked
    "DEF": 1.15,    # Defenders booked slightly above average
    "MID": 1.25,    # Midfielders most commonly booked (tactical fouls)
    "FWD": 0.85,    # Forwards less commonly booked
}


@dataclass
class PlayerBookingProfile:
    """Profile for a single player's booking tendency."""
    player_id: int
    name: str
    web_name: str
    team: str
    position: str
    minutes: int
    yellow_cards: int
    red_cards: int
    yellows_per_90: float
    is_card_magnet: bool  # Top quartile card rate
    base_booking_prob: float  # Per-match booking probability


class PlayerCardsModel:
    """
    Player-level booking probability model.

    P(booked) = base_rate × referee_multiplier × opponent_foul_factor × derby_factor

    Where:
    - base_rate = player's yellows_per_90 converted to per-match probability
    - referee_multiplier = referee_avg_yellows / league_avg_yellows
    - opponent_foul_factor = opponent's fouls_drawn_per_game / league_avg
    - derby_factor = 1.0 (normal) or ~1.3 (derby)
    """

    def __init__(self):
        self.profiles: Dict[str, List[PlayerBookingProfile]] = {}  # team -> [profiles]
        self.league_avg_yellows_per_90 = 0.0
        self.min_minutes = CARDS.get("min_player_minutes", 900)
        self.derby_card_multiplier = 1.30  # +30% card probability in derbies

    def fit(self, player_stats: pd.DataFrame) -> Dict:
        """
        Build player booking profiles from FPL data.

        Args:
            player_stats: DataFrame from fpl_api.build_player_stats()

        Returns:
            Dict with summary metrics.
        """
        df = player_stats.copy()

        # Filter to players with meaningful minutes
        df = df[df["minutes"] >= self.min_minutes].copy()

        # Exclude players marked unavailable/departed (status='u')
        if "available" in df.columns:
            df = df[df["available"]].copy()

        if len(df) == 0:
            logger.warning("No players with sufficient minutes for card model")
            return {"n_players": 0}

        # Compute per-90 card rates
        df["yellows_per_90"] = df.apply(
            lambda r: r["yellow_cards"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
            axis=1,
        )
        df["reds_per_90"] = df.apply(
            lambda r: r["red_cards"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
            axis=1,
        )

        # League average card rate
        self.league_avg_yellows_per_90 = df["yellows_per_90"].mean()

        # Identify card magnets (top quartile)
        q75 = df["yellows_per_90"].quantile(0.75)

        # Build profiles by team
        self.profiles = {}
        n_magnets = 0

        for _, row in df.iterrows():
            team = row["team"]
            if team not in self.profiles:
                self.profiles[team] = []

            is_magnet = row["yellows_per_90"] >= q75 and row["yellows_per_90"] > 0
            if is_magnet:
                n_magnets += 1

            # Convert per-90 rate to per-match probability
            # Assuming ~75 mins average playing time per start
            # P(booked in match) ≈ 1 - (1 - rate_per_90)^(avg_mins/90)
            avg_mins_played = min(row["minutes"] / max(row["minutes"] / 90, 1), 90)
            base_prob = min(row["yellows_per_90"] * (avg_mins_played / 90), 0.95)

            # Apply position multiplier
            pos_mult = POSITION_MULTIPLIERS.get(row["position"], 1.0)
            base_prob = min(base_prob * pos_mult, 0.95)

            profile = PlayerBookingProfile(
                player_id=row["player_id"],
                name=row["name"],
                web_name=row["web_name"],
                team=team,
                position=row["position"],
                minutes=row["minutes"],
                yellow_cards=row["yellow_cards"],
                red_cards=row["red_cards"],
                yellows_per_90=row["yellows_per_90"],
                is_card_magnet=is_magnet,
                base_booking_prob=base_prob,
            )
            self.profiles[team].append(profile)

        logger.info(
            f"Player cards model: {sum(len(v) for v in self.profiles.values())} players, "
            f"{n_magnets} card magnets, "
            f"league avg {self.league_avg_yellows_per_90:.3f} yellows/90"
        )

        return {
            "n_players": sum(len(v) for v in self.profiles.values()),
            "n_teams": len(self.profiles),
            "n_card_magnets": n_magnets,
            "league_avg_yellows_per_90": self.league_avg_yellows_per_90,
            "q75_threshold": q75,
        }

    def predict_match(
        self,
        home: str,
        away: str,
        referee: Optional[str] = None,
        referee_profiles: Optional[Dict] = None,
        team_foul_drawn: Optional[Dict[str, float]] = None,
        is_derby: bool = False,
        top_n: int = 5,
    ) -> Dict:
        """
        Predict player booking probabilities for a match.

        Args:
            home: Home team name
            away: Away team name
            referee: Referee name
            referee_profiles: Dict of referee profiles for multiplier
            team_foul_drawn: Dict of team -> fouls drawn per game
            is_derby: Whether this is a derby match
            top_n: Return top N most likely to be booked

        Returns:
            Dict with booking probabilities per player and top picks.
        """
        home_players = self.profiles.get(home, [])
        away_players = self.profiles.get(away, [])

        if not home_players and not away_players:
            logger.warning(f"No player profiles for {home} vs {away}")
            return {"home_players": [], "away_players": [], "top_bookings": []}

        # Compute adjustment factors
        ref_multiplier = self._referee_multiplier(referee, referee_profiles)
        derby_factor = self.derby_card_multiplier if is_derby else 1.0

        # Compute per-player booking probs
        all_bookings = []

        for player in home_players:
            # Opponent (away) foul-drawing tendency
            opp_factor = self._opponent_foul_factor(away, team_foul_drawn)

            prob = self._adjusted_prob(
                player.base_booking_prob, ref_multiplier, opp_factor, derby_factor
            )
            all_bookings.append({
                "player_id": player.player_id,
                "name": player.name,
                "web_name": player.web_name,
                "team": player.team,
                "position": player.position,
                "side": "home",
                "base_prob": player.base_booking_prob,
                "adjusted_prob": prob,
                "yellows_per_90": player.yellows_per_90,
                "yellow_cards": player.yellow_cards,
                "minutes": player.minutes,
                "is_card_magnet": player.is_card_magnet,
            })

        for player in away_players:
            opp_factor = self._opponent_foul_factor(home, team_foul_drawn)

            prob = self._adjusted_prob(
                player.base_booking_prob, ref_multiplier, opp_factor, derby_factor
            )
            all_bookings.append({
                "player_id": player.player_id,
                "name": player.name,
                "web_name": player.web_name,
                "team": player.team,
                "position": player.position,
                "side": "away",
                "base_prob": player.base_booking_prob,
                "adjusted_prob": prob,
                "yellows_per_90": player.yellows_per_90,
                "yellow_cards": player.yellow_cards,
                "minutes": player.minutes,
                "is_card_magnet": player.is_card_magnet,
            })

        # Sort by adjusted probability
        all_bookings.sort(key=lambda x: x["adjusted_prob"], reverse=True)

        # Split by team
        home_bookings = [b for b in all_bookings if b["side"] == "home"]
        away_bookings = [b for b in all_bookings if b["side"] == "away"]

        return {
            "home_players": home_bookings,
            "away_players": away_bookings,
            "top_bookings": all_bookings[:top_n],
            "adjustments": {
                "referee": referee,
                "referee_multiplier": ref_multiplier,
                "is_derby": is_derby,
                "derby_factor": derby_factor,
            },
        }

    def _adjusted_prob(
        self,
        base_prob: float,
        ref_multiplier: float,
        opp_factor: float,
        derby_factor: float,
    ) -> float:
        """Apply all adjustment factors to base booking probability."""
        prob = base_prob * ref_multiplier * opp_factor * derby_factor
        return min(max(prob, 0.01), 0.85)  # Bound between 1% and 85%

    def _referee_multiplier(
        self, referee: Optional[str], referee_profiles: Optional[Dict]
    ) -> float:
        """Get referee card-rate multiplier."""
        if not referee or not referee_profiles:
            return 1.0

        profile = referee_profiles.get(referee)
        if profile is None:
            return 1.0

        ref_avg = getattr(profile, "avg_yellows_per_match", None)
        if ref_avg is None:
            return 1.0

        # Compare to typical league average (~3.5 yellows per match)
        league_avg = 3.5
        multiplier = ref_avg / league_avg if league_avg > 0 else 1.0
        return np.clip(multiplier, 0.6, 1.6)

    def _opponent_foul_factor(
        self, opponent: str, team_foul_drawn: Optional[Dict[str, float]]
    ) -> float:
        """Get opponent's foul-drawing tendency factor."""
        if not team_foul_drawn:
            return 1.0

        opp_drawn = team_foul_drawn.get(opponent, 12.0)
        league_avg = np.mean(list(team_foul_drawn.values())) if team_foul_drawn else 12.0

        if league_avg <= 0:
            return 1.0

        factor = opp_drawn / league_avg
        return np.clip(factor, 0.7, 1.4)

    def get_card_magnets(self, team: Optional[str] = None) -> List[Dict]:
        """Get all card magnets, optionally filtered by team."""
        magnets = []
        for t, players in self.profiles.items():
            if team and t != team:
                continue
            for p in players:
                if p.is_card_magnet:
                    magnets.append({
                        "name": p.name,
                        "web_name": p.web_name,
                        "team": p.team,
                        "position": p.position,
                        "yellows_per_90": p.yellows_per_90,
                        "yellow_cards": p.yellow_cards,
                        "minutes": p.minutes,
                        "base_booking_prob": p.base_booking_prob,
                    })

        magnets.sort(key=lambda x: x["yellows_per_90"], reverse=True)
        return magnets


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.fpl_api import fetch_bootstrap_static, build_player_stats

    bootstrap = fetch_bootstrap_static()
    player_stats = build_player_stats(bootstrap)

    model = PlayerCardsModel()
    metrics = model.fit(player_stats)
    print(f"\nModel metrics: {metrics}")

    # Show top card magnets
    magnets = model.get_card_magnets()
    print(f"\nTop 10 card magnets:")
    for m in magnets[:10]:
        print(f"  {m['web_name']} ({m['team']}, {m['position']}): "
              f"{m['yellows_per_90']:.3f} yellows/90, "
              f"{m['yellow_cards']} total yellows")

    # Predict for a match
    pred = model.predict_match("Arsenal", "Tottenham", is_derby=True)
    print(f"\nArsenal vs Tottenham — Top 5 most likely bookings:")
    for b in pred["top_bookings"]:
        print(f"  {b['web_name']} ({b['team']}, {b['position']}): "
              f"P(booked)={b['adjusted_prob']:.1%} "
              f"(base={b['base_prob']:.1%}, magnet={b['is_card_magnet']})")
