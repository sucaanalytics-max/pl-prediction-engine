"""
YouTube upload metadata — titles and descriptions only, via the official API.

## What this may and may not touch

**Transcripts are excluded, permanently.** YouTube's terms prohibit them four
separate ways: §III.E.6 bars obtaining scraped YouTube data at all, §III.I.14
bars non-API access, and §III.E.1(a) bars downloading audiovisual content.
Buying transcripts from a vendor does not launder any of that. So this module
reads what the Data API returns for a video and nothing else: title,
description, publish time, channel.

That is a real limitation and worth stating plainly — the analysis is in the
video, and we can only see its label.

## Why it is still worth having

Two things, neither of which needs the audio:

1. **Titles sometimes carry the claim outright** — "Salah OUT — confirmed" is a
   tier-3 signal that costs one API unit to see.
2. **A burst of uploads about one club is evidence that news landed.** That is
   the more valuable signal, and it does not depend on parsing anything: five
   channels posting about Arsenal within an hour means something happened, and
   the poller should open its window rather than wait for the next scheduled
   tick.

This is the weakest of the four connectors, which is why the plan builds it
last and why nothing else depends on it.

## Quota

Free tier is 10,000 units/day. The expensive mistake is `search.list`, which
costs **100 units** per call and has its own separate 100/day cap — fifteen
channels polled hourly through `search.list` would exhaust everything in a
single morning.

So this never calls `search.list`. It resolves each channel's uploads playlist
once via `channels.list` (1 unit), caches that id forever because it does not
change, and then reads `playlistItems.list` (1 unit) per poll. Fifteen channels
at four polls an hour is ~1,440 units/day against a 10,000 budget, and the
ledger below refuses to spend past a configured ceiling rather than trusting
that arithmetic to stay true.

## The 30-day storage cap

The terms require API-derived data to be deleted within 30 days. `prune` does
that, and `poll` calls it every run — an intention that is not enforced by code
is not a policy. The cap applies to what we *store*; a claim already extracted
and written to the availability store is our own derived observation, and the
raw metadata behind it is what expires.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pipeline.data.news_feeds import FeedEntry, FeedOutcome

logger = logging.getLogger(__name__)

API_BASE = "https://www.googleapis.com/youtube/v3"

STATE_KEY = "youtube"
STATE_VERSION = 1

#: Bumped when the emitted `FeedEntry` shape or the parsing changes.
FETCHER_VERSION = 1

#: Unit costs, from the published quota table. Named so the arithmetic in
#: `poll` is checkable against the documentation rather than being folklore.
COST_CHANNELS_LIST = 1
COST_PLAYLIST_ITEMS = 1
#: Never used. Present so the reason for its absence is greppable.
COST_SEARCH_LIST = 100

#: YouTube's terms. Not a tuning knob.
MAX_STORAGE_DAYS = 30


class QuotaExhausted(RuntimeError):
    """Raised when a call would exceed the configured daily ceiling."""


@dataclass
class Ledger:
    """
    Units spent today, persisted between runs.

    Keyed on the UTC date because that is the boundary the quota resets on. A
    local-midnight reset would hand back the budget at the wrong hour and, in
    British Summer Time, hand it back twice on one day a year.
    """

    date: str
    spent: int = 0
    ceiling: int = 5_000

    def would_exceed(self, cost: int) -> bool:
        return self.spent + cost > self.ceiling

    def charge(self, cost: int) -> None:
        if self.would_exceed(cost):
            raise QuotaExhausted(
                f"{self.spent} of {self.ceiling} units spent today; "
                f"a further {cost} would exceed the ceiling"
            )
        self.spent += cost

    def as_dict(self) -> Dict[str, Any]:
        return {"date": self.date, "spent": self.spent, "ceiling": self.ceiling}


def load_ledger(state: Mapping[str, Any], now: datetime, ceiling: int) -> Ledger:
    """The ledger for today, reset when the UTC date has rolled."""
    stored = (state.get(STATE_KEY) or {}).get("ledger") or {}
    today = now.astimezone(timezone.utc).date().isoformat()
    if stored.get("date") != today:
        return Ledger(date=today, spent=0, ceiling=ceiling)
    return Ledger(
        date=today,
        spent=int(stored.get("spent") or 0),
        # The ceiling comes from config, not from the stored copy: a lowered
        # limit must take effect immediately rather than on the next date roll.
        ceiling=ceiling,
    )


def _get(path: str, params: Mapping[str, Any], timeout: int) -> Dict[str, Any]:
    """One API call. Raises on anything but a 200."""
    import requests

    response = requests.get(f"{API_BASE}/{path}", params=dict(params), timeout=timeout)
    if response.status_code == 403:
        # The API reports quota exhaustion as 403 with a reason in the body.
        # Distinguishing it from a bad key matters: one is "wait until tomorrow"
        # and the other is "this will never work".
        body = response.text[:500]
        if "quota" in body.lower():
            raise QuotaExhausted(f"YouTube reports the quota exhausted: {body}")
        raise RuntimeError(f"YouTube rejected the request (403): {body}")
    if response.status_code != 200:
        raise RuntimeError(
            f"YouTube {path} returned {response.status_code}: {response.text[:300]}"
        )
    return response.json()


def uploads_playlist_id(
    channel_id: str, api_key: str, state: Dict[str, Any], ledger: Ledger,
    timeout: int = 20,
) -> str:
    """
    The channel's uploads playlist, resolved once and cached forever.

    It is derived from the channel id and never changes, so paying a unit for it
    on every poll would be pure waste. Cached in state rather than computed by
    string surgery on the channel id: the `UC` → `UU` substitution is widely
    repeated and is an undocumented implementation detail, not a contract.
    """
    cache: Dict[str, Any] = state.setdefault(STATE_KEY, {}).setdefault("uploads", {})
    cached = cache.get(channel_id)
    if isinstance(cached, str) and cached:
        return cached

    ledger.charge(COST_CHANNELS_LIST)
    payload = _get(
        "channels",
        {"part": "contentDetails", "id": channel_id, "key": api_key},
        timeout,
    )
    items = payload.get("items") or []
    if not items:
        raise RuntimeError(f"YouTube knows no channel {channel_id}")
    playlist = (
        (items[0].get("contentDetails") or {}).get("relatedPlaylists") or {}
    ).get("uploads")
    if not isinstance(playlist, str) or not playlist:
        raise RuntimeError(f"channel {channel_id} exposes no uploads playlist")
    cache[channel_id] = playlist
    return playlist


def _entry_from_item(item: Mapping[str, Any], channel: Mapping[str, Any]) -> Optional[FeedEntry]:
    """
    One upload as a `FeedEntry`, or None when it is unusable.

    Deliberately the same type the RSS connector emits, so `news_extract` and
    the poller consume it with no branch on where it came from. A second entry
    shape would mean a second extractor, and a second extractor is a second set
    of rules that drift apart.
    """
    snippet = item.get("snippet") or {}
    title = snippet.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    video_id = ((snippet.get("resourceId") or {}).get("videoId")) or item.get("id")
    if not isinstance(video_id, str) or not video_id:
        return None

    published = snippet.get("publishedAt")
    description = snippet.get("description")
    return FeedEntry(
        feed=str(channel["name"]),
        tier=int(channel["tier"]),
        title=title.strip(),
        # Truncated: descriptions carry sponsor blurbs and timestamps that
        # dwarf the content and would swamp the extractor's text window.
        summary=(description or "")[:600].strip(),
        link=f"https://www.youtube.com/watch?v={video_id}",
        published_at=published if isinstance(published, str) else None,
        entry_id=f"youtube:{video_id}",
    )


def fetch_channel(
    channel: Mapping[str, Any],
    api_key: str,
    state: Dict[str, Any],
    ledger: Ledger,
    *,
    max_results: int = 10,
    timeout: int = 20,
) -> FeedOutcome:
    """
    Recent uploads from one channel.

    Never raises for an expected condition. A channel that is missing, private,
    or over quota returns a failed outcome with a reason, because one bad
    channel must not cost the other fourteen their poll.
    """
    name = str(channel["name"])
    try:
        playlist = uploads_playlist_id(
            str(channel["channel_id"]), api_key, state, ledger, timeout,
        )
        ledger.charge(COST_PLAYLIST_ITEMS)
        payload = _get(
            "playlistItems",
            {
                "part": "snippet",
                "playlistId": playlist,
                "maxResults": max_results,
                "key": api_key,
            },
            timeout,
        )
    except QuotaExhausted as error:
        # Distinct from a failure: nothing is wrong, there is simply no budget.
        return FeedOutcome(feed=name, status="skipped_interval", reason=str(error))
    except Exception as error:  # noqa: BLE001 - one channel must not sink the rest
        logger.warning("youtube channel %s failed: %s", name, error)
        return FeedOutcome(feed=name, status="failed", reason=str(error))

    entries = [
        entry
        for entry in (
            _entry_from_item(item, channel) for item in payload.get("items") or []
        )
        if entry is not None
    ]
    return FeedOutcome(feed=name, status="fetched", entries=entries)


def prune(state: Dict[str, Any], now: datetime, max_days: int = MAX_STORAGE_DAYS) -> int:
    """
    Drop stored metadata older than the terms allow.

    Returns how many records were removed. Called on every poll rather than on a
    schedule: a policy enforced by a cron job that has not run is not enforced.
    """
    store: Dict[str, Any] = state.setdefault(STATE_KEY, {}).setdefault("seen", {})
    cutoff = now.astimezone(timezone.utc) - timedelta(days=max_days)
    removed = 0
    for key in list(store.keys()):
        stamp = store.get(key)
        if not isinstance(stamp, str):
            # No timestamp means we cannot prove it is inside the window, and
            # the safe reading of "delete within 30 days" is to delete it.
            del store[key]
            removed += 1
            continue
        try:
            seen_at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            del store[key]
            removed += 1
            continue
        if seen_at.tzinfo is None:
            seen_at = seen_at.replace(tzinfo=timezone.utc)
        if seen_at < cutoff:
            del store[key]
            removed += 1
    if removed:
        logger.info("pruned %d youtube record(s) past the %d-day cap", removed, max_days)
    return removed


@dataclass
class PollResult:
    """What one YouTube poll produced."""

    entries: List[FeedEntry] = field(default_factory=list)
    outcomes: List[FeedOutcome] = field(default_factory=list)
    units_spent: int = 0
    pruned: int = 0
    #: Set when the connector did not run at all, with the reason.
    skipped: Optional[str] = None

    @property
    def fresh(self) -> List[FeedEntry]:
        return self.entries


def poll(
    channels: Sequence[Mapping[str, Any]],
    state: Dict[str, Any],
    config: Mapping[str, Any],
    now: datetime,
    api_key: Optional[str],
) -> PollResult:
    """
    Poll every configured channel, within the day's remaining budget.

    Returns a `PollResult` whose `skipped` is set when no API key is configured
    — which is the state today. That is not an error and must not fail the run:
    the connector is additive, and every other source works without it.
    """
    if not api_key:
        return PollResult(
            skipped=(
                "No YOUTUBE_API_KEY is configured, so no upload metadata was "
                "fetched. Every other news source is unaffected."
            )
        )
    if not channels:
        return PollResult(skipped="No channels are configured.")

    ledger = load_ledger(state, now, int(config.get("daily_unit_ceiling", 5_000)))
    started = ledger.spent
    outcomes: List[FeedOutcome] = []
    entries: List[FeedEntry] = []
    seen: Dict[str, Any] = state.setdefault(STATE_KEY, {}).setdefault("seen", {})
    stamp = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    for channel in channels:
        outcome = fetch_channel(
            channel, api_key, state, ledger,
            max_results=int(config.get("max_results", 10)),
            timeout=int(config.get("timeout_seconds", 20)),
        )
        outcomes.append(outcome)
        for entry in outcome.entries:
            if entry.entry_id in seen:
                continue
            seen[entry.entry_id] = stamp
            entries.append(entry)

    pruned = prune(state, now, int(config.get("max_storage_days", MAX_STORAGE_DAYS)))
    state.setdefault(STATE_KEY, {})["ledger"] = ledger.as_dict()
    state.setdefault(STATE_KEY, {})["version"] = STATE_VERSION

    return PollResult(
        entries=entries,
        outcomes=outcomes,
        units_spent=ledger.spent - started,
        pruned=pruned,
    )


def club_burst(
    entries: Sequence[FeedEntry],
    clubs: Mapping[str, Sequence[str]],
    *,
    threshold: int = 3,
) -> Dict[str, int]:
    """
    Clubs mentioned by several channels at once.

    The signal worth having from this connector. Counts **distinct channels**,
    not videos: one channel posting four times about Arsenal is a content
    schedule, whereas four channels posting once each within the same poll is
    evidence that something happened.

    `clubs` maps a canonical club name to the aliases to match, so the caller
    supplies the mapping from `pipeline/data/team_mapping.py` conventions rather
    than this module inventing a second one.
    """
    by_club: Dict[str, set] = {}
    for entry in entries:
        haystack = entry.text.lower()
        for club, aliases in clubs.items():
            if any(alias.lower() in haystack for alias in aliases):
                by_club.setdefault(club, set()).add(entry.feed)
    return {
        club: len(channels)
        for club, channels in sorted(by_club.items())
        if len(channels) >= threshold
    }
