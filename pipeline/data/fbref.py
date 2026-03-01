"""
FBref data fetcher via fbrefdata library.
Provides xG, xGA, advanced stats for team and player features.
Falls back gracefully if fbrefdata breaks (HTML scraper fragility).
"""
import logging
from pathlib import Path
from typing import Optional, Tuple

import pandas as pd

from pipeline.config import DATA_RAW, DATA_PROCESSED, CURRENT_SEASON, SEASON_LABELS
from pipeline.data.team_mapping import normalize_team_name

logger = logging.getLogger(__name__)


def fetch_fbref_team_stats(season: str = None, force: bool = False) -> Optional[pd.DataFrame]:
    """
    Fetch team-level xG stats from Understat via soccerdata.

    Returns DataFrame with columns: team, xg, xga, npxg
    (season averages per match, aggregated from match-level data).

    Falls back to cache or returns None if unavailable.
    """
    if season is None:
        season = CURRENT_SEASON

    cache_dir = DATA_PROCESSED / "fbref"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"team_stats_{season}.parquet"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 48:
            logger.info(f"Loading cached Understat team xG stats: {cache_path}")
            return pd.read_parquet(cache_path)

    try:
        from soccerdata import Understat

        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching Understat xG stats for {season_label}...")

        us = Understat(leagues="ENG-Premier League", seasons=season_label)
        match_stats = us.read_team_match_stats()

        if match_stats is not None and len(match_stats) > 0:
            # Build per-team xG averages from both home and away perspectives
            home = match_stats[["home_team", "home_xg", "home_np_xg", "away_xg"]].copy()
            home.columns = ["team", "xg", "npxg", "xga"]

            away = match_stats[["away_team", "away_xg", "away_np_xg", "home_xg"]].copy()
            away.columns = ["team", "xg", "npxg", "xga"]

            team_stats = (
                pd.concat([home, away])
                .groupby("team")[["xg", "xga", "npxg"]]
                .mean()
                .reset_index()
            )
            team_stats["team"] = team_stats["team"].apply(normalize_team_name)

            team_stats.to_parquet(cache_path)
            logger.info(f"Understat xG stats: {len(team_stats)} teams loaded")
            return team_stats

    except ImportError:
        logger.warning("soccerdata not installed. Skipping Understat xG data.")
    except Exception as e:
        logger.warning(f"Understat fetch failed: {e}")

    # Fallback to cache
    if cache_path.exists():
        logger.warning("Using stale xG cache")
        return pd.read_parquet(cache_path)

    logger.warning("No xG data available. Pipeline will proceed without xG features.")
    return None


def fetch_fbref_match_stats(season: str = None, force: bool = False) -> Optional[pd.DataFrame]:
    """
    Fetch match-level stats from FBref (xG per match, shots, possession).
    Returns None if unavailable.
    """
    if season is None:
        season = CURRENT_SEASON

    cache_dir = DATA_PROCESSED / "fbref"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"match_stats_{season}.parquet"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 48:
            return pd.read_parquet(cache_path)

    try:
        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching Understat match stats for {season_label}...")

        from soccerdata import Understat

        us = Understat(leagues="ENG-Premier League", seasons=season_label)
        match_stats = us.read_team_match_stats()

        if match_stats is not None and len(match_stats) > 0:
            match_stats = match_stats.reset_index()
            for col in ["home_team", "away_team"]:
                if col in match_stats.columns:
                    match_stats[col] = match_stats[col].apply(normalize_team_name)

            match_stats.to_parquet(cache_path)
            logger.info(f"Understat match stats: {len(match_stats)} matches loaded")
            return match_stats

    except ImportError:
        logger.warning("soccerdata not installed.")
    except Exception as e:
        logger.warning(f"Understat match stats fetch failed: {e}")

    if cache_path.exists():
        return pd.read_parquet(cache_path)

    return None


def build_xg_features(team_stats: Optional[pd.DataFrame]) -> dict:
    """
    Build xG-based features from FBref data.
    Returns dict of team → {xG_per90, xGA_per90, npxG, ...} or empty dict if no data.
    """
    if team_stats is None:
        return {}

    features = {}
    for _, row in team_stats.iterrows():
        team = row.get("team", row.get("squad", "Unknown"))
        features[team] = {
            "xg": row.get("xg", row.get("xG", None)),
            "xga": row.get("xga", row.get("xGA", None)),
            "npxg": row.get("npxg", row.get("npxG", None)),
            "poss": row.get("poss", row.get("Poss", None)),
        }

    return features


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    team_stats = fetch_fbref_team_stats()
    if team_stats is not None:
        print(f"\nFBref team stats columns: {list(team_stats.columns)}")
        print(team_stats.head())
    else:
        print("FBref data unavailable")
