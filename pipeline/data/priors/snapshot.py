"""
Capture the pre-season FPL bootstrap before the season destroys it.

Why this exists
---------------
During pre-season, ``bootstrap-static``'s ``elements`` carry LAST season's
per-player aggregates: ``total_points``, ``minutes``, ``starts``,
``defensive_contribution``, ``clearances_blocks_interceptions``, ``saves``,
``expected_goals`` and the rest. The instant the new season starts, FPL zeroes
all of them. There is no API route back — ``element-summary/{id}/history_past``
returns only season totals for points and minutes, not the component stats the
minutes and goal-share models are built from.

So this is a one-shot, time-boxed capture. Miss the GW1 deadline and the
parameter layer is permanently degraded.

Two artifacts are written:

``bootstrap_preseason_{season}.json.gz``
    The entire bootstrap payload, verbatim and gzipped. Over-capture is
    deliberate: it costs ~200 KB and cannot be redone.

``fpl_player_priors_{prior_season}.json``
    A distilled, typed, team-canonicalised per-player table. This is what the
    models actually read.

``now_cost`` is captured too, because pre-season prices are GW1 purchase
prices — exact, since prices do not move until the season begins. Selling-price
reconstruction depends on that baseline being right.
"""
import gzip
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from pipeline.config import CURRENT_SEASON, PRIORS_DIR, SEASON_LABELS
from pipeline.data.team_mapping import normalize_team_name

logger = logging.getLogger(__name__)

SNAPSHOT_VERSION = 1

# Counting stats carried over from the prior season. Integers.
PRIOR_COUNT_FIELDS = (
    "minutes",
    "starts",
    "total_points",
    "goals_scored",
    "assists",
    "clean_sheets",
    "goals_conceded",
    "own_goals",
    "penalties_saved",
    "penalties_missed",
    "yellow_cards",
    "red_cards",
    "saves",
    "bonus",
    "bps",
    "clearances_blocks_interceptions",
    "recoveries",
    "tackles",
    "defensive_contribution",
)

# Prior-season rates and indices. Floats, delivered as strings by the API.
PRIOR_RATE_FIELDS = (
    "influence",
    "creativity",
    "threat",
    "ict_index",
    "expected_goals",
    "expected_assists",
    "expected_goal_involvements",
    "expected_goals_conceded",
    "starts_per_90",
    "saves_per_90",
    "expected_goals_per_90",
    "expected_assists_per_90",
    "expected_goal_involvements_per_90",
    "expected_goals_conceded_per_90",
    "goals_conceded_per_90",
    "clean_sheets_per_90",
    "defensive_contribution_per_90",
)

# Set-piece and penalty duty. Integer rank or None when the player has no duty.
SET_PIECE_FIELDS = (
    "penalties_order",
    "direct_freekicks_order",
    "corners_and_indirect_freekicks_order",
)

# Current-season market and availability state, captured for the GW1 baseline.
MARKET_FLOAT_FIELDS = (
    "selected_by_percent",
    "ep_next",
    "form",
    "points_per_game",
    "value_season",
)


class SeasonAlreadyStartedError(RuntimeError):
    """Raised when the prior-season aggregates are already gone."""


def _as_int(value: Any) -> Optional[int]:
    """Coerce to int, preserving None. FPL sends some integers as strings."""
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> Optional[float]:
    """Coerce to float, preserving None."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def season_has_started(bootstrap: dict) -> bool:
    """
    True once any gameweek is live or settled.

    Checked across every event rather than only ``events[0]``: a mid-season
    invocation must also be refused, and a season whose GW1 was rescheduled
    should not slip through.
    """
    for event in bootstrap.get("events", []):
        if event.get("finished") or event.get("is_current") or event.get("data_checked"):
            return True
    return False


def prior_season_label(season: str = CURRENT_SEASON) -> str:
    """
    Label of the season whose aggregates a pre-season bootstrap carries.

    ``"2627"`` → ``"2526"``. Derived arithmetically rather than by lookup so a
    new season needs no config edit.
    """
    start = int(season[:2])
    return f"{start - 1:02d}{start:02d}"


def build_player_priors(bootstrap: dict) -> Dict[str, Any]:
    """
    Distil per-player prior-season aggregates from a pre-season bootstrap.

    Returns a dict with a ``metadata`` block and a ``players`` list. Every
    player in ``elements`` is included, including those with zero minutes —
    exclusion is the caller's decision, and the models shrink rather than
    filter.
    """
    if season_has_started(bootstrap):
        raise SeasonAlreadyStartedError(
            "bootstrap reports a started season; its per-player aggregates are "
            "current-season, not prior-season. Refusing to build priors."
        )

    elements = bootstrap.get("elements", [])
    if not elements:
        raise ValueError("bootstrap contains no elements")

    teams = {t["id"]: t for t in bootstrap.get("teams", [])}
    positions = {
        et["id"]: et["singular_name_short"]
        for et in bootstrap.get("element_types", [])
    }

    players = []
    for element in elements:
        team = teams.get(element["team"], {})
        raw_team = team.get("name", f"Team {element['team']}")

        row: Dict[str, Any] = {
            # `code` is FPL's permanent player code and is stable across
            # seasons. `element_id` is season-scoped and must never be used as
            # a cross-season join key.
            "code": element.get("code"),
            "element_id": element["id"],
            "first_name": element.get("first_name", ""),
            "second_name": element.get("second_name", ""),
            "web_name": element.get("web_name", ""),
            "team_id": element["team"],
            "team": normalize_team_name(raw_team),
            "team_raw": raw_team,
            "position": positions.get(element["element_type"], "UNK"),
            # Pre-season price == GW1 purchase price, in tenths of a million.
            "now_cost": element.get("now_cost"),
            "status": element.get("status", "a"),
            "chance_of_playing_next_round": _as_int(
                element.get("chance_of_playing_next_round")
            ),
            "news": element.get("news", ""),
        }

        for field in PRIOR_COUNT_FIELDS:
            row[field] = _as_int(element.get(field)) or 0
        for field in PRIOR_RATE_FIELDS:
            row[field] = _as_float(element.get(field)) or 0.0
        for field in SET_PIECE_FIELDS:
            row[field] = _as_int(element.get(field))
        for field in MARKET_FLOAT_FIELDS:
            row[field] = _as_float(element.get(field)) or 0.0

        players.append(row)

    events = bootstrap.get("events", [])
    first_deadline = events[0].get("deadline_time") if events else None

    return {
        "metadata": {
            "snapshot_version": SNAPSHOT_VERSION,
            "season": CURRENT_SEASON,
            "season_label": SEASON_LABELS.get(CURRENT_SEASON, CURRENT_SEASON),
            "prior_season": prior_season_label(),
            "prior_season_label": SEASON_LABELS.get(
                prior_season_label(), prior_season_label()
            ),
            "gw1_deadline": first_deadline,
            "n_players": len(players),
            "n_with_prior_minutes": sum(1 for p in players if p["minutes"] > 0),
            "source": "bootstrap-static (pre-season)",
        },
        "players": players,
    }


def snapshot_priors(
    bootstrap: Optional[dict] = None,
    priors_dir: Optional[Path] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Capture the pre-season bootstrap to disk. Safe to call on a daily schedule.

    Behaviour is deliberately asymmetric around the season boundary:

    * pre-season — always rewrites, so ``now_cost`` tracks pre-season price
      reveals right up to the GW1 deadline;
    * season started, snapshot present — no-op, because the live aggregates are
      now current-season and would corrupt the record;
    * season started, snapshot absent — raises. The data is gone and this is
      not recoverable, so it must not pass silently.

    ``force`` overrides the started-season guard for tests only.
    """
    priors_dir = Path(priors_dir) if priors_dir else PRIORS_DIR
    priors_dir.mkdir(parents=True, exist_ok=True)

    prior = prior_season_label()
    priors_path = priors_dir / f"fpl_player_priors_{prior}.json"
    bootstrap_path = priors_dir / f"bootstrap_preseason_{CURRENT_SEASON}.json.gz"

    if bootstrap is None:
        # Demand a live payload: a cached one may predate a price reveal, and
        # a stale one may postdate the rollover.
        from pipeline.data.fpl_api import fetch_bootstrap_static

        bootstrap = fetch_bootstrap_static(force=True, allow_stale=False)

    started = season_has_started(bootstrap)

    if started and not force:
        if priors_path.exists():
            logger.info(
                "Season has started and %s already exists — nothing to capture.",
                priors_path.name,
            )
            return json.loads(priors_path.read_text())
        raise SeasonAlreadyStartedError(
            f"Season {CURRENT_SEASON} has started and {priors_path} does not "
            "exist. Prior-season per-player aggregates are no longer available "
            "from the FPL API and cannot be recovered from it. Restore the "
            "snapshot from git history or backfill from the season archive."
        )

    priors = build_player_priors(bootstrap) if not force else _build_forced(bootstrap)

    bootstrap_path.write_bytes(
        gzip.compress(json.dumps(bootstrap, separators=(",", ":")).encode("utf-8"))
    )
    priors_path.write_text(json.dumps(priors, indent=2, sort_keys=True) + "\n")

    logger.info(
        "Captured %d players (%d with prior-season minutes) → %s",
        priors["metadata"]["n_players"],
        priors["metadata"]["n_with_prior_minutes"],
        priors_path.name,
    )
    return priors


def _build_forced(bootstrap: dict) -> Dict[str, Any]:
    """Build priors bypassing the started-season guard. Tests only."""
    events = bootstrap.get("events", [])
    neutered = dict(bootstrap)
    neutered["events"] = [
        {**e, "finished": False, "is_current": False, "data_checked": False}
        for e in events
    ]
    return build_player_priors(neutered)


def load_player_priors(priors_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Load the committed prior-season snapshot. Raises if it was never taken."""
    priors_dir = Path(priors_dir) if priors_dir else PRIORS_DIR
    path = priors_dir / f"fpl_player_priors_{prior_season_label()}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"{path} does not exist. Run pipeline.data.priors.snapshot before "
            "the GW1 deadline; after it, the source data is gone."
        )
    return json.loads(path.read_text())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    result = snapshot_priors()
    meta = result["metadata"]
    print(
        f"Season {meta['season_label']}: captured {meta['n_players']} players, "
        f"{meta['n_with_prior_minutes']} with {meta['prior_season_label']} minutes. "
        f"GW1 deadline {meta['gw1_deadline']}."
    )
