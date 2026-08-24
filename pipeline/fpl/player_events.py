"""
The player-events display artifact: shots and creation, from Understat.

## Why a separate artifact from `player_stats.json`

`player_stats.json` is built from FPL's own API and is therefore as reliable as
the rest of the pipeline. This is built from a scraped source that may be absent,
stale, or partially joined on any given day. Merging them would make one file with
two very different warranties and no way for a screen to tell which half it was
reading.

So this is its own file, and it carries its own provenance: how much of the league
the join actually covered, which players it could not place, and — the part most
easily forgotten — an explicit list of the fields it does NOT have.

## `not_available` is a feature

A screen that wants a "shots on target" column has two options: render an empty
column, or know in advance that the number does not exist. This artifact names the
gap so the second option is available, and so a UI does not have to hardcode a
guess about the feed's shape. When a richer feed is wired in, the list shrinks and
the screen follows without a code change.

## Nothing here reaches a projection

By construction. The optimiser reads `xp_gw{NN}.json`; this file has no consumer
in `pipeline/`. That is what makes it safe for the whole thing to come back empty.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
FILENAME = "player_events.json"

#: Fields the reader may ask for and this source cannot answer. Named rather than
#: silently absent — see the module docstring.
NOT_AVAILABLE = (
    "shots_on_target",
    "big_chances",
    "crosses",
    "passes_into_final_third",
    "touches_in_opposition_box",
    "progressive_passes",
)

#: How many unmatched players to publish. Enough to diagnose a broken join by
#: eye; not the whole league when a season label is wrong and nothing matches.
UNMATCHED_CAP = 40

#: Fields that count things. A player takes four shots, not 4.0 of them — and a
#: float count invites a screen to render "6.0" where "6" is the fact. Published
#: as int whenever the value is whole; a non-whole count would mean the source
#: sent something unexpected, and that is worth seeing rather than truncating.
_COUNTS = (
    "minutes", "shots", "key_passes", "goals", "assists", "np_goals",
    "yellow_cards", "red_cards", "matches",
)

#: Carried straight through, after coercion.
_NUMERIC = (
    "minutes", "shots", "key_passes", "goals", "assists",
    "xg", "xa", "np_xg", "np_goals", "xg_chain", "xg_buildup",
    "yellow_cards", "red_cards", "matches",
)


#: Decimal places every published float is rounded to.
#:
#: Understat returns full binary float precision — 0.2258007824420929 for a
#: quarter of an expected goal. Sixteen significant digits is a claim about
#: measurement nobody can support: the underlying model is fitted on a few
#: thousand shots, so everything past the second decimal is arithmetic, not
#: information. Rounding at the source means no consumer has to decide, and two
#: screens cannot disagree about the same number.
DECIMALS = 2


def _num(value: Any) -> Optional[float]:
    """A float rounded to DECIMALS, or None. Understat sends strings, pandas NaN."""
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if out != out else round(out, DECIMALS)  # NaN


def _per90(total: Optional[float], minutes: Optional[float]) -> Optional[float]:
    """
    Rate per ninety, or None below a minutes floor.

    The floor is the honest part. One substitute appearance of eight minutes with
    one shot extrapolates to 11 shots per 90, which is not a projection about a
    player, it is a projection about arithmetic. Below 90 minutes the answer is
    that we do not know yet.
    """
    if total is None or minutes is None or minutes < 90:
        return None
    return round(total * 90.0 / minutes, DECIMALS)


def build(
    matched: Mapping[int, Mapping[str, Any]],
    unmatched: Sequence[Mapping[str, str]],
    names: Mapping[int, str],
    teams: Mapping[int, str],
    universe_size: int,
    season: str,
    source_rows: int = 0,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the artifact. Pure: no I/O, no clock unless one is withheld."""
    players: List[Dict[str, Any]] = []
    for eid, row in sorted(matched.items()):
        out: Dict[str, Any] = {
            "element_id": int(eid),
            "name": names.get(int(eid)),
            "team": teams.get(int(eid)),
        }
        for key in _NUMERIC:
            value = _num(row.get(key))
            if key in _COUNTS and value is not None and value.is_integer():
                value = int(value)
            out[key] = value
        minutes = out.get("minutes")
        out["shots_per_90"] = _per90(out.get("shots"), minutes)
        out["key_passes_per_90"] = _per90(out.get("key_passes"), minutes)
        out["xg_per_90"] = _per90(out.get("xg"), minutes)
        out["xa_per_90"] = _per90(out.get("xa"), minutes)
        players.append(out)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "season": season,
        "source": "understat",
        "source_note": (
            "Understat's own xG model, independent of FPL's. The two disagree by "
            "design; neither is a correction of the other."
        ),
        # Two fractions, because they answer different questions and conflating
        # them raised a false alarm the first time this ran. `join_fraction` is
        # how well the NAME MATCH worked, and is the number to judge this code by.
        # `league_fraction` is how much of FPL's squad list Understat covers at
        # all — one game into a season that is inherently low, because Understat
        # lists players who have played and FPL lists everyone who could.
        "coverage": {
            "matched": len(players),
            "understat_rows": int(source_rows),
            "fpl_universe": int(universe_size),
            "unmatched": len(unmatched),
            # Rounded like everything else. Nothing is lost: `matched`,
            # `understat_rows` and `fpl_universe` above are exact integers, so a
            # reader who wants more precision can divide them.
            "join_fraction": (
                round(len(players) / source_rows, DECIMALS) if source_rows else None
            ),
            "league_fraction": (
                round(len(players) / universe_size, DECIMALS) if universe_size else None
            ),
        },
        "unmatched": [dict(u) for u in unmatched[:UNMATCHED_CAP]],
        "unmatched_truncated": max(0, len(unmatched) - UNMATCHED_CAP),
        "not_available": list(NOT_AVAILABLE),
        "players": players,
    }


def write(payload: Mapping[str, Any], directory: Path) -> Path:
    """Write the artifact atomically, returning its path."""
    from pipeline.fpl.artifacts import write_json_atomically

    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    return write_json_atomically(dict(payload), directory / FILENAME)


def publish(
    season_label: str,
    season: str,
    bootstrap: Mapping[str, Any],
    cache_dir: Path,
    out_dirs: Sequence[Path],
    force: bool = False,
) -> Optional[Path]:
    """
    Fetch, join, and publish — the one call a pipeline step needs.

    Returns the last path written, or None when the source was unavailable. A
    None here is a normal Tuesday, not an error: the caller logs it and carries on.
    """
    from pipeline.data.team_mapping import normalize_team_name
    from pipeline.data.understat import fetch_player_season_stats, match_to_fpl

    frame = fetch_player_season_stats(season_label, Path(cache_dir), force=force)
    if frame is None:
        logger.info("Understat unavailable; %s not refreshed", FILENAME)
        return None

    rows = frame.to_dict("records")
    elements = list(bootstrap.get("elements") or [])
    team_of = {t["id"]: str(t.get("name") or "") for t in bootstrap.get("teams") or []}

    matched, unmatched = match_to_fpl(rows, elements, team_of, normalize_team_name)

    names = {int(e["id"]): str(e.get("web_name") or "") for e in elements}
    teams = {
        int(e["id"]): team_of.get(e.get("team"), "") for e in elements
    }

    payload = build(
        matched=matched,
        unmatched=unmatched,
        names=names,
        teams=teams,
        universe_size=len(elements),
        season=season,
        source_rows=len(rows),
    )

    cov = payload["coverage"]
    # Judged on the JOIN, not on league coverage. A 45% league fraction one game
    # into a season is Understat's scope; a 45% join fraction would be this code
    # failing, and the two must not share an alarm.
    frac = cov["join_fraction"]
    if frac is not None and frac < 0.9:
        logger.warning(
            "Understat name join matched only %.1f%% of offered rows (%d of %d); "
            "first unmatched: %s",
            frac * 100, cov["matched"], cov["understat_rows"], payload["unmatched"][:3],
        )
    else:
        logger.info(
            "Understat join: %d of %d rows matched (%.1f%%), covering %d of %d "
            "FPL players; %d unmatched",
            cov["matched"], cov["understat_rows"], (frac or 0) * 100,
            cov["matched"], cov["fpl_universe"], cov["unmatched"],
        )

    written = None
    for directory in out_dirs:
        written = write(payload, Path(directory))
        logger.info("wrote %s", written)
    return written
