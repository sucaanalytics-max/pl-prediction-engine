"""
Read a position the owner captured in the hub.

## Why this reads over the network instead of from a file

The agent's `work` job runs `actions/checkout`, then `setup-python`, then a full
`pip install -r pipeline/requirements.txt`, and only then the agent
(`.github/workflows/fpl_agent.yml`). A commit landing in that gap is invisible to
the run already in flight — git does not retroactively alter a checkout. So a
capture the owner makes while a run is underway can only reach that run over the
wire. That is the entire reason this module exists.

## What it is for, and what it is not

It serves the entries the agent actually decides for — `FPL_ENTRIES` in
`pipeline/config.py`, currently the two bot teams. It has nothing to say about the
owner's own team, which is a display entity in the frontend and never reaches
`_decide_for_entries`.

It is also inert for GW1. `config.py:448` says an empty squad "means the opening
build, where the whole budget is cash", and FPL does not publish any entry's picks
before the first deadline — so an empty squad is the CORRECT input for GW1 and a
capture cannot improve it. This starts earning its keep at GW2, when a squad is
held and the API may lag behind what the owner has actually done.

## It never raises, and it is off by default

`_read_entry` is reached from `_decide_for_entries`, which the seal path calls
AFTER `seal_forecast` inside a `try/except Exception`. So an exception here costs a
proposal, not a seal. That is not licence to be careless: this returns None on
every failure, so a hub that is down, misconfigured, or slow degrades to the FPL
API read that already works, rather than turning a recoverable proposal into a red
run.

The gate is `FPL_HUB_CAPTURE`, and it must be set explicitly. Shipping this with
the gate off means the agent's behaviour is unchanged byte for byte until someone
decides otherwise — which is the only responsible way to add a network dependency
to a decision path in the days before an irrecoverable seal.

Standard library only, matching `pipeline/learning/schedule.py`'s discipline, so
this cannot drag a new dependency into the deadline path.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

#: The provenance value written by the hub's capture route. Distinct from
#: `captured_authenticated_draft`, which means "official picks were unavailable".
OWNER_CAPTURED = "owner_captured"

#: FPL applies price changes at roughly 01:30 UTC. A captured bank and set of
#: purchase prices are claims about the prices of one particular day, so they stop
#: being trustworthy once that boundary passes — not after some round number of
#: hours. The squad list itself does not age this way: it changes only when the
#: owner transfers, which is an act the owner would capture again.
PRICE_CHANGE_HOUR = 1
PRICE_CHANGE_MINUTE = 30

#: Short on purpose. This runs inside the pre-deadline decision path, where a slow
#: dependency is a worse failure than an absent one: the FPL API read below it
#: already works, so waiting is pure downside.
DEFAULT_TIMEOUT_SECONDS = 3.0

#: The table already exists, RLS enabled and forced, service-role only
#: (supabase/migrations/202607280001_create_private_fpl_snapshots.sql).
TABLE = "fpl_manager_snapshots"


@dataclass
class Capture:
    """
    One position the owner entered by hand, as stored.

    Units are integer tenths of a million throughout, matching
    `pipeline.fpl.entry_api.EntryState` so that nothing has to convert on the way
    into a decision. The table's `bank` and `squad_value` columns are millions,
    for reading in SQL; the `payload` this is built from is tenths.
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


def capture_enabled() -> bool:
    """
    Whether the agent should consult the hub at all.

    Defaults to FALSE, and only an explicit affirmative turns it on. A gate that
    could be switched on by an empty string or an unset variable would not be a
    gate.
    """
    return os.environ.get("FPL_HUB_CAPTURE", "").strip().lower() in {"1", "true", "yes"}


def _credentials() -> Optional[Dict[str, str]]:
    """Matches the frontend's fallback order in frontend/lib/fpl-snapshot-store.ts."""
    url = os.environ.get("SUPABASE_URL")
    secret = (
        os.environ.get("SUPABASE_SECRET_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    if not url or not secret:
        return None
    return {"url": url.rstrip("/"), "secret": secret}


def _price_change_has_passed(
    captured_at: datetime, now: Optional[datetime] = None
) -> bool:
    now = now or datetime.now(timezone.utc)
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    boundary = captured_at.astimezone(timezone.utc).replace(
        hour=PRICE_CHANGE_HOUR, minute=PRICE_CHANGE_MINUTE, second=0, microsecond=0
    )
    if boundary <= captured_at.astimezone(timezone.utc):
        boundary += timedelta(days=1)
    return boundary <= now.astimezone(timezone.utc)


def _parse_stamp(value: Any) -> Optional[datetime]:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _build(row: Dict[str, Any], entry_id: int, gameweek: int) -> Optional[Capture]:
    """
    Turn one row into a Capture, or None if it does not describe a usable position.

    Validated rather than trusted. This crosses a process boundary from a browser
    form, and a squad of the wrong size or an unparseable stamp would otherwise
    reach the optimiser as though the owner had asserted it.
    """
    captured_at = _parse_stamp(row.get("captured_at"))
    if captured_at is None:
        logger.warning("hub capture for entry %s has no readable captured_at", entry_id)
        return None

    payload = row.get("payload")
    if not isinstance(payload, dict):
        logger.warning("hub capture for entry %s has no payload object", entry_id)
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

    # A capture is a claim about a full squad. Fifteen is not a style preference:
    # the optimiser's transfer accounting starts from the squad it is handed, and a
    # short squad would silently read as free slots to fill.
    if len(squad) != 15 or len(set(squad)) != 15:
        logger.warning(
            "hub capture for entry %s holds %d distinct players, not 15; ignoring",
            entry_id, len(set(squad)),
        )
        return None

    return Capture(
        entry_id=entry_id,
        gameweek=gameweek,
        captured_at=captured_at,
        squad=squad,
        bank=bank,
        free_transfers=free_transfers,
        purchase_prices=purchase_prices,
    )


def read_capture(
    entry_id: int,
    gameweek: int,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Optional[Capture]:
    """
    The newest owner capture for this entry and gameweek, or None.

    None covers every reason there is nothing to use — gate off, no credentials,
    hub unreachable, no capture yet, malformed row — deliberately, because the
    caller's action is identical in all of them: fall through to the FPL API read
    that already works. The reasons are distinguished in the log, not in the
    return type.

    Scoped to `gameweek` in the query rather than filtered afterwards. A capture
    is a claim about one gameweek's position; serving GW3's squad into a GW4
    decision would be a wrong answer delivered confidently.
    """
    if not capture_enabled():
        return None

    credentials = _credentials()
    if credentials is None:
        logger.info(
            "FPL_HUB_CAPTURE is set but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are "
            "not; no capture can be read"
        )
        return None

    query = urllib.parse.urlencode(
        {
            "entry_id": f"eq.{int(entry_id)}",
            "event_id": f"eq.{int(gameweek)}",
            "source": f"eq.{OWNER_CAPTURED}",
            "select": "captured_at,payload",
            "order": "captured_at.desc",
            "limit": "1",
        }
    )
    request = urllib.request.Request(
        f"{credentials['url']}/rest/v1/{TABLE}?{query}",
        headers={
            "apikey": credentials["secret"],
            "Authorization": f"Bearer {credentials['secret']}",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        # Not re-raised. See the module docstring: the fallback below this is a
        # working read, so a hub outage must cost nothing.
        logger.warning("could not read hub capture for entry %s (%s)", entry_id, exc)
        return None

    if not isinstance(rows, list) or not rows:
        logger.info("no hub capture for entry %s GW%s", entry_id, gameweek)
        return None

    return _build(rows[0], int(entry_id), int(gameweek))
