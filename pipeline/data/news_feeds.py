"""
Fetching the press-conference feed cluster, politely and idempotently.

This module's whole job is to turn six URLs into a list of `(title, summary, link,
published_at)` tuples. It derives no availability, resolves no player, and knows
nothing about claims — `news_extract.py` does that, and keeping the two apart is
what makes the extractor testable against a fixture corpus rather than against the
internet.

## Why conditional GET is load-bearing rather than good manners

The poller runs on a 15-minute cron, which is ~96 requests per feed per day. These
are small independent sites; that is a real cost to them and a real risk to us of
being blocked. So every request carries `If-None-Match` / `If-Modified-Since` from
the last response, and a 304 costs one round trip and yields nothing to parse.

**Two of the six do not support it.** Measured against the live endpoints:

    hayters.com                  ETag + Last-Modified
    allaboutfpl.com              ETag + Last-Modified
    www.premierfantasytools.com  Last-Modified
    www.fantasyfootballscout.co.uk  ETag + Last-Modified
    feeds.bbci.co.uk             NEITHER
    www.skysports.com            NEITHER

For BBC and Sky a conditional request is impossible, so the per-host minimum
interval is the only thing standing between us and a full re-download every
fifteen minutes. That is why the interval exists as well as the validators, and
why those two hosts get a longer one.

## Why the URLs are post-redirect

Three of the six 301 to a different host or path. Following a redirect on every
poll doubles the request count against sites we are trying not to burden, so
`NEWS_FEEDS` records the canonical target and redirects are *not* followed by
default — a new redirect means the feed moved and should be noticed, not absorbed.

## Failure policy

A feed that fails is logged and skipped; the others still run. This is the
"optional scraped sources degrade gracefully" side of the repo's contract, and it
is correct here because these feeds *add* claims: rule R4 means a missing tier-2
claim leaves FPL's own field standing, which is exactly today's behaviour. A feed
that fails silently upgrades nothing and downgrades nothing.

What must NOT be silent is a feed failing *persistently*, which would mean the
news layer has quietly stopped working while the app still shows a green tick.
`FeedOutcome.consecutive_failures` is carried in the state file for that reason,
and the caller escalates on it.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

STATE_FILENAME = "news_feed_state.json"
STATE_VERSION = 1

# Bumped when `FeedEntry` gains or loses a field, so a stored state file written by
# an older poller is recognisable rather than merely surprising.
FETCHER_VERSION = 1


class FeedError(RuntimeError):
    """A feed could not be fetched or parsed."""


@dataclass(frozen=True)
class FeedEntry:
    """One item from one feed, before any interpretation."""

    feed: str
    tier: int
    title: str
    summary: str
    link: str
    # When the SOURCE says it published this. None when the feed omits a date,
    # which is common enough to handle and never worth inventing: `claimed_at`
    # feeds rule R2's tie-break, so a fabricated timestamp would let a stale item
    # outrank a fresh one.
    published_at: Optional[str]
    # Stable identity for the entry, from the feed's own guid where it has one.
    entry_id: str

    @property
    def text(self) -> str:
        """Title and summary together, which is what the extractor reads."""
        return f"{self.title}\n{self.summary}".strip()


@dataclass
class FeedOutcome:
    """What happened to one feed on one tick."""

    feed: str
    status: str  # "fetched" | "not_modified" | "skipped_interval" | "failed"
    entries: List[FeedEntry] = field(default_factory=list)
    reason: str = ""
    consecutive_failures: int = 0


def load_state(predictions_dir: Path) -> Dict[str, Any]:
    """
    Per-feed ETag, Last-Modified, last poll time and failure streak.

    A missing or unreadable state file yields an empty state rather than raising:
    losing the validators costs one unconditional fetch per feed, which is
    recoverable, whereas refusing to poll loses perishable team news outright.
    """
    path = Path(predictions_dir) / STATE_FILENAME
    if not path.exists():
        return {"version": STATE_VERSION, "feeds": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("news feed state unreadable (%s); starting fresh", exc)
        return {"version": STATE_VERSION, "feeds": {}}
    if not isinstance(payload, Mapping) or "feeds" not in payload:
        logger.warning("news feed state has no feeds map; starting fresh")
        return {"version": STATE_VERSION, "feeds": {}}
    return dict(payload)


def save_state(state: Mapping[str, Any], predictions_dir: Path) -> Path:
    path = Path(predictions_dir) / STATE_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(state)
    payload["version"] = STATE_VERSION
    payload["fetcher_version"] = FETCHER_VERSION
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")
    return path


def host_of(url: str) -> str:
    return urlsplit(url).netloc


def min_interval_for(url: str, config: Mapping[str, Any]) -> int:
    intervals = config.get("min_interval_seconds") or {}
    if not isinstance(intervals, Mapping):
        return 0
    return int(intervals.get(host_of(url), intervals.get("default", 0)))


def due(
    feed: Mapping[str, Any],
    feed_state: Mapping[str, Any],
    config: Mapping[str, Any],
    now: datetime,
) -> Tuple[bool, str]:
    """
    Whether enough time has passed to poll this feed again.

    Enforced against the feed's own last *attempt*, not against the cron tick, so
    a queued or doubled-up workflow run cannot bypass it.
    """
    last = feed_state.get("last_attempt_at")
    if not last:
        return True, ""
    try:
        previous = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        # An unparseable stamp is treated as "no idea when we last asked", which
        # errs toward one extra request rather than toward never polling again.
        return True, ""
    if previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    interval = min_interval_for(str(feed["url"]), config)
    elapsed = (now - previous).total_seconds()
    if elapsed < interval:
        return False, f"{int(interval - elapsed)}s until next poll"
    return True, ""


def _read_capped(response: Any, max_bytes: int) -> bytes:
    """
    Read at most `max_bytes`, then stop.

    Streamed and capped rather than `response.content`, so an oversized or
    endless body is never fully materialised. The cap is applied BEFORE any
    parsing: feedparser is a reasonable library but it is still an XML parser
    reading bytes from six third-party sites, and the cheapest mitigation is to
    put a bound on what it is allowed to see.
    """
    chunks: List[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=65_536):
        if not chunk:
            continue
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            raise FeedError(f"response exceeded {max_bytes} bytes")
    return b"".join(chunks)


def _entry_timestamp(entry: Any) -> Optional[str]:
    """
    The entry's own publication time as ISO-8601 UTC, or None.

    feedparser normalises RSS 2.0's RFC 822 and Atom's RFC 3339 into a
    `struct_time` in UTC, which is precisely why it is worth the dependency: a
    hand-rolled parser that mishandled one of those formats would misorder claims,
    and R2 breaks ties on `claimed_at`.
    """
    for key in ("published_parsed", "updated_parsed"):
        parsed = getattr(entry, key, None) or (
            entry.get(key) if isinstance(entry, Mapping) else None
        )
        if not parsed:
            continue
        try:
            moment = datetime(*parsed[:6], tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        return moment.isoformat().replace("+00:00", "Z")
    return None


def _strip_html(text: str) -> str:
    """
    Feed summaries are HTML. Reduce to text without pulling in a parser.

    Deliberately crude: the extractor matches patterns against short factual
    sentences, and a stray entity is harmless there, whereas adding BeautifulSoup
    to a 15-minute job for cosmetic cleanup is not worth the import cost.
    """
    out: List[str] = []
    depth = 0
    for char in text:
        if char == "<":
            depth += 1
        elif char == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(char)
    cleaned = "".join(out)
    for entity, literal in (
        ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
        ("&#8217;", "'"), ("&#8216;", "'"), ("&#8211;", "-"), ("&#038;", "&"),
        ("&nbsp;", " "),
    ):
        cleaned = cleaned.replace(entity, literal)
    return " ".join(cleaned.split())


def parse(raw: bytes, feed_name: str, tier: int) -> List[FeedEntry]:
    """
    Bytes to entries. No network, so this is what the corpus tests drive.

    feedparser sets `bozo` on malformed input but still returns whatever it could
    read. That is the behaviour we want — one broken entry must not cost the other
    nineteen — so `bozo` is logged rather than raised on.
    """
    import feedparser  # Imported here so the module is importable without it.

    parsed = feedparser.parse(raw)
    if getattr(parsed, "bozo", 0) and not parsed.entries:
        raise FeedError(
            f"{feed_name}: unparseable feed "
            f"({getattr(parsed, 'bozo_exception', 'unknown')})"
        )
    if getattr(parsed, "bozo", 0):
        logger.info(
            "%s: feed is malformed but %d entr(ies) were readable",
            feed_name, len(parsed.entries),
        )

    entries: List[FeedEntry] = []
    for item in parsed.entries:
        title = _strip_html(str(item.get("title") or ""))
        summary = _strip_html(str(item.get("summary") or item.get("description") or ""))
        if not title and not summary:
            continue
        link = str(item.get("link") or "")
        entries.append(FeedEntry(
            feed=feed_name,
            tier=tier,
            title=title,
            summary=summary,
            link=link,
            published_at=_entry_timestamp(item),
            # Prefer the feed's own guid. Falling back to the link keeps identity
            # stable for feeds that omit one; falling back to the title would make
            # a corrected headline look like a new item.
            entry_id=str(item.get("id") or item.get("guid") or link or title),
        ))
    return entries


def recent(
    entries: Sequence[FeedEntry], now: datetime, max_age_days: int,
) -> List[FeedEntry]:
    """
    Drop entries older than the window.

    An entry with no timestamp is KEPT. It cannot be shown to be old, and the
    store deduplicates by content anyway — so the cost of keeping it is one
    redundant extraction, while the cost of dropping it is losing a claim from
    every feed that omits dates.
    """
    cutoff = now - timedelta(days=max_age_days)
    kept: List[FeedEntry] = []
    for entry in entries:
        if entry.published_at is None:
            kept.append(entry)
            continue
        try:
            moment = datetime.fromisoformat(entry.published_at.replace("Z", "+00:00"))
        except ValueError:
            kept.append(entry)
            continue
        if moment >= cutoff:
            kept.append(entry)
    return kept


def fetch_one(
    feed: Mapping[str, Any],
    state: Dict[str, Any],
    config: Mapping[str, Any],
    now: datetime,
    session: Any = None,
) -> FeedOutcome:
    """
    Fetch one feed, honouring its validators and its interval.

    Mutates `state["feeds"][name]` with the new validators and attempt time. The
    caller saves the state once for all feeds, so a crash mid-run costs at most
    one tick's validators rather than corrupting the file.
    """
    import requests

    name = str(feed["name"])
    url = str(feed["url"])
    tier = int(feed["tier"])
    feeds_state: Dict[str, Any] = state.setdefault("feeds", {})
    feed_state: Dict[str, Any] = feeds_state.setdefault(name, {})

    ready, why = due(feed, feed_state, config, now)
    if not ready:
        return FeedOutcome(feed=name, status="skipped_interval", reason=why,
                           consecutive_failures=int(feed_state.get("failures", 0)))

    headers = {"User-Agent": str(config.get("user_agent", "pl-prediction-engine/1.0")),
               "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"}
    if feed_state.get("etag"):
        headers["If-None-Match"] = str(feed_state["etag"])
    if feed_state.get("last_modified"):
        headers["If-Modified-Since"] = str(feed_state["last_modified"])

    feed_state["last_attempt_at"] = now.isoformat().replace("+00:00", "Z")
    getter = session.get if session is not None else requests.get

    try:
        response = getter(
            url, headers=headers,
            timeout=int(config.get("timeout_seconds", 20)),
            stream=True,
            # Not followed on purpose: NEWS_FEEDS holds the post-redirect URL, so
            # a redirect now means the feed MOVED. Absorbing it silently would
            # hide that and double every request.
            allow_redirects=False,
        )
    except Exception as exc:  # noqa: BLE001 - any transport error is the same here
        feed_state["failures"] = int(feed_state.get("failures", 0)) + 1
        return FeedOutcome(feed=name, status="failed", reason=str(exc)[:200],
                           consecutive_failures=feed_state["failures"])

    try:
        if response.status_code == 304:
            feed_state["failures"] = 0
            feed_state["last_not_modified_at"] = feed_state["last_attempt_at"]
            return FeedOutcome(feed=name, status="not_modified")

        if response.status_code in (301, 302, 307, 308):
            feed_state["failures"] = int(feed_state.get("failures", 0)) + 1
            location = response.headers.get("Location", "?")
            return FeedOutcome(
                feed=name, status="failed",
                reason=(f"feed moved to {location} — update NEWS_FEEDS rather than "
                        f"following it on every poll"),
                consecutive_failures=feed_state["failures"],
            )

        if response.status_code != 200:
            feed_state["failures"] = int(feed_state.get("failures", 0)) + 1
            return FeedOutcome(feed=name, status="failed",
                               reason=f"HTTP {response.status_code}",
                               consecutive_failures=feed_state["failures"])

        try:
            raw = _read_capped(response, int(config.get("max_bytes", 4_000_000)))
            entries = parse(raw, name, tier)
        except FeedError as exc:
            feed_state["failures"] = int(feed_state.get("failures", 0)) + 1
            return FeedOutcome(feed=name, status="failed", reason=str(exc)[:200],
                               consecutive_failures=feed_state["failures"])
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    # Only recorded on a successful parse. Storing a validator for a response we
    # could not read would make the next poll a 304 and skip the feed forever.
    if response.headers.get("ETag"):
        feed_state["etag"] = response.headers["ETag"]
    if response.headers.get("Last-Modified"):
        feed_state["last_modified"] = response.headers["Last-Modified"]
    feed_state["failures"] = 0
    feed_state["last_success_at"] = feed_state["last_attempt_at"]
    feed_state["last_entry_count"] = len(entries)

    fresh = recent(entries, now, int(config.get("max_entry_age_days", 10)))
    return FeedOutcome(feed=name, status="fetched", entries=fresh)


def fetch_all(
    feeds: Sequence[Mapping[str, Any]],
    state: Dict[str, Any],
    config: Mapping[str, Any],
    now: datetime,
    session: Any = None,
) -> List[FeedOutcome]:
    """Every feed, independently. One failure never stops the others."""
    outcomes: List[FeedOutcome] = []
    for feed in feeds:
        outcome = fetch_one(feed, state, config, now, session=session)
        if outcome.status == "failed":
            logger.warning("feed %s failed: %s", outcome.feed, outcome.reason)
        else:
            logger.info("feed %s: %s (%d entries)",
                        outcome.feed, outcome.status, len(outcome.entries))
        outcomes.append(outcome)
    return outcomes


# A feed broken this many consecutive ticks has stopped working rather than had a
# bad minute, and the human should be told. At a 15-minute cadence this is a few
# hours, which is short enough to matter before a deadline.
FAILURE_ESCALATION_THRESHOLD = 8


def feeds_needing_escalation(
    outcomes: Sequence[FeedOutcome],
) -> List[FeedOutcome]:
    """
    Feeds whose failures have gone from noise to signal.

    The point of the threshold is that a single failure is genuinely fine — these
    are small sites and the poller runs 96 times a day — while a persistent one
    means the news layer has stopped working. Without this, that difference is
    invisible and the app shows a healthy agent with no news.
    """
    return [o for o in outcomes
            if o.status == "failed"
            and o.consecutive_failures >= FAILURE_ESCALATION_THRESHOLD]
