"""
Turning a browser read of an X profile into rows the claim store already accepts.

## Why this exists, and why it is not a connector

The 3-hourly automated lanes both need money: xAI returns 403 until the team
buys credits, and X discontinued its free developer tier in February 2026. The
logged-out X profile page, however, serves the five most recent posts to anyone,
with permalinks — measured against `x.com/robtFPL`, not assumed.

So this is the third route: a Claude Code session reads the page through the
Chrome MCP and appends rows to a CSV inbox; the 15-minute poller reads that
inbox in CI, where there is no browser and no login. The two halves are
decoupled through a committed file, which is what lets each run where it can.

**This module contains no browser code and makes no network calls.** It is the
part that can be wrong — timestamps, text boundaries, CSV quoting — and is
therefore the part that is tested. `EXTRACT_JS` is the DOM read, kept here as a
constant so it is reviewable in a diff rather than retyped per session.

## What it does NOT do

It does not extract availability values. Every row it writes is
`unparsed_news`: the verbatim post, its author, its URL and its timestamp, and
no machine-usable claim. That is deliberate and it is the same bar the RSS path
holds — `availability_news.py` earns its parsed claims against a hand-labelled
corpus with zero false positives, because R4 lets a tier-2 claim push
availability *down*. Regex-guessing "a knock for Shaw" into a chance_of_playing
would be a fabricated number wearing a citation.

The posts land on `/evidence` as a reading list, which is honest and immediately
useful. Structured extraction is a separate change with its own corpus.

## Tier

Tier 3, always. robtFPL is a well-sourced aggregator, not a press conference,
and rule 2 of the feed contract is that tier 2 requires a direct quote from a
manager, club or presser reporter. Tier 3 cannot raise availability above FPL's
own field (R4), which is the correct ceiling for a third party's reading.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

#: Twitter's snowflake epoch in milliseconds (2010-11-04T01:42:54.657Z).
#:
#: A status id encodes its own creation time in the high bits, so the timestamp
#: comes from the id rather than from the page. That matters: the logged-out
#: profile renders "9 Aug" with no year and no time, and rule 4 of the feed
#: contract forbids inventing a timestamp. Decoding the id is exact, is stable
#: across every markup change X has ever made, and cannot drift a year at the
#: turn of January.
SNOWFLAKE_EPOCH_MS = 1288834974657

#: Bits the timestamp is shifted by inside the id.
SNOWFLAKE_SHIFT = 22

#: A decoded time before this is not a status id.
#:
#: The obvious guard — "reject anything decoding to before the epoch" — can
#: never fire, because shifting a positive integer right yields a non-negative
#: offset, so id `1` decodes to the epoch itself rather than to something
#: earlier. A floor date is the check that actually works. 2015 is well before
#: any post this repo cares about and well after ids reached 18 digits, so a
#: short or malformed id fails here instead of filing a claim dated 2010.
SNOWFLAKE_MIN_MS = 1420070400000  # 2015-01-01T00:00:00Z

#: Where the scan leaves its rows, relative to `predictions/fpl/`.
#:
#: Defined here rather than in the poller because this module owns the format.
#: The poller imports it, which also makes the dependency real: a constant copied
#: into both places would let the writer and the reader drift apart silently, and
#: the reachability test would report this module as reachable only from its own
#: test — which it was, until this moved.
INBOX_FILENAME = "x_inbox.csv"

#: The lane and claim type every scanned row uses. See the module docstring:
#: nothing here is a parsed availability value.
LANE = "availability"
CLAIM_TYPE = "unparsed_news"
TIER = 3

#: Engagement counters trail the post body in `innerText`: "4", "5", "82",
#: "18k". Dropping them by shape rather than by count is deliberate — a post
#: with no replies renders fewer of them.
COUNTER = re.compile(r"^[\d,.]+[KMkm]?$")

#: Lines X puts before the body: display name, @handle, and the date. Matched by
#: shape so a renamed account does not need a code change.
HANDLE = re.compile(r"^@[A-Za-z0-9_]{1,15}$")
SHORT_DATE = re.compile(r"^\d{1,2}\s+\w{3}$|^\w{3}\s+\d{1,2}$|^\d+[smhd]$")

#: A post shorter than this is a stub — a bare link or an emoji reply — and
#: carries nothing worth filing.
MIN_BODY = 24

#: Read from the DOM in the browser. Returns one record per article and nothing
#: derived: no timestamps, no text cleaning, no tier. Everything judgemental
#: happens in Python where it can be tested.
#:
#: Measured against the live logged-out page: `<time>` is absent and
#: `data-testid` attributes are not emitted at all in that view, so neither is
#: used. `article` and `a[href*="/status/"]` are both present.
EXTRACT_JS = """() => {
  const posts = [];
  for (const article of document.querySelectorAll('article')) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) continue;
    const id = (link.href.match(/status\\/(\\d+)/) || [])[1];
    if (!id) continue;
    posts.push({
      status_id: id,
      url: 'https://x.com/' + location.pathname.split('/')[1] + '/status/' + id,
      lines: article.innerText.split('\\n'),
    });
  }
  return { handle: location.pathname.split('/')[1], posts: posts };
}"""


def claimed_at(status_id: Any) -> Optional[str]:
    """
    The post's creation time, decoded from its id.

    Returns None rather than a guess for anything that is not a plausible
    snowflake — an id from before Twitter existed, or a non-numeric one, means
    the page shape changed and the caller should skip the row.
    """
    try:
        value = int(str(status_id).strip())
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    millis = (value >> SNOWFLAKE_SHIFT) + SNOWFLAKE_EPOCH_MS
    if millis < SNOWFLAKE_MIN_MS:
        return None
    try:
        stamp = datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    # Whole seconds. The store's dedupe hashes `claimed_at`, and sub-second
    # precision buys nothing while making two reads of one post look different
    # if the page ever rounds differently.
    return stamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def body_from_lines(lines: Sequence[str]) -> str:
    """
    The post text, with X's chrome removed.

    Drops the leading display name / @handle / date block and the trailing
    engagement counters, then rejoins. Boundaries are found by shape rather than
    by index: a quote-tweet or a missing counter shifts every position, and an
    off-by-one here silently files half a post as the claim.
    """
    cleaned = [str(line).strip() for line in lines]

    start = 0
    for index, line in enumerate(cleaned[:6]):
        if HANDLE.match(line):
            # The body begins after the handle and the date that follows it.
            start = index + 1
            while start < len(cleaned) and (
                not cleaned[start] or cleaned[start] == "·"
                or SHORT_DATE.match(cleaned[start])
            ):
                start += 1
            break

    end = len(cleaned)
    while end > start and (not cleaned[end - 1] or COUNTER.match(cleaned[end - 1])):
        end -= 1

    return "\n".join(cleaned[start:end]).strip()


def club_in(text: str) -> str:
    """
    The club a post is about, when its name is literally in the text.

    This is a lookup, not an inference: it matches the canonical names and
    aliases in `team_mapping.TEAM_ALIASES` — the table CLAUDE.md requires every
    provider's club names to go through — as whole words, and returns the
    canonical spelling.

    **Requires exactly one distinct club.** robtFPL's per-club summaries name one
    ("Arsenal summary from the Dortmund friendly"), but a post comparing two
    sides names two, and picking either would be a guess. Ambiguity returns
    empty, which the caller treats as "no club" rather than as an error — the row
    is still attributable through `source` and `url`.
    """
    from pipeline.data.team_mapping import TEAM_ALIASES

    haystack = str(text)
    found = set()
    for canonical, aliases in TEAM_ALIASES.items():
        for alias in (canonical, *aliases):
            # Word boundaries matter: "Brentford" must not match inside another
            # word, and short aliases would otherwise hit ordinary prose.
            if re.search(rf"\b{re.escape(str(alias))}\b", haystack, re.IGNORECASE):
                found.add(canonical)
                break
    return next(iter(found)) if len(found) == 1 else ""


def to_items(
    scan: Mapping[str, Any],
    *,
    source: str,
    club: Optional[str] = None,
    now: Optional[datetime] = None,
    max_age_days: int = 3,
) -> List[Dict[str, Any]]:
    """
    Turn a browser scan into feed items, dropping what cannot be filed.

    `club` pins every row to one club; leave it None to detect per post via
    `club_in`. An account covering the whole league needs the detection, and a
    club-specific account is better served by pinning it.
    """
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    items: List[Dict[str, Any]] = []

    for post in scan.get("posts") or []:
        if not isinstance(post, Mapping):
            continue
        stamp = claimed_at(post.get("status_id"))
        if stamp is None:
            continue
        age = (moment - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).days
        # A month-old post is not news. Bounded here as well as downstream so a
        # scan of a quiet account does not refile its whole visible history.
        if age > max_age_days or age < 0:
            continue

        body = body_from_lines(post.get("lines") or [])
        if len(body) < MIN_BODY:
            continue

        url = str(post.get("url") or "")
        if not url.startswith("https://"):
            continue

        items.append({
            "lane": LANE,
            "claim_type": CLAIM_TYPE,
            "value": body,
            "player_surname": "",
            "club": club if club is not None else club_in(body),
            "tier": TIER,
            "source": source,
            "quote": "",
            "url": url,
            "claimed_at": stamp,
            "metric": "",
            "horizon_gameweeks": "",
        })
    return items


def to_csv(items: Iterable[Mapping[str, Any]], columns: Sequence[str]) -> str:
    """
    Render items as the feed CSV, header included.

    Uses `csv.writer` rather than joining on commas. Post bodies contain commas,
    quotes and newlines as a matter of course, and a hand-rolled join produced a
    one-line file with zero parsable rows the first time this was attempted by
    hand.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    writer.writerow(list(columns))
    for item in items:
        writer.writerow([str(item.get(column, "") or "") for column in columns])
    return buffer.getvalue()


def merge_inbox(existing: str, fresh: str, columns: Sequence[str]) -> str:
    """
    Append new rows to an inbox, dropping ones already present.

    Deduplicates on `(url, claimed_at)`. The claim store dedupes again on
    `claim_id`, so this is not what protects the store — it is what stops the
    committed file growing without bound as the same five visible posts are
    rescanned twice a day.
    """
    header = list(columns)
    seen = set()
    rows: List[List[str]] = []

    for source in (existing, fresh):
        if not source or not source.strip():
            continue
        reader = csv.reader(io.StringIO(source))
        for index, row in enumerate(reader):
            if not row or (index == 0 and row[:1] == header[:1]):
                continue
            padded = (row + [""] * len(header))[:len(header)]
            record = dict(zip(header, padded))
            key = (record.get("url"), record.get("claimed_at"))
            if key in seen:
                continue
            seen.add(key)
            rows.append(padded)

    # Newest first, so a human opening the file reads the current news.
    rows.sort(key=lambda r: dict(zip(header, r)).get("claimed_at") or "", reverse=True)

    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue()


def write_inbox(path: Path, csv_text: str) -> Path:
    """
    Publish the inbox atomically.

    The poller may read this file at any moment on its 15-minute tick; a
    half-written CSV would parse as a truncated row rather than fail.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_suffix(".csv.tmp")
    scratch.write_text(csv_text, encoding="utf-8")
    scratch.replace(target)
    return target


def ingest(raw: Any, *, source: str, club: Optional[str], predictions_dir: Path,
           now: Optional[datetime] = None, max_age_days: int = 3) -> int:
    """
    Merge one browser scan into the inbox. Returns the row count afterwards.

    Takes the raw payload the Chrome MCP returned, so the session hands over
    exactly what it read with no reshaping in between.
    """
    from pipeline.data.grok_feed import SHEET_COLUMNS, parse_sheet

    scan = raw
    # The MCP tool may wrap the payload; find the object that has posts.
    while isinstance(scan, Mapping) and "posts" not in scan:
        nested = [v for v in scan.values() if isinstance(v, Mapping) and "posts" in v]
        if not nested:
            break
        scan = nested[0]
    if not isinstance(scan, Mapping) or "posts" not in scan:
        raise ValueError("scan payload has no 'posts'; the extractor returned "
                         "something else and filing it would be a guess")

    items = to_items(scan, source=source, club=club, now=now,
                     max_age_days=max_age_days)
    target = Path(predictions_dir) / "fpl" / INBOX_FILENAME
    existing = target.read_text(encoding="utf-8") if target.is_file() else ""
    merged = merge_inbox(existing, to_csv(items, SHEET_COLUMNS), SHEET_COLUMNS)
    write_inbox(target, merged)
    return len(parse_sheet(merged).get("items") or [])


def main(argv: Optional[Sequence[str]] = None) -> int:
    """
    `python -m pipeline.data.x_scan --raw scan.json --source x:robtFPL`

    The browser half runs in a Claude Code session; this is the half that turns
    its output into rows. Separating them is what makes the logic testable — and
    what lets the same rows arrive from anything that can produce the payload.
    """
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Merge an X scan into the inbox.")
    parser.add_argument("--raw", required=True,
                        help="JSON file holding the extractor's output")
    parser.add_argument("--source", required=True, help="e.g. x:robtFPL")
    parser.add_argument("--club", default=None,
                        help="pin every row to one club; omit to detect per post")
    parser.add_argument("--predictions-dir", default="predictions")
    parser.add_argument("--max-age-days", type=int, default=3)
    args = parser.parse_args(argv)

    total = ingest(
        json.loads(Path(args.raw).read_text(encoding="utf-8")),
        source=args.source, club=args.club,
        predictions_dir=Path(args.predictions_dir),
        max_age_days=args.max_age_days,
    )
    print(f"x inbox now holds {total} row(s)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
