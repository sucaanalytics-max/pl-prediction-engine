"""
Football-Data.co.uk CSV fetcher.
Downloads Premier League match data with results, shots, corners, cards, odds.
"""
import logging
from pathlib import Path
from typing import Optional

import pandas as pd
import requests

from pipeline.config import (
    DATA_RAW, FOOTBALL_DATA_URL, FOOTBALL_DATA_SEASONS, SEASONS
)
from pipeline.data.team_mapping import normalize_team_name

logger = logging.getLogger(__name__)

# Columns we care about from the CSV
REQUIRED_COLS = [
    "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR",
    "HTHG", "HTAG", "HTR",
    "HS", "AS", "HST", "AST",  # Shots, shots on target
    "HF", "AF",                 # Fouls
    "HC", "AC",                 # Corners
    "HY", "AY", "HR", "AR",    # Cards
]

ODDS_COLS = [
    "B365H", "B365D", "B365A",             # Bet365 1X2
    "PSH", "PSD", "PSA",                   # Pinnacle 1X2
    "AvgH", "AvgD", "AvgA",               # Market average 1X2
    "Avg>2.5", "Avg<2.5",                  # Over/Under 2.5
]


def fetch_season_csv(season_code: str, force: bool = False) -> pd.DataFrame:
    """
    Download E0.csv for a given season from Football-Data.co.uk.

    Args:
        season_code: e.g. "2324" for 2023-24
        force: Re-download even if cached

    Returns:
        DataFrame with match data
    """
    cache_dir = DATA_RAW / "football_data"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"E0_{season_code}.csv"

    if cache_path.exists() and not force:
        logger.info(f"Loading cached Football-Data CSV: {cache_path}")
        return pd.read_csv(cache_path, encoding="latin-1")

    url = FOOTBALL_DATA_URL.format(season=season_code)
    logger.info(f"Fetching Football-Data CSV: {url}")

    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error(f"Failed to fetch {url}: {e}")
        if cache_path.exists():
            logger.warning("Falling back to stale cache")
            return pd.read_csv(cache_path, encoding="latin-1")
        raise

    cache_path.write_bytes(resp.content)
    return pd.read_csv(cache_path, encoding="latin-1")


def clean_football_data(df: pd.DataFrame, season_code: str) -> pd.DataFrame:
    """
    Clean and standardize a Football-Data CSV.

    - Parse dates
    - Normalize team names
    - Cast numeric columns
    - Add season label and match_id
    """
    df = df.copy()

    # Parse date (Football-Data uses DD/MM/YYYY or DD/MM/YY)
    df["Date"] = pd.to_datetime(df["Date"], dayfirst=True, format="mixed")

    # Normalize team names
    df["HomeTeam"] = df["HomeTeam"].apply(normalize_team_name)
    df["AwayTeam"] = df["AwayTeam"].apply(normalize_team_name)

    # Cast score columns to int (drop rows with missing scores = unplayed)
    score_cols = ["FTHG", "FTAG", "HTHG", "HTAG"]
    for col in score_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["FTHG", "FTAG"])
    for col in score_cols:
        if col in df.columns:
            df[col] = df[col].astype(int)

    # Cast stats columns
    stat_cols = ["HS", "AS", "HST", "AST", "HF", "AF", "HC", "AC", "HY", "AY", "HR", "AR"]
    for col in stat_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Cast odds columns
    for col in ODDS_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Add metadata
    df["season"] = season_code
    df["match_id"] = df.apply(
        lambda r: f"{r['Date'].strftime('%Y%m%d')}_{r['HomeTeam']}_{r['AwayTeam']}",
        axis=1,
    )

    # Sort by date
    df = df.sort_values("Date").reset_index(drop=True)

    return df


def load_all_seasons(seasons: Optional[list] = None, force: bool = False) -> pd.DataFrame:
    """
    Load and merge all seasons into a single DataFrame.

    Args:
        seasons: List of season codes, e.g. ["2324", "2425", "2526"]
        force: Force re-download

    Returns:
        Combined DataFrame sorted by date
    """
    if seasons is None:
        seasons = SEASONS

    frames = []
    for season in seasons:
        code = FOOTBALL_DATA_SEASONS.get(season, season)
        try:
            raw = fetch_season_csv(code, force=force)
            cleaned = clean_football_data(raw, season)
            frames.append(cleaned)
            logger.info(f"Season {season}: {len(cleaned)} matches loaded")
        except Exception as e:
            logger.error(f"Failed to load season {season}: {e}")

    if not frames:
        raise RuntimeError("No seasons loaded successfully")

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.sort_values("Date").reset_index(drop=True)

    logger.info(f"Total matches loaded: {len(combined)}")
    return combined


def extract_odds_benchmark(df: pd.DataFrame) -> pd.DataFrame:
    """
    Extract bookmaker odds as benchmark (NOT for model training).
    Converts decimal odds to implied probabilities.
    """
    odds_df = df[["match_id", "Date", "HomeTeam", "AwayTeam"]].copy()

    # Pinnacle odds preferred, fallback to Bet365, then average
    for suffix, label in [("PS", "pinnacle"), ("B365", "bet365"), ("Avg", "market_avg")]:
        h_col, d_col, a_col = f"{suffix}H", f"{suffix}D", f"{suffix}A"
        if all(c in df.columns for c in [h_col, d_col, a_col]):
            total = 1 / df[h_col] + 1 / df[d_col] + 1 / df[a_col]
            odds_df[f"implied_home_{label}"] = (1 / df[h_col]) / total
            odds_df[f"implied_draw_{label}"] = (1 / df[d_col]) / total
            odds_df[f"implied_away_{label}"] = (1 / df[a_col]) / total
            odds_df[f"odds_home_{label}"] = df[h_col]
            odds_df[f"odds_draw_{label}"] = df[d_col]
            odds_df[f"odds_away_{label}"] = df[a_col]

    # Over/Under 2.5 if available
    if "Avg>2.5" in df.columns and "Avg<2.5" in df.columns:
        total_ou = 1 / df["Avg>2.5"] + 1 / df["Avg<2.5"]
        odds_df["implied_over25"] = (1 / df["Avg>2.5"]) / total_ou
        odds_df["implied_under25"] = (1 / df["Avg<2.5"]) / total_ou

    return odds_df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    df = load_all_seasons()
    print(f"\nLoaded {len(df)} matches")
    print(f"Columns: {list(df.columns)}")
    print(f"\nSample:\n{df.tail(3)}")
