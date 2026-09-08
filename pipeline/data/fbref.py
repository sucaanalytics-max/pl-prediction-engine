"""
FBref and Understat team-level data.

Two libraries, deliberately: `soccerdata` for Understat, and `fbrefdata` for the
FBref passing table, which soccerdata's reader does not expose. See the comment
in `fetch_fbref_passing_stats` for why both are here.
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


#: FBref's passing table, as the columns this code needs are actually spelled.
#:
#: The table arrives with a two-level column index — ("Total", "Cmp%"), ("Short",
#: "Cmp%"), ("", "KP") — and the mapping is keyed on the level that carries the
#: meaning, with the group named where the group matters.
#:
#: Exact keys, not substrings, and that is the whole point of this table. The
#: substring scan this replaced tested `"cmp%" in column`, which is true of
#: ("Total","Cmp%") AND ("Short","Cmp%") AND ("Medium","Cmp%") AND ("Long","Cmp%")
#: — so four columns were renamed to `pass_completion_pct`, and a frame with four
#: identically named columns hands `float(row[col])` a Series. It also matched
#: "kp" inside any column containing those two letters. None of this ever fired
#: because the fetch above raised before reaching it.
_PASSING_COLUMNS = {
    ("Total", "Cmp%"): "pass_completion_pct",
    ("", "PrgP"): "progressive_passes",
    ("", "KP"): "key_passes",
    ("", "1/3"): "passes_into_final_third",
    ("", "CrsPA"): "crosses",
}

#: What a team column can be called, in order of preference. `reset_index()` on
#: an fbrefdata frame yields `team` from the index; `Squad` is what the scraped
#: table itself calls it.
_TEAM_COLUMNS = ("team", "Squad", "squad")

#: Published for the caller and for the test, so neither restates the list.
PASSING_FEATURES = (
    "pass_completion_pct", "progressive_passes", "key_passes",
    "passes_into_final_third", "crosses",
)


def _column_key(column) -> Tuple[str, str]:
    """One column's (group, name), whether the frame's columns are flat or not."""
    if isinstance(column, tuple):
        parts = [str(p).strip() for p in column]
        parts = [p for p in parts if p and not p.startswith("Unnamed:")]
        if not parts:
            return ("", "")
        if len(parts) == 1:
            return ("", parts[0])
        return (parts[-2], parts[-1])
    return ("", str(column).strip())


def select_passing_columns(frame: pd.DataFrame) -> pd.DataFrame:
    """
    A flat frame of `team` plus whichever passing features FBref supplied.

    Pure, and separate from the fetch so that the mapping is testable without a
    network call — which matters more than usual here, because the fetch has
    never once succeeded, so nothing downstream of it has ever run.

    A feature FBref did not send is simply absent: `build_advanced_features`
    treats a missing column and a null the same way, and inventing a zero for a
    pass-completion percentage would be a fabricated measurement.
    """
    out = pd.DataFrame(index=frame.index)

    team = None
    for column in frame.columns:
        group, name = _column_key(column)
        if name in _TEAM_COLUMNS and team is None:
            team = frame[column]
    if team is None:
        # The first column, which after `reset_index()` is the leftmost index
        # level. Named rather than silently accepted: if this is what happens,
        # the frame is not shaped the way this function expects.
        logger.warning(
            "FBref passing frame has no team column; falling back to %r",
            frame.columns[0],
        )
        team = frame[frame.columns[0]]
    out["team"] = team.astype(str)

    seen = set()
    for column in frame.columns:
        target = _PASSING_COLUMNS.get(_column_key(column))
        if target is None or target in seen:
            continue
        out[target] = pd.to_numeric(frame[column], errors="coerce")
        seen.add(target)

    missing = [f for f in PASSING_FEATURES if f not in out.columns]
    if missing:
        logger.info("FBref passing table did not carry: %s", ", ".join(missing))
    return out


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
        # `fbrefdata`, and deliberately NOT `soccerdata`, which the rest of this
        # repo uses. soccerdata's FBref reader offers five stat types — standard,
        # keeper, shooting, playing_time, misc — and `passing` is not among them,
        # so it cannot answer this function's question at all. fbrefdata offers
        # eleven, passing included. Two scraping libraries is the price of the
        # only one that has the table.
        #
        # NO LONGER DECLARED IN pipeline/requirements.txt, so this import now
        # raises everywhere and this function always returns None. That is the
        # intended state, not a regression — see the requirements comment. In
        # short: `fbrefdata==0.4.1` caps `rich<14`, `soccerdata>=1.9` needs
        # `rich>=14`, and holding fbrefdata pinned soccerdata at 1.8.2, whose
        # Understat parser is broken. That cost the player-events artifact and the
        # team-level xG features — both of which come from Understat through
        # soccerdata — to keep a passing fetch that `test_fbref_passing.py`
        # records as never having completed once.
        #
        # Kept rather than deleted because the column mapping below is tested and
        # correct, and is the half worth keeping if a source for the table ever
        # arrives. Restoring it means finding one that does not cap rich.
        from fbrefdata import FBref

        season_label = SEASON_LABELS.get(season, f"20{season[:2]}-{season[2:]}")
        logger.info(f"Fetching FBref passing stats for {season_label}...")

        # League and season belong to the CONSTRUCTOR; `read_team_season_stats`
        # takes only `(stat_type, opponent_stats)`. The call here used to pass
        # the league and season positionally into those two slots and then repeat
        # `stat_type` as a keyword, which raises TypeError for a duplicate
        # argument — swallowed by the generic `except Exception` below, which is
        # why this source has never once returned a row. A bare `FBref()` was the
        # third bug in the same three lines: with no leagues or seasons it does
        # not know what to read.
        fb = FBref(leagues="ENG-Premier League", seasons=season_label)
        passing = fb.read_team_season_stats(stat_type="passing")

        if passing is not None and len(passing) > 0:
            passing = select_passing_columns(passing.reset_index())
            passing["team"] = passing["team"].apply(normalize_team_name)
            passing.to_parquet(cache_path)
            logger.info(f"FBref passing stats: {len(passing)} teams, cols={list(passing.columns)}")
            return passing

    except ImportError as exc:
        # Expected on every interpreter now, CI included: the package was removed
        # from requirements because it pinned soccerdata to a version that cannot
        # read Understat. Logged at INFO rather than WARNING so it stops competing
        # for attention with failures that are not deliberate.
        logger.info(
            "fbrefdata is not installed (%s); passing stats are not collected. "
            "Removed deliberately — it capped rich<14 and held soccerdata at "
            "1.8.2, whose Understat parser is broken.",
            exc,
        )
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
