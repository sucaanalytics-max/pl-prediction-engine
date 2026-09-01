"""
Fantasy Premier League API client.
Fetches player stats, fixtures, injuries, and form data.
"""
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import pandas as pd

from pipeline.config import (
    DATA_RAW, FPL_BOOTSTRAP, FPL_FIXTURES, FPL_ELEMENT_SUMMARY,
    PLAYER_TEAM_OVERRIDES, EXCLUDED_PLAYERS,
)
from pipeline.data.team_mapping import normalize_team_name, update_fpl_team_map
from pipeline.utils import fetch_with_retry

logger = logging.getLogger(__name__)


SOURCE_NETWORK = "network"
SOURCE_FRESH_CACHE = "cache"
SOURCE_STALE_CACHE = "stale_cache"

# Provenance describing where a fetched payload actually came from.
Provenance = Dict[str, Any]


def _cache_age_seconds(cache_path: Path) -> float:
    """Age of a cache file in seconds, computed consistently in UTC."""
    mtime = pd.Timestamp(cache_path.stat().st_mtime, unit="s", tz="UTC")
    return (pd.Timestamp.now(tz="UTC") - mtime).total_seconds()


def _fetch_cached_json(
    url: str,
    cache_path: Path,
    ttl_hours: float,
    force: bool,
    allow_stale: bool,
    label: str,
) -> Tuple[Any, Provenance]:
    """
    Fetch JSON from `url`, caching to `cache_path` with a `ttl_hours` freshness window.

    Returns ``(data, provenance)`` where ``provenance["source"]`` is one of
    ``"network"``, ``"cache"`` (fresh, inside the TTL) or ``"stale_cache"``.

    The two flags are independent and compose:

    * ``force=True``      — ignore the cache entirely and require a live fetch.
    * ``allow_stale=False`` — a network failure raises instead of silently
      serving an arbitrarily old cache.

    Any caller that timestamps a forecast MUST pass both. A stale bootstrap on
    deadline day — exactly when the FPL API is most likely to fail — otherwise
    produces a permanent record built on stale prices, a stale
    ``chance_of_playing`` and a stale ``deadline_time``, with nothing in the
    artifact revealing it. The GitHub Actions cache compounds this: its
    ``restore-keys`` prefix has no run pin, so the restored cache can be
    arbitrarily old.
    """
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    if cache_path.exists() and not force:
        age = _cache_age_seconds(cache_path)
        if age < ttl_hours * 3600:
            logger.info("Loading cached %s (age %.0fs)", label, age)
            return json.loads(cache_path.read_text()), {
                "source": SOURCE_FRESH_CACHE,
                "age_seconds": age,
                "url": url,
            }

    logger.info("Fetching %s...", label)
    try:
        resp = fetch_with_retry(url, max_retries=3, timeout=30)
        data = resp.json()
        cache_path.write_text(json.dumps(data))
        return data, {"source": SOURCE_NETWORK, "age_seconds": 0.0, "url": url}
    except Exception as exc:
        logger.error("%s fetch error: %s", label, exc)
        if not allow_stale:
            # Fail loudly. The caller has declared that a stale payload would
            # be worse than no payload.
            raise
        if cache_path.exists():
            age = _cache_age_seconds(cache_path)
            logger.warning(
                "Falling back to stale %s cache (age %.0fs)", label, age
            )
            return json.loads(cache_path.read_text()), {
                "source": SOURCE_STALE_CACHE,
                "age_seconds": age,
                "url": url,
            }
        raise


def fetch_bootstrap_static_with_provenance(
    force: bool = False, allow_stale: bool = True
) -> Tuple[dict, Provenance]:
    """As :func:`fetch_bootstrap_static`, also returning fetch provenance."""
    return _fetch_cached_json(
        FPL_BOOTSTRAP,
        DATA_RAW / "fpl" / "bootstrap_static.json",
        ttl_hours=12,
        force=force,
        allow_stale=allow_stale,
        label="FPL bootstrap-static",
    )


def fetch_bootstrap_static(force: bool = False, allow_stale: bool = True) -> dict:
    """
    Fetch FPL bootstrap-static endpoint.
    Contains all players, teams, events (gameweeks), and game settings.
    """
    data, _ = fetch_bootstrap_static_with_provenance(
        force=force, allow_stale=allow_stale
    )
    return data


def fetch_fixtures_with_provenance(
    force: bool = False, allow_stale: bool = True
) -> Tuple[list, Provenance]:
    """As :func:`fetch_fixtures`, also returning fetch provenance."""
    return _fetch_cached_json(
        FPL_FIXTURES,
        DATA_RAW / "fpl" / "fixtures.json",
        ttl_hours=1,
        force=force,
        allow_stale=allow_stale,
        label="FPL fixtures",
    )


def fetch_fixtures(force: bool = False, allow_stale: bool = True) -> list:
    """Fetch all FPL fixtures for the season."""
    data, _ = fetch_fixtures_with_provenance(force=force, allow_stale=allow_stale)
    return data


def get_current_gameweek(bootstrap: dict) -> int:
    """
    The gameweek FPL currently calls current — the one being SCORED.

    Correct for anything retrospective (settling a week, reviewing a decision).
    Deliberately NOT the answer for anything forward-looking: see
    :func:`planning_gameweek`, and never swap one for the other here.
    """
    events = bootstrap.get("events", [])
    for event in events:
        if event.get("is_current", False):
            return event["id"]
    # Fallback: find next unfinished gameweek
    for event in events:
        if not event.get("finished", False):
            return event["id"]
    return max(e["id"] for e in events)


def planning_gameweek(bootstrap: dict, now: pd.Timestamp | None = None) -> int:
    """
    The gameweek a squad is being PICKED for. Never a week already locked.

    FPL keeps an event ``is_current`` from its own deadline until the NEXT one, so
    for the days between a gameweek's last match and the following deadline
    :func:`get_current_gameweek` names a week already played. Anything
    forward-looking that trusts it points at the past.

    Measured on 2026-08-26: ``is_current`` was GW1, played five days earlier,
    while the squad being priced was GW2's. ``get_upcoming_fixtures`` already
    rolls past it internally and returns GW2's matches, but
    ``run_pipeline`` stamped the un-rolled scalar beside them — so every
    prediction row for GW2's fixtures carried ``gameweek: 1``.

    The frontend answers this with ``planningEventId`` in
    ``frontend/lib/fpl-live-server.ts``; the two must agree, and
    ``test_planning_gameweek.py`` pins the same cases that file's test does.
    """
    if now is None:
        now = pd.Timestamp.now(tz="UTC")
    events = bootstrap.get("events", [])
    if not events:
        # The id becomes a fixture filter and a request path segment. A loud 1 is
        # better than a NaN that fails silently downstream.
        return 1

    def deadline(event: dict) -> pd.Timestamp | None:
        raw = event.get("deadline_time")
        if not raw:
            return None
        try:
            ts = pd.Timestamp(raw)
        except (ValueError, TypeError):
            return None
        if ts is pd.NaT or pd.isna(ts):
            return None
        return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")

    anchor = next((e for e in events if e.get("is_current")), None)
    if anchor is None:
        anchor = next((e for e in events if e.get("is_next")), None)
    if anchor is None:
        anchor = next((e for e in events if not e.get("finished")), None)
    if anchor is None:
        return max(e["id"] for e in events)

    at = deadline(anchor)
    # No parseable deadline is no EVIDENCE the week has closed. Rolling forward on
    # a guess would aim the whole run at a week that may not be next.
    if at is None or now < at:
        return anchor["id"]

    later = [e for e in events
             if (d := deadline(e)) is not None and d > now]
    if later:
        return min(later, key=lambda e: e["id"])["id"]
    # Past the last deadline of the season: clamp rather than invent a GW39.
    return max(e["id"] for e in events)


def gameweek_of_upcoming(
    upcoming: "pd.DataFrame",
    bootstrap: dict,
    now: "pd.Timestamp | None" = None,
) -> int:
    """
    The gameweek the upcoming-fixture rows actually belong to.

    ## Why this is read off the rows instead of computed

    The scalar stamped on every prediction used to be resolved in PARALLEL with the
    fixture list, and the two disagreed twice, in opposite directions:

    - `get_current_gameweek` LAGS. An event stays `is_current` from its own deadline
      until the next one, so between a week's last match and the following deadline it
      names a week already played while these rows hold the next week's. Every GW2
      prediction carried `gameweek: 1`.
    - `planning_gameweek` LEADS. It rolls forward at the deadline, which is right for
      "what am I picking a squad for" and wrong here, because a week's fixtures are
      still upcoming for the two or three days between its deadline and its last match.
      `matchweek_3.json` was written 21 minutes after GW2's deadline and stamped
      `gameweek: 3` onto GW2's own fixtures.

    No clock rule reconciles two independent answers. `get_upcoming_fixtures` has
    already decided which week it is returning and stamps each row with that week's own
    `event`, so the scalar is READ OFF the rows and the disagreement becomes impossible
    rather than unlikely.

    The mode rather than the first row: `get_upcoming_fixtures` filters to a single
    event, so every row should agree — but a fixture postponed into another week is the
    shape that would break that, and the dominant week is a better answer than whichever
    row happened to sort first.

    Falls back to :func:`planning_gameweek` only when the rows cannot answer at all — no
    upcoming fixtures, or none carrying a gameweek. That is the question `planning_gameweek`
    is genuinely good at, and it is the same fallback the caller wants when the season has
    run out of fixtures.
    """
    if upcoming is not None and len(upcoming) and "gameweek" in upcoming:
        weeks = pd.to_numeric(upcoming["gameweek"], errors="coerce").dropna()
        if len(weeks):
            return int(weeks.mode().iloc[0])
    return planning_gameweek(bootstrap, now)


def get_upcoming_fixtures(bootstrap: dict, fixtures: list) -> pd.DataFrame:
    """
    Get fixtures for the next gameweek.
    Returns DataFrame with home_team, away_team, kickoff, difficulty.
    """
    now = pd.Timestamp.now(tz="UTC").tz_localize(None)

    def is_upcoming(fix: dict) -> bool:
        """True only before kickoff and while the fixture is unfinished."""
        if fix.get("finished"):
            return False
        kickoff = fix.get("kickoff_time")
        if kickoff:
            kt = pd.Timestamp(kickoff).tz_localize(None) if pd.Timestamp(kickoff).tzinfo is None else pd.Timestamp(kickoff).tz_convert(None)
            return kt > now
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
        full_name = f"{p['first_name']} {p['second_name']}"

        # Skip players known to have left the Premier League
        if full_name in EXCLUDED_PLAYERS:
            logger.debug(f"Excluding departed player: {full_name}")
            continue

        # Apply team override if FPL has incorrect team assignment
        team_name = team_map.get(p["team"], f"Team {p['team']}")
        if full_name in PLAYER_TEAM_OVERRIDES:
            corrected = PLAYER_TEAM_OVERRIDES[full_name]
            if team_name != corrected:
                logger.warning(
                    f"Team override: {full_name} FPL→{team_name}, corrected→{corrected}"
                )
            team_name = corrected

        rows.append({
            "player_id": p["id"],
            "name": full_name,
            "web_name": p["web_name"],
            "team_id": p["team"],
            "team": team_name,
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


def build_league_table(bootstrap: dict, fixtures: list) -> list:
    """Build current-season standings from completed FPL fixtures."""
    team_map = update_fpl_team_map(bootstrap.get("teams", []))
    standings = {
        team_id: {
            "team": team_name,
            "played": 0,
            "won": 0,
            "drawn": 0,
            "lost": 0,
            "gf": 0,
            "ga": 0,
            "gd": 0,
            "points": 0,
            "form": [],
        }
        for team_id, team_name in team_map.items()
    }

    ordered_fixtures = sorted(
        fixtures,
        key=lambda f: f.get("kickoff_time") or "",
    )
    for fixture in ordered_fixtures:
        home_score = fixture.get("team_h_score")
        away_score = fixture.get("team_a_score")
        if not fixture.get("finished") or home_score is None or away_score is None:
            continue

        home = standings.get(fixture.get("team_h"))
        away = standings.get(fixture.get("team_a"))
        if home is None or away is None:
            continue

        home["played"] += 1
        away["played"] += 1
        home["gf"] += int(home_score)
        home["ga"] += int(away_score)
        away["gf"] += int(away_score)
        away["ga"] += int(home_score)

        if home_score > away_score:
            home["won"] += 1
            away["lost"] += 1
            home["points"] += 3
            home["form"].append("W")
            away["form"].append("L")
        elif home_score < away_score:
            away["won"] += 1
            home["lost"] += 1
            away["points"] += 3
            home["form"].append("L")
            away["form"].append("W")
        else:
            home["drawn"] += 1
            away["drawn"] += 1
            home["points"] += 1
            away["points"] += 1
            home["form"].append("D")
            away["form"].append("D")

    table = []
    for row in standings.values():
        row["gd"] = row["gf"] - row["ga"]
        row["form"] = row["form"][-5:]
        table.append(row)

    table.sort(
        key=lambda r: (-r["points"], -r["gd"], -r["gf"], r["team"])
    )
    for position, row in enumerate(table, start=1):
        row["position"] = position
    return table


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
