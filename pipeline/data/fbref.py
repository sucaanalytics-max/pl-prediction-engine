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
    Fetch team-level advanced stats from FBref via fbrefdata.

    Returns DataFrame with columns like:
        team, xG, xGA, npxG, poss, progressive_passes, pressures, etc.

    Returns None if fbrefdata fails (with warning).
    """
    if season is None:
        season = CURRENT_SEASON

    cache_dir = DATA_PROCESSED / "fbref"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"team_stats_{season}.parquet"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 48:  # FBref data updates less frequently
            logger.info(f"Loading cached FBref team stats: {cache_path}")
            return pd.read_parquet(cache_path)

    try:
        import fbrefdata as fbd

        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching FBref team stats for {season_label}...")

        # fbrefdata API - fetch team season stats
        loader = fbd.FBref(leagues="ENG-Premier League", seasons=season_label)

        # Try to get team stats
        team_stats = loader.read_team_season_stats(stat_type="standard")

        if team_stats is not None and len(team_stats) > 0:
            # Normalize team names
            if "team" in team_stats.columns:
                team_stats["team"] = team_stats["team"].apply(normalize_team_name)
            elif "squad" in team_stats.columns:
                team_stats["team"] = team_stats["squad"].apply(normalize_team_name)

            team_stats.to_parquet(cache_path)
            logger.info(f"FBref team stats: {len(team_stats)} teams loaded")
            return team_stats

    except ImportError:
        logger.warning("fbrefdata not installed. Skipping FBref data.")
    except Exception as e:
        logger.warning(f"FBref fetch failed (likely HTML change): {e}")

    # Fallback to cache
    if cache_path.exists():
        logger.warning("Using stale FBref cache")
        return pd.read_parquet(cache_path)

    logger.warning("No FBref data available. Pipeline will proceed without xG features.")
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
        import fbrefdata as fbd

        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching FBref match stats for {season_label}...")

        loader = fbd.FBref(leagues="ENG-Premier League", seasons=season_label)

        # Try match logs
        match_stats = loader.read_schedule()

        if match_stats is not None and len(match_stats) > 0:
            # Normalize team names
            for col in ["home_team", "away_team", "squad"]:
                if col in match_stats.columns:
                    match_stats[col] = match_stats[col].apply(normalize_team_name)

            match_stats.to_parquet(cache_path)
            logger.info(f"FBref match stats: {len(match_stats)} matches loaded")
            return match_stats

    except ImportError:
        logger.warning("fbrefdata not installed.")
    except Exception as e:
        logger.warning(f"FBref match stats fetch failed: {e}")

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
