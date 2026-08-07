"""
The timestamped record of what was known about who could play, and when.

**Why a store rather than just reading the bootstrap.** The seal already freezes
the whole bootstrap once per gameweek, so the deadline state is preserved. But the
agent runs every three hours, and the interesting thing about availability is the
*path*: a player flagged on Thursday, downgraded after Friday's press conference,
cleared on Saturday morning. The seal keeps the endpoint; this keeps the path. Any
future question of the form "how much does late team news actually move a
projection" is unanswerable without it, and unanswerable *retrospectively* —
which makes it the same perishable-evidence argument as the sealed ledger and the
market snapshots.

**Append-only, content-addressed.** A claim's id is a hash of its content, so
re-ingesting unchanged news at the three-hourly cadence writes nothing rather than
38 identical lines per player per season. A retraction is a NEW claim with a later
timestamp, never an edit — the same forward-only discipline as parameter rollback.

**Two timestamps, and the distinction is load-bearing.** ``claimed_at`` is when
the claim was made — FPL's own ``news_added``, or when a manager said it at a
press conference. ``observed_at`` is when we read it. Recency is judged on
``claimed_at``, because that is what decides whether an old article should lose to
a newer club update; freshness of our own reading is ``observed_at``. A claim
asserting it was made after we read it is impossible, and that single check is
what stops a stale source overriding a fresher one.

Tiers, and what they are allowed to do, are enforced at resolution rather than
here. This module records; it does not adjudicate.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

EVIDENCE_FILENAME = "availability_evidence.jsonl"
SCHEMA_VERSION = 1

# Kept deliberately small, on the same principle as the message feed's kinds:
# every extra type is another branch resolution has to handle and another thing
# that can be silently mis-tagged.
CLAIM_TYPES = (
    "status",              # FPL status letter
    "chance_of_playing",   # int 0..100
    "return_date",         # ISO date — FITNESS: expected to be able to play
    "unavailable_until",   # ISO date — ELIGIBILITY: banned until then, match-fit
    "permanent_exit",      # transferred, loaned out, released
    "severity",            # body part and coarse category
    "predicted_start",     # float 0..1 — about p_start, NOT about availability
    "expected_minutes",    # float 0..90
    "unparsed_news",       # verbatim text carrying no derived availability
)

# 1 = official or owned (FPL's own fields, and our parse of its own text)
# 2 = press conference, club statement
# 3 = aggregator, predicted lineup
TIERS = (1, 2, 3)

SOURCE_FPL_FIELDS = "fpl_bootstrap"
SOURCE_FPL_NEWS = "fpl_news_parse"


def provenance_digest(source_text: Optional[str], url: Optional[str] = None) -> str:
    """
    A verifiable fingerprint of what a claim was derived from.

    Rule R0 in ``availability_conflicts.py`` drops any tier-2-or-lower claim that
    has no digest, on the principle that "an unauditable claim that can move a
    projection is worse than no claim". Until the news connectors existed, every
    claim in the system was tier 1 from FPL's own bootstrap, so nothing ever
    populated this field and **the gate had never been passed by anything** — a
    rule that was unsatisfiable rather than merely unused.

    What it buys: the stored ``source_text`` can be re-hashed and compared, so a
    quote cannot be edited after the fact without the digest disagreeing. That is
    the difference between a claim you can audit and a claim you are asked to
    trust.

    Raises on empty input rather than returning the hash of "", because a digest
    over nothing would satisfy R0 while auditing nothing — the exact failure mode
    the rule exists to prevent.
    """
    material = f"{(source_text or '').strip()}\n{(url or '').strip()}".strip()
    if not material:
        raise EvidenceError(
            "provenance digest needs source text or a URL; a tier-2+ claim with "
            "neither cannot be audited and R0 will drop it"
        )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def digest_matches(
    claim: "AvailabilityClaim", source_text: Optional[str] = None,
) -> bool:
    """
    Whether a claim's recorded digest still matches its stored text.

    The audit itself. A mismatch means the quote was altered after the claim was
    filed, which is the one thing an append-only store cannot otherwise detect.
    """
    if not claim.provenance_digest:
        return False
    try:
        expected = provenance_digest(
            source_text if source_text is not None else claim.source_text,
            claim.provenance_url,
        )
    except EvidenceError:
        return False
    return expected == claim.provenance_digest


class EvidenceError(RuntimeError):
    """A claim could not be recorded or read."""


@dataclass(frozen=True)
class AvailabilityClaim:
    """One assertion, from one source, at one moment, about one player."""

    element_id: int
    source: str
    source_tier: int
    claim_type: str
    value: Any
    # When the claim was MADE. None when the source publishes no timestamp of its
    # own — FPL's structured status and chance fields do not. Recency then falls
    # back to `observed_at`, which is weaker but honest; inventing a publication
    # time would both fabricate evidence and break content-addressed dedupe,
    # since `observed_at` moves on every three-hourly tick.
    claimed_at: Optional[str]
    observed_at: str
    gameweek: int
    player_code: Optional[int] = None
    confidence: Optional[float] = None
    provenance_url: Optional[str] = None
    provenance_digest: Optional[str] = None
    source_text: Optional[str] = None
    parser_version: Optional[int] = None
    notes: str = ""
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self) -> None:
        # Vocabulary and tier are programming errors, so they raise on
        # construction. Timestamp ordering is a DATA error and is caught at
        # resolution instead: raising here would make one bad stored line
        # unreadable and take the whole history with it.
        if self.claim_type not in CLAIM_TYPES:
            raise ValueError(
                f"unknown claim type {self.claim_type!r}; expected {CLAIM_TYPES}"
            )
        if self.source_tier not in TIERS:
            raise ValueError(
                f"unknown source tier {self.source_tier!r}; expected {TIERS}"
            )

    @property
    def claim_id(self) -> str:
        """
        Content hash. Excludes ``observed_at`` so re-reading unchanged news
        deduplicates, and includes ``claimed_at`` so a genuinely new assertion
        from the same source about the same thing is a distinct claim.
        """
        payload = json.dumps(
            [self.source, self.element_id, self.claim_type, self.value,
             self.claimed_at],
            sort_keys=True, allow_nan=False, default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "claim_id": self.claim_id,
            "element_id": self.element_id,
            "player_code": self.player_code,
            "source": self.source,
            "source_tier": self.source_tier,
            "claim_type": self.claim_type,
            "value": self.value,
            "confidence": self.confidence,
            "claimed_at": self.claimed_at,
            "observed_at": self.observed_at,
            "gameweek": self.gameweek,
            "provenance_url": self.provenance_url,
            "provenance_digest": self.provenance_digest,
            "source_text": self.source_text,
            "parser_version": self.parser_version,
            "notes": self.notes,
        }


def claims_from_bootstrap(
    bootstrap: Mapping[str, Any], gameweek: int, observed_at: str
) -> List[AvailabilityClaim]:
    """
    Tier-1 claims from data we already fetch and already own.

    Two sources, both tier 1 but genuinely distinct: FPL's structured fields, and
    OUR parse of FPL's prose. They can disagree — the prose can say "75% chance"
    while the field says something else — and that disagreement is worth
    surfacing, because it means our parser is wrong. Recording them separately is
    what makes it detectable at all.

    Zero cost: no scraping, no network, no quota. The text is already in the
    payload and was previously discarded.
    """
    from pipeline.data.availability_news import PARSER_VERSION, parse_news

    claims: List[AvailabilityClaim] = []
    for element in bootstrap.get("elements", []):
        element_id = int(element.get("id", 0))
        if not element_id:
            continue
        code = element.get("code")
        news = element.get("news") or ""
        news_added = element.get("news_added")
        # FPL's own fields carry no publication timestamp of their own, so the
        # news timestamp is the best available claim time.
        #
        # Falling back to `observed_at` when it is absent was a real defect: the
        # claim id is content-addressed and includes `claimed_at`, so a flagged
        # player with no news prose produced a NEW id on every three-hourly tick.
        # Measured — four ingestions of a byte-identical bootstrap stored eight
        # lines instead of two, and would have grown without bound all season.
        # It also silently redefined `claimed_at` as "when we last read it",
        # destroying the recency semantics the two timestamps exist to separate.
        #
        # So the honest value is None: we do not know when FPL made this
        # assertion. None is stable across re-reads, so identical content
        # deduplicates, and resolution orders such a claim by `observed_at`
        # instead — which is a documented fallback rather than a fabricated
        # publication time masquerading as one.
        claimed_at = news_added

        def _claim(claim_type: str, value: Any, **extra: Any) -> AvailabilityClaim:
            return AvailabilityClaim(
                element_id=element_id,
                player_code=int(code) if code is not None else None,
                source=extra.pop("source", SOURCE_FPL_FIELDS),
                source_tier=1,
                claim_type=claim_type,
                value=value,
                claimed_at=claimed_at,
                observed_at=observed_at,
                gameweek=int(gameweek),
                **extra,
            )

        status = (element.get("status") or "a").strip().lower()
        chance = element.get("chance_of_playing_next_round")

        # Only record a flagged player. Logging 500 "status a" claims every three
        # hours would bury the ones that matter and grow the file by ~50x for no
        # information — an absent claim already means "nothing was flagged".
        if status == "a" and chance is None and not news:
            continue

        claims.append(_claim("status", status))
        if chance is not None:
            claims.append(_claim("chance_of_playing", int(chance)))

        if not news:
            continue

        digest = hashlib.sha256(news.encode("utf-8")).hexdigest()[:16]
        parsed = parse_news(news, news_added)
        news_kwargs = {
            "source": SOURCE_FPL_NEWS,
            "provenance_digest": digest,
            "source_text": news,
            "parser_version": PARSER_VERSION,
        }

        if parsed.matched_pattern is None:
            # Preserved verbatim so the record is complete, but carrying no
            # derived availability. The parser can only ever add information.
            claims.append(_claim("unparsed_news", news, **news_kwargs))
            continue

        if parsed.chance_of_playing is not None:
            claims.append(
                _claim("chance_of_playing", parsed.chance_of_playing, **news_kwargs)
            )
        if parsed.return_date is not None:
            claims.append(_claim("return_date", parsed.return_date, **news_kwargs))
        if parsed.unavailable_until is not None:
            claims.append(
                _claim("unavailable_until", parsed.unavailable_until, **news_kwargs)
            )
        if parsed.exit_kind is not None:
            claims.append(_claim(
                "permanent_exit",
                {"kind": parsed.exit_kind, "club": parsed.exit_club},
                **news_kwargs,
            ))
        if parsed.injury_category is not None:
            claims.append(_claim(
                "severity",
                {"body_part": parsed.body_part, "category": parsed.injury_category},
                **news_kwargs,
            ))

    return claims


def parse_coverage(claims: Sequence[AvailabilityClaim]) -> Dict[str, Any]:
    """
    How much of the flagged population the news parser understood.

    A jump in the unparsed share means FPL changed its wording and ban/return
    extraction has silently stopped working — which is otherwise invisible,
    because the failure mode is a quiet fallback to the previous behaviour.
    """
    claimed = {c.element_id for c in claims}
    unparsed = {c.element_id for c in claims if c.claim_type == "unparsed_news"}
    dated = {
        c.element_id for c in claims
        if c.claim_type in ("return_date", "unavailable_until")
    }
    # The denominator is players who HAVE news, not everyone with a claim. A
    # player carrying only a published chance of playing — including a 100 that
    # says he has recovered — has nothing for the parser to read, so counting him
    # would dilute the share and hide a real wording change behind a healthy-
    # looking percentage.
    with_news = {
        c.element_id for c in claims
        if c.claim_type == "unparsed_news" or c.source == SOURCE_FPL_NEWS
    }
    return {
        "n_claimed": len(claimed),
        "n_flagged": len(with_news),
        "n_unparsed": len(unparsed),
        "n_dated": len(dated),
        "unparsed_share": (len(unparsed) / len(with_news)) if with_news else 0.0,
        "parser_version": next(
            (c.parser_version for c in claims if c.parser_version is not None), None
        ),
    }


def should_escalate_parse_failures(coverage: Mapping[str, Any]) -> bool:
    """
    Whether the unparsed rate deserves a message.

    Both conditions, deliberately: a share alone fires on one oddity in a quiet
    week, and a count alone fires every week in a busy injury crisis. The signal
    worth surfacing is "a lot of them, and a lot proportionally", which is what a
    wording change looks like.
    """
    return (
        coverage.get("unparsed_share", 0.0) > 0.25
        and coverage.get("n_unparsed", 0) >= 3
    )


def record(
    claims: Sequence[AvailabilityClaim],
    predictions_dir: Path,
    dry_run: bool = False,
) -> Optional[Path]:
    """
    Append every claim not already on file. Returns the path if anything landed.

    Deduplication is against every claim ever recorded, not just the last one,
    because a claim is an assertion made at a moment — an unchanged flag re-read
    three hours later is the same assertion, not a new one. That is the opposite
    of the market snapshot store, where an unchanged price genuinely is a new
    observation of the market at a new time; here the timestamp is part of the
    claim, so identical content means identical claim.
    """
    if not claims:
        return None

    try:
        known = {claim.claim_id for claim in history(predictions_dir)}
    except EvidenceError as exc:
        # Today's news is perishable; the corruption is already permanent. Losing
        # dedupe costs duplicate lines, which is recoverable. Losing the claim is
        # not.
        logger.error("evidence history unreadable (%s); dedupe disabled", exc)
        known = set()

    fresh = [claim for claim in claims if claim.claim_id not in known]
    if not fresh:
        logger.info("availability evidence: no new claim among %d", len(claims))
        return None

    if dry_run:
        logger.info("dry run: would record %d availability claim(s)", len(fresh))
        return None

    directory = Path(predictions_dir) / "fpl"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / EVIDENCE_FILENAME
    with path.open("a", encoding="utf-8") as handle:
        for claim in fresh:
            handle.write(json.dumps(claim.as_dict(), allow_nan=False) + "\n")

    by_type: Dict[str, int] = {}
    for claim in fresh:
        by_type[claim.claim_type] = by_type.get(claim.claim_type, 0) + 1
    logger.info("recorded %d availability claim(s): %s", len(fresh), by_type)
    return path


def history(predictions_dir: Path) -> List[AvailabilityClaim]:
    """
    Every claim ever recorded, oldest observation first.

    A malformed line raises. Skipping it would silently shorten the record, and
    a resolution computed from a silently shortened record is exactly the
    confidently-wrong output the store exists to prevent.
    """
    path = Path(predictions_dir) / "fpl" / EVIDENCE_FILENAME
    if not path.exists():
        return []

    claims: List[AvailabilityClaim] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EvidenceError(f"{path}:{number} is not valid JSON ({exc})") from exc
        payload.pop("claim_id", None)  # Derived, never trusted from disk.
        try:
            claims.append(AvailabilityClaim(**payload))
        except (TypeError, ValueError) as exc:
            raise EvidenceError(f"{path}:{number} is not a valid claim ({exc})") from exc
    return sorted(claims, key=lambda c: (c.observed_at, c.element_id, c.claim_type))


def effective_claim_time(claim: AvailabilityClaim) -> str:
    """
    The timestamp recency should be judged on.

    ``claimed_at`` where the source published one, else ``observed_at``. Kept as a
    named function rather than an inline ``or`` so the fallback is one decision in
    one place, and so resolution cannot accidentally compare a real publication
    time against a missing one.
    """
    return claim.claimed_at or claim.observed_at


def claims_for_gameweek(
    predictions_dir: Path, gameweek: int
) -> Dict[int, List[AvailabilityClaim]]:
    """Claims recorded for one gameweek, grouped by player."""
    grouped: Dict[int, List[AvailabilityClaim]] = {}
    for claim in history(predictions_dir):
        if int(claim.gameweek) != int(gameweek):
            continue
        grouped.setdefault(claim.element_id, []).append(claim)
    return grouped
