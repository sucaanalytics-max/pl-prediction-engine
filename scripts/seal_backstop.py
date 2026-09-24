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
from typing import List, Optional, Tuple

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


def next_deadline(now: datetime, token: str) -> Tuple[int, datetime]:
    """FPL's own calendar first; the repo's published agent status if FPL is down."""
    try:
        request = urllib.request.Request(BOOTSTRAP, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            events = json.load(response)["events"]
        upcoming = sorted(
            (datetime.fromisoformat(e["deadline_time"].replace("Z", "+00:00")), int(e["id"]))
            for e in events if e.get("deadline_time")
        )
        for deadline, gameweek in upcoming:
            if deadline > now:
                return gameweek, deadline
        raise RuntimeError("no future deadline in bootstrap")
    except Exception as error:  # noqa: BLE001 - fall back, and say so
        log(f"FPL bootstrap unavailable ({error}); falling back to agent_status.json")
        out = _gh(["api", f"repos/{REPO}/contents/frontend/public/predictions/fpl/"
                   "agent_status.json", "-H", "Accept: application/vnd.github.raw"], token)
        status = json.loads(out.stdout)
        return int(status["gameweek"]), datetime.fromisoformat(
            status["deadline"].replace("Z", "+00:00"))


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
    token = owner_token()
    gameweek, deadline = next_deadline(now, token)
    opens, closes = deadline - SEAL_WINDOW, deadline - LOCKOUT_BEFORE_DEADLINE
    log(f"GW{gameweek} deadline {deadline:%Y-%m-%d %H:%M}Z; seal window "
        f"{opens:%H:%M}-{closes:%H:%M}Z; now {now:%Y-%m-%d %H:%M}Z")

    if not (opens <= now < closes):
        log("outside the seal window; nothing to do")
        return 0
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
