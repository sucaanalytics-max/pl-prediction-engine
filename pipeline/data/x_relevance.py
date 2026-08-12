"""
Whether a scanned X post may be filed at all — and mostly deciding it may not.

## Why this exists

`x_scan.py` used to read curated FPL profiles logged out, so everything it saw
was football by construction and the only question was where the post text
started and stopped. Attaching to a signed-in Chrome changed that: scrolling
yields 3.6x more posts, but the extra posts are retweets from arbitrary accounts
and, worse, the user's own home timeline.

Measured on `pipeline/tests/fixtures/x_feed_corpus.json` (39 posts, live-captured
2026-08-12, `origin` = "home" or "profile:robtFPL"):

    home feed      21 posts, 2 football, ZERO carrying team news
                   (the rest: Indian business/finance, AI, promoted ads, memes)
    profile scan   18 posts, all football, including three reposts from
                   @OptaAnalyst, @SolioAnalytics and @FPL_Spaceman

One home post is the canonical false positive, and it is worth quoting because it
is what this module is shaped around:

    "FACT: Emirates Stadium offers wedding ceremonies and receptions. Arsenal's
     website has a section that says 'Say I Do at Emirates Stadium.' A
     Gunnersaurus meet and greet is an optional add-on in Arsenal's official
     wedding packages brochure"  — @PolymarketSport

It names a canonical club twice and has zero FPL value. A club-name gate files it
as a football availability claim; `x_scan.club_in` already returns "Arsenal" for
it. Under conflict rule R4 a tier-3 claim can push a player's availability
*down*, so a false positive here does not add noise, it benches a fit player.
Hence the bias: a wrong claim is far worse than a missed one.

## Shape of the decision

Vetoes first, then one requirement:

1. **Promoted posts.** X renders "Ad" where the timestamp line would be.
2. **Out of scope** — `news_extract.is_out_of_scope`, reused unchanged
   (women's/WSL/U21/academy). Not re-implemented: two copies of that list drift.
3. **Gambling/affiliate promos.** Organic betting spam is not flagged "Ad" and
   carries real football vocabulary, so nothing else here would stop it.
4. **Surface trust.** Trust comes only from `config.X_SCAN_ACCOUNTS`, matched
   against the scan's own `handle` or the post's author. The home timeline is
   refused outright — measured 2/21 football and 0/21 team news, so refusing it
   costs nothing measured and removes the whole non-football internet.
5. **One hit from a closed football vocabulary**, over accent-folded text
   (Ødegaard/Šeško/Vušković all appear in the corpus and all must still match).

**A club name is never evidence.** It is neither necessary — the three reposts
that must pass name no club at all — nor sufficient, which is exactly what
refuses the wedding post. `TEAM_ALIASES` remains the one club table and is used
by `x_scan.club_in` to *label* a row that has already been admitted, never to
admit one. That rule is also why "stadium", "ground", "kit", "fans" and "ticket"
are not in the vocabulary: they are the club-adjacent nouns that post is built
from.

## What this module never does

It only ever says no. It returns pass/refuse plus the terms it literally
matched, and touches no `value`, `player_surname`, `club` or `tier`. Rows stay
lane=availability, claim_type=unparsed_news, tier 3, so nothing it admits can
derive an availability number. Fabricating one would need a hand-labelled corpus
and a human, which is what `pipeline/learning/file_claim.py` is for.

## Deliberately not here

No player-name index. A bootstrap-derived surname index would add recall, but
441 of 663 surname keys are ambiguous (measured in `news_extract.py`) and it
would make every decision depend on a snapshot whose absence silently changes
the answer — the swallowed failure CLAUDE.md forbids. Regex, two imports, no
network, no MCP, no LLM.

Also not here: the quote-tweet provenance smear. `x_scan.body_from_lines` keeps
the quoted post, so corpus #34 and #36 file Opta's and Solio's assertions under
source `x:robtFPL`. This gate cannot veto that shape — those two posts must pass
— so the fix is a separate change (record the quoted handles, or keep only the
top-level segment).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, Optional, Sequence, Tuple

from pipeline.data.news_extract import fold, is_out_of_scope

#: Bumped on EVERY edit to the vocabulary or the veto order, mirroring
#: `news_extract.EXTRACTOR_VERSION`. A stored row's meaning depends on which gate
#: admitted it: "we filed this because it mentioned a hamstring" and "we filed
#: this because someone widened the vocabulary" are different claims about the
#: same CSV. `test_x_relevance.py` pins the pattern count against this number, so
#: adding a term without bumping it fails the suite rather than passing quietly.
GATE_VERSION = 1

#: An X handle: 1-15 of `[A-Za-z0-9_]`, case-insensitive at X's end.
#:
#: Deliberately not shared with `x_scan.HANDLE`, which matches the `@handle`
#: *line* inside `article.innerText` while parsing the body. Same alphabet,
#: different job; merging them would make one caller's tightening break the
#: other's parse.
HANDLE_SHAPE = re.compile(r"^[A-Za-z0-9_]{1,15}$")

#: X renders the literal string "Ad" where the timestamp line belongs on a
#: promoted post. Matched on the raw `lines` (and, for a row read back from the
#: CSV, on the body's first line) rather than only on the assembled body:
#: `body_from_lines` happens to leave "Ad" as the first body line today, and a
#: perfectly reasonable cleanup of that would silently disable this veto.
#:
#: Measured: 4 of 21 home posts (@AI21Labs, @india_BullAi, @weartransition,
#: @LevelUp_edu). Redundant with the trust check on today's corpus, and kept
#: anyway because it is the check that survives a *football-brand* ad reposted
#: onto a curated timeline — "Ad / Arsenal's new kit, injury-free comfort" is
#: refused here and nowhere else.
AD_MARKER = "ad"

#: How far into the post the "Ad" marker can appear. Display name, handle,
#: then the slot the timestamp would occupy.
AD_WINDOW = 4

#: Deliberately NOT an ad tell: the "From <domain>" card line. The must-pass
#: @OptaAnalyst repost ends "From theanalyst.com", so that heuristic costs a
#: high-signal post. Recorded because a rejected heuristic is worth as much as a
#: kept one.

#: Betting affiliate spam. Organic (unpromoted) gambling posts carry genuine
#: football vocabulary — "Bet on Arsenal vs Chelsea this gameweek, free bet for
#: new customers" clears the vocabulary requirement — so this is the only check
#: that stops them, and it is the hole the trust layer leaves open *behind* a
#: curated handle.
PROMO_PATTERNS = tuple(re.compile(p) for p in (
    r"\bfree bets?\b",
    r"\bpromo code\b",
    r"\buse code\b",
    r"\bdeposit bonus\b",
    r"\bt&cs?\b",
    r"\b18\+\b",
    r"\bbegambleaware\b",
    r"\bnew customers\b",
    r"\bsign[- ]?up offer\b",
))

# ── The football vocabulary ───────────────────────────────────────────────────
#
# Closed, hand-maintained, and grouped into named families so a refusal log can
# say which KIND of signal was missing rather than just "no match". One hit
# admits a post; the families are evidence, not a score.
#
# Two tables, because case carries information:
#
#   FOLDED   matched against `news_extract.fold(text)` — lowercased and
#            accent-stripped. Load-bearing on this corpus, not hypothetically:
#            Šeško/Estêvão (#22), Ødegaard (#26), Groß/Vušković (#31),
#            García (#35).
#   EXACT    matched case-sensitively against the raw text, for abbreviations of
#            three characters or fewer. `\bXI\b` must not fire on "Xi Jinping"
#            and `\bcm\b` must not fire on "30cm" — on a news-heavy timeline
#            those are live collisions, not thought experiments.
#
# TERMS EXCLUDED ON PURPOSE, each because it fired on something in the measured
# home feed or on ordinary business prose, and each at zero cost to corpus
# coverage (every post that mentioned one also mentioned a kept term):
#
#   bare "assists"      "the agent assists analysts"
#   bare "goals"        quarterly goals            (kept: "season goals", "G+A")
#   bare "minutes"      "inspired for 3 minutes"   (@sairahul1)
#   bare "window"       hiring window              (kept: "transfer window")
#   bare "transfer"     bank/data/learning transfer
#   bare "card"         "transit cards"            (@RaoSumukh)
#   bare "scan"         "you scan QR codes"        (@RaoSumukh)
#   bare "manager"      "Management Credibility"   (@india_BullAi)
#   bare "PL"           P&L in a finance feed      (kept: "Premier League")
#   bare "corners"      "cut corners"              (kept: "took ... corners")
#   bare "knock"        knock-on effect            — see the recall note below
#   bare "friendly"     "a friendly reminder", "user-friendly"
#   "differential"      rate/wage differential
#   "wildcard"          business wildcard
#   "DEFCON"            DEF CON
#   "squad", "form", "shots", "player", "penalty", "stadium", "ground", "kit",
#   "fans", "ticket", "price", "free", "forward", "draft", "sports"
#
# Known recall cost of that strictness, stated rather than hidden and MEASURED,
# not guessed: bare "knock" is excluded and bare "in training" is not a pattern
# either (only "back in/returned to training", "trains fully" and friends), so
# "Shaw picked up a knock in training" is REFUSED as no-football-signal. Corpus
# #30 is the same sentence inside a longer post and survives on CF/LW/CM, "took
# corners" and "on target" — which is luck, not coverage. Widening this is a
# vocabulary edit with a `GATE_VERSION` bump, not a quiet tweak.

#: Availability language specific enough to carry a post on its own.
AVAILABILITY = (
    r"\b(?:hamstring|groin|calf|achilles|acl|hernia|concussion)\b",
    r"\bruled out\b",
    r"\bsidelined\b",
    r"\blimped off\b",
    r"\b(?:sent off|red card)\b",
    r"\bout for (?:up to |the )?(?:\w+ )?(?:weeks?|months?|games?|season)\b",
    r"\b(?:match|fully|declared) fit\b",
    r"\b(?:back|returned) (?:in|to) (?:full )?training\b",
    r"\bin full training\b",
    r"\btrains? (?:fully|with|again|normally)\b",
    r"\btrained (?:fully|with|again|normally)\b",
    r"\binjury (?:concerns?|update|news|doubt|list|blow|scare|latest)\b",
    r"\b(?:a|major|serious|slight) doubt\b",
    r"\bdoubt for\b",
    r"\b(?:suspension|match ban)\b",
    r"\bexpected back\b",
)

#: Availability words that are ALSO ordinary English, so they may corroborate but
#: never admit on their own.
#:
#: The residual class this closes: "A workplace injury claim was filed against
#: the Anderson group" is not team news, and on a bare `injury` rule it would be
#: filed as though it were. The football-specific set above is what a genuine
#: injury post says instead.
AVAILABILITY_GENERIC = (
    r"\binjur(?:y|ies|ed)\b",
    r"\bunavailable\b",
    r"\bmisses? out\b",
    r"\bfitness\b",
)

SELECTION = (
    # `XI` only with a qualifier, in the folded table; bare uppercase `XI` is in
    # EXACT below, where "Xi Jinping" cannot reach it.
    r"\b(?:starting|main|first|best|predicted|probable|outfield|expected|"
    r"projected|likely)\s+(?:xi|eleven|line-?ups?)\b",
    r"\bteam news\b",
    r"\bdepth charts?\b",
    r"\bsquad depth\b",
    r"\b(?:the|our|their) starters\b",
    r"\b(?:on the bench|benched)\b",
    r"\bsubstitut(?:e|ed|es|ion)\b",
    r"\bpre-?season starts?\b",
    r"\bcameo\b",
)

ROLE = (
    r"\b(?:full|wing|centre|center|left|right)[- ]backs?\b",
    r"\bmidfield(?:er|ers)?\b",
    r"\bgoalkeepers?\b",
    r"\bstrikers?\b",
    r"\bwingers?\b",
    r"\bdefenders?\b",
)

PERFORMANCE = (
    r"\bclean sheets?\b",
    r"\bassist (?:total|totals|market|markets|numbers)\b",
    r"\b(?:season|projected|expected) goals?\b",
    r"\bgoals? (?:total|totals|market|markets)\b",
    r"\bheat ?maps?\b",
    r"\bshot maps?\b",
    r"\btouch maps?\b",
    r"\bposition maps?\b",
    r"\bset[- ]?pieces?\b",
    # "took some LHS corners", "splitting set pieces", "on all set pieces". The
    # verb is what makes this football rather than "cut corners".
    r"\b(?:took|taking|takes|split|splitting|on)\s+(?:some |all )?(?:\w+ )?"
    r"(?:corners?|penalties|penalty|free[- ]kicks?|fks?)\b",
    r"\bon target\b",
)

FIXTURE = (
    r"\bpre-?season\b",
    r"\bfixture runs?\b",
    r"\bfixture (?:list|swing|swings|ticker)\b",
    r"\bpremier league\b",
    r"\bgame ?weeks?\b",
    r"\bkick-?off\b",
    r"\bmatchday\b",
)

TRANSFER = (
    r"\btransfer window\b",
    r"\bon loan\b",
    r"\bloan (?:move|deal|spell)\b",
    r"\bdeadline day\b",
    r"\bnew signings?\b",
    r"\bcompleted? (?:a|the) (?:move|transfer)\b",
    r"\bhere we go\b",
)

FPL_META = (
    r"\bchip strateg(?:y|ies)\b",
    r"\bfree hit\b",
    r"\btriple captain\b",
    r"\bbench boost\b",
    r"\bcaptaincy\b",
    r"\bmini-?league\b",
    r"\bpoints? per (?:game|match)\b",
    r"\bfantasy premier league\b",
    r"\bprice ris(?:e|es)\b",
)

#: Case-sensitive, uppercase-only. This is the graft that stops an abbreviation
#: gate being a liability: `\bXI\b` cannot fire on "Xi Jinping", `\bCM\b` cannot
#: fire on "30cm", and `\bGW\d` cannot fire on "5GW of solar capacity" because
#: there is no word boundary inside "5GW".
EXACT: Dict[str, Tuple[str, ...]] = {
    "selection": (r"\bXI\b",),
    "role": (r"\b(?:GK|CB|LB|RB|LWB|RWB|CDM|CAM|CM|CF|LW|RW)\b", r"\bFWDs?\b"),
    "performance": (r"\bG\+A\b", r"\bnpxG\b", r"\bxGI?\b", r"\bCS%", r"\bFKs?\b"),
    "fixture": (r"\bGW\d{1,2}\b",),
    # Collides with Florida Power & Light, which is only reachable behind a
    # curated FPL handle, so the blast radius is one account's reposts.
    "fpl_meta": (r"\bFPL\b",),
}

FOLDED: Dict[str, Tuple[str, ...]] = {
    "availability": AVAILABILITY,
    "availability_generic": AVAILABILITY_GENERIC,
    "selection": SELECTION,
    "role": ROLE,
    "performance": PERFORMANCE,
    "fixture": FIXTURE,
    "transfer": TRANSFER,
    "fpl_meta": FPL_META,
}

#: Families whose hits corroborate but cannot admit a post alone. See
#: `AVAILABILITY_GENERIC`.
WEAK_FAMILIES = frozenset({"availability_generic"})

#: Refusals that hold regardless of which page the post arrived on. Reported in
#: preference to "untrusted-surface" because they say more: "this is an ad" is a
#: fact about the post, "we did not curate that page" is a fact about us.
HARD_VETOES = ("promoted-post", "gambling-promo", "out-of-scope")

_FOLDED_COMPILED = {
    family: tuple(re.compile(p) for p in patterns)
    for family, patterns in FOLDED.items()
}
_EXACT_COMPILED = {
    family: tuple(re.compile(p) for p in patterns)
    for family, patterns in EXACT.items()
}

#: Total patterns in the vocabulary. Pinned by a test against `GATE_VERSION`, so
#: a well-meant term addition cannot change what a stored row means without
#: saying so.
PATTERN_COUNT = (
    sum(len(v) for v in FOLDED.values()) + sum(len(v) for v in EXACT.values())
)


@dataclass(frozen=True)
class Relevance:
    """
    One admissibility decision, with its evidence.

    Frozen and always carrying a `reason`, mirroring
    `news_extract.is_out_of_scope`: a refusal with no reason is a refusal nobody
    can audit, and the refusal log is the only alarm this design has against
    silent recall loss.
    """

    passed: bool
    reason: str
    families: Tuple[str, ...] = ()
    terms: Tuple[str, ...] = ()


def trusted_handles(accounts: Optional[Iterable[Mapping[str, object]]] = None
                    ) -> frozenset:
    """
    The surfaces we curated, folded for comparison.

    Sourced from `config.X_SCAN_ACCOUNTS` — the table that already exists, is
    already reviewable in a diff, and already has an owner. Injectable so tests
    drive the gate without editing config.

    Trust is a property of the page we chose to open, which is why a repost by a
    curated account inherits it (that is what admits @SolioAnalytics,
    @OptaAnalyst and @FPL_Spaceman) while the identical repost seen on the home
    timeline does not.
    """
    if accounts is None:
        from pipeline.config import X_SCAN_ACCOUNTS
        accounts = X_SCAN_ACCOUNTS
    return frozenset(
        fold(str(entry.get("handle") or "")) for entry in accounts
        if str(entry.get("handle") or "").strip()
    )


def is_promoted(text: str, lines: Sequence[str] = ()) -> bool:
    """Whether X marked this as a paid placement."""
    for line in list(lines)[:AD_WINDOW]:
        if fold(str(line).strip()) == AD_MARKER:
            return True
    # A row read back from the CSV has no `lines` left; today `body_from_lines`
    # leaves "Ad" as the body's first line, so the same veto still reaches it.
    head = str(text).strip().splitlines()[:1]
    return bool(head) and fold(head[0].strip()) == AD_MARKER


def football_signals(text: str) -> Dict[str, Tuple[str, ...]]:
    """
    Which vocabulary families the text hits, and the literal matches.

    Returns matched substrings, never an interpretation of them. Nothing
    downstream may treat a match as an availability value.
    """
    low = fold(str(text))
    raw = str(text)
    hits: Dict[str, list] = {}
    for family, patterns in _FOLDED_COMPILED.items():
        for pattern in patterns:
            found = pattern.search(low)
            if found:
                hits.setdefault(family, []).append(found.group(0))
    for family, patterns in _EXACT_COMPILED.items():
        for pattern in patterns:
            found = pattern.search(raw)
            if found:
                hits.setdefault(family, []).append(found.group(0))
    return {family: tuple(terms) for family, terms in hits.items()}


def is_football_text(text: str, lines: Sequence[str] = ()) -> Relevance:
    """
    The CONTENT half of the gate: the checks that need no knowledge of the page.

    Split out because `run_news.py` re-screens the committed inbox, where the
    surface a row came from was never recorded. Running only the content layer
    there is the honest version: it catches a row written by an older, wider scan
    — the wedding post scores zero here, so either layer alone refuses it —
    without inventing a trust decision the CSV cannot support.
    """
    body = str(text)
    if is_promoted(body, lines):
        return Relevance(False, "promoted-post")

    out_of_scope = is_out_of_scope(body)
    if out_of_scope:
        # Reused rather than reimplemented. Zero hits on this corpus, but it is
        # the measured failure from the sibling RSS lane ("Olid named new Man Utd
        # Women boss"), and two copies of that list would drift.
        return Relevance(False, f"out-of-scope: {out_of_scope}")

    low = fold(body)
    for pattern in PROMO_PATTERNS:
        found = pattern.search(low)
        if found:
            return Relevance(False, f"gambling-promo: {found.group(0)!r}")

    hits = football_signals(body)
    strong = sorted(set(hits) - WEAK_FAMILIES)
    if not strong:
        reason = (
            "generic-availability-only" if hits else "no-football-signal"
        )
        return Relevance(False, reason, tuple(sorted(hits)),
                         tuple(t for f in sorted(hits) for t in hits[f]))
    families = tuple(sorted(hits))
    return Relevance(True, "ok", families,
                     tuple(t for f in families for t in hits[f]))


def is_football_relevant(
    text: str,
    author: str = "",
    *,
    handle: str = "",
    lines: Sequence[str] = (),
    trusted: Optional[Iterable[str]] = None,
) -> Relevance:
    """
    Whether a scanned post may be filed. Refuses by default.

    `handle` is the page the scan read — the extractor already returns it
    (`x_extract.js` sets it to `location.pathname.split('/')[1] || 'home'`), so
    "home" is self-labelling and no new field is needed. `author` is the post's
    own author, read from its status permalink.

    Fail-safe: a payload with neither a curated handle nor a curated author is
    refused. Quantified on the corpus rather than asserted — a legacy payload
    with no `handle` files 15 of 18 profile posts instead of 18, because the
    three reposts lose their trust, rather than widening the gate to compensate.
    """
    surfaces = frozenset(fold(h) for h in trusted) if trusted is not None \
        else trusted_handles()

    # Content vetoes first, so an ad, a betting promo or a women's-team post is
    # refused with the reason that actually describes it even when it arrives on
    # a curated page. Ordering only affects which reason the log records; the
    # verdict is the same either way.
    content = is_football_text(text, lines)
    if not content.passed and content.reason.startswith(HARD_VETOES):
        return content

    clean = str(author or "").strip().lstrip("@")
    trusted_handle = bool(handle) and fold(str(handle)) in surfaces
    trusted_author = bool(clean) and fold(clean) in surfaces

    if not trusted_handle and not HANDLE_SHAPE.match(clean):
        # No author, no filing. `to_items` falls back to the CLI `--source` when
        # the extractor cannot read an author, which on a shared surface stamps a
        # stranger's post `x:robtFPL` — and the author is the only thing that
        # makes these rows admissible at all. A single-author curated profile is
        # the one case where the fallback is accurate, so it is the one case this
        # allows (pinned by
        # test_x_scan.FeedAttributionTests.test_a_missing_author_falls_back...).
        return Relevance(False, "no-author-on-untrusted-surface")

    if not (trusted_handle or trusted_author):
        return Relevance(False, "untrusted-surface")

    return content
