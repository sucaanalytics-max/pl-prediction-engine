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

## What it refuses to read

Everything a logged-out curated profile served was football by construction. A
signed-in scroll is not: it carries reposts from arbitrary accounts and, on a
home timeline, mostly not football at all (measured 2 of 21, with zero team
news). So `to_items` puts every post through `x_relevance.is_football_relevant`
before building a row, unconditionally — see the note on that call for why there
is no opt-out.

## Tier

Tier 3, always. robtFPL is a well-sourced aggregator, not a press conference,
and rule 2 of the feed contract is that tier 2 requires a direct quote from a
manager, club or presser reporter. Tier 3 cannot raise availability above FPL's
own field (R4), which is the correct ceiling for a third party's reading.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from pipeline.config import X_SCAN_MAX_AGE_DAYS

from pipeline.data.news_extract import fold
from pipeline.data.x_relevance import (
    GATE_VERSION, is_football_relevant, trusted_handles,
)

logger = logging.getLogger(__name__)

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

#: X's own truncation control, rendered as a line of its own on a long post
#: (corpus posts #0/#9/#18/#20 of `fixtures/x_feed_corpus.json`). It is chrome,
#: not text: leaving it in puts a UI label inside the verbatim quote a human
#: reads on `/evidence`.
#:
#: Its other consequence is not fixable here and is worth stating: text past the
#: fold was never in the DOM, so a post can be refused by the relevance gate for
#: lacking a word it actually contains. Expanding the post is a browser-side
#: change to `x_extract.js`, not a Python one.
TRUNCATION_MARKERS = ("Show more", "Show less")

#: Read from the DOM in the browser. Returns one record per article and nothing
#: derived: no timestamps, no text cleaning, no tier. Everything judgemental
#: happens in Python where it can be tested.
#:
#: Measured against the live logged-out page: `<time>` is absent and
#: `data-testid` attributes are not emitted at all in that view, so neither is
#: used. `article` and `a[href*="/status/"]` are both present.
#: Path to the DOM read, which lives in its own file rather than in this string.
#:
#: Two callers need the identical JavaScript: this module (for a Claude Code
#: session driving the Chrome MCP) and `scripts/x_scan.mjs` (for the headless
#: Playwright run that `launchd` schedules). Two copies of a scraper's selectors
#: drift, and the failure is silent — the stale copy returns zero posts and
#: reports success.
EXTRACT_JS_PATH = Path(__file__).resolve().parent / "x_extract.js"


def _load_extract_js() -> str:
    """
    The DOM read, as text.

    Strips the leading comment block so the value is a bare function expression,
    which is what an `evaluate` call needs.
    """
    source = EXTRACT_JS_PATH.read_text(encoding="utf-8")
    body = source[source.index("() =>"):] if "() =>" in source else source
    return body.strip()


EXTRACT_JS = _load_extract_js()


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

    body = [line for line in cleaned[start:end]
            if line not in TRUNCATION_MARKERS]
    return "\n".join(body).strip()


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
    max_age_days: int = X_SCAN_MAX_AGE_DAYS,
    trusted: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Turn a browser scan into feed items, dropping what cannot be filed.

    `club` pins every row to one club; leave it None to detect per post via
    `club_in`. An account covering the whole league needs the detection, and a
    club-specific account is better served by pinning it.

    `source` is the fallback attribution, used only for posts whose author the
    extractor could not read. A **profile** scan is one author, so one `source`
    describes every row; a **logged-in home timeline** is many authors, and
    stamping them all `x:home-feed` would destroy the only thing that makes these
    rows admissible — who said it. So each post's own author wins when present.

    Every surviving post must also clear `x_relevance.is_football_relevant`.
    `trusted` overrides the curated-surface set for tests; there is deliberately
    **no way to turn the gate off**. An opt-in flag has to default somewhere, and
    the caller most likely to forget it is a signed-in session scrolling home —
    precisely the caller whose posts are 19-in-21 not football. A refused post is
    dropped rather than filed with a marker: the inbox is a claim feed, not a
    quarantine, and a row in it is an assertion that something was worth reading.
    """
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    items: List[Dict[str, Any]] = []
    handle = str(scan.get("handle") or "")
    # Whether that page was the handle's own timeline. Absent from a legacy payload
    # written before the extractor reported it, and defaulting True there gives the
    # old behaviour for the only shape that ever existed — a root profile scan.
    profile_root = bool(scan.get("profileRoot", True))
    refusals: Counter = Counter()
    considered = 0
    #: Posts the extractor handed over, before any of our own drops.
    #:
    #: Separate from `considered` because the drift alarm needs it. `considered`
    #: counts posts that survived the structural gates below, so a DOM change that
    #: breaks the status permalink or the body assembly takes it to zero — and the
    #: alarm, which only fired when `considered` was non-zero, then said nothing at
    #: all. That is the exact shape it claims to catch.
    read = 0
    #: Why the structural gates dropped things, so a total structural wipe can name
    #: the field that broke rather than just reporting silence.
    structural: Counter = Counter()

    for post in scan.get("posts") or []:
        if not isinstance(post, Mapping):
            structural["not-a-mapping"] += 1
            continue
        read += 1
        stamp = claimed_at(post.get("status_id"))
        if stamp is None:
            structural["unreadable-status-id"] += 1
            continue
        age = (moment - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).days
        # A month-old post is not news. Bounded here as well as downstream so a
        # scan of a quiet account does not refile its whole visible history.
        if age > max_age_days or age < 0:
            structural["outside-the-age-window"] += 1
            continue

        body = body_from_lines(post.get("lines") or [])
        if len(body) < MIN_BODY:
            structural["body-too-short"] += 1
            continue

        url = str(post.get("url") or "")
        if not url.startswith("https://"):
            structural["no-https-url"] += 1
            continue

        author = str(post.get("author") or "").strip()

        # The relevance gate. Counted after the cheap structural drops above so
        # the refusal tally describes posts that were otherwise filable —
        # "refused 19 of 21 as untrusted-surface" is a statement about the feed,
        # whereas mixing in stale and stub posts would make it a statement about
        # nothing.
        considered += 1
        verdict = is_football_relevant(
            body, author, handle=handle, lines=post.get("lines") or (),
            trusted=trusted, profile_root=profile_root,
        )
        if not verdict.passed:
            refusals[verdict.reason] += 1
            continue

        # The `--club` pin describes the ACCOUNT, so it may only be applied to
        # that account's own posts.
        #
        # `X_SCAN_ACCOUNTS` invites a club pin for a club-specific account, and
        # `to_items` used to stamp it on every row. Once a page's trust extends to
        # reposts, that writes a club that appears nowhere in the text: measured,
        # a `--club Arsenal` scan of robtFPL filed @SolioAnalytics, @OptaAnalyst
        # and @FPL_Spaceman posts as Arsenal, none of which mention Arsenal. That
        # string lands in `AvailabilityClaim.notes` in the append-only evidence
        # store, so it is a fabricated attribution that cannot be edited out.
        # Latent today (the one configured account has club=None) and fixed before
        # a club-specific account makes it routine.
        own_post = bool(author) and author.casefold() == handle.casefold()
        pinned = club if (club is not None and (own_post or not author)) else None

        items.append({
            "lane": LANE,
            "claim_type": CLAIM_TYPE,
            "value": body,
            "player_surname": "",
            "club": pinned if pinned is not None else club_in(body),
            "tier": TIER,
            "source": f"x:{author}" if HANDLE.match(f"@{author}") else source,
            "quote": "",
            "url": url,
            "claimed_at": stamp,
            "metric": "",
            "horizon_gameweeks": "",
        })

    _log_relevance(handle, len(items), considered, read, refusals, structural,
                   trusted)
    return items


def _log_relevance(handle: str, filed: int, considered: int, read: int,
                   refusals: Mapping[str, int],
                   structural: Mapping[str, int],
                   trusted: Optional[Iterable[str]]) -> None:
    """
    Say what was dropped and why, and warn when a curated scan yields nothing.

    An allowlist's only real failure mode is silent recall loss, and a silent
    0-of-N is indistinguishable from a quiet day — the same failure CLAUDE.md
    already records for the duplicated scraper, which "returns zero posts and
    reports success". So a curated page that files none of what it read is a
    WARNING: either the vocabulary has gone stale or the extractor has drifted,
    and both need a human.

    The first version returned early when `considered` was 0, which is precisely
    the shape of an extractor drift — break the status permalink or the body
    assembly and every post is dropped structurally, `considered` never leaves 0,
    and the alarm advertised as catching drift said nothing at all. Measured on
    four induced failures: only the vocabulary one produced any output. So the
    trigger is now what the extractor HANDED OVER, and the structural tally is
    reported so the message can name the field that broke.
    """
    if not read:
        return

    if refusals or structural:
        logger.info(
            "x relevance (%s): filed %d of %d read; %s",
            handle or "unknown", filed, read,
            "; ".join(filter(None, (
                ", ".join(f"{reason} x{count}"
                          for reason, count in sorted(refusals.items())),
                ", ".join(f"{reason} x{count}"
                          for reason, count in sorted(structural.items())),
            ))) or "nothing dropped",
        )

    surfaces = (frozenset(fold(h) for h in trusted) if trusted is not None
                else trusted_handles())
    if filed or fold(handle) not in surfaces:
        return

    if considered:
        logger.warning(
            "x relevance: curated scan of %s filed 0 of %d posts, all refused by "
            "the gate. The vocabulary may have gone stale; check "
            "pipeline/data/x_relevance.py (gate v%s) before assuming a quiet day",
            handle, considered, GATE_VERSION,
        )
    else:
        # Nothing even reached the gate: the extractor is the suspect, not the
        # vocabulary. Naming which structural check ate them is the difference
        # between a five-minute fix and a selector hunt.
        logger.warning(
            "x relevance: curated scan of %s read %d post(s) and NONE reached the "
            "gate (%s). That is the shape of extractor drift — check "
            "pipeline/data/x_extract.js against the live page",
            handle, read,
            ", ".join(f"{reason} x{count}"
                      for reason, count in sorted(structural.items())) or "unknown",
        )


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
           now: Optional[datetime] = None, max_age_days: int = X_SCAN_MAX_AGE_DAYS) -> int:
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
    parser.add_argument("--max-age-days", type=int, default=X_SCAN_MAX_AGE_DAYS)
    args = parser.parse_args(argv)

    # Turn the records on. Without this the whole refusal tally is written to a
    # logger with no handler and discarded, so a scan that refused 21 posts prints
    # exactly what a scan that read nothing prints: "x inbox now holds N row(s)".
    # Measured — an operator running the documented command saw no trace of 4
    # promoted-post and 17 untrusted-surface refusals. The alarm survived only
    # because WARNING reaches logging's last-resort handler.
    #
    # To stderr, so the stdout line stays the machine-readable result and a caller
    # piping it is unaffected.
    logging.basicConfig(
        level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s",
    )

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
