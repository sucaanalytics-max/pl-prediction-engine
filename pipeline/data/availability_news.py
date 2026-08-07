"""
Reading the FPL ``news`` string, which the model currently throws away.

Every element on ``bootstrap-static`` carries ``news`` and ``news_added``. Today
only the timestamp is used, for a single 21-day staleness cliff; the text itself
is stored in two snapshots and read by nothing. That discards the only structured
availability information FPL gives us beyond a status letter and a percentage:

    "Suspended until 29 Aug"                 -> a KNOWN end date
    "Groin injury - Expected back 21 Aug"    -> a known expected end date
    "Hamstring injury - Unknown return date" -> explicitly open-ended
    "Has joined Grimsby Town on loan..."     -> not coming back at all

Those four are different futures that the model currently treats identically,
because all of them arrive as ``chance_of_playing_next_round == 0``. A one-match
suspension and a season-ending loan are not the same projection.

**This costs nothing.** No scraping, no new source, no quota, no network — the
text is already in a payload we fetch, already committed to the archive, and
already thrown away.

Design constraints, each of which is a bug avoided:

*Fail-safe by construction.* An unrecognised string yields NO availability
information at all, so the caller falls back to exactly today's behaviour. The
parser can only ever ADD information, never remove it, which means a parser
regression degrades to the current model rather than to something worse.

*Never resolve a date against the wall clock.* FPL writes "21 Aug" with no year.
Resolving that against ``datetime.now()`` would make the same archived record
parse differently depending on when the parser runs, which would destroy the
reproducibility of a sealed forecast. The year comes from ``news_added`` — the
moment the claim was published — or the date is not resolved at all.

*No locale-dependent month parsing.* ``strptime("%b")`` depends on the runner's
locale, so a CI image with a non-English locale would silently stop matching.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

# Bump when the patterns change, so a stored claim records which parser produced
# it and a reprocessing pass can tell old rows from new.
PARSER_VERSION = 1

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

# How far a resolved date may fall before the news that announced it before we
# conclude the year rolled over. A return date is normally in the future, but FPL
# leaves stale notes in place for weeks, so "expected back 21 Aug" still seen in
# late September is a stale note about this year — not a prediction about next.
# Beyond this, a December note about "3 Jan" is next January.
YEAR_ROLLOVER_GRACE_DAYS = 60

# Injury categories, coarse on purpose. A finer taxonomy would imply we can
# estimate a return distribution per body part, and with a handful of episodes
# per season per category there is no power to fit one.
_MUSCULAR = {"hamstring", "calf", "groin", "thigh", "muscle", "muscular", "quadricep"}
_LIGAMENT = {"knee", "ankle", "achilles", "shoulder", "wrist", "elbow"}

_DATE = r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]{3,9})"

PATTERNS = (
    # Order matters only in that the more specific injury suffixes are tried
    # before the bare ones; the four suffixes are mutually exclusive in practice.
    ("injury_dated", re.compile(
        rf"^(?P<part>.+?)\s+injury\s*-\s*Expected back\s+{_DATE}\.?$", re.IGNORECASE)),
    ("injury_chance", re.compile(
        r"^(?P<part>.+?)\s+injury\s*-\s*(?P<pct>\d{1,3})%\s+chance of playing\.?$",
        re.IGNORECASE)),
    ("injury_undated", re.compile(
        r"^(?P<part>.+?)\s+injury\s*-\s*Unknown return date\.?$", re.IGNORECASE)),
    ("suspended_until", re.compile(
        rf"^Suspended until\s+{_DATE}\.?$", re.IGNORECASE)),
    ("loan_out", re.compile(
        r"^Has joined\s+(?P<club>.+?)\s+on loan.*$", re.IGNORECASE)),
    ("transfer_out", re.compile(
        r"^Has joined\s+(?P<club>.+?)\s+permanently\.?$", re.IGNORECASE)),
    ("returned_to", re.compile(
        r"^Has returned to\s+(?P<club>.+?)\.?$", re.IGNORECASE)),
    ("free_agent", re.compile(
        r"^Has departed the club as a free agent\.?$", re.IGNORECASE)),
)

# Exit kinds. A loan and a permanent transfer differ in principle but not in
# consequence for this season, which is what the projection needs.
EXIT_TRANSFER = "transfer"
EXIT_LOAN = "loan"
EXIT_FREE_AGENT = "free_agent"


@dataclass(frozen=True)
class ParsedNews:
    """Structured facts extracted from one ``news`` string."""

    matched_pattern: Optional[str] = None
    body_part: Optional[str] = None
    injury_category: Optional[str] = None
    chance_of_playing: Optional[int] = None
    # A FITNESS date: he is expected to be able to play from here.
    return_date: Optional[str] = None
    # An ELIGIBILITY date: he is banned until here, and is match-fit throughout.
    unavailable_until: Optional[str] = None
    exit_kind: Optional[str] = None
    exit_club: Optional[str] = None
    # Verbatim text when nothing matched, so the record is complete even though
    # no availability was derived from it.
    residual: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "matched_pattern": self.matched_pattern,
            "body_part": self.body_part,
            "injury_category": self.injury_category,
            "chance_of_playing": self.chance_of_playing,
            "return_date": self.return_date,
            "unavailable_until": self.unavailable_until,
            "exit_kind": self.exit_kind,
            "exit_club": self.exit_club,
            "residual": self.residual,
            "parser_version": PARSER_VERSION,
        }


def _parse_stamp(stamp: Optional[str]) -> Optional[datetime]:
    if not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def resolve_date(day: str, month: str, news_added: Optional[str]) -> Optional[str]:
    """
    Turn FPL's year-less "21 Aug" into an ISO date, using the news timestamp.

    Returns None — rather than guessing — when ``news_added`` is missing or the
    day/month is not a real date. A None date makes the caller treat the absence
    as open-ended, which is the conservative reading and is exactly what the
    string said before we tried to be clever about it.
    """
    published = _parse_stamp(news_added)
    if published is None:
        return None

    month_number = MONTHS.get(month.strip().lower()[:3])
    if month_number is None:
        return None

    try:
        candidate = datetime(
            published.year, month_number, int(day), tzinfo=timezone.utc
        )
    except ValueError:
        # 31 Feb and similar. FPL does not write these, but a typo upstream must
        # not raise inside an unattended pipeline.
        return None

    if candidate < published - timedelta(days=YEAR_ROLLOVER_GRACE_DAYS):
        try:
            candidate = candidate.replace(year=published.year + 1)
        except ValueError:  # 29 Feb into a non-leap year
            return None

    return candidate.date().isoformat()


def _categorise(part: Optional[str]) -> Optional[str]:
    if not part:
        return None
    words = set(re.findall(r"[a-z]+", part.lower()))
    if words & _MUSCULAR:
        return "muscular"
    if words & _LIGAMENT:
        return "ligament"
    return "unspecified"


def parse_news(text: Optional[str], news_added: Optional[str] = None) -> ParsedNews:
    """
    Extract what can be extracted from one ``news`` string.

    Never raises and never guesses. An unmatched string comes back with
    ``matched_pattern=None`` and the text in ``residual``.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return ParsedNews()

    for name, pattern in PATTERNS:
        match = pattern.match(cleaned)
        if not match:
            continue
        groups = match.groupdict()
        part = (groups.get("part") or "").strip() or None

        if name == "injury_dated":
            return ParsedNews(
                matched_pattern=name,
                body_part=part,
                injury_category=_categorise(part),
                return_date=resolve_date(
                    groups["day"], groups["month"], news_added
                ),
            )
        if name == "injury_chance":
            percent = int(groups["pct"])
            if not 0 <= percent <= 100:
                break  # Not a percentage; treat the whole string as unparsed.
            return ParsedNews(
                matched_pattern=name,
                body_part=part,
                injury_category=_categorise(part),
                chance_of_playing=percent,
            )
        if name == "injury_undated":
            return ParsedNews(
                matched_pattern=name,
                body_part=part,
                injury_category=_categorise(part),
            )
        if name == "suspended_until":
            return ParsedNews(
                matched_pattern=name,
                unavailable_until=resolve_date(
                    groups["day"], groups["month"], news_added
                ),
            )
        if name in ("loan_out", "transfer_out", "returned_to", "free_agent"):
            kind = {
                "loan_out": EXIT_LOAN,
                "transfer_out": EXIT_TRANSFER,
                "returned_to": EXIT_TRANSFER,
                "free_agent": EXIT_FREE_AGENT,
            }[name]
            return ParsedNews(
                matched_pattern=name,
                exit_kind=kind,
                exit_club=(groups.get("club") or "").strip() or None,
            )

    return ParsedNews(residual=cleaned)
