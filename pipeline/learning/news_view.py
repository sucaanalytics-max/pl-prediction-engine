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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
FILENAME = "news_view.json"

#: Only `unparsed_news` reaches this view. A parsed claim belongs in
#: `evidence_view.json`, where its conflicts and the rule that beat it live.
KIND = "unparsed_news"

DEFAULT_MAX_AGE_DAYS = 5
DEFAULT_LIMIT = 60

#: Headlines are truncated for display. The full text stays in the store.
MAX_HEADLINE = 180


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
    items.sort(
        key=lambda i: (
            not i["touches_squad"],
            -(_parse(i["claimed_at"]) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(),
            i["digest"],
        )
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "window_days": max_age_days,
        "n_articles": len(items),
        "n_shown": min(len(items), limit),
        # Named in the artifact so a consumer cannot mistake this for evidence
        # the model acted on. Nothing here has moved a projection.
        "basis": (
            "Headlines the parser could not turn into an availability claim. "
            "None of this has moved a projection — the model uses FPL's own "
            "availability field and parsed tier-2/3 claims only. This is a "
            "reading list."
        ),
        "items": items[:limit],
    }


def write(view: Mapping[str, Any], public_dir: Path) -> Path:
    """Publish the reading list."""
    from pipeline.fpl.artifacts import write_json_atomically

    directory = Path(public_dir)
    directory.mkdir(parents=True, exist_ok=True)
    return write_json_atomically(dict(view), directory / FILENAME)
