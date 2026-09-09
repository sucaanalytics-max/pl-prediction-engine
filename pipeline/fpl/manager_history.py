"""
A ledger of the manager's own season: what each gameweek returned, and what each
transfer did.

## Why this depends on no seal

``decision_review`` scores decisions against ``predictions/fpl/ledger/``, which
only exists for gameweeks the agent sealed before the deadline — two of three so
far. This producer answers a different question ("what happened") that needs no
forecast, so it reads only the public API and settles independently. A gameweek
the agent never sealed still has a history, and this is the artifact that has it.

## Why it is not a gate in schedule.py

That gate order is load-bearing: ``MISSED_SEAL`` must stay last and
``PROJECTION_WINDOW`` after it, both pinned by tests, and a new gate has already
once caused a livelock where one miss preempted every later gameweek. This runs
as its own workflow step instead, and so cannot interfere with a seal.

## The identity

``sum(multiplier x points) - event_transfers_cost == entry_history.points``,
asserted per gameweek. It holds because ``picks[].multiplier`` is post-auto-sub.
Verified exact for GW1-3 of 2026/27 on 2026-09-09; the subtraction term is not
yet observed, because no settled gameweek has taken a hit.
"""
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from pipeline.config import FPL_ENTRIES, FPL_PUBLIC_DIR
from pipeline.data.fpl_api import fetch_bootstrap_static, fetch_event_live
from pipeline.fpl.entry_api import fetch_history, fetch_picks, fetch_transfers

logger = logging.getLogger(__name__)

ARTIFACT_NAME = "manager_history.json"
SCHEMA_VERSION = 1


class ManagerHistoryError(RuntimeError):
    """The ledger could not be built. Never publish a plausible wrong number."""


def settled_gameweeks(bootstrap: Dict[str, Any]) -> List[int]:
    """
    Gameweeks whose points are final.

    Both flags are required. ``finished`` goes true when the last match ends;
    ``data_checked`` goes true when bonus and any corrections have landed.
    Reading a finished-but-unchecked gameweek would bake provisional bonus
    points into a permanent ledger.
    """
    return [
        int(event["id"])
        for event in bootstrap.get("events", [])
        if event.get("finished") and event.get("data_checked")
    ]


def points_by_element(live_payload: Dict[str, Any]) -> Dict[int, int]:
    """Realised total points per element for one gameweek."""
    return {
        int(element["id"]): int(element.get("stats", {}).get("total_points") or 0)
        for element in live_payload.get("elements", [])
        if element.get("id") is not None
    }


def minutes_by_element(live_payload: Dict[str, Any]) -> Dict[int, int]:
    """Realised minutes per element for one gameweek."""
    return {
        int(element["id"]): int(element.get("stats", {}).get("minutes") or 0)
        for element in live_payload.get("elements", [])
        if element.get("id") is not None
    }


def build_gameweek_row(
    *,
    event: int,
    picks: Dict[str, Any],
    history_row: Dict[str, Any],
    points: Dict[int, int],
    minutes: Dict[int, int],
    average: Optional[int],
    highest: Optional[int],
) -> Dict[str, Any]:
    """One settled gameweek, with the identity asserted."""
    rows = picks.get("picks") or []
    gross = sum(
        int(p.get("multiplier") or 0) * points.get(int(p["element"]), 0)
        for p in rows
    )
    cost = int(history_row.get("event_transfers_cost") or 0)
    credited = int(history_row.get("points") or 0)
    if gross - cost != credited:
        raise ManagerHistoryError(
            f"GW{event} does not reconcile: sum(multiplier x points) = {gross}, "
            f"transfer cost = {cost}, but FPL credited {credited}. Either the "
            f"multiplier is not post-auto-sub, or the hit is not a flat "
            f"subtraction. Publishing would inherit the error into every "
            f"derived metric on the page."
        )

    captain = next((p for p in rows if int(p.get("multiplier") or 0) >= 2), None)
    subs = []
    for sub in picks.get("automatic_subs") or []:
        came_in = int(sub["element_in"])
        multiplier = next(
            (int(p.get("multiplier") or 0) for p in rows
             if int(p["element"]) == came_in),
            0,
        )
        subs.append({
            "element_in": came_in,
            "element_out": int(sub["element_out"]),
            # What the auto-sub recovered. Not a difference: the player subbed
            # out scored nothing, by definition of being subbed out.
            "points_gained": multiplier * points.get(came_in, 0),
        })

    return {
        "event": int(event),
        "points": credited,
        "gross_points": gross,
        "transfer_cost": cost,
        "transfers_made": int(history_row.get("event_transfers") or 0),
        "bench_points": int(history_row.get("points_on_bench") or 0),
        "average_entry_score": average,
        "highest_score": highest,
        "rank": history_row.get("rank"),
        "overall_rank": history_row.get("overall_rank"),
        "value": history_row.get("value"),
        "bank": history_row.get("bank"),
        "chip": picks.get("active_chip"),
        "captain": None if captain is None else {
            "element": int(captain["element"]),
            "multiplier": int(captain.get("multiplier") or 0),
            "points": points.get(int(captain["element"]), 0),
        },
        "auto_subs": subs,
        "picks": [
            {
                "element": int(p["element"]),
                "multiplier": int(p.get("multiplier") or 0),
                "points": points.get(int(p["element"]), 0),
                "minutes": minutes.get(int(p["element"]), 0),
            }
            for p in rows
        ],
    }


def build_transfer_rows(
    *,
    transfers: List[Dict[str, Any]],
    settled: List[int],
    points_by_gw: Dict[int, Dict[int, int]],
    picks_by_gw: Dict[int, Dict[int, int]],
) -> List[Dict[str, Any]]:
    """
    One row per transfer, carrying both players' points for every settled
    gameweek from the transfer onwards.

    JSON object keys are strings, so the by-gameweek maps are keyed by
    ``str(gw)``.

    Two absences that must not be confused, and are not:

    * A gameweek **missing** from a map has not settled. The frontend renders it
      as "not yet measurable" and excludes it from every window.
    * A gameweek present with ``in_multiplier_by_gw[gw] is None`` settled, but
      the incoming player was no longer in the squad. That is the pollution
      signal, and his points are still recorded so the sale can be priced.

    Windows, deltas and pollution are NOT computed here on purpose: they are
    presentation choices, and baking them into a committed artifact means a
    pipeline run to change 2/3/4 to 1/3/6.
    """
    forward = sorted(
        transfers, key=lambda t: (int(t["event"]), str(t.get("time") or ""))
    )
    horizon = sorted(settled)

    rows: List[Dict[str, Any]] = []
    for transfer in forward:
        event = int(transfer["event"])
        came_in = int(transfer["element_in"])
        went_out = int(transfer["element_out"])
        covered = [gw for gw in horizon if gw >= event]

        rows.append({
            "event": event,
            "time": transfer.get("time"),
            "element_in": came_in,
            "element_in_cost": transfer.get("element_in_cost"),
            "element_out": went_out,
            "element_out_cost": transfer.get("element_out_cost"),
            "in_points_by_gw": {
                str(gw): points_by_gw.get(gw, {}).get(came_in, 0)
                for gw in covered
            },
            "out_points_by_gw": {
                str(gw): points_by_gw.get(gw, {}).get(went_out, 0)
                for gw in covered
            },
            "in_multiplier_by_gw": {
                str(gw): picks_by_gw.get(gw, {}).get(came_in) for gw in covered
            },
        })
    return rows


def named_elements(
    gameweeks: List[Dict[str, Any]], transfers: List[Dict[str, Any]]
) -> set:
    """
    The elements this artifact actually shows by name.

    Transfers and captains and auto-subs only — NOT the pick lists. Carrying
    all 600 bootstrap names would be most of the file's bytes, and carrying the
    45 picks would add names nothing renders. ``run_decision_review`` trims the
    same way and for the same reason.
    """
    wanted = set()
    for transfer in transfers:
        wanted.add(int(transfer["element_in"]))
        wanted.add(int(transfer["element_out"]))
    for week in gameweeks:
        captain = week.get("captain")
        if captain:
            wanted.add(int(captain["element"]))
        for sub in week.get("auto_subs") or []:
            wanted.add(int(sub["element_in"]))
            wanted.add(int(sub["element_out"]))
    return wanted


def build(
    *,
    entry_id: int,
    settled: List[int],
    gameweeks: List[Dict[str, Any]],
    transfers: List[Dict[str, Any]],
    generated_at: str,
    names: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Assemble the artifact. ``settled_through`` is null when nothing has."""
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "entry_id": int(entry_id),
        "settled_through": max(settled) if settled else None,
        "names": names or {},
        "gameweeks": gameweeks,
        "transfers": transfers,
    }


def already_current(target: Path, *, settled_through: Optional[int]) -> bool:
    """
    Whether the published file already covers this much of the season.

    The agent runs hourly and a gameweek settles weekly, so without this the
    producer would rewrite an identical file 167 times between gameweeks and
    commit the churn. A schema bump republishes even when the same gameweeks
    have settled, because the shape is part of what is being published.
    """
    if not target.exists():
        return False
    try:
        existing = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if int(existing.get("schema_version") or 0) != SCHEMA_VERSION:
        return False
    return existing.get("settled_through") == settled_through


def run(
    *,
    entry: str = "owner",
    public_dir: Path = FPL_PUBLIC_DIR,
    write: bool = True,
    force: bool = False,
) -> Dict[str, Any]:
    """Read the settled season and, by default, publish the ledger."""
    config = FPL_ENTRIES.get(entry)
    if config is None:
        raise KeyError(f"no FPL entry configured under {entry!r}")
    entry_id = int(config["entry_id"])

    bootstrap = fetch_bootstrap_static(allow_stale=True)
    settled = settled_gameweeks(bootstrap)
    target = Path(public_dir) / ARTIFACT_NAME
    settled_through = max(settled) if settled else None

    if not force and already_current(target, settled_through=settled_through):
        logger.info(
            "%s already covers GW%s; nothing to do", ARTIFACT_NAME, settled_through
        )
        return json.loads(target.read_text())

    events = {int(e["id"]): e for e in bootstrap.get("events", [])}
    history = fetch_history(entry_id)
    history_rows = {int(r["event"]): r for r in history.get("current") or []}

    gameweeks: List[Dict[str, Any]] = []
    points_by_gw: Dict[int, Dict[int, int]] = {}
    picks_by_gw: Dict[int, Dict[int, int]] = {}

    for gameweek in settled:
        history_row = history_rows.get(gameweek)
        if history_row is None:
            raise ManagerHistoryError(
                f"GW{gameweek} is settled but absent from the entry's history. "
                f"The entry may not have existed yet; that is a real state, not "
                f"a default to paper over."
            )
        live = fetch_event_live(gameweek)
        picks = fetch_picks(entry_id, gameweek)
        points = points_by_element(live)
        minutes = minutes_by_element(live)
        points_by_gw[gameweek] = points
        picks_by_gw[gameweek] = {
            int(p["element"]): int(p.get("multiplier") or 0)
            for p in picks.get("picks") or []
        }
        event = events.get(gameweek, {})
        gameweeks.append(build_gameweek_row(
            event=gameweek, picks=picks, history_row=history_row,
            points=points, minutes=minutes,
            average=event.get("average_entry_score"),
            highest=event.get("highest_score"),
        ))

    transfer_rows = build_transfer_rows(
        transfers=fetch_transfers(entry_id),
        settled=settled,
        points_by_gw=points_by_gw,
        picks_by_gw=picks_by_gw,
    )

    # Off the bootstrap already in hand — no extra fetch. A row reading
    # "445 / 418" is technically complete and unreadable; an id is not a name.
    wanted = named_elements(gameweeks, transfer_rows)
    names = {
        str(int(element["id"])): str(element.get("web_name") or "")
        for element in bootstrap.get("elements", [])
        if int(element["id"]) in wanted
    }

    payload = build(
        entry_id=entry_id,
        settled=settled,
        gameweeks=gameweeks,
        transfers=transfer_rows,
        generated_at=datetime.now(timezone.utc).isoformat(),
        names=names,
    )

    if write:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2) + "\n")
        logger.info(
            "wrote %s — %d gameweek(s), %d transfer(s)",
            target, len(payload["gameweeks"]), len(payload["transfers"]),
        )
    return payload


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", default="owner")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    payload = run(entry=args.entry, write=not args.no_write, force=args.force)
    print(json.dumps(
        {k: v for k, v in payload.items() if k not in ("gameweeks", "transfers")},
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
