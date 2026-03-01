"""
FBref data fetcher via soccerdata / Understat library.
Provides xG, xGA, advanced stats for team and player features.
Now also fetches passing stats (completion %, progressive passes, key passes).
Falls back gracefully if data source breaks.
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


def fetch_fbref_passing_stats(season: str = None, force: bool = False) -> Optional[pd.DataFrame]:
    """
    Fetch team-level passing stats from FBref via fbrefdata.

    Returns DataFrame with columns per team:
        - pass_completion_pct, progressive_passes, key_passes
        - passes_into_final_third, crosses

    Falls back gracefully if unavailable.
    """
    if season is None:
        season = CURRENT_SEASON

    cache_dir = DATA_PROCESSED / "fbref"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"passing_stats_{season}.parquet"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 48:
            logger.info(f"Loading cached FBref passing stats: {cache_path}")
            return pd.read_parquet(cache_path)

    try:
        from fbrefdata import FBref

        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching FBref passing stats for {season_label}...")

        fb = FBref()
        passing = fb.read_team_season_stats(
            "ENG-Premier League", season_label, stat_type="passing"
        )

        if passing is not None and len(passing) > 0:
            passing = passing.reset_index()

            # Normalize column names (FBref columns vary)
            col_map = {}
            for col in passing.columns:
                col_lower = str(col).lower().replace(" ", "_")
                if "cmp%" in col_lower or "completion" in col_lower:
                    col_map[col] = "pass_completion_pct"
                elif "prgp" in col_lower or "progressive_passes" in col_lower:
                    col_map[col] = "progressive_passes"
                elif "kp" in col_lower or "key_passes" in col_lower:
                    col_map[col] = "key_passes"
                elif "1/3" in col_lower or "final_third" in col_lower:
                    col_map[col] = "passes_into_final_third"
                elif "crspa" in col_lower or "crosses" in col_lower:
                    col_map[col] = "crosses"
                elif "squad" in col_lower or "team" in col_lower:
                    col_map[col] = "team"

            passing = passing.rename(columns=col_map)

            # Ensure team column exists
            if "team" not in passing.columns:
                passing = passing.rename(columns={passing.columns[0]: "team"})

            passing["team"] = passing["team"].apply(normalize_team_name)

            # Keep only relevant columns
            keep_cols = ["team"]
            for c in ["pass_completion_pct", "progressive_passes", "key_passes",
                       "passes_into_final_third", "crosses"]:
                if c in passing.columns:
                    keep_cols.append(c)

            passing = passing[keep_cols].copy()
            passing.to_parquet(cache_path)
            logger.info(f"FBref passing stats: {len(passing)} teams, cols={list(passing.columns)}")
            return passing

    except ImportError:
        logger.warning("fbrefdata not installed. Skipping passing stats.")
    except Exception as e:
        logger.warning(f"FBref passing stats fetch failed: {e}")

    if cache_path.exists():
        logger.warning("Using stale passing stats cache")
        return pd.read_parquet(cache_path)

    logger.warning("No passing data available. Pipeline continues without passing features.")
    return None


def fetch_fbref_match_stats(season: str = None, force: bool = False) -> Optional[pd.DataFrame]:
    """
    Fetch match-level stats from Understat (xG per match, shots, possession).
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
    Returns dict of team -> {xg, xga, npxg, poss} or empty dict if no data.
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


def build_advanced_features(
    team_stats: Optional[pd.DataFrame],
    passing_stats: Optional[pd.DataFrame] = None,
) -> dict:
    """
    Build advanced features combining xG + passing data.

    Returns dict of team -> {
        xg, xga, npxg, poss,
        pass_completion_pct, progressive_passes, key_passes,
        passes_into_final_third, crosses
    }
    """
    features = build_xg_features(team_stats)

    if passing_stats is not None:
        for _, row in passing_stats.iterrows():
            team = row.get("team", "Unknown")
            if team not in features:
                features[team] = {}

            for col in ["pass_completion_pct", "progressive_passes", "key_passes",
                        "passes_into_final_third", "crosses"]:
                if col in row.index and pd.notna(row[col]):
                    features[team][col] = float(row[col])

        logger.info(f"Advanced features built for {len(features)} teams "
                     f"(passing data for {len(passing_stats)} teams)")

    return features


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    team_stats = fetch_fbref_team_stats()
    if team_stats is not None:
        print(f"\nFBref team stats columns: {list(team_stats.columns)}")
        print(team_stats.head())

    passing = fetch_fbref_passing_stats()
    if passing is not None:
        print(f"\nPassing stats columns: {list(passing.columns)}")
        print(passing.head())

    features = build_advanced_features(team_stats, passing)
    if features:
        sample_team = next(iter(features))
        print(f"\nSample features for {sample_team}: {features[sample_team]}")
