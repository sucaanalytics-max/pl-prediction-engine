"""
Filing an availability claim by hand.

## Why this exists rather than being a fallback

The connector layer surfaces *evidence* — timestamped, sourced, club- or
player-linked quotes — and derives no availability from prose, because it cannot
do so without false positives (see ``news_extract.py``). This module is where
evidence becomes a claim that actually moves a projection.

That makes it the primary path for tier-2 availability, not a workaround. It is the
same propose-and-approve shape the repo already uses for decisions: the machine
assembles and presents, the human commits. The difference from typing numbers into
a spreadsheet is that a claim filed here is **timestamped, attributed, versioned
and adjudicated** — it flows through R0-R8 exactly like FPL's own fields, so it can
lose to a fresher source, and every loser is named.

It is also the only route for sources with no clean machine path: @robtFPL and
anything else on X, podcasts, paywalled reporting.

## The two timestamps, again

``--claimed-at`` is when the source *said it*. ``observed_at`` is when we recorded
it, and is set here. Getting these the wrong way round is the failure the evidence
store was built to prevent: recency is judged on ``claimed_at``, so a claim
back-dated to now would outrank a genuinely fresher source. The CLI therefore
**requires** ``--claimed-at`` for anything but ``--now``, and refuses a future one.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pipeline.learning.availability_evidence import (
    CLAIM_TYPES, TIERS, AvailabilityClaim, provenance_digest, record,
)

logger = logging.getLogger(__name__)

# Claim types a human may file. Deliberately a subset of CLAIM_TYPES:
#
# `status` is excluded because it is FPL's own letter and inventing one would
# impersonate a tier-1 source. `predicted_start` is excluded from *this* tool
# because R5 keeps it out of the availability view entirely — it belongs to the
# minutes model, and filing it here would suggest it affects availability.
FILEABLE = (
    "chance_of_playing",
    "return_date",
    "unavailable_until",
    "permanent_exit",
    "severity",
    "expected_minutes",
    "unparsed_news",
)

# A human filing a claim is not an official source. Tier 1 is "official or owned"
# and is reserved for FPL's own fields and our parse of its own text; letting a
# manual claim take tier 1 would let it outrank FPL under R3 while carrying less
# authority than the press conference it came from.
MANUAL_TIERS = (2, 3)

SOURCE_PREFIX = "manual:"


class ClaimInputError(ValueError):
    """The claim as described cannot be filed."""


def parse_stamp(value: str, what: str) -> datetime:
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ClaimInputError(
            f"{what} {value!r} is not ISO-8601 (try 2026-08-06T14:30:00Z)"
        ) from exc
    if moment.tzinfo is None:
        # Assuming local time would make the same claim resolve differently on a
        # laptop and on a runner, which breaks the reproducibility the sealed
        # ledger depends on.
        raise ClaimInputError(
            f"{what} {value!r} has no timezone; append Z for UTC"
        )
    return moment.astimezone(timezone.utc)


def coerce_value(claim_type: str, raw: str) -> Any:
    """
    Turn the CLI string into the value the claim type requires.

    Validated here rather than trusted, because a `chance_of_playing` of "75%"
    silently stored as a string would compare wrongly against FPL's integer and
    resolution would pick the wrong winner without erroring.
    """
    if claim_type == "chance_of_playing":
        text = raw.strip().rstrip("%")
        try:
            percent = int(text)
        except ValueError as exc:
            raise ClaimInputError(
                f"chance_of_playing must be an integer 0-100, got {raw!r}"
            ) from exc
        if not 0 <= percent <= 100:
            raise ClaimInputError(f"chance_of_playing {percent} is outside 0-100")
        return percent

    if claim_type == "expected_minutes":
        try:
            minutes = float(raw)
        except ValueError as exc:
            raise ClaimInputError(
                f"expected_minutes must be a number 0-90, got {raw!r}"
            ) from exc
        if not 0.0 <= minutes <= 90.0:
            raise ClaimInputError(f"expected_minutes {minutes} is outside 0-90")
        return minutes

    if claim_type in ("return_date", "unavailable_until"):
        # A bare date, validated so a typo does not become an unparseable claim
        # that only fails later, inside resolution.
        try:
            datetime.strptime(raw.strip(), "%Y-%m-%d")
        except ValueError as exc:
            raise ClaimInputError(
                f"{claim_type} must be YYYY-MM-DD, got {raw!r}"
            ) from exc
        return raw.strip()

    if claim_type == "permanent_exit":
        kind = raw.strip().lower()
        if kind not in ("transfer", "loan", "free_agent"):
            raise ClaimInputError(
                f"permanent_exit must be transfer|loan|free_agent, got {raw!r}"
            )
        # A MAPPING with a "kind" key, not a bare string: R0 validates
        # `isinstance(value, Mapping) and "kind" in value` and drops anything else.
        # A string here would be recorded successfully and then silently discarded
        # at resolution.
        return {"kind": kind}

    # `severity` and `unparsed_news` are free text by design.
    return raw


def build_claim(
    element_id: int,
    source: str,
    tier: int,
    claim_type: str,
    value: str,
    claimed_at: datetime,
    gameweek: int,
    observed_at: datetime,
    quote: Optional[str] = None,
    url: Optional[str] = None,
    note: str = "",
    player_code: Optional[int] = None,
) -> AvailabilityClaim:
    """Validate everything, then construct. Raises rather than filing a bad claim."""
    if claim_type not in FILEABLE:
        raise ClaimInputError(
            f"{claim_type!r} cannot be filed by hand; choose from {FILEABLE}. "
            f"('status' is FPL's own field and 'predicted_start' belongs to the "
            f"minutes model, not the availability view.)"
        )
    if tier not in MANUAL_TIERS:
        raise ClaimInputError(
            f"tier {tier} is not available to a manual claim; choose from "
            f"{MANUAL_TIERS}. Tier 1 is reserved for FPL's own fields."
        )
    if element_id <= 0:
        raise ClaimInputError(
            "element_id must be a positive FPL element id. A claim about nobody "
            "in particular is evidence, and belongs on the feed rather than here."
        )
    if claimed_at > observed_at:
        # The single check that stops a back-dated claim outranking a fresher one.
        raise ClaimInputError(
            f"claimed_at {claimed_at.isoformat()} is after now "
            f"{observed_at.isoformat()}: a claim cannot have been made in the "
            f"future, and recency is judged on claimed_at."
        )
    if not source.strip():
        raise ClaimInputError("source is required: an unattributed claim is a guess")

    coerced = coerce_value(claim_type, value)
    tagged = source if source.startswith(SOURCE_PREFIX) else f"{SOURCE_PREFIX}{source}"

    # R0 requires a digest for tier 2+, so a manual claim needs something to hash.
    # Demanding a quote or a URL is not bureaucracy: without one the claim asserts
    # something about a real player's fitness with nothing behind it, and R4 lets
    # it push availability DOWN.
    if not (quote or url):
        raise ClaimInputError(
            "a tier-2+ claim needs --quote or --url so it can be audited; "
            "rule R0 drops claims with no provenance digest"
        )
    digest = provenance_digest(quote or note or claim_type, url)

    return AvailabilityClaim(
        element_id=int(element_id),
        player_code=player_code,
        source=tagged,
        source_tier=int(tier),
        claim_type=claim_type,
        value=coerced,
        claimed_at=claimed_at.isoformat().replace("+00:00", "Z"),
        observed_at=observed_at.isoformat().replace("+00:00", "Z"),
        gameweek=int(gameweek),
        provenance_url=url or None,
        provenance_digest=digest,
        source_text=(quote or None),
        # No parser produced this, and saying "version 1" would imply one did.
        parser_version=None,
        notes=note or "filed by hand",
    )


def resolve_element(
    bootstrap: Mapping[str, Any], query: str,
) -> Dict[str, Any]:
    """
    Find exactly one player, or refuse.

    Ambiguity is an error, never a choice: "two Silvas at one club must escalate,
    not pick". The CLI prints the candidates so the caller can disambiguate with an
    element id.
    """
    if query.isdigit():
        for element in bootstrap.get("elements") or []:
            if int(element["id"]) == int(query):
                return dict(element)
        raise ClaimInputError(f"no element with id {query}")

    needle = query.strip().lower()
    teams = {t["id"]: t["name"] for t in bootstrap.get("teams") or []}
    matches = [
        element for element in bootstrap.get("elements") or []
        if needle in f"{element.get('first_name','')} {element.get('second_name','')}".lower()
        or needle == str(element.get("web_name", "")).lower()
    ]
    if not matches:
        raise ClaimInputError(f"no player matches {query!r}")
    if len(matches) > 1:
        listing = ", ".join(
            f"{m['id']}={m.get('web_name')} ({teams.get(m.get('team'), '?')})"
            for m in matches[:12]
        )
        raise ClaimInputError(
            f"{query!r} matches {len(matches)} players: {listing}. "
            f"Re-run with an element id."
        )
    return dict(matches[0])


def _load_bootstrap(path: Optional[str]) -> Dict[str, Any]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    import urllib.request
    from pipeline.config import FPL_BOOTSTRAP
    request = urllib.request.Request(
        FPL_BOOTSTRAP, headers={"User-Agent": "pl-prediction-engine/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.learning.file_claim",
        description=(
            "File one availability claim by hand. The claim flows through the same "
            "conflict rules (R0-R8) as FPL's own fields, so it can lose to a "
            "fresher source and every loser is named."
        ),
        epilog=(
            "example:\n"
            "  python -m pipeline.learning.file_claim \\\n"
            "    --player Kulusevski --type chance_of_playing --value 25 \\\n"
            "    --source 'De Zerbi presser via Hayters' --tier 2 \\\n"
            "    --claimed-at 2026-08-06T13:30:00Z --gameweek 1 \\\n"
            "    --quote 'He is a couple of weeks away' \\\n"
            "    --url https://hayters.com/...\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--player", required=True,
                        help="FPL element id, web name, or part of a full name")
    parser.add_argument("--type", required=True, choices=list(FILEABLE),
                        dest="claim_type")
    parser.add_argument("--value", required=True,
                        help="0-100 for chance_of_playing; YYYY-MM-DD for dates; "
                             "transfer|loan|free_agent for permanent_exit")
    parser.add_argument("--source", required=True,
                        help="who said it, e.g. 'Arteta presser via Hayters'")
    parser.add_argument("--tier", type=int, required=True, choices=list(MANUAL_TIERS),
                        help="2 = press conference or club statement, "
                             "3 = aggregator or predicted lineup")
    parser.add_argument("--gameweek", type=int, required=True)
    stamp = parser.add_mutually_exclusive_group(required=True)
    stamp.add_argument("--claimed-at",
                       help="ISO-8601 UTC when the SOURCE said it (not now)")
    stamp.add_argument("--now", action="store_true",
                       help="the source said it just now; only correct for live "
                            "reporting you are watching as it happens")
    parser.add_argument("--quote", help="verbatim words, for the evidence surface")
    parser.add_argument("--url", help="where it was published")
    parser.add_argument("--note", default="", help="anything a reader would need")
    parser.add_argument("--bootstrap", help="local bootstrap JSON instead of fetching")
    parser.add_argument("--predictions-dir", default=None)
    parser.add_argument("--dry-run", action="store_true",
                        help="print the claim without writing it")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = build_parser().parse_args(argv)

    from pipeline.config import PREDICTIONS_DIR
    predictions_dir = Path(args.predictions_dir or PREDICTIONS_DIR)
    now = datetime.now(timezone.utc)

    try:
        bootstrap = _load_bootstrap(args.bootstrap)
        element = resolve_element(bootstrap, args.player)
        claimed_at = now if args.now else parse_stamp(args.claimed_at, "--claimed-at")
        claim = build_claim(
            element_id=int(element["id"]),
            player_code=int(element["code"]) if element.get("code") else None,
            source=args.source,
            tier=args.tier,
            claim_type=args.claim_type,
            value=args.value,
            claimed_at=claimed_at,
            gameweek=args.gameweek,
            observed_at=now,
            quote=args.quote,
            url=args.url,
            note=args.note,
        )
    except ClaimInputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    teams = {t["id"]: t["name"] for t in bootstrap.get("teams") or []}
    print(f"  player   {element.get('web_name')} ({teams.get(element.get('team'), '?')}) "
          f"id={element['id']}")
    print(f"  claim    {claim.claim_type} = {claim.value!r}")
    print(f"  source   {claim.source} (tier {claim.source_tier})")
    print(f"  said at  {claim.claimed_at}")
    print(f"  read at  {claim.observed_at}")
    print(f"  claim_id {claim.claim_id}")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    path = record([claim], predictions_dir)
    if path is None:
        # Content-addressed, so re-filing the same assertion is a no-op rather
        # than a duplicate line.
        print("already on file; nothing written")
    else:
        print(f"recorded -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
