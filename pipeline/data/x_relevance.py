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

## English only, and that is a decision rather than an oversight

The vocabulary is English. A presser quote or club statement in another language is
refused even behind a curated handle — measured: `Offiziell: Wirtz fehlt wegen einer
Verletzung am Oberschenkel.` scores zero signals.

What coverage exists is **accidental, and worse than none for being unpredictable**.
`Guardiola: "Rodri estará fuera dos semanas por una lesión muscular."` passes, but
only on the cognate `muscular`, which is in the body-part table for English reasons.
Drop that one word — `"Rodri estará fuera dos semanas."` — and the identical claim
is refused. So the gate does not admit Spanish; it admits Spanish sentences that
happen to contain an English-looking word, which is not a property anyone should
plan around.

Recorded here because the `fold()` machinery gives the opposite impression. Folding
exists so that *English* posts naming Ødegaard, Šeško or Vušković still match; it
says nothing about the language of the surrounding sentence, and a reader could
reasonably assume otherwise.

Adding a language costs a vocabulary per language and a corpus per language to
measure it against, and the accounts in `X_SCAN_ACCOUNTS` post in English. When one
does not, that is the moment to pay for it — not before, and not by machine
translation, which would put a paraphrase where a verbatim quote is supposed to be.

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

from pipeline.data.availability_news import _LIGAMENT, _MUSCULAR
from pipeline.data.news_extract import fold, is_out_of_scope

#: Bumped on EVERY edit to the vocabulary or the veto order, mirroring
#: `news_extract.EXTRACTOR_VERSION`. A stored row's meaning depends on which gate
#: admitted it: "we filed this because it mentioned a hamstring" and "we filed
#: this because someone widened the vocabulary" are different claims about the
#: same CSV. `test_x_relevance.py` pins the pattern count against this number, so
#: adding a term without bumping it fails the suite rather than passing quietly.
#: v2: the recall repair. An adversarial pass measured that v1's AVAILABILITY
#: family saw only 4 of the 13 body parts this repo already classifies, had no term
#: for surgery at all, and carried noun forms without their inflections — so
#: "faces a suspension" was admitted while "is suspended for three games" was not.
#: Rows filed under v1 were filed by a materially narrower gate, which is exactly
#: what this number exists to record.
GATE_VERSION = 2

#: An X handle: 1-15 of `[A-Za-z0-9_]`, case-insensitive at X's end.
#:
#: Deliberately not shared with `x_scan.HANDLE`, which matches the `@handle`
#: *line* inside `article.innerText` while parsing the body. Same alphabet,
#: different job; merging them would make one caller's tightening break the
#: other's parse.
HANDLE_SHAPE = re.compile(r"^[A-Za-z0-9_]{1,15}$")

#: Any run of whitespace, including the newlines `body_from_lines` joins on.
WHITESPACE = re.compile(r"\s+")

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

#: How far into the post the "Ad" marker can appear.
#:
#: Display name, handle, then the slot the timestamp would occupy — 4 on the
#: measured corpus shape. Widened to 6 because the chrome above the body is not a
#: fixed height: a "Rob T reposted" frame adds a line, and a card-style promotion
#: with no @handle line at all pushed "Ad" to index 4, outside a 4-line window,
#: where `body_from_lines` then also missed it (its own handle search gives up
#: after 6 lines) and the ad was filed. 6 matches that search, so the two agree
#: about where the post begins.
#:
#: Widening is close to free because the check is an EXACT line equal to "Ad" — a
#: body line that is precisely that and nothing else is not a real post.
AD_WINDOW = 6

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
    # `\b18\+\b` — the first version — can NEVER match a real "18+": a word
    # boundary after "+" requires a following word character, so it fired only on
    # "18+only". Its test passed because both fixtures also said "free bet" or
    # "deposit bonus", so the one pattern meant to catch a bare regulatory marker
    # was never exercised. Measured dead against "18+", "18+ only", "18+.",
    # "(18+)" and "18+ | begambleaware".
    r"\b18\+",
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

#: Body parts, taken from `availability_news.py` rather than re-listed.
#:
#: The first version hand-wrote seven and an adversarial check counted the cost:
#: **9 of the 13 parts this repo already classifies were invisible**, so
#: "Saka has a knee problem" was refused while "Saka has a hamstring problem"
#: passed. That asymmetry has no defence — it is not a judgement about evidence,
#: it is a gap in a list. Importing the tables that the RSS lane already uses
#: means the two lanes cannot disagree about what counts as an injury, which is
#: the same argument that keeps `TEAM_ALIASES` singular.
#: `back` is deliberately NOT here even though FPL's `news` field uses it. It is
#: ordinary English — "back in training", "back on the picket line", "back to the
#: drawing board" — and adding it made a Sam Altman quote thread pass the content
#: half. That is the same class of mistake the excluded-homograph list below
#: records; it is only visible because a test asserted the corpus verdicts.
_PARTS = tuple(sorted(_MUSCULAR | _LIGAMENT | {
    # Present in FPL's own `news` strings and in press reporting, but not in the
    # two coarse categories above, which exist to bucket a *return distribution*
    # rather than to enumerate anatomy.
    "foot", "toe", "hip", "metatarsal", "rib", "hernia", "concussion", "acl",
}))

#: Availability language specific enough to carry a post on its own.
AVAILABILITY = (
    rf"\b(?:{'|'.join(_PARTS)})\b",
    # Surgery had NO term at all, and "<player> has had knee surgery, out until
    # October" is the single most common shape of real team news. Measured: six
    # such posts were refused end-to-end with zero signals.
    #
    # Scoped rather than bare. "operation" and "underwent" alone are business
    # English ("the operation of the business", "the fund underwent a review"), and
    # a gate that admits a stranger's prose is worse than one that misses a post.
    r"\bhad (?:successful )?surgery\b",
    r"\bsurgery on\b",
    r"\bunderwent (?:an? )?(?:operation|surgery|procedure)\b",
    r"\bstress fracture\b",
    r"\bruled out\b",
    r"\bsidelined\b",
    r"\blimped off\b",
    r"\b(?:sent off|red card)\b",
    r"\bout for (?:up to |the )?(?:\w+ )?(?:weeks?|months?|games?|season)\b",
    # Inflections, because the noun-only version produced arbitrary near-synonym
    # splits: "faces a suspension" passed while "is suspended" was refused, and
    # "is a doubt" passed while "is doubtful" was refused.
    #
    # Each is scoped to a football object. Bare `suspend(ed|s)` admitted "Everton
    # shares suspended after the takeover filing" — a club name plus a finance verb,
    # which is precisely the shape this module exists to refuse. A test caught it.
    r"\bout until\b",
    r"\bsuspended (?:for|until)\b",
    r"\bdoubtful for\b",
    r"\bwill miss (?:the |his |\w+ )?"
    r"(?:game|match|fixture|weekend|season|trip|tie|leg|opener)\b",
    r"\bmisses the (?:game|match|trip|weekend|season|opener)\b",
    r"\bnot available for (?:selection|the)\b",
    r"\bchance of playing\b",
    r"\bwithdrawn from the (?:squad|camp|group)\b",
    r"\bleft out of the (?:squad|travelling squad|matchday squad)\b",
    r"\bwill be assessed\b",
    r"\b(?:is|been) rested\b",
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

#: The out-of-scope reasons that no evidence can overrule.
#:
#: A women's or WSL story concerns a competition whose players are not in FPL, so
#: availability language in it is still not senior team news — the players it names
#: have no `element_id` to attach a claim to. Contrast "academy", "U21" and
#: "legend", which describe people who routinely appear inside a senior story
#: ("academy graduate Nwaneri starts instead"), and which therefore yield to
#: explicit senior availability evidence. Mirrors the first two entries of
#: `news_extract.EXCLUDE_PATTERNS`; kept as a narrow local pattern rather than by
#: importing that tuple, because the split is a judgement THIS lane makes about
#: post bodies, not a claim about the headline list.
DIFFERENT_COMPETITION = re.compile(r"\bwomen'?s?\b|\bwsl\b", re.IGNORECASE)

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
    # Match against whitespace-collapsed text.
    #
    # `body_from_lines` joins a post with "\n", and X breaks lines wherever the
    # rendering did — so "TEAM\nNEWS: Palmer starts" missed `\bteam news\b` while
    # the identical post on one line matched. The inconsistency was accidental
    # rather than chosen: patterns written with `\s+` (the qualified-XI rule)
    # already survived the split, and the ones written with a literal space did
    # not. Collapsing here fixes every multi-word pattern at once instead of
    # rewriting eighty of them and missing some.
    flat = WHITESPACE.sub(" ", str(text))
    low = fold(flat)
    raw = flat
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
    without inventing a trust decision the CSV cannot support.

    **This layer is a second line, not a football classifier.** An earlier version
    of this docstring claimed "the wedding post scores zero here, so either layer
    alone refuses it". That was refuted by execution: adding one clause — "Kick-off
    for the first ceremony is in September" — makes the same post pass here with
    `terms=('kick-off',)`. Its refusal is a property of the words that tweet
    happened to use, not of the design. The vocabulary is also not exclusively
    football: "The Fed has ruled out a rate cut... a serious doubt for the rest of
    the year" passes on AVAILABILITY terms, as do NBA, cricket and picket-line
    prose. The trust layer is what makes the gate sound; this narrows what a
    trusted surface may say, and screens legacy rows that have no surface at all.
    """
    body = str(text)
    if is_promoted(body, lines):
        return Relevance(False, "promoted-post")

    hits = football_signals(body)
    out_of_scope = is_out_of_scope(body)
    if out_of_scope and (
        DIFFERENT_COMPETITION.search(body) or "availability" not in hits
    ):
        # Reused rather than reimplemented — two copies of that list would drift,
        # and it encodes the sibling RSS lane's measured false positive ("Olid
        # named new Man Utd Women boss").
        #
        # Scoped by evidence, because the list was written for HEADLINES and this
        # runs on multi-topic post BODIES. As an unconditional veto it refused
        # "Arteta confirms Saka is ruled out; academy graduate Nwaneri starts
        # instead" for the word "academy", discarding matched senior availability
        # evidence — and on this repo's own 102-entry RSS corpus it vetoed 5
        # further entries that are in scope by title.
        #
        # But the scoping is NOT uniform, and getting that wrong is how this fix
        # nearly shipped a regression: my first version admitted "Man Utd Women
        # boss; she trains fully with the squad" because it carries availability
        # language. A women's or WSL story is a DIFFERENT COMPETITION whose players
        # are not in FPL at all, so no amount of availability language makes it
        # senior team news — it stays a hard veto. "academy", "U21" and "legend"
        # describe people who can appear in a senior story, so those yield to
        # explicit senior availability evidence. The existing reuse test is what
        # caught the difference.
        return Relevance(False, f"out-of-scope: {out_of_scope}")

    low = fold(body)
    for pattern in PROMO_PATTERNS:
        found = pattern.search(low)
        if found:
            return Relevance(False, f"gambling-promo: {found.group(0)!r}")

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
    profile_root: bool = True,
) -> Relevance:
    """
    Whether a scanned post may be filed. Refuses by default.

    `handle` is the page the scan read — the extractor returns it, so "home" is
    self-labelling and no new field is needed. `author` is the post's own author,
    read from its status permalink.

    `profile_root` says whether that page was the handle's own timeline. It has to
    be asked, because `handle` names the profile OWNER and not the author of what
    the page shows: `/robtFPL`, `/robtFPL/with_replies` and `/robtFPL/status/<id>`
    all report "robtFPL", and the last two render articles by arbitrary strangers.
    An adversarial check filed 5 of 5 stranger replies from a `/with_replies`
    payload as trusted — one of them "Russia has ruled out any reduction of its
    nuclear arsenal", stamped `club=Arsenal` because "arsenal" is a club alias.

    So a handle vouches for OTHER authors only on its root timeline, which shows
    its own posts and the reposts it chose to amplify. Off the root, a post must
    carry a curated author of its own. It defaults True so a caller that cannot
    say gets today's behaviour for a root scan, and `to_items` passes the
    extractor's answer.

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
    on_root = bool(handle) and fold(str(handle)) in surfaces
    trusted_author = bool(clean) and fold(clean) in surfaces
    # The page vouches for a stranger only on its own timeline. Off the root it
    # still vouches for the owner's own posts — a `/robtFPL/status/<id>` read of
    # robtFPL's own post is the same assertion as reading it on the timeline.
    #
    # A blank author is deliberately NOT covered off-root. There, "we could not
    # read who wrote it" and "the owner wrote it" are different statements, and
    # the `--source` fallback would turn the first into the second.
    owns_the_post = bool(clean) and fold(clean) == fold(str(handle))
    trusted_handle = on_root and (profile_root or owns_the_post)

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
