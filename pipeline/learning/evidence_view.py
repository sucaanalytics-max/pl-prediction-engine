"""
The evidence behind an availability number, exported for a human to read.

## The gap this fills

From the competitor study of eight products, the largest single finding:

> *Nobody presents injury/availability **evidence** — only conclusions. FFS gives
> you "Carvalho 25%" with no source, no quote, no timestamp on the claim. No
> product shows you: here is the press-conference quote, here is who reported it,
> here is when, here is why 25%. The entire category asks you to trust a number.*

We already store everything needed to close that. `Resolution.conflicts` names
every claim that lost, and rule **R8** exists precisely so a side is never silently
picked. So this module is an export and a projection — no new modelling — and its
job is to make the losing claims first-class rather than a footnote.

A player whose 25% survived three conflicting reports is a different decision from
one whose 25% is unopposed, and no other product can tell you which you are
looking at.

## Bounded on purpose

Only players with something to say: anyone whose availability is not plainly
"available", plus anyone with an escalation. The full roster is 570 and the
overwhelming majority have one uninteresting tier-1 claim each. Publishing all of
them would be a megabyte of noise obscuring the fifteen rows that matter.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from pipeline.learning.availability_conflicts import Resolution
from pipeline.learning.availability_evidence import AvailabilityClaim

logger = logging.getLogger(__name__)

VIEW_FILENAME = "evidence_view.json"
SCHEMA_VERSION = 1

# Claim types that bear on whether someone can play. `predicted_start` is excluded
# by rule R5 — it says "he is in the eleven", which is about p_start conditional on
# availability, and letting it through here is how a rotation call becomes an
# injury flag.
AVAILABILITY_TYPES = (
    "status", "chance_of_playing", "return_date", "unavailable_until",
    "permanent_exit",
)

# A player is worth showing when his availability is in question. Everyone else is
# a tier-1 "available" row that tells the reader nothing.
UNREMARKABLE_STATUS = "a"
FULL_CHANCE = 100


def _is_notable(resolutions: Mapping[str, Resolution]) -> bool:
    """Whether this player's availability is worth a reader's attention."""
    for claim_type, resolution in resolutions.items():
        if claim_type == "status" and str(resolution.value).lower() != UNREMARKABLE_STATUS:
            return True
        if claim_type == "chance_of_playing":
            try:
                if float(resolution.value) < FULL_CHANCE:
                    return True
            except (TypeError, ValueError):
                return True
        if claim_type in ("return_date", "unavailable_until", "permanent_exit"):
            return True
        if resolution.unresolved or resolution.escalation:
            return True
    return False


def _claim_row(claim: AvailabilityClaim, verdict: str, beaten_by: str = "") -> Dict[str, Any]:
    """
    One claim as the page renders it.

    `verdict` is the whole point: "won", "lost" or "dropped", with the rule that
    decided it. A reader can then see that a 25% survived three disagreements, or
    that it is the only thing anyone has said.
    """
    return {
        "claim_id": claim.claim_id,
        "source": claim.source,
        "source_tier": claim.source_tier,
        "claim_type": claim.claim_type,
        "value": claim.value,
        # When the SOURCE said it, which is what recency is judged on. Distinct
        # from observed_at, and conflating them is what lets a stale article
        # outrank a fresh club update.
        "claimed_at": claim.claimed_at,
        "observed_at": claim.observed_at,
        "quote": claim.source_text,
        "url": claim.provenance_url,
        "verdict": verdict,
        "beaten_by": beaten_by or None,
    }


def build(
    claims: Sequence[AvailabilityClaim],
    resolutions: Mapping[Tuple[int, str], Resolution],
    escalations: Sequence[Resolution],
    gameweek: int,
    generated_at: str,
    names: Optional[Mapping[int, Tuple[str, str]]] = None,
) -> Dict[str, Any]:
    """
    Assemble the view. Pure — takes what the agent already computed.

    Kept free of I/O and of the bootstrap so it can be tested against fabricated
    resolutions without a network or a solver.
    """
    names = names or {}

    by_player: Dict[int, Dict[str, Resolution]] = {}
    for (element_id, claim_type), resolution in resolutions.items():
        if claim_type not in AVAILABILITY_TYPES:
            continue
        by_player.setdefault(element_id, {})[claim_type] = resolution

    claims_by_id = {claim.claim_id: claim for claim in claims}
    claims_by_player: Dict[int, List[AvailabilityClaim]] = {}
    for claim in claims:
        claims_by_player.setdefault(claim.element_id, []).append(claim)

    players: List[Dict[str, Any]] = []
    for element_id, per_type in sorted(by_player.items()):
        if not _is_notable(per_type):
            continue

        name, club = names.get(element_id, ("", ""))
        entries: List[Dict[str, Any]] = []

        for claim_type, resolution in sorted(per_type.items()):
            winner = claims_by_id.get(resolution.winning_claim_id or "")
            rows: List[Dict[str, Any]] = []
            if winner is not None:
                rows.append(_claim_row(winner, "won"))
            # THE feature: every loser, named, with the rule that beat it.
            for lost_id in resolution.conflicts:
                lost = claims_by_id.get(lost_id)
                if lost is not None:
                    rows.append(_claim_row(lost, "lost", resolution.rule))
            # Dropped is separate from lost: a malformed claim did not lose an
            # argument, it never entered one.
            for dropped in resolution.dropped:
                claim_id = str(dropped).split(":", 1)[0]
                bad = claims_by_id.get(claim_id)
                if bad is not None:
                    rows.append(_claim_row(bad, "dropped", str(dropped)))

            entries.append({
                "claim_type": claim_type,
                "resolved_value": resolution.value,
                "rule": resolution.rule,
                "n_conflicts": len(resolution.conflicts),
                "n_dropped": len(resolution.dropped),
                "unresolved": resolution.unresolved,
                "escalation": resolution.escalation,
                "claims": rows,
            })

        players.append({
            "element_id": element_id,
            "player_name": name,
            "club": club,
            "entries": entries,
            # Surfaced at the top level so a list can be sorted by "most disputed"
            # without walking every entry.
            "total_conflicts": sum(e["n_conflicts"] for e in entries),
            "needs_attention": any(
                e["unresolved"] or e["escalation"] for e in entries
            ),
        })

    # Most disputed first: those are the rows where the number is a judgement
    # rather than a reading, and they are what a human should look at.
    players.sort(key=lambda p: (-p["total_conflicts"], p["element_id"]))

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "gameweek": gameweek,
        "players": players,
        "counts": {
            "n_claims": len(claims),
            "n_players_with_claims": len(claims_by_player),
            "n_players_shown": len(players),
            "n_escalations": len(escalations),
            # The honest denominator: how much of the store this view omits, so a
            # short list reads as "little to report" rather than "the export broke".
            "n_players_resolved": len(by_player),
        },
    }


def write(view: Mapping[str, Any], public_dir: Path, dry_run: bool = False) -> Optional[Path]:
    """
    Publish it. Public-only: the raw `availability_evidence.jsonl` is never
    published — it grows all season and carries every claim ever made, while this
    is a bounded projection of the current gameweek.
    """
    if dry_run:
        logger.info("dry run: would write %s", VIEW_FILENAME)
        return None
    target = Path(public_dir) / VIEW_FILENAME
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(view, indent=2, allow_nan=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    logger.info(
        "evidence view: %d player(s) shown of %d resolved -> %s",
        len(view.get("players") or []),
        (view.get("counts") or {}).get("n_players_resolved", 0),
        target,
    )
    return target
