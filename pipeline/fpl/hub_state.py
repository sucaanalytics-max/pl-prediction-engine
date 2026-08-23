"""
Read a position the owner captured in the hub.

## A committed file, not a database

The hub writes a capture to `predictions/fpl/hub/capture/{entry_id}.json` through
GitHub's Contents API, and the agent reads it out of its own checkout like every
other artifact. There is no database in this project: truth is committed JSON
served from the CDN, and the five-state artifact model does the work a query layer
would.

The earlier version of this module read PostgREST over the network, to close a real
gap — the agent's `work` job checks out, installs dependencies, and only then runs,
so a commit landing in that gap is invisible to the run already in flight. That gap
is real but small: inside a Friday seal window `fpl_agent.yml` ticks every thirty
minutes (`'0,30 13-16 * * 5'` beside the hourly cron), so a capture waits for the
next tick rather than the next hour. Thirty minutes, hours before a deadline, did
not justify a second store, a second secret, and a second place for provenance to
diverge.

What that buys, beyond one fewer dependency: the capture inherits git's own
history. A database row overwritten in place leaves no trace of what it replaced,
while `git log` on this path shows every position the owner has ever claimed,
timestamped by something outside our control.

## Latest wins, and absence is the gate

One file per entry, overwritten by each capture. The newest claim is the truth and
git keeps the rest, so nothing here needs to reason about ordering.

There is no feature flag. An absent file means no capture, which is exactly what
`_read_entry` should do with it — fall through to FPL's own endpoint. The previous
version carried an `FPL_HUB_CAPTURE` gate because a NETWORK dependency in the
pre-deadline decision path needed an off switch; reading a file that may not exist
is what every other artifact in this repo already does.

## It still never raises

`_read_entry` is reached from `_decide_for_entries`, which the seal path calls
AFTER `seal_forecast` inside a `try/except Exception`. So a failure here costs a
proposal, not a seal. This returns None on every unusable input regardless, because
the fallback below it is a working read and a degraded proposal beats none.

Standard library only, matching `pipeline/learning/schedule.py`, so nothing here can
drag a dependency into the deadline path.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

#: Provenance, written by the capture route and carried in the file. Distinct from
#: `captured_authenticated_draft`, which the frontend sets when FPL's official picks
#: were unavailable — "the owner typed this in" is a stronger claim than "the API
#: would not tell us", and the UI renders them differently.
OWNER_CAPTURED = "owner_captured"

#: Where the hub writes. A path no other writer owns, declared in the other
#: workflows' FORBID_PATHS rather than left incidentally disjoint — `pipeline.yml`
#: stages `predictions` wholesale, so "nothing else happens to touch it" is not a
#: guarantee, it is a coincidence waiting to end.
CAPTURE_DIR = ("fpl", "hub", "capture")

#: FPL applies price changes at roughly 01:30 UTC. A captured bank and set of
#: purchase prices are claims about one particular day's prices, so they stop being
#: trustworthy once that boundary passes — not after some round number of hours. The
#: squad list does not age this way: it changes only when the owner transfers, which
#: is an act the owner would capture again.
PRICE_CHANGE_HOUR = 1
PRICE_CHANGE_MINUTE = 30

SQUAD_SIZE = 15


@dataclass
class Capture:
    """
    One position the owner entered by hand.

    Units are integer tenths of a million throughout, matching
    `pipeline.fpl.entry_api.EntryState`, so nothing converts on the way into a
    decision.
    """

    entry_id: int
    gameweek: int
    captured_at: datetime
    squad: List[int] = field(default_factory=list)
    bank: int = 0
    free_transfers: int = 1
    purchase_prices: Dict[int, int] = field(default_factory=dict)

    def prices_are_stale(self, now: Optional[datetime] = None) -> bool:
        """Whether an FPL price change has landed since this was captured."""
        return _price_change_has_passed(self.captured_at, now)


def capture_path(predictions_dir: Path, entry_id: int) -> Path:
    """Where one entry's capture lives, under the predictions root it is given."""
    return Path(predictions_dir).joinpath(*CAPTURE_DIR) / f"{int(entry_id)}.json"


def _price_change_has_passed(
    captured_at: datetime, now: Optional[datetime] = None
) -> bool:
    now = now or datetime.now(timezone.utc)
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    captured_at = captured_at.astimezone(timezone.utc)
    boundary = captured_at.replace(
        hour=PRICE_CHANGE_HOUR, minute=PRICE_CHANGE_MINUTE, second=0, microsecond=0
    )
    if boundary <= captured_at:
        boundary += timedelta(days=1)
    return boundary <= now.astimezone(timezone.utc)


def _parse_stamp(value: Any) -> Optional[datetime]:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def read_capture(
    predictions_dir: Path, entry_id: int, gameweek: int
) -> Optional[Capture]:
    """
    The owner's capture for this entry and gameweek, or None.

    None covers every reason there is nothing to use — no file, unreadable JSON,
    wrong gameweek, malformed squad — deliberately, because the caller's action is
    identical in all of them: fall through to the FPL read that already works. The
    reasons are distinguished in the log, not in the return type.

    The gameweek is checked rather than trusted. A capture is a claim about one
    gameweek's position, and serving GW3's squad into a GW4 decision would be a
    wrong answer delivered confidently.
    """
    path = capture_path(predictions_dir, entry_id)
    if not path.exists():
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("hub capture at %s is unreadable (%s)", path, exc)
        return None

    if not isinstance(payload, dict):
        logger.warning("hub capture at %s is not an object", path)
        return None

    if payload.get("source") != OWNER_CAPTURED:
        logger.warning(
            "hub capture at %s claims source %r, not %r; ignoring",
            path, payload.get("source"), OWNER_CAPTURED,
        )
        return None

    if int(payload.get("gameweek", -1)) != int(gameweek):
        logger.info(
            "hub capture for entry %s is for GW%s, not GW%s; ignoring",
            entry_id, payload.get("gameweek"), gameweek,
        )
        return None

    captured_at = _parse_stamp(payload.get("captured_at"))
    if captured_at is None:
        logger.warning("hub capture for entry %s has no readable captured_at", entry_id)
        return None

    try:
        squad = [int(element) for element in payload.get("squad", [])]
        bank = int(payload.get("bank", 0))
        free_transfers = int(payload.get("free_transfers", 1))
        purchase_prices = {
            int(element): int(price)
            for element, price in (payload.get("purchase_prices") or {}).items()
        }
    except (TypeError, ValueError) as exc:
        logger.warning("hub capture for entry %s is not numeric (%s)", entry_id, exc)
        return None

    # A capture is a claim about a full squad. Fifteen is not a style preference: the
    # optimiser's transfer accounting starts from the squad it is handed, and a short
    # squad reads as free slots to fill, which it would then spend the bank on.
    if len(squad) != SQUAD_SIZE or len(set(squad)) != SQUAD_SIZE:
        logger.warning(
            "hub capture for entry %s holds %d distinct players, not %d; ignoring",
            entry_id, len(set(squad)), SQUAD_SIZE,
        )
        return None

    return Capture(
        entry_id=int(entry_id),
        gameweek=int(gameweek),
        captured_at=captured_at,
        squad=squad,
        bank=bank,
        free_transfers=free_transfers,
        purchase_prices=purchase_prices,
    )
