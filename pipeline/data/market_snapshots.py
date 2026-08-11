"""
Keeping the pre-deadline bookmaker prices we currently throw away.

The odds cache writes ``data/processed/odds_api/main_odds.json`` under one fixed
key, and ``data/processed/`` is gitignored. So every pre-deadline price we have
ever fetched has been overwritten within 24 hours and never committed. That is
unrecoverable evidence being discarded for free, and it is the same shape as the
sealed-ledger argument: what a forecast could have known at the deadline is only
knowable if it was written down at the deadline.

**Why this matters concretely.** A blend weight between a market anchor and our
own posterior can be fitted on the historical Football-Data corpus, but that
corpus holds *closing* prices — sharper than the pre-deadline prices we actually
consume, because they contain team news ours cannot. A weight fitted on closing
lines is therefore an upper bound on how much to trust our live line. The only
way to replace that bound with a measurement is to have a history of our OWN
pre-deadline prices, and the only way to have one in ten weeks is to start now.

**Raw prices, not de-vigged consensus.** The obvious design stores the de-vigged
consensus, which is smaller and directly usable. It is the wrong choice: it bakes
today's de-vig method into a permanent record, so the day the method changes the
whole history becomes incomparable and cannot be re-derived. Storing what the
bookmakers actually published keeps the record method-independent — every de-vig
variant can be measured against the same history, which is precisely the
comparison the method choice needs.

Append-only, and deduplicated by content: bookmakers do not move every line every
day, so an unchanged fixture writes nothing. Line MOVEMENT is itself the signal
worth keeping, and dedupe preserves it exactly while dropping the repeats.

No quota cost. This module never fetches anything — it is handed prices that were
already fetched for the value-bet path.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

SNAPSHOTS_FILENAME = "market_snapshots.jsonl"
SCHEMA_VERSION = 1


def _parse_iso(stamp: Optional[str]) -> Optional[datetime]:
    if not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@dataclass(frozen=True)
class MarketSnapshot:
    """One fixture's per-bookmaker prices, as published at one moment."""

    match_key: str
    home_team: str
    away_team: str
    commence_time: Optional[str]
    captured_at: str
    # bookmaker key -> {home, draw, away}
    h2h: Dict[str, Dict[str, float]] = field(default_factory=dict)
    # bookmaker key -> line -> {over, under}
    totals: Dict[str, Dict[str, Dict[str, float]]] = field(default_factory=dict)
    schema_version: int = SCHEMA_VERSION

    @property
    def digest(self) -> str:
        """
        Content hash of the prices alone.

        Deliberately excludes ``captured_at``: two captures of identical prices
        must collide so the repeat can be dropped. Sorted keys, because dict
        ordering is not part of what a bookmaker published.
        """
        payload = json.dumps(
            {"h2h": self.h2h, "totals": self.totals},
            sort_keys=True,
            allow_nan=False,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @property
    def hours_to_kickoff(self) -> Optional[float]:
        """
        How far ahead of kickoff this was captured. Negative means after.

        Recorded rather than derived at read time so a later analysis can select
        "the snapshot nearest the deadline" without re-parsing timestamps, and so
        the number cannot drift if the parsing changes.
        """
        kickoff = _parse_iso(self.commence_time)
        captured = _parse_iso(self.captured_at)
        if kickoff is None or captured is None:
            return None
        return (kickoff - captured).total_seconds() / 3600.0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "match_key": self.match_key,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "commence_time": self.commence_time,
            "captured_at": self.captured_at,
            "hours_to_kickoff": self.hours_to_kickoff,
            "n_books_h2h": len(self.h2h),
            "n_books_totals": len(self.totals),
            "digest": self.digest,
            "h2h": self.h2h,
            "totals": self.totals,
        }


def extract(
    parsed_odds: Mapping[str, Mapping[str, Any]], captured_at: str
) -> List[MarketSnapshot]:
    """
    Build snapshots from ``parse_match_odds`` output.

    Reads ``h2h_all`` and ``totals_all`` — the per-bookmaker views — and never the
    best-price ``h2h``/``totals`` keys, which mix books and whose implied
    probabilities do not sum to a margin. A fixture with neither is skipped
    rather than recorded empty: an empty record is indistinguishable from "the
    market had gone" and would pollute any later count of coverage.
    """
    snapshots: List[MarketSnapshot] = []
    for match_key, data in sorted(parsed_odds.items()):
        h2h_all = {
            bk: {side: float(price) for side, price in prices.items()}
            for bk, prices in (data.get("h2h_all") or {}).items()
            if prices
        }
        totals_all = {
            bk: {
                line: {side: float(price) for side, price in sides.items()}
                for line, sides in lines.items()
            }
            for bk, lines in (data.get("totals_all") or {}).items()
            if lines
        }
        if not h2h_all and not totals_all:
            continue
        snapshots.append(
            MarketSnapshot(
                match_key=match_key,
                home_team=str(data.get("home_team", "")),
                away_team=str(data.get("away_team", "")),
                commence_time=data.get("commence_time"),
                captured_at=captured_at,
                h2h=h2h_all,
                totals=totals_all,
            )
        )
    return snapshots


def record(
    snapshots: Sequence[MarketSnapshot],
    predictions_dir: Path,
    dry_run: bool = False,
) -> Optional[Path]:
    """
    Append every snapshot whose prices differ from that fixture's last recorded
    ones. Returns the path if anything was written, else None.

    Never rewrites an earlier line. A price that moved and moved back records
    three lines, which is correct — the record is of what was published when, not
    of the set of distinct prices seen.
    """
    if not snapshots:
        return None

    last = _latest_digests(predictions_dir)
    fresh = [s for s in snapshots if last.get(s.match_key) != s.digest]
    unchanged = len(snapshots) - len(fresh)

    if not fresh:
        logger.info(
            "market snapshot: no price changed across %d fixture(s)", unchanged
        )
        return None

    if dry_run:
        logger.info(
            "dry run: would record %d market snapshot(s) (%d unchanged)",
            len(fresh), unchanged,
        )
        return None

    directory = Path(predictions_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / SNAPSHOTS_FILENAME
    with path.open("a", encoding="utf-8") as handle:
        for snapshot in fresh:
            handle.write(json.dumps(snapshot.as_dict(), allow_nan=False) + "\n")

    logger.info(
        "recorded %d market snapshot(s), %d unchanged; median books per fixture %d",
        len(fresh), unchanged,
        sorted(len(s.h2h) for s in fresh)[len(fresh) // 2],
    )
    return path


def history(predictions_dir: Path) -> List[MarketSnapshot]:
    """
    Every snapshot ever recorded, oldest first.

    A malformed line raises rather than being skipped. Skipping would silently
    shorten the history, and a blend weight fitted on a silently shortened
    history is exactly the kind of confidently wrong number this whole store
    exists to prevent.
    """
    path = Path(predictions_dir) / SNAPSHOTS_FILENAME
    if not path.exists():
        return []

    rows: List[MarketSnapshot] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{number} is not valid JSON ({exc})") from exc
        rows.append(
            MarketSnapshot(
                match_key=payload["match_key"],
                home_team=payload.get("home_team", ""),
                away_team=payload.get("away_team", ""),
                commence_time=payload.get("commence_time"),
                captured_at=payload["captured_at"],
                h2h=payload.get("h2h") or {},
                totals=payload.get("totals") or {},
                schema_version=int(payload.get("schema_version", 1)),
            )
        )
    return sorted(rows, key=lambda s: (s.captured_at, s.match_key))


def _latest_digests(predictions_dir: Path) -> Dict[str, str]:
    """The most recently recorded price digest per fixture."""
    latest: Dict[str, str] = {}
    try:
        rows = history(predictions_dir)
    except ValueError as exc:
        # A corrupt history must not stop us capturing today's prices — today's
        # are perishable and the corruption is already permanent. Dedupe is the
        # only thing lost, so the worst case is a duplicate line.
        logger.error("market snapshot history unreadable (%s); dedupe disabled", exc)
        return {}
    for snapshot in rows:
        latest[snapshot.match_key] = snapshot.digest
    return latest


def last_before_kickoff(
    predictions_dir: Path, min_hours: float = 0.0
) -> Dict[str, MarketSnapshot]:
    """
    Per fixture, the latest snapshot captured at least ``min_hours`` before
    kickoff — the closest thing we have to "what the market said at the deadline".

    ``min_hours`` exists because a snapshot taken after the deadline is not a
    forecast input, however good the prices are. Snapshots with no parseable
    kickoff are excluded rather than assumed in time.
    """
    best: Dict[str, MarketSnapshot] = {}
    for snapshot in history(predictions_dir):
        lead = snapshot.hours_to_kickoff
        if lead is None or lead < min_hours:
            continue
        current = best.get(snapshot.match_key)
        if current is None or snapshot.captured_at > current.captured_at:
            best[snapshot.match_key] = snapshot
    return best
