"""
Referee Profile System.
Builds historical referee stats from Football-Data.co.uk match data.
Fetches upcoming referee assignments from Premier League API.
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import requests

from pipeline.config import DATA_RAW

logger = logging.getLogger(__name__)


@dataclass
class RefereeProfile:
    """Statistical profile for a Premier League referee."""
    name: str
    games_officiated: int = 0
    avg_yellows_per_match: float = 0.0
    avg_reds_per_match: float = 0.0
    avg_fouls_per_match: float = 0.0
    avg_home_yellows: float = 0.0
    avg_away_yellows: float = 0.0
    avg_home_fouls: float = 0.0
    avg_away_fouls: float = 0.0
    std_yellows: float = 0.0
    card_consistency: float = 0.0  # Lower = more consistent
    home_bias_cards: float = 0.0   # Positive = penalizes home more

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "games_officiated": self.games_officiated,
            "avg_yellows_per_match": round(self.avg_yellows_per_match, 3),
            "avg_reds_per_match": round(self.avg_reds_per_match, 3),
            "avg_fouls_per_match": round(self.avg_fouls_per_match, 3),
            "avg_home_yellows": round(self.avg_home_yellows, 3),
            "avg_away_yellows": round(self.avg_away_yellows, 3),
            "avg_home_fouls": round(self.avg_home_fouls, 3),
            "avg_away_fouls": round(self.avg_away_fouls, 3),
            "std_yellows": round(self.std_yellows, 3),
            "card_consistency": round(self.card_consistency, 3),
            "home_bias_cards": round(self.home_bias_cards, 3),
        }


def build_referee_profiles(matches: pd.DataFrame) -> Dict[str, RefereeProfile]:
    """
    Build statistical profiles for all referees from historical match data.

    Args:
        matches: DataFrame from load_all_seasons() with Referee column

    Returns:
        Dict mapping referee name → RefereeProfile
    """
    if "Referee" not in matches.columns:
        logger.warning("No Referee column in match data — skipping referee profiles")
        return {}

    df = matches.dropna(subset=["Referee"]).copy()
    if len(df) == 0:
        logger.warning("No matches with referee data found")
        return {}

    profiles = {}

    for referee, group in df.groupby("Referee"):
        if not referee or referee in ("None", "Nan", ""):
            continue

        n_games = len(group)
        if n_games < 3:
            continue  # Need minimum sample

        # Yellow cards
        total_yellows = group["HY"].fillna(0) + group["AY"].fillna(0)
        home_yellows = group["HY"].fillna(0)
        away_yellows = group["AY"].fillna(0)

        # Red cards
        total_reds = group["HR"].fillna(0) + group["AR"].fillna(0)

        # Fouls
        total_fouls = group["HF"].fillna(0) + group["AF"].fillna(0)
        home_fouls = group["HF"].fillna(0)
        away_fouls = group["AF"].fillna(0)

        avg_yellows = total_yellows.mean()
        std_yellows = total_yellows.std() if n_games > 1 else 0
        avg_home_y = home_yellows.mean()
        avg_away_y = away_yellows.mean()

        # Card consistency: coefficient of variation (lower = more predictable)
        card_consistency = std_yellows / avg_yellows if avg_yellows > 0 else 1.0

        # Home bias: positive means ref penalizes home more than away
        home_bias = avg_home_y - avg_away_y

        profile = RefereeProfile(
            name=referee,
            games_officiated=n_games,
            avg_yellows_per_match=avg_yellows,
            avg_reds_per_match=total_reds.mean(),
            avg_fouls_per_match=total_fouls.mean(),
            avg_home_yellows=avg_home_y,
            avg_away_yellows=avg_away_y,
            avg_home_fouls=home_fouls.mean(),
            avg_away_fouls=away_fouls.mean(),
            std_yellows=std_yellows,
            card_consistency=card_consistency,
            home_bias_cards=home_bias,
        )

        profiles[referee] = profile

    logger.info(f"Built referee profiles for {len(profiles)} referees "
                f"(avg {np.mean([p.games_officiated for p in profiles.values()]):.0f} games each)")

    # Log top card-happy referees
    top_refs = sorted(profiles.values(), key=lambda p: p.avg_yellows_per_match, reverse=True)[:5]
    for ref in top_refs:
        logger.info(f"  {ref.name}: {ref.avg_yellows_per_match:.1f} yellows/game "
                     f"({ref.games_officiated} games)")

    return profiles


def get_referee_multiplier(
    referee_name: Optional[str],
    profiles: Dict[str, RefereeProfile],
) -> float:
    """
    Get a referee card-rate multiplier relative to league average.

    Returns:
        Multiplier > 1 if ref gives more cards than average, < 1 if fewer.
    """
    if not referee_name or not profiles:
        return 1.0

    profile = profiles.get(referee_name)
    if not profile:
        return 1.0

    # League average yellows
    all_avgs = [p.avg_yellows_per_match for p in profiles.values() if p.games_officiated >= 5]
    if not all_avgs:
        return 1.0

    league_avg = np.mean(all_avgs)
    if league_avg <= 0:
        return 1.0

    return profile.avg_yellows_per_match / league_avg


def get_referee_for_upcoming(upcoming_fixtures: pd.DataFrame) -> Dict[str, str]:
    """
    Attempt to fetch referee assignments for upcoming fixtures.

    Tries the Premier League website / FPL API to find referee assignments.
    Returns dict: 'HomeTeam_vs_AwayTeam' → referee name.
    Falls back to empty dict if unavailable.
    """
    assignments = {}

    try:
        # FPL fixtures endpoint sometimes includes referee info
        cache_dir = DATA_RAW / "fpl"
        cache_path = cache_dir / "fixtures.json"
        if cache_path.exists():
            import json
            fixtures = json.loads(cache_path.read_text())
            # FPL doesn't consistently include referee, but check
            for fix in fixtures:
                if fix.get("event") and not fix.get("finished"):
                    # FPL API doesn't have referee field, but some third-party
                    # overlays add it. For now, we rely on historical profiles
                    pass

    except Exception as e:
        logger.debug(f"Referee assignment fetch failed: {e}")

    # Fallback: try scraping premierleague.com match centre
    try:
        url = "https://www.premierleague.com/match/list"
        resp = requests.get(url, timeout=10, headers={
            "User-Agent": "Mozilla/5.0"
        })
        # Note: PL website requires JavaScript rendering, so this is a
        # best-effort scrape. In production, use a headless browser or
        # wait for official API support.
        if resp.status_code == 200:
            # Parse referee names from match detail pages
            # This is fragile and may need updating each season
            pass
    except Exception as e:
        logger.debug(f"PL website referee scrape failed: {e}")

    if assignments:
        logger.info(f"Fetched {len(assignments)} referee assignments")
    else:
        logger.info("No upcoming referee assignments available — using historical profiles")

    return assignments


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.football_data import load_all_seasons

    matches = load_all_seasons()
    profiles = build_referee_profiles(matches)

    print(f"\n{len(profiles)} referees profiled")
    for name, prof in sorted(profiles.items(), key=lambda x: x[1].avg_yellows_per_match, reverse=True)[:10]:
        print(f"  {name:25s}  yellows={prof.avg_yellows_per_match:.1f}  "
              f"reds={prof.avg_reds_per_match:.2f}  fouls={prof.avg_fouls_per_match:.1f}  "
              f"games={prof.games_officiated}")
