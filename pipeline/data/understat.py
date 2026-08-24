"""
Player-level shot and creation data from Understat.

## Why this is a separate module from `fbref.py`

`fbref.py` fetches TEAM-level aggregates and feeds them to the model as features.
This is PLAYER-level and feeds a screen. The distinction matters because of the
repo's rule on scraped sources: an optional source may degrade gracefully, but a
source a model depends on must fail loudly. Nothing here reaches a projection, so
everything here is allowed to come back empty.

## What Understat has that FPL does not

`shots`, `key_passes`, `np_xg` (penalties separated), `xg_chain` and `xg_buildup`.
FPL's own API carries xG and xA but no shot counts at all, so the "how many times
did he try" question has no answer without this.

It is also a SECOND xG model. On 2026-08-24 Understat priced Isak's opening match
at 1.41 xG against FPL's 1.09 for the same 90 minutes. Neither is right; the
disagreement is the information, and a screen that shows both is worth more than
one that averages them.

## What it does not have

Shots on target, crosses, passes into the final third, touches in the box. Those
are FBref/Opta columns, and `soccerdata`'s FBref reader exposes only `standard`,
`shooting`, `keeper`, `misc` and `playing_time` — no `passing` or `possession`. So
a "Creativity" surface built on this is partial by construction, and should say so
rather than imply otherwise.

## The join is the hard part, not the fetch

Understat names players in full ("Alexander Isak"); FPL splits them across
`first_name`, `second_name` and `web_name`, and the three disagree in ways no
single rule covers:

    Understat            FPL first    FPL second              FPL web
    Alexander Isak       Alexander    Isak                    Isak
    Bruno Fernandes      Bruno        Borges Fernandes        B.Fernandes
    João Pedro           João Pedro   Junqueira de Jesus      João Pedro
    Virgil van Dijk      Virgil       van Dijk                Virgil

So the match is layered, ordered by confidence, and scoped to one club — clubs
themselves going through `normalize_team_name`, because Understat says "Coventry"
where FPL says "Coventry City". Anything unmatched is REPORTED, never dropped
quietly: a join that silently covers 60% of the league looks identical on screen
to one that covers 99%.
"""

from __future__ import annotations

import logging
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

#: Cache lifetime. Understat updates after matches, not continuously, and the
#: fetch reaches a site that does not invite traffic — so this is deliberately
#: long. The pipeline runs daily; this makes most of those runs free.
CACHE_HOURS = 48

#: Characters Unicode decomposition will NOT strip for us. `ğ` and `é` decompose
#: to a base letter plus a combining mark and are handled by NFKD; these do not
#: decompose at all, so they need naming. Missing one means a player silently
#: fails to match — `Kadıoğlu` and `Groß` are both in the league right now.
_FOLD_MAP = str.maketrans({
    "ı": "i", "İ": "i", "ß": "ss", "ø": "o", "Ø": "o", "ł": "l", "Ł": "l",
    "đ": "d", "Đ": "d", "ð": "d", "þ": "th", "æ": "ae", "œ": "oe", "ħ": "h",
})


def fold(name: str) -> str:
    """
    A name reduced to the letters two providers can agree on.

    Lowercased, accents decomposed away, the non-decomposing characters above
    mapped explicitly, and everything that is not a latin letter dropped — so
    ``F.Kadıoğlu``, ``Kadıoğlu`` and ``Ferdi Kadioglu`` all fold toward the same
    letters and can be compared without punctuation or spacing getting in the way.
    """
    if not name:
        return ""
    lowered = str(name).strip().lower().translate(_FOLD_MAP)
    decomposed = unicodedata.normalize("NFKD", lowered)
    return "".join(c for c in decomposed if c.isalpha() and c.isascii())


def _tokens(name: str) -> List[str]:
    """The name's words, folded individually. Empty words are dropped."""
    return [t for t in (fold(part) for part in str(name or "").split()) if t]


def fetch_player_season_stats(
    season_label: str,
    cache_dir: Path,
    force: bool = False,
) -> Optional["Any"]:
    """
    One league-season table of per-player Understat stats, or None.

    ONE request per refresh, not one per player: this is the whole league in a
    single table. That is what keeps a scraped source defensible — 609 player
    pages would be abusive, one season table is what a human viewing the site
    would cost them.

    Returns None on any failure, by design. Callers must treat absence as normal.
    """
    try:
        import pandas as pd
    except ImportError:
        logger.warning("pandas unavailable; skipping Understat player stats")
        return None

    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"understat_players_{season_label.replace('-', '')}.parquet"

    if cache_path.exists() and not force:
        age_h = (
            pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")
        ).total_seconds() / 3600
        if age_h < CACHE_HOURS:
            logger.info("Understat player stats from cache (%.1fh old)", age_h)
            try:
                return pd.read_parquet(cache_path)
            except Exception as exc:  # noqa: BLE001 - a corrupt cache must not be fatal
                logger.warning("Understat cache unreadable (%s); refetching", exc)

    # The import gets its own try, and nothing else goes inside it. A broad
    # `except ImportError` around the whole fetch reported "soccerdata not
    # installed" when the real failure was `to_parquet` wanting pyarrow — an
    # error message that sends the reader to the wrong package entirely.
    try:
        # Imported here rather than at module scope: the phase-dispatch paths
        # import this module cheaply, and soccerdata pulls a large dependency
        # tree plus a TLS shim it downloads on first use.
        from soccerdata import Understat
    except ImportError as exc:
        logger.warning("soccerdata unavailable (%s); skipping Understat", exc)
        return None

    try:
        logger.info("Fetching Understat player season stats for %s", season_label)
        reader = Understat(leagues="ENG-Premier League", seasons=season_label)
        frame = reader.read_player_season_stats()
        if frame is None or len(frame) == 0:
            logger.warning("Understat returned no player rows for %s", season_label)
            return None
        frame = frame.reset_index()
    except Exception as exc:  # noqa: BLE001 - scraped source, degrades by design
        logger.warning("Understat player fetch failed (%s)", exc)
        if cache_path.exists():
            try:
                logger.info("falling back to stale Understat cache")
                return pd.read_parquet(cache_path)
            except Exception:  # noqa: BLE001
                pass
        return None

    # Caching is a convenience, not the product. A missing parquet engine or an
    # unwritable directory must not discard rows we already have in hand.
    try:
        frame.to_parquet(cache_path)
        logger.info("Understat: %d player rows cached", len(frame))
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Understat fetched %d rows but the cache write failed (%s); "
            "continuing uncached", len(frame), exc)
    return frame


def _fpl_keys(element: Mapping[str, Any]) -> List[str]:
    """
    Every folded spelling of one FPL player, most specific first.

    The order is the confidence order the matcher walks, so it is meaningful:
    a full first+second match is stronger evidence than a bare surname, which
    two players at one club can share.
    """
    first = str(element.get("first_name") or "")
    second = str(element.get("second_name") or "")
    web = str(element.get("web_name") or "")
    second_tokens = _tokens(second)

    keys = [
        fold(first + second),                                   # alexanderisak
        fold(first + (second_tokens[-1] if second_tokens else "")),  # brunofernandes
        fold(first),                                            # joaopedro
        fold(web),                                              # isak / bfernandes
        fold(second),                                           # borgesfernandes
        # The FIRST token of a compound surname, because Iberian names are
        # normally used by the paternal surname and Understat follows that.
        # FPL has `Yéremy` / `Pino Santos`; Understat says `Yeremi Pino` — the
        # first names disagree on a vowel, so the only common ground is `pino`,
        # which is the first token here and the last token there. Ambiguity is
        # still refused by the uniqueness check, so this only ever ADDS a match
        # that was otherwise impossible.
        second_tokens[0] if second_tokens else "",
    ]
    # Order-preserving dedupe: the index of a key is its confidence rank.
    seen: Dict[str, None] = {}
    for k in keys:
        if k:
            seen.setdefault(k, None)
    return list(seen)


def _understat_keys(name: str) -> List[str]:
    """Folded spellings of one Understat name, most specific first."""
    toks = _tokens(name)
    if not toks:
        return []
    keys = ["".join(toks)]                       # alexanderisak
    if len(toks) > 1:
        keys.append(toks[0] + toks[-1])          # brunofernandes (drops middles)
        keys.append(toks[-1])                    # isak
        keys.append(toks[0])                     # joaopedro (as a first name)
    seen: Dict[str, None] = {}
    for k in keys:
        if k:
            seen.setdefault(k, None)
    return list(seen)


def match_to_fpl(
    understat_rows: Sequence[Mapping[str, Any]],
    fpl_elements: Sequence[Mapping[str, Any]],
    fpl_team_of: Mapping[int, str],
    normalise_team,
) -> Tuple[Dict[int, Dict[str, Any]], List[Dict[str, str]]]:
    """
    Join Understat player rows onto FPL element ids.

    Returns ``(by_element_id, unmatched)``. Both halves are the point: the second
    is what makes a bad join visible instead of merely small.

    Matching is scoped to one canonical club, then walks the confidence-ordered
    key lists on both sides and takes the first pairing that is UNIQUE within
    that club. An ambiguous pairing — two players at one club answering to the
    same folded surname — is left unmatched on purpose rather than guessed.
    """
    # Two indexes per club, not one, and the reason is Arsenal.
    #
    # Understat calls Gabriel Magalhães simply "Gabriel". Three Arsenal players
    # have the first name Gabriel, so a single index keyed on folded strings puts
    # all of them under "gabriel" and the match is refused as ambiguous. But only
    # ONE of them has `web_name == "Gabriel"` — FPL already made that call, and
    # deferring to it is better than guessing or giving up.
    #
    # So an exact web_name index is consulted first, and the looser keys second.
    by_club_web: Dict[str, Dict[str, List[Mapping[str, Any]]]] = {}
    by_club: Dict[str, Dict[str, List[Mapping[str, Any]]]] = {}
    for el in fpl_elements:
        club = normalise_team(fpl_team_of.get(el.get("team"), "")) or ""
        web_key = fold(el.get("web_name"))
        if web_key:
            by_club_web.setdefault(club, {}).setdefault(web_key, []).append(el)
        bucket = by_club.setdefault(club, {})
        for key in _fpl_keys(el):
            bucket.setdefault(key, []).append(el)

    matched: Dict[int, Dict[str, Any]] = {}
    unmatched: List[Dict[str, str]] = []

    for row in understat_rows:
        name = str(row.get("player") or "")
        club = normalise_team(str(row.get("team") or "")) or ""
        bucket = by_club.get(club, {})
        hit = None
        reason = "no name key matched at this club"

        if not bucket and club not in by_club_web:
            reason = "club not found in FPL after canonicalisation"
        else:
            keys = _understat_keys(name)
            web_bucket = by_club_web.get(club, {})
            # Tier 1: FPL's own display name, exactly. Unambiguous by convention.
            for key in keys:
                candidates = web_bucket.get(key)
                if candidates and len(candidates) == 1:
                    hit = candidates[0]
                    break
            # Tier 2: the looser spellings.
            if hit is None:
                for key in keys:
                    candidates = bucket.get(key)
                    if not candidates:
                        continue
                    if len(candidates) == 1:
                        hit = candidates[0]
                        break
                    reason = (
                        f"{len(candidates)} players at {club} share the key {key!r}"
                    )

        if hit is None:
            unmatched.append({"player": name, "team": club, "reason": reason})
            continue

        eid = int(hit["id"])
        # First writer wins: Understat lists a transferred player once per club,
        # and the row we already accepted was matched on a stronger key.
        if eid not in matched:
            matched[eid] = dict(row)

    return matched, unmatched
