#!/usr/bin/env python3
"""
Seal backstop: dispatch the FPL agent when a seal window is open and nothing has sealed.

## Why this exists

A seal is the one irrecoverable thing in this repo: it must be written between
SEAL_WINDOW (4h) and LOCKOUT_BEFORE_DEADLINE (30m) before a deadline, and a missed
one can never be made up. It rides on GitHub's scheduler, which does not deliver
what it is asked for — measured 2026-09-24 over 199 scheduled runs of an hourly
cron: six to eight runs a day, and a 06:00-09:30 UTC band with NO run on 7 of 31
days. The cron went to every fifteen minutes, and that does NOT help: a `*/15`
workflow in the same repo got 6.6 scheduled runs a day over 10-24 Sep against
6.5 for the hourly agent. This is the part that does not depend on GitHub's
scheduler. A `workflow_dispatch` is not a scheduled event and is not queued with
them — measured 2026-09-24: the run was created 5 seconds after the request.

## Why it is safe to run at any time

It decides nothing about the agent. It only asks GitHub for one more tick, and
only when all of these hold:

* FPL's next deadline puts NOW inside [deadline - 4h, deadline - 30m);
* `predictions/fpl/ledger/gwNN/forecast.jsonl` is not on main;
* no FPL Agent run is queued, running, or started in the last ten minutes.

The tick then goes through the agent's own phase resolver, which returns IDLE once
the gameweek is sealed, and `seal_forecast` raises AlreadySealedError rather than
overwriting — so even a redundant dispatch cannot double-seal.

**`dry_run=false` is passed explicitly.** The workflow's dispatch input defaults to
`true`, which produces and notifies WITHOUT sealing — a manual trigger that looked
like a rescue and sealed nothing.

## Why it can run every ten minutes, all season

Outside a seal band it touches nothing: FPL's whole-season calendar is cached
(CALENDAR_CACHE) and re-read every 12 hours, hourly within a day of a deadline in
case FPL moves one. The token, GitHub and the dispatch are reached only inside a
band. So a check costs a file read almost every time, and the log gets one line per
calendar refresh — a heartbeat — rather than one per check.

## Usage

    python3 scripts/seal_backstop.py                 # act, if a window is open
    python3 scripts/seal_backstop.py --dry-run       # say what it would do
    python3 scripts/seal_backstop.py --dry-run --now 2026-10-10T07:00:00Z

Scheduled by `scripts/com.pl-prediction.seal-backstop.plist`. Standard library only;
`gh` must be logged in as the repo owner (`gh auth token -u <owner>`).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, List, Optional, Tuple

REPO = "sucaanalytics-max/pl-prediction-engine"
OWNER = "sucaanalytics-max"
WORKFLOW = "fpl_agent.yml"
WORKFLOW_NAME = "FPL Agent"
GH = "/opt/homebrew/bin/gh"
BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"

# Mirrors pipeline/learning/schedule.py. Duplicated rather than imported so this runs
# from any Python with nothing installed; `test_seal_backstop.py` pins the two equal.
SEAL_WINDOW = timedelta(hours=4)
LOCKOUT_BEFORE_DEADLINE = timedelta(minutes=30)
RECENT_RUN = timedelta(minutes=10)
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}

CALENDAR_CACHE = Path.home() / "Library" / "Caches" / "pl-prediction-seal-backstop" / "calendar.json"
CALENDAR_MAX_AGE = timedelta(hours=12)
# Within a day of a deadline, re-read hourly: FPL occasionally moves one.
CALENDAR_MAX_AGE_NEAR = timedelta(hours=1)
NEAR = timedelta(hours=24)

Calendar = List[Tuple[int, datetime]]


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {message}", flush=True)


def _gh(args: List[str], token: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [GH, *args], capture_output=True, text=True, timeout=60,
        env={"GH_TOKEN": token, "PATH": "/opt/homebrew/bin:/usr/bin:/bin"},
    )


def owner_token() -> str:
    out = subprocess.run(
        [GH, "auth", "token", "-u", OWNER], capture_output=True, text=True, timeout=30
    )
    token = out.stdout.strip()
    if out.returncode != 0 or not token:
        raise RuntimeError(f"no gh token for {OWNER}: {out.stderr.strip()}")
    return token


def _parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def fetch_calendar() -> Calendar:
    """Every gameweek's deadline, from FPL's own bootstrap."""
    request = urllib.request.Request(BOOTSTRAP, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        events = json.load(response)["events"]
    return sorted(
        (int(e["id"]), _parse(e["deadline_time"])) for e in events if e.get("deadline_time")
    )


def _next(calendar: Calendar, now: datetime) -> Optional[Tuple[int, datetime]]:
    return next(((gw, d) for gw, d in sorted(calendar, key=lambda x: x[1]) if d > now), None)


def load_calendar(
    fetch: Callable[[], Calendar] = fetch_calendar,
    cache: Path = CALENDAR_CACHE,
    wall: Optional[datetime] = None,
) -> Calendar:
    """
    The season's deadlines, from cache when it is fresh enough.

    Fresh means younger than CALENDAR_MAX_AGE, or than CALENDAR_MAX_AGE_NEAR once the
    next cached deadline is within NEAR. A failed refresh falls back to a stale cache
    with a log line — an old calendar is far better than none, since deadlines
    rarely move — and raises only when there is no cache at all.

    Age is judged on the WALL clock, never on `--now`. The first version stamped the
    cache with the simulated time, so one `--now 2026-10-10T07:00Z` dry run wrote a
    fetch time a fortnight ahead, and every real run after it saw a "fresh" cache and
    would not have refreshed until then. A stamp in the future is treated as stale.
    """
    wall = wall or datetime.now(timezone.utc)
    cached: Optional[Calendar] = None
    fetched_at: Optional[datetime] = None
    try:
        payload = json.loads(cache.read_text(encoding="utf-8"))
        fetched_at = _parse(payload["fetched_at"])
        cached = [(int(gw), _parse(d)) for gw, d in payload["deadlines"]]
    except (OSError, ValueError, KeyError, TypeError):
        cached = None

    if cached is not None and fetched_at is not None and fetched_at <= wall:
        upcoming = _next(cached, wall)
        near = upcoming is not None and upcoming[1] - wall <= NEAR
        if wall - fetched_at < (CALENDAR_MAX_AGE_NEAR if near else CALENDAR_MAX_AGE):
            return cached

    try:
        calendar = fetch()
    except Exception as error:  # noqa: BLE001 - fall back, and say so
        if cached is not None:
            log(f"calendar refresh failed ({error}); using the cached one")
            return cached
        raise
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({
        "fetched_at": wall.isoformat().replace("+00:00", "Z"),
        "deadlines": [[gw, d.isoformat().replace("+00:00", "Z")] for gw, d in calendar],
    }), encoding="utf-8")
    upcoming = _next(calendar, wall)
    log(f"calendar refreshed: {len(calendar)} deadlines; next "
        + (f"GW{upcoming[0]} {upcoming[1]:%Y-%m-%d %H:%M}Z" if upcoming else "none"))
    return calendar


def next_deadline(now: datetime) -> Tuple[int, datetime]:
    upcoming = _next(load_calendar(), now)
    if upcoming is None:
        raise RuntimeError("no future deadline in FPL's calendar")
    return upcoming


def is_sealed(gameweek: int, token: str) -> bool:
    path = f"predictions/fpl/ledger/gw{gameweek:02d}/forecast.jsonl"
    out = _gh(["api", f"repos/{REPO}/contents/{path}", "--silent"], token)
    return out.returncode == 0


def agent_busy(now: datetime, token: str) -> Optional[str]:
    out = _gh(["run", "list", "-R", REPO, "-w", WORKFLOW_NAME, "-L", "5",
               "--json", "status,createdAt,event,databaseId"], token)
    if out.returncode != 0:
        raise RuntimeError(f"could not list runs: {out.stderr.strip()}")
    for run in json.loads(out.stdout):
        started = datetime.fromisoformat(run["createdAt"].replace("Z", "+00:00"))
        if run["status"] in ACTIVE:
            return f"run {run['databaseId']} is {run['status']}"
        if now - started < RECENT_RUN:
            return f"run {run['databaseId']} started {int((now - started).total_seconds() // 60)}m ago"
    return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="report, do not dispatch")
    parser.add_argument("--now", help="pretend it is this UTC time (for testing)")
    args = parser.parse_args(argv)

    now = (datetime.fromisoformat(args.now.replace("Z", "+00:00"))
           if args.now else datetime.now(timezone.utc))
    gameweek, deadline = next_deadline(now)
    opens, closes = deadline - SEAL_WINDOW, deadline - LOCKOUT_BEFORE_DEADLINE

    # Outside a band: no token, no GitHub, and no log line (the calendar refresh is
    # the heartbeat). Run every ten minutes, a line per check would bury the ones
    # that matter.
    if not (opens <= now < closes):
        if args.dry_run:
            log(f"GW{gameweek} band {opens:%Y-%m-%d %H:%M}-{closes:%H:%M}Z; "
                f"now {now:%Y-%m-%d %H:%M}Z: outside the seal window; nothing to do")
        return 0

    log(f"GW{gameweek} deadline {deadline:%Y-%m-%d %H:%M}Z; inside the seal band "
        f"{opens:%H:%M}-{closes:%H:%M}Z; now {now:%H:%M}Z")
    token = owner_token()
    if is_sealed(gameweek, token):
        log(f"GW{gameweek} is already sealed on main; nothing to do")
        return 0
    busy = agent_busy(datetime.now(timezone.utc), token)
    if busy:
        log(f"GW{gameweek} not sealed yet, but {busy}; leaving it to that run")
        return 0
    if args.dry_run:
        log(f"DRY RUN: GW{gameweek} is not sealed and no agent run is active; "
            f"would dispatch {WORKFLOW} with dry_run=false")
        return 0

    out = _gh(["workflow", "run", WORKFLOW, "-R", REPO, "-f", "dry_run=false"], token)
    if out.returncode != 0:
        log(f"DISPATCH FAILED: {out.stderr.strip()}")
        return 1
    log(f"dispatched {WORKFLOW} with dry_run=false for GW{gameweek}")
    time.sleep(15)
    check = _gh(["run", "list", "-R", REPO, "-w", WORKFLOW_NAME, "-L", "1",
                 "--json", "event,status,databaseId,createdAt"], token)
    log(f"latest agent run: {check.stdout.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
