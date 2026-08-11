"""
Settlement: what actually happened, joined back to what was sealed.

Source is ``event/{gw}/live/``, not ``fixtures[].stats``. That choice matters and
was checked rather than assumed: ``fixtures[].stats`` carries only the scoring
events (goals, assists, cards, saves, bonus, bps) and lists only non-zero
entries — no minutes, no clean sheets, no goals conceded, no total_points. Without
minutes you cannot compute appearance points or apply the 60-minute gate, so most
of the scoring function is unreachable from it. ``event/{gw}/live/`` returns every
stat plus ``total_points`` plus ``explain`` (per fixture, which is how a double
gameweek is resolved) in a single request.

Provisional versus final is a real distinction, not bookkeeping. FPL locks points
at 09:00 UK the day after a gameweek's final match, and bonus and defensive
contributions move until then because Opta amends its data in a six-hour review
window. A provisional settlement is recorded as such and superseded; scoring an
accuracy claim from provisional data would be measuring the wrong thing.

SHAPE CAVEAT, recorded deliberately: the stat *vocabulary* is verified — every
field name here appears in ``element-summary/{id}/history_past``, which is
populated today. The *envelope* (``elements[].stats`` and ``explain``) cannot be
verified against a live payload until a gameweek has actually been played:
pre-season, ``event/1/live/`` returns ``{"elements": []}``. The parser is written
against the documented shape and tested against a committed fixture, and must be
re-checked against the real payload at GW1.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from pipeline.learning.ledger import (
    LedgerError,
    RECORD_HEADER,
    gameweek_dir,
)

logger = logging.getLogger(__name__)

OUTCOME_SCHEMA_VERSION = 1

# Every stat the scoring function needs. Names verified against
# element-summary/{id}/history_past.
OUTCOME_STATS = (
    "minutes",
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
    "starts",
    "total_points",
)


class SettlementError(RuntimeError):
    """Settlement could not be completed. Never swallow this."""


def parse_event_live(payload: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    """
    Parse ``event/{gw}/live/`` into ``{element_id: stats}``.

    ``explain`` is retained per element: in a double gameweek it is the only
    thing that says which fixture each contribution came from, and a settlement
    that cannot distinguish them cannot attribute a double correctly.
    """
    elements = payload.get("elements")
    if elements is None:
        raise SettlementError(
            "payload has no 'elements' key; this is not an event/{gw}/live "
            "response"
        )

    parsed: Dict[int, Dict[str, Any]] = {}
    for element in elements:
        element_id = element.get("id")
        if element_id is None:
            continue
        stats = element.get("stats") or {}
        row = {name: _as_int(stats.get(name)) for name in OUTCOME_STATS}
        explain = element.get("explain") or []
        row["n_fixtures_played"] = len(explain)
        row["fixture_ids"] = [
            entry.get("fixture") for entry in explain if entry.get("fixture") is not None
        ]
        parsed[int(element_id)] = row
    return parsed


def _as_int(value: Any) -> int:
    if value is None or value == "":
        return 0
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def settle_gameweek(
    gameweek: int,
    predictions_dir: Path,
    live_payload: Dict[str, Any],
    provisional: bool,
    now: Optional[datetime] = None,
    dry_run: bool = False,
) -> Path:
    """
    Write settled outcomes for one gameweek.

    Unlike the seal, settlement IS repairable: outcomes do not change, so a
    provisional reading may be superseded by the final one. The file is rewritten
    in that case and the header records which revision it is.
    """
    now = now or datetime.now(timezone.utc)
    directory = gameweek_dir(predictions_dir, gameweek, dry_run=dry_run)
    if not (directory / "forecast.jsonl").exists():
        raise SettlementError(
            f"GW{gameweek} has no sealed forecast; there is nothing to settle "
            "against. Settling an unsealed gameweek would produce outcomes with "
            "no prediction to score them against."
        )

    parsed = parse_event_live(live_payload)
    if not parsed:
        raise SettlementError(
            f"event/{gameweek}/live returned no elements. Pre-season and "
            "mid-gameweek this is expected; it is not a settlement."
        )

    outcome_path = directory / "outcome.jsonl"
    previous_revision = 0
    if outcome_path.exists():
        existing = read_outcomes(outcome_path)
        previous_revision = int(existing["header"].get("revision", 0))
        if not existing["header"].get("provisional", True):
            raise SettlementError(
                f"GW{gameweek} is already settled as FINAL. Re-settling would "
                "replace confirmed outcomes with a later reading of the same "
                "match, which can only lose information."
            )

    header = {
        "record": RECORD_HEADER,
        "schema_version": OUTCOME_SCHEMA_VERSION,
        "gameweek": int(gameweek),
        "settled_at": now.isoformat(),
        "provisional": bool(provisional),
        "revision": previous_revision + 1,
        "n_elements": len(parsed),
        "github_run_id": os.environ.get("GITHUB_RUN_ID"),
        "source": "event/{gw}/live",
    }

    with outcome_path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header, sort_keys=True) + "\n")
        for element_id, row in sorted(parsed.items()):
            handle.write(
                json.dumps({"element_id": element_id, **row}, sort_keys=True) + "\n"
            )

    logger.info(
        "settled GW%d (%s, revision %d): %d elements",
        gameweek,
        "provisional" if provisional else "final",
        header["revision"],
        len(parsed),
    )
    return outcome_path


def read_outcomes(path: Path) -> Dict[str, Any]:
    """Read settled outcomes back as ``{"header": ..., "rows": {id: row}}``."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"{path} does not exist")

    header: Optional[Dict[str, Any]] = None
    rows: Dict[int, Dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("record") == RECORD_HEADER:
                header = record
            else:
                rows[int(record["element_id"])] = record

    if header is None:
        raise LedgerError(f"{path} has no header record")
    return {"header": header, "rows": rows}
