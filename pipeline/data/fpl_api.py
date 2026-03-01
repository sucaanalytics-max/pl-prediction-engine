"""
Fantasy Premier League API client.
Fetches player stats, fixtures, injuries, and form data.
"""
import json
import logging
from pathlib import Path
from typing import Optional

import pandas as pd
import requests

from pipeline.config import (
    DATA_RAW, FPL_BOOTSTRAP, FPL_FIXTURES, FPL_ELEMENT_SUMMARY
)
from pipeline.data.team_mapping import normalize_team_name, update_fpl_team_map

logger = logging.getLogger(__name__)


def fetch_bootstrap_static(force: bool = False) -> dict:
    """
    Fetch FPL bootstrap-static endpoint.
    Contains all players, teams, events (gameweeks), and game settings.
    """
    cache_dir = DATA_RAW / "fpl"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "bootstrap_static.json"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 12:
            logger.info("Loading cached FPL bootstrap-static")
            return json.loads(cache_path.read_text())

    logger.info("Fetching FPL bootstrap-static...")
    try:
        resp = requests.get(FPL_BOOTSTRAP, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        cache_path.write_text(json.dumps(data))
        return data
    except requests.RequestException as e:
        logger.error(f"FPL API error: {e}")
        if cache_path.exists():
            logger.warning("Falling back to stale cache")
            return json.loads(cache_path.read_text())
        raise


def fetch_fixtures(force: bool = False) -> list:
    """Fetch all FPL fixtures for the season."""
    cache_dir = DATA_RAW / "fpl"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "fixtures.json"

    if cache_path.exists() and not force:
        age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
        if age_hours < 1:
            return json.loads(cache_path.read_text())

    logger.info("Fetching FPL fixtures...")
    try:
        resp = requests.get(FPL_FIXTURES, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        cache_path.write_text(json.dumps(data))
        return data
    except requests.RequestException as e:
        logger.error(f"FPL fixtures error: {e}")
        if cache_path.exists():
            return json.loads(cache_path.read_text())
        raise


def get_current_gameweek(bootstrap: dict) -> int:
    """Determine current gameweek from events data."""
    events = bootstrap.get("events", [])
    for event in events:
        if event.get("is_current", False):
            return event["id"]
    # Fallback: find next unfinished gameweek
    for event in events:
        if not event.get("finished", False):
            return event["id"]
    return max(e["id"] for e in events)


def get_upcoming_fixtures(bootstrap: dict, fixtures: list) -> pd.DataFrame:
    """
    Get fixtures for the next gameweek.
    Returns DataFrame with home_team, away_team, kickoff, difficulty.
    """
    import datetime

    now = pd.Timestamp.utcnow().tz_localize(None)

    def is_upcoming(fix: dict) -> bool:
        """True if the match hasn't started yet (90-min buffer) and isn't marked finished."""
        if fix.get("finished"):
            return False
        kickoff = fix.get("kickoff_time")
        if kickoff:
            kt = pd.Timestamp(kickoff).tz_localize(None) if pd.Timestamp(kickoff).tzinfo is None else pd.Timestamp(kickoff).tz_convert(None)
            return kt > now - pd.Timedelta(minutes=90)
        return True

    gw = get_current_gameweek(bootstrap)
    team_map = update_fpl_team_map(bootstrap["teams"])

    upcoming = [f for f in fixtures if f.get("event") == gw and is_upcoming(f)]
    if not upcoming:
        # Current GW fully played — move to next
        upcoming = [f for f in fixtures if f.get("event") == gw + 1 and is_upcoming(f)]
        if upcoming:
            gw = gw + 1

    rows = []
    for fix in upcoming:
        rows.append({
            "gameweek": fix.get("event", gw),
            "home_team": team_map.get(fix["team_h"], f"Team {fix['team_h']}"),
            "away_team": team_map.get(fix["team_a"], f"Team {fix['team_a']}"),
            "kickoff": fix.get("kickoff_time"),
            "home_difficulty": fix.get("team_h_difficulty"),
            "away_difficulty": fix.get("team_a_difficulty"),
        })

    return pd.DataFrame(rows)


def build_player_stats(bootstrap: dict) -> pd.DataFrame:
    """
    Build player-level feature table from FPL bootstrap data.
    """
    players = bootstrap.get("elements", [])
    team_map = update_fpl_team_map(bootstrap["teams"])
    element_types = {et["id"]: et["singular_name_short"] for et in bootstrap.get("element_types", [])}

    rows = []
    for p in players:
        rows.append({
            "player_id": p["id"],
            "name": f"{p['first_name']} {p['second_name']}",
            "web_name": p["web_name"],
            "team_id": p["team"],
            "team": team_map.get(p["team"], f"Team {p['team']}"),
            "position": element_types.get(p["element_type"], "UNK"),
            "now_cost": p["now_cost"] / 10,  # Convert to millions
            "total_points": p["total_points"],
            "minutes": p["minutes"],
            "goals_scored": p["goals_scored"],
            "assists": p["assists"],
            "clean_sheets": p["clean_sheets"],
            "yellow_cards": p["yellow_cards"],
            "red_cards": p["red_cards"],
            "form": float(p.get("form", 0)),
            "points_per_game": float(p.get("points_per_game", 0)),
            "selected_by_percent": float(p.get("selected_by_percent", 0)),
            "ict_index": float(p.get("ict_index", 0)),
            "influence": float(p.get("influence", 0)),
            "creativity": float(p.get("creativity", 0)),
            "threat": float(p.get("threat", 0)),
            "expected_goals": float(p.get("expected_goals", 0)),
            "expected_assists": float(p.get("expected_assists", 0)),
            "expected_goal_involvements": float(p.get("expected_goal_involvements", 0)),
            "bonus": p.get("bonus", 0),
            "bps": p.get("bps", 0),
            "chance_of_playing": p.get("chance_of_playing_next_round"),
            "news": p.get("news", ""),
            "status": p.get("status", "a"),  # a=available, i=injured, etc.
        })

    df = pd.DataFrame(rows)

    # Derived features
    df["goals_per_90"] = df.apply(
        lambda r: r["goals_scored"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
        axis=1
    )
    df["xg_per_90"] = df.apply(
        lambda r: r["expected_goals"] / (r["minutes"] / 90) if r["minutes"] > 0 else 0,
        axis=1
    )
    df["available"] = df["status"].isin(["a", "d"])  # available or doubtful

    return df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    bootstrap = fetch_bootstrap_static()
    fixtures = fetch_fixtures()

    gw = get_current_gameweek(bootstrap)
    print(f"Current gameweek: {gw}")

    upcoming = get_upcoming_fixtures(bootstrap, fixtures)
    print(f"\nUpcoming fixtures:\n{upcoming}")

    players = build_player_stats(bootstrap)
    print(f"\nPlayers loaded: {len(players)}")
    print(players.sort_values("total_points", ascending=False).head(10)[
        ["web_name", "team", "position", "total_points", "form", "expected_goals"]
    ])
