"""
Turning feed entries into availability claims — and mostly declining to.

## What this module refuses to do, and why

`availability_news.py` parses FPL's own ``news`` string with eight regexes and
55/55 corpus coverage, because that text is machine-generated from a fixed set of
templates:

    "Groin injury - Expected back 21 Aug"
    "Suspended until 29 Aug"
    "Has joined Grimsby Town on loan until the end of the season"

RSS headlines are not that. Measured against a live pull of all six feeds (93
entries):

    "Spurs boss De Zerbi gives optimistic update on Kulusevski"
    "Alonso on Chelsea duo's absence and Mudryk's return in pre-season friendly"
    "Olid named new Man Utd Women boss"
    "Best £5.0m midfielders for FPL 2026/27: All 89 assessed"

A naive surname index over the 570-player bootstrap makes this actively dangerous:
**441 of 663 surname keys are ambiguous** (Wilson x6, Phillips x6, Henderson x4),
substring matching finds ``esse`` inside "as-sesse-d", and a Manchester United
*Women* article matches a men's player named Scott. Under rule R4 a tier-2 claim
may push availability **down**, so a false positive does not merely add noise — it
benches a fit player.

The plan's bar was "coverage AND zero false positives". Prose cannot clear it for
*availability*. So this module draws the line where the evidence actually is:

1. **Club-level `unparsed_news` claims.** 49 of 93 entries resolve a club
   confidently, because club names are unambiguous where surnames are not. These
   carry the verbatim text, the source, the tier, the timestamp and the URL. They
   derive **no availability at all** — `unparsed_news` exists in `CLAIM_TYPES` for
   exactly this — so they cannot move a projection, and they are the raw material
   for the evidence surface that no competitor offers.

2. **Player-level linking only when every check agrees**: a unique surname of at
   least five characters, matched on word boundaries, whose own club is named in
   the same entry. High precision, low recall by construction. Still
   `unparsed_news`.

3. **Availability claims come from the manual lane**, `file_claim.py`. A human
   reads the surfaced evidence and files the claim, which then flows through
   R0-R8 like any other. That is the propose-and-approve model this repo already
   uses for decisions, applied to evidence.

The one exception is (4) below: a small set of patterns whose wording is
unambiguous enough to parse automatically. There are few of them, and that is the
honest number rather than a disappointing one.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from pipeline.data.news_feeds import FeedEntry
from pipeline.learning.availability_evidence import (
    AvailabilityClaim, provenance_digest,
)

logger = logging.getLogger(__name__)

# Bumped when the matcher or the patterns change, so a stored claim records which
# extractor produced it and a reprocessing pass can tell old rows from new.
EXTRACTOR_VERSION = 1

# A surname shorter than this matches too much prose to be safe. Measured: at four
# characters, "king", "sarr" and "esse" all fire on ordinary sentences.
MIN_SURNAME_LENGTH = 5

# Verbatim text kept on a claim. Enough to read the assertion, short enough that
# storing it is quotation rather than republication — these feeds permit
# consumption, not redistribution.
MAX_SOURCE_TEXT = 300


def fold(text: str) -> str:
    """
    Lowercase and strip accents for matching.

    Feeds spell players inconsistently ("Kulusevski", "Kulusevški"), and the
    bootstrap uses the accented form. Folding both sides is the only way a
    headline matches the roster; doing it on only one side silently fails.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


@dataclass(frozen=True)
class ClubIndex:
    """Club name and alias lookup, built from the live bootstrap."""

    # folded alias -> canonical short name as FPL spells it
    aliases: Mapping[str, str]

    def find(self, text: str) -> Set[str]:
        low = fold(text)
        found: Set[str] = set()
        for alias, canonical in self.aliases.items():
            if re.search(rf"(?<![a-z]){re.escape(alias)}(?![a-z])", low):
                found.add(canonical)
        return found


@dataclass(frozen=True)
class PlayerIndex:
    """
    Unique-surname lookup, built from the live bootstrap.

    Only surnames that identify exactly one player are included. A shared surname
    is not a weaker signal, it is an unusable one: picking either Wilson is a
    coin flip presented as a fact.
    """

    unique: Mapping[str, int]          # folded surname -> element id
    club_of: Mapping[int, str]         # element id -> canonical club
    name_of: Mapping[int, str]         # element id -> display name
    code_of: Mapping[int, int]         # element id -> stable player code
    ambiguous: Mapping[str, Tuple[int, ...]]  # folded surname -> element ids

    def find(self, text: str) -> Set[int]:
        low = fold(text)
        return {
            element_id for surname, element_id in self.unique.items()
            if re.search(rf"(?<![a-z]){re.escape(surname)}(?![a-z])", low)
        }

    def ambiguous_in(self, text: str) -> Dict[str, Tuple[int, ...]]:
        """
        Shared surnames the text mentions.

        Surfaced rather than silently dropped: "two Silvas at one club must
        escalate, not pick". A human reading the evidence can resolve it; the
        matcher must not guess.
        """
        low = fold(text)
        return {
            surname: ids for surname, ids in self.ambiguous.items()
            if re.search(rf"(?<![a-z]){re.escape(surname)}(?![a-z])", low)
        }


# Aliases the feeds use that FPL's own team names do not cover. Kept here rather
# than in team_mapping.py because that module canonicalises *provider* names for
# joining match data, whereas these are colloquialisms that only appear in prose.
PROSE_CLUB_ALIASES = {
    "spurs": "Spurs",
    "tottenham": "Spurs",
    "tottenham hotspur": "Spurs",
    "man utd": "Man Utd",
    "man united": "Man Utd",
    "manchester united": "Man Utd",
    "united": None,          # too ambiguous to use; recorded so it is not added
    "man city": "Man City",
    "manchester city": "Man City",
    "gunners": "Arsenal",
    "villa": "Aston Villa",
    "aston villa": "Aston Villa",
    "wolves": "Wolves",
    "wolverhampton": "Wolves",
    "newcastle united": "Newcastle",
    "magpies": "Newcastle",
    "nottingham forest": "Nott'm Forest",
    "notts forest": "Nott'm Forest",
    "forest": "Nott'm Forest",
    "brighton": "Brighton",
    "bournemouth": "Bournemouth",
    "leeds united": "Leeds",
    "west ham united": "West Ham",
    "hammers": "West Ham",
    "palace": "Crystal Palace",
    "crystal palace": "Crystal Palace",
    "toffees": "Everton",
    "blades": "Sheffield Utd",
    "cottagers": "Fulham",
}

# Entries about a club's women's team, academy or a former player are not team
# news about the senior squad. Measured false positive: "Olid named new Man Utd
# Women boss" resolves Man Utd and would otherwise be filed as squad evidence.
EXCLUDE_PATTERNS = (
    re.compile(r"\bwomen'?s?\b", re.IGNORECASE),
    re.compile(r"\bwsl\b", re.IGNORECASE),
    re.compile(r"\bunder-?\s?\d{2}\b", re.IGNORECASE),
    re.compile(r"\bu\d{2}s?\b", re.IGNORECASE),
    re.compile(r"\bacademy\b", re.IGNORECASE),
    re.compile(r"\byouth team\b", re.IGNORECASE),
    re.compile(r"\blegend\b", re.IGNORECASE),
)


def is_out_of_scope(text: str) -> Optional[str]:
    """Why this entry is not senior-squad news, or None if it might be."""
    for pattern in EXCLUDE_PATTERNS:
        match = pattern.search(text)
        if match:
            return f"mentions {match.group(0)!r}"
    return None


def build_club_index(bootstrap: Mapping[str, Any]) -> ClubIndex:
    aliases: Dict[str, str] = {}
    for team in bootstrap.get("teams") or []:
        name = str(team.get("name") or "").strip()
        if not name:
            continue
        aliases[fold(name)] = name
        short = str(team.get("short_name") or "").strip()
        # Three-letter codes like "ARS" match too much prose to be usable.
        if len(short) > 3:
            aliases[fold(short)] = name
    for alias, canonical in PROSE_CLUB_ALIASES.items():
        if canonical is None:
            continue
        # Only add an alias whose target actually plays this season.
        if canonical in aliases.values() or fold(canonical) in aliases:
            aliases[fold(alias)] = aliases.get(fold(canonical), canonical)
    return ClubIndex(aliases=aliases)


def build_player_index(bootstrap: Mapping[str, Any]) -> PlayerIndex:
    teams = {t["id"]: str(t.get("name") or "") for t in bootstrap.get("teams") or []}
    counts: Dict[str, int] = {}
    for element in bootstrap.get("elements") or []:
        counts[fold(str(element.get("second_name") or ""))] = (
            counts.get(fold(str(element.get("second_name") or "")), 0) + 1
        )

    unique: Dict[str, int] = {}
    ambiguous: Dict[str, List[int]] = {}
    club_of: Dict[int, str] = {}
    name_of: Dict[int, str] = {}
    code_of: Dict[int, int] = {}

    for element in bootstrap.get("elements") or []:
        element_id = int(element["id"])
        surname = fold(str(element.get("second_name") or ""))
        club_of[element_id] = teams.get(element.get("team"), "")
        name_of[element_id] = str(element.get("web_name") or surname)
        if element.get("code") is not None:
            code_of[element_id] = int(element["code"])
        if len(surname) < MIN_SURNAME_LENGTH:
            continue
        if counts.get(surname, 0) == 1:
            unique[surname] = element_id
        else:
            ambiguous.setdefault(surname, []).append(element_id)

    return PlayerIndex(
        unique=unique,
        club_of=club_of,
        name_of=name_of,
        code_of=code_of,
        ambiguous={k: tuple(v) for k, v in ambiguous.items()},
    )


# ── (4) The few patterns whose wording IS unambiguous ────────────────────────
#
# Deliberately short. Each one was checked against the 93-entry live corpus for
# false positives, and any pattern that could fire on an editorial headline was
# rejected rather than tightened — a pattern that needs three negative lookaheads
# to be safe is a pattern that will surprise someone later.
#
# These produce a `severity` or `permanent_exit` claim, never a percentage: a
# headline saying "out for three weeks" does not license inventing a
# chance_of_playing, and R4 would let that invented number bench the player.

RULED_OUT_SEASON = re.compile(
    r"\bout for (?:the )?(?:rest of the |remainder of the )?season\b", re.IGNORECASE)
RULED_OUT_MONTHS = re.compile(
    r"\bout for (?:up to )?(?P<n>\w+|\d+) months?\b", re.IGNORECASE)
RULED_OUT_WEEKS = re.compile(
    r"\bout for (?:up to )?(?P<n>\w+|\d+) weeks?\b", re.IGNORECASE)


@dataclass(frozen=True)
class Extraction:
    """What one entry yielded."""

    claims: Tuple[AvailabilityClaim, ...]
    # Entries we deliberately did not turn into anything, and why. Counted so a
    # coverage report distinguishes "nothing to find" from "matcher broken".
    skipped: Tuple[Tuple[str, str], ...] = ()
    # Shared surnames seen but not resolved. Escalated, never guessed.
    ambiguities: Tuple[Tuple[str, Tuple[int, ...]], ...] = ()


def extract_entry(
    entry: FeedEntry,
    clubs: ClubIndex,
    players: PlayerIndex,
    gameweek: int,
    observed_at: str,
) -> Extraction:
    """
    One feed entry to zero or more claims.

    Never raises on content. An entry that yields nothing is the normal case, and
    the caller needs the reason rather than an exception.
    """
    text = entry.text
    if not text.strip():
        return Extraction(claims=(), skipped=((entry.entry_id, "empty"),))

    out_of_scope = is_out_of_scope(text)
    if out_of_scope:
        return Extraction(claims=(), skipped=((entry.entry_id, out_of_scope),))

    named_clubs = clubs.find(text)
    if not named_clubs:
        # No club means we cannot even file it as club evidence. Roughly half of a
        # broad feed's items are like this; that is the feed being broad, not a
        # failure.
        return Extraction(claims=(), skipped=((entry.entry_id, "no club resolved"),))

    ambiguities = tuple(players.ambiguous_in(text).items())

    # Player linking requires the player's OWN club to be named in the entry.
    # Without that check, "Man City boss on the futures of Forest and Spurs linked
    # duo" attaches City players to a Spurs story.
    linked = [
        element_id for element_id in players.find(text)
        if players.club_of.get(element_id) in named_clubs
    ]

    quote = text[:MAX_SOURCE_TEXT]
    claimed_at = entry.published_at  # None when the feed omits a date. Never faked.
    # Rule R0 drops any tier-2-or-lower claim with no digest, on the grounds that
    # an unauditable claim which can move a projection is worse than no claim.
    # Every claim here is tier 2 or 3, so without this they would ALL be dropped —
    # silently, since a dropped claim is counted rather than raised on.
    digest = provenance_digest(quote, entry.link or None)

    claims: List[AvailabilityClaim] = []

    if linked:
        for element_id in sorted(linked):
            claims.append(AvailabilityClaim(
                element_id=element_id,
                player_code=players.code_of.get(element_id),
                source=entry.feed,
                source_tier=entry.tier,
                # `unparsed_news` on purpose: this records that something was said
                # about this player, and derives NO availability from it. A human
                # or a later, better parser turns it into a claim that bites.
                claim_type="unparsed_news",
                value=quote,
                claimed_at=claimed_at,
                observed_at=observed_at,
                gameweek=gameweek,
                provenance_url=entry.link or None,
                provenance_digest=digest,
                source_text=quote,
                parser_version=EXTRACTOR_VERSION,
                notes=f"club-agreed link via unique surname; clubs={sorted(named_clubs)}",
            ))
    else:
        # Club-level evidence. `element_id` is 0 because no player is implicated —
        # the store keys on element ids, and inventing one would attach the note to
        # a real player who was never mentioned.
        claims.append(AvailabilityClaim(
            element_id=0,
            source=entry.feed,
            source_tier=entry.tier,
            claim_type="unparsed_news",
            value=quote,
            claimed_at=claimed_at,
            observed_at=observed_at,
            gameweek=gameweek,
            provenance_url=entry.link or None,
            provenance_digest=digest,
            source_text=quote,
            parser_version=EXTRACTOR_VERSION,
            notes=f"club-level evidence; clubs={sorted(named_clubs)}",
        ))

    return Extraction(claims=tuple(claims), ambiguities=ambiguities)


def extract_all(
    entries: Sequence[FeedEntry],
    bootstrap: Mapping[str, Any],
    gameweek: int,
    observed_at: Optional[str] = None,
) -> Tuple[List[AvailabilityClaim], Dict[str, Any]]:
    """
    Every entry, plus a coverage report.

    The report is the thing that makes this honest: it says how many entries
    resolved a club, how many resolved a player, how many were out of scope and how
    many surnames were too ambiguous to use. A silently low yield and a broken
    matcher look identical without it.
    """
    stamp = observed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    clubs = build_club_index(bootstrap)
    players = build_player_index(bootstrap)

    claims: List[AvailabilityClaim] = []
    skipped: List[Tuple[str, str]] = []
    ambiguities: Dict[str, Tuple[int, ...]] = {}
    player_linked = 0
    club_only = 0

    for entry in entries:
        result = extract_entry(entry, clubs, players, gameweek, stamp)
        claims.extend(result.claims)
        skipped.extend(result.skipped)
        ambiguities.update(dict(result.ambiguities))
        if any(c.element_id > 0 for c in result.claims):
            player_linked += 1
        elif result.claims:
            club_only += 1

    reasons: Dict[str, int] = {}
    for _, reason in skipped:
        key = reason if reason in ("empty", "no club resolved") else "out of scope"
        reasons[key] = reasons.get(key, 0) + 1

    report = {
        "extractor_version": EXTRACTOR_VERSION,
        "n_entries": len(entries),
        "n_claims": len(claims),
        "n_player_linked": player_linked,
        "n_club_only": club_only,
        "n_skipped": len(skipped),
        "skipped_by_reason": reasons,
        # Surnames the text mentioned that identify more than one player. These are
        # exactly the cases a guess would get wrong half the time.
        "ambiguous_surnames": {k: list(v) for k, v in sorted(ambiguities.items())},
        "n_unique_surnames": len(players.unique),
        "n_ambiguous_surnames": len(players.ambiguous),
    }
    return claims, report


def coverage_is_suspicious(report: Mapping[str, Any]) -> Optional[str]:
    """
    Whether a coverage report indicates the matcher has broken rather than the
    news being quiet.

    Distinguishing those two is the whole point. In the pre-season roughly half of
    a broad feed resolves no club at all and almost nothing resolves a player, and
    that is correct. What is NOT correct is every entry failing to resolve a club,
    which would mean the bootstrap changed shape or the alias table went stale.
    """
    n = int(report.get("n_entries", 0))
    if n == 0:
        return None
    if int(report.get("n_claims", 0)) == 0:
        return f"all {n} entries yielded nothing; club index may be stale"
    if int(report.get("n_unique_surnames", 0)) == 0:
        return "player index is empty; bootstrap element shape may have changed"
    return None
