"""
What the feeds are saying — the captured headlines, made visible.

## Why this exists

The poller reads six feeds every fifteen minutes and writes every item it can
link to a player into `availability_evidence.jsonl`. After one live run that was
59 items across BBC, Sky, FantasyFootballScout and Hayters.

**Nothing rendered any of them.** `evidence_view.json` carries resolved
availability claim trees, and every one of these is `unparsed_news` — a headline
the extractor deliberately refused to turn into an availability value, because
RSS prose cannot meet the zero-false-positive bar that R4 demands (a tier-2
claim can push availability *down*, so a wrong one is expensive). So they were
collected into a file with no reader and no route to a screen.

That is the gap this closes. The items are worth reading even when they carry no
machine-usable claim: "Solomon completes £7m move from Spurs" tells a manager
something no availability field will.

## What this is NOT

**These are not model inputs.** Nothing here has moved a projection, and the
view says so. The model uses FPL's own availability field plus parsed tier-2/3
claims, and the whole point of `unparsed_news` is that it is the residue the
parser would not vouch for. Presenting it as evidence the model used would be
the same lie as a hand-typed captaincy confidence.

It is a reading list, ranked by whether it touches players you hold.

## Bounding

Recency-windowed and count-capped, and deduplicated on `provenance_digest`:
one article that mentions three players is one article, not three headlines. The
file is published on the poller's 15-minute cadence, so an unbounded view would
be committed hundreds of times a day and grow all season.
"""

from __future__ import annotations

import json
import logging
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
FILENAME = "news_view.json"

#: Only `unparsed_news` reaches this view. A parsed claim belongs in
#: `evidence_view.json`, where its conflicts and the rule that beat it live.
KIND = "unparsed_news"

DEFAULT_MAX_AGE_DAYS = 5

#: How many articles the view carries.
#:
#: Raised from 60 after measuring the first X scan: five hand-curated posts
#: sorted to positions 58-64 of 66, so the cap dropped three of them. Age-ranked
#: ordering is correct, but it means the content chosen deliberately is the first
#: to be crowded out by continuous aggregator volume — the opposite of what the
#: ranking is for.
#:
#: 90 is headroom, not a solution. If the total approaches it again the answer is
#: a reserved slice per source rather than another bump, because bumping trades
#: a silent drop for a bigger file and keeps the same failure.
DEFAULT_LIMIT = 90

#: Headlines are truncated for display. The full text stays in the store.
MAX_HEADLINE = 180

#: How much of the article's own summary travels with the headline.
#:
#: The extractor already stores it — `source_text` is the title, a newline, and
#: the feed's summary — and this view dropped it for its whole life by reading
#: only the first line.
#:
#: 400 rather than the full body: the same allaboutfpl post carries 8.7KB of
#: article in its feed, and ninety of those would be 780KB the browser downloads
#: to render a reading list. 400 characters is the feed's own teaser length and
#: costs about 36KB across a full view.
MAX_SUMMARY = 400


def _parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def read_claims(predictions_dir: Path) -> List[Dict[str, Any]]:
    """Every record in the evidence store, or an empty list."""
    path = Path(predictions_dir) / "fpl" / "availability_evidence.jsonl"
    if not path.is_file():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            # One corrupt line must not hide the rest, but it is worth saying:
            # the store is append-only and a bad line means a bad write.
            logger.warning("unreadable line in the evidence store; skipping it")
            continue
        if isinstance(record, dict):
            out.append(record)
    return out


def _headline(record: Mapping[str, Any]) -> str:
    """The first line of the captured text, which is the article title."""
    text = record.get("source_text") or record.get("value") or ""
    first = str(text).split("\n", 1)[0].strip()
    return first[:MAX_HEADLINE]


def _summary(record: Mapping[str, Any]) -> Optional[str]:
    """
    Everything after the title, which the extractor has been storing all along.

    `source_text` is the title, a newline, then the feed's own summary — 300
    characters for a real allaboutfpl post, the body of the post for an X
    source. `_headline` takes the first line and the remainder went on the
    floor, so this view published a list of titles when it had what it needed
    for a readable card.

    None rather than "" when there is no second line, which is the case for some
    feeds: an empty string renders as a card with a blank body, where None
    renders as a headline that never had a summary.
    """
    text = str(record.get("source_text") or record.get("value") or "")
    rest = text.split("\n", 1)[1] if "\n" in text else ""
    # Feeds wrap at arbitrary widths, so the stored newlines are not the author's
    # paragraphs and collapsing them loses nothing a reader wanted.
    collapsed = " ".join(rest.split())
    return collapsed[:MAX_SUMMARY] or None


def _rank(item: Mapping[str, Any]) -> Tuple[bool, float, str]:
    """
    Squad-relevant first, then most recent, digest breaking ties.

    Extracted so the sort before the cap and the sort after it cannot drift: the
    balance step reorders items by source, and re-sorting with a second copy of
    this key is how the two silently stop matching.
    """
    when = _parse(item.get("claimed_at")) or datetime.min.replace(tzinfo=timezone.utc)
    return (not item.get("touches_squad"), -when.timestamp(), str(item.get("digest") or ""))


def _balanced(
    items: Sequence[Dict[str, Any]], limit: int,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """
    Fill the cap by taking a turn from each source, rather than off the top.

    ## The measured problem

    Ranking is squad-first then recency, and the cap was a flat slice of it. Two
    general football feeds publish far more than the FPL-specific ones, so a real
    poll filled the ninety slots: bbc_football 33, sky_football 24, hayters 14,
    fantasyfootballscout 11, x:robtFPL 5, x:OptaAnalyst 2 — and **allaboutfpl 1**.
    The sources chosen for FPL value were being crowded out by volume, which is
    what `DEFAULT_LIMIT` warned would happen and why it says a bigger cap is not
    the answer: raising it only admits more BBC.

    ## Why round-robin rather than a list of favoured sources

    A preferred-source list would work, and would bake an editorial opinion into
    the producer where the reader cannot see it and only a code change can move
    it. Taking a turn from each source needs no list: a feed with one article
    contributes it, a feed with eighty contributes whatever is left once the
    others have had their turn, and the total is unchanged.

    Order within a source is preserved, so each contributes its best first. The
    caller re-sorts the result into the global order, so the file still reads
    squad-first and most-recent-first.

    Returns the chosen items, and how many each source lost.
    """
    if len(items) <= limit:
        return list(items), {}

    queues: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
    for item in items:
        queues.setdefault(str(item.get("source") or "?"), []).append(item)

    chosen: List[Dict[str, Any]] = []
    while len(chosen) < limit and any(queues.values()):
        for queue in queues.values():
            if not queue:
                continue
            chosen.append(queue.pop(0))
            if len(chosen) >= limit:
                break

    return chosen, {source: len(rest) for source, rest in queues.items() if rest}


def build(
    claims: Sequence[Mapping[str, Any]],
    names: Mapping[int, Any],
    *,
    now: datetime,
    generated_at: str,
    held: Iterable[int] = (),
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    limit: int = DEFAULT_LIMIT,
) -> Dict[str, Any]:
    """
    Reduce the store to a bounded reading list.

    ``names`` maps element id to ``(web_name, club)``. ``held`` is the squad, so
    an item touching a player you own sorts first — the only ranking that
    reflects why someone would read this.
    """
    cutoff = now.astimezone(timezone.utc) - timedelta(days=max_age_days)
    squad = {int(e) for e in held}

    # One article is one item, however many players it names.
    by_article: Dict[str, Dict[str, Any]] = {}
    for record in claims:
        if record.get("claim_type") != KIND:
            continue
        claimed = _parse(record.get("claimed_at")) or _parse(record.get("observed_at"))
        if claimed is None or claimed < cutoff:
            continue

        digest = str(
            record.get("provenance_digest")
            or record.get("provenance_url")
            or record.get("claim_id")
            or ""
        )
        if not digest:
            continue

        element_id = record.get("element_id")
        label = names.get(element_id) if isinstance(element_id, int) else None
        player = {
            "element_id": element_id,
            "name": (label or (None, None))[0],
            "club": (label or (None, None))[1],
            "held": isinstance(element_id, int) and element_id in squad,
        } if isinstance(element_id, int) else None

        existing = by_article.get(digest)
        if existing is None:
            by_article[digest] = {
                "digest": digest,
                "headline": _headline(record),
                "summary": _summary(record),
                "source": record.get("source"),
                "tier": record.get("source_tier"),
                "url": record.get("provenance_url"),
                "claimed_at": record.get("claimed_at"),
                "players": [player] if player else [],
            }
        elif player and not any(
            p["element_id"] == player["element_id"] for p in existing["players"]
        ):
            existing["players"].append(player)

    items = list(by_article.values())
    for item in items:
        item["touches_squad"] = any(p["held"] for p in item["players"])

    # Squad-relevant first, then most recent. Digest breaks ties so the order is
    # total and a re-publish does not reshuffle the file for no reason.
    items.sort(key=_rank)

    # Every source gets a turn before any source gets a second one, so a feed
    # that publishes all day cannot bury one that publishes once.
    shown, lost_by_source = _balanced(items, limit)
    # Back into the global order: the balance decides *which* items travel, not
    # what the file reads like, and a round-robin order would interleave sources
    # into something no reader asked for.
    shown.sort(key=_rank)

    # A cap that drops content without saying so reads as "this is everything".
    # Naming the loss is the difference between a bound and a lie — and it is now
    # named per source, because "dropped 15" hid which source was being starved.
    dropped = max(0, len(items) - limit)
    if dropped:
        logger.warning(
            "news view is capped at %d and dropped %d article(s): %s",
            limit, dropped,
            ", ".join(f"{source} {n}" for source, n in sorted(lost_by_source.items())),
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        # Explicit, so a reader can tell a complete list from a truncated one.
        "n_dropped": dropped,
        # Which source lost what. A single total told you the list was truncated
        # and not that one source was being starved by another's volume.
        "dropped_by_source": dict(sorted(lost_by_source.items())),
        "window_days": max_age_days,
        "n_articles": len(items),
        "n_shown": len(shown),
        # Named in the artifact so a consumer cannot mistake this for evidence
        # the model acted on. Nothing here has moved a projection.
        "basis": (
            "Headlines the parser could not turn into an availability claim. "
            "None of this has moved a projection — the model uses FPL's own "
            "availability field and parsed tier-2/3 claims only. This is a "
            "reading list."
        ),
        "items": shown,
    }


def write(view: Mapping[str, Any], public_dir: Path) -> Path:
    """
    Publish the reading list.

    Writes directly rather than through `pipeline.fpl.artifacts`. That module is
    fine on the daily pipeline, which installs the full requirements, but the
    news poller installs only `requests` and `feedparser` — news.yml says so and
    explains why: it must finish in seconds, and pulling PyMC and SciPy would
    cost minutes per 15-minute tick.

    Importing the shared helper broke exactly that: the first live run failed
    with `No module named 'yaml'` and lost the view while keeping the poll. The
    write is three lines; the dependency was not worth it.

    Atomic via a temp file and `replace`, so a poll interrupted mid-write cannot
    leave the app fetching half a JSON document.
    """
    directory = Path(public_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / FILENAME
    scratch = target.with_suffix(".json.tmp")
    scratch.write_text(json.dumps(dict(view), indent=2) + "\n", encoding="utf-8")
    scratch.replace(target)
    return target
