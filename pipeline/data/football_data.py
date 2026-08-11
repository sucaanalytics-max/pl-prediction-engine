"""
Football-Data.co.uk CSV fetcher.
Downloads Premier League match data with results, shots, corners, cards, odds.

**Two odds vocabularies live in these CSVs and only one of them is de-viggable.**
The ``Avg*`` columns are averages ACROSS bookmakers and the ``PSH/PSD/PSA``
columns are Pinnacle's PRE-match price; neither is a single bookmaker's closing
book, so neither may be handed to :mod:`pipeline.models.devig`. The ``*C*``
columns (``PSCH``, ``B365CH``, ``PC>2.5``, ...) are one book's closing view and
are the only ones :func:`load_closing_odds` reads. See that function's docstring.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd

from pipeline.config import (
    DATA_RAW, FOOTBALL_DATA_URL, FOOTBALL_DATA_SEASONS, SEASONS, CURRENT_SEASON
)
from pipeline.data.team_mapping import normalize_team_name
from pipeline.utils import fetch_with_retry

logger = logging.getLogger(__name__)

# Columns we care about from the CSV
REQUIRED_COLS = [
    "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR",
    "HTHG", "HTAG", "HTR",
    "Referee",                   # Match referee
    "HS", "AS", "HST", "AST",  # Shots, shots on target
    "HF", "AF",                 # Fouls
    "HC", "AC",                 # Corners
    "HY", "AY", "HR", "AR",    # Cards
]

ODDS_COLS = [
    "B365H", "B365D", "B365A",             # Bet365 1X2
    "PSH", "PSD", "PSA",                   # Pinnacle 1X2 (PRE-match — not de-viggable)
    "AvgH", "AvgD", "AvgA",               # Cross-book average 1X2 (not de-viggable)
    "Avg>2.5", "Avg<2.5",                  # Over/Under 2.5
]

# The two books whose CLOSING prices Football-Data.co.uk publishes per market.
# Every column here ends in a "C" after the book prefix: those are the prices at
# kickoff, from ONE bookmaker, which is the only shape devig.py accepts.
#
# Measured over 2324/2425/2526 (1140 matches): Pinnacle's 1X2 margin runs a
# 2.87-2.94% median and Bet365's a 5.49-5.57% median, both wholly inside devig's
# [0.5%, 15%] plausible-single-book band. Two genuinely independent books, so a
# median across them is a consensus rather than one book echoing itself.
CLOSING_BOOKS = {
    "pinnacle": {"h2h": ("PSCH", "PSCD", "PSCA"), "totals": {2.5: ("PC>2.5", "PC<2.5")},
                 "ah_line": "AHCh", "ah": ("PCAHH", "PCAHA")},
    "bet365":   {"h2h": ("B365CH", "B365CD", "B365CA"), "totals": {2.5: ("B365C>2.5", "B365C<2.5")}},
}

# Canonical, provider-independent columns every closing-odds row carries.
CLOSING_META_COLS = [
    "season", "date", "home_team", "away_team", "home_goals", "away_goals", "match_id",
]


def fetch_season_csv(season_code: str, force: bool = False) -> pd.DataFrame:
    """
    Download E0.csv for a given season from Football-Data.co.uk.

    Args:
        season_code: e.g. "2324" for 2023-24
        force: Re-download even if cached

    Returns:
        DataFrame with match data
    """
    cache_dir = DATA_RAW / "football_data"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"E0_{season_code}.csv"

    if cache_path.exists() and not force:
        # For the current season, refresh every 6 hours so new results are picked up.
        # Completed past seasons are immutable — cache indefinitely.
        if season_code == CURRENT_SEASON:
            age_hours = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime, unit="s")).total_seconds() / 3600
            if age_hours < 6:
                logger.info(f"Loading cached Football-Data CSV: {cache_path}")
                return pd.read_csv(cache_path, encoding="latin-1")
            logger.info(f"Current season CSV is {age_hours:.1f}h old — refreshing...")
        else:
            logger.info(f"Loading cached Football-Data CSV: {cache_path}")
            return pd.read_csv(cache_path, encoding="latin-1")

    url = FOOTBALL_DATA_URL.format(season=season_code)
    logger.info(f"Fetching Football-Data CSV: {url}")

    try:
        resp = fetch_with_retry(url, max_retries=3, timeout=30)
    except Exception as e:
        logger.error(f"Failed to fetch {url}: {e}")
        if cache_path.exists():
            logger.warning("Falling back to stale cache")
            return pd.read_csv(cache_path, encoding="latin-1")
        raise

    cache_path.write_bytes(resp.content)
    return pd.read_csv(cache_path, encoding="latin-1")


def clean_football_data(df: pd.DataFrame, season_code: str) -> pd.DataFrame:
    """
    Clean and standardize a Football-Data CSV.

    - Parse dates
    - Normalize team names
    - Cast numeric columns
    - Add season label and match_id
    """
    df = df.copy()

    # Parse date (Football-Data uses DD/MM/YYYY or DD/MM/YY)
    df["Date"] = pd.to_datetime(df["Date"], dayfirst=True, format="mixed")

    # Normalize team names
    df["HomeTeam"] = df["HomeTeam"].apply(normalize_team_name)
    df["AwayTeam"] = df["AwayTeam"].apply(normalize_team_name)

    # Cast score columns to int (drop rows with missing scores = unplayed)
    score_cols = ["FTHG", "FTAG", "HTHG", "HTAG"]
    for col in score_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["FTHG", "FTAG"])
    for col in score_cols:
        if col in df.columns:
            df[col] = df[col].astype(int)

    # Normalize referee name (strip whitespace, title case)
    if "Referee" in df.columns:
        df["Referee"] = df["Referee"].astype(str).str.strip().str.title()
        df["Referee"] = df["Referee"].replace({"Nan": None, "None": None, "": None})

    # Cast stats columns
    stat_cols = ["HS", "AS", "HST", "AST", "HF", "AF", "HC", "AC", "HY", "AY", "HR", "AR"]
    for col in stat_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Cast odds columns
    for col in ODDS_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Add metadata
    df["season"] = season_code
    df["match_id"] = df.apply(
        lambda r: f"{r['Date'].strftime('%Y%m%d')}_{r['HomeTeam']}_{r['AwayTeam']}",
        axis=1,
    )

    # Sort by date
    df = df.sort_values("Date").reset_index(drop=True)

    return df


def load_all_seasons(seasons: Optional[list] = None, force: bool = False) -> pd.DataFrame:
    """
    Load and merge all seasons into a single DataFrame.

    Args:
        seasons: List of season codes, e.g. ["2324", "2425", "2526"]
        force: Force re-download

    Returns:
        Combined DataFrame sorted by date
    """
    if seasons is None:
        seasons = SEASONS

    frames = []
    for season in seasons:
        code = FOOTBALL_DATA_SEASONS.get(season, season)
        try:
            raw = fetch_season_csv(code, force=force)
            cleaned = clean_football_data(raw, season)
            frames.append(cleaned)
            logger.info(f"Season {season}: {len(cleaned)} matches loaded")
        except Exception as e:
            logger.error(f"Failed to load season {season}: {e}")

    if not frames:
        raise RuntimeError("No seasons loaded successfully")

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.sort_values("Date").reset_index(drop=True)

    logger.info(f"Total matches loaded: {len(combined)}")
    return combined


def market_columns() -> List[str]:
    """The price columns :func:`closing_market` reads — 1X2 and totals only."""
    columns: List[str] = []
    for spec in CLOSING_BOOKS.values():
        columns.extend(spec["h2h"])
        for pair in spec.get("totals", {}).values():
            columns.extend(pair)
    return columns


def closing_price_columns() -> List[str]:
    """Every raw CSV price column :data:`CLOSING_BOOKS` refers to, in order."""
    columns = list(market_columns())
    for spec in CLOSING_BOOKS.values():
        if spec.get("ah_line"):
            columns.append(spec["ah_line"])
        columns.extend(spec.get("ah", ()))
    # AHCh is shared between books in principle, so dedupe rather than assume.
    return list(dict.fromkeys(columns))


def parse_match_dates(raw: pd.Series) -> pd.Series:
    """
    Parse Football-Data.co.uk match dates, which are dd/mm/yy in some seasons and
    dd/mm/yyyy in others.

    Two explicit day-first formats rather than ``format="mixed"``: mixed infers
    per element, so on a corpus where "05/08/25" and "05/08/2025" both appear the
    inference can settle differently in different seasons and there is nothing in
    the output to show it did. Trying the four-digit form first and only the
    unparsed remainder as two-digit is deterministic, and either format is
    unambiguous once day-first is fixed.
    """
    if pd.api.types.is_datetime64_any_dtype(raw):
        return raw
    text = raw.astype("string").str.strip()
    parsed = pd.to_datetime(text, format="%d/%m/%Y", errors="coerce")
    short = parsed.isna() & text.notna()
    if short.any():
        parsed = parsed.fillna(
            pd.to_datetime(text.where(short), format="%d/%m/%y", errors="coerce")
        )
    return parsed


def shape_closing_odds(raw: pd.DataFrame, season: str) -> pd.DataFrame:
    """
    One raw season CSV to one closing-odds row per PLAYED match.

    Split out from :func:`load_closing_odds` so the shaping is testable without a
    fetch, and so a season whose CSV predates a book's coverage still produces a
    frame with the same columns (missing prices become NaN rather than missing
    keys, which is what lets seasons be concatenated).
    """
    frame = pd.DataFrame(index=raw.index)
    frame["season"] = season
    frame["date"] = parse_match_dates(raw["Date"])
    # Canonicalised here, not by the caller. Football-Data spells clubs
    # "Man United"/"Wolves" while every other provider spells them differently,
    # and a join on raw provider strings silently drops the disagreeing rows.
    frame["home_team"] = raw["HomeTeam"].apply(normalize_team_name)
    frame["away_team"] = raw["AwayTeam"].apply(normalize_team_name)
    frame["home_goals"] = pd.to_numeric(raw["FTHG"], errors="coerce")
    frame["away_goals"] = pd.to_numeric(raw["FTAG"], errors="coerce")

    for column in closing_price_columns():
        values = raw[column] if column in raw.columns else pd.Series(pd.NA, index=raw.index)
        values = pd.to_numeric(values, errors="coerce")
        if column != CLOSING_BOOKS["pinnacle"]["ah_line"]:
            # A decimal price at or below 1.0 is not a price. Nulling it here
            # means the "is this book usable" decision lives in exactly one place
            # (:func:`closing_market`) instead of being re-derived per consumer.
            values = values.where(values > 1.0)
        frame[column] = values

    # A row with no result cannot contribute to fitting a trust weight against
    # realised scorelines, which is the only thing this corpus is for.
    frame = frame.dropna(subset=["date", "home_goals", "away_goals"])
    frame["home_goals"] = frame["home_goals"].astype(int)
    frame["away_goals"] = frame["away_goals"].astype(int)
    frame["match_id"] = [
        f"{date.strftime('%Y%m%d')}_{home}_{away}"
        for date, home, away in zip(frame["date"], frame["home_team"], frame["away_team"])
    ]

    frame = frame[CLOSING_META_COLS + closing_price_columns()]
    return frame.sort_values("date").reset_index(drop=True)


def load_closing_odds(
    seasons: Optional[list] = None, force: bool = False
) -> pd.DataFrame:
    """
    Per-bookmaker CLOSING prices for every played match in the historical corpus.

    One row per match: canonical ``season``, ``date``, ``home_team``,
    ``away_team``, ``home_goals``, ``away_goals``, ``match_id``, plus the raw
    decimal prices under their original CSV names (see :data:`CLOSING_BOOKS`).
    Prices are left raw — de-vigging is :mod:`pipeline.models.devig`'s job, and
    doing it here would bake one method into the corpus.

    **Only single-book closing columns are read.** ``AvgH/AvgD/AvgA`` are averages
    ACROSS bookmakers and ``PSH/PSD/PSA`` are Pinnacle's PRE-match price; neither
    is one book's coherent view, so **neither may be de-vigged**. A cross-book
    average is close to a best-price vector: its implied probabilities carry no
    single margin to remove, and "normalising" it distorts every leg by an amount
    that moves with how many books happened to quote. ``extract_odds_benchmark``
    below reads exactly those columns, which is why it is dead code rather than a
    shortcut worth reusing.

    **Legitimacy boundary.** These prices exist to fit HOW MUCH TO TRUST a market
    covariate against realised scorelines — the ``market.blend_weight`` question —
    and nothing else. They must never reach the value-bet or Kelly path: an edge
    measured against a price using a rate derived from that same price is a
    readout of the price, and Kelly would then stake real money on a circularity.

    **A weight fitted here is an UPPER BOUND, not the weight to ship.** Closing
    lines contain confirmed team news — lineups, late fitness calls, weather —
    that our pre-deadline line cannot contain, so they are strictly more
    informative than the market we actually blend against. Fitting on them
    answers "how much would we trust a market that knew the teamsheets"; the live
    weight has to sit at or below that.
    """
    if seasons is None:
        seasons = SEASONS

    frames = []
    for season in seasons:
        code = FOOTBALL_DATA_SEASONS.get(season, season)
        # Deliberately NOT the log-and-continue of ``load_all_seasons``. A silently
        # dropped season changes the fitted trust weight without changing anything
        # a reader would notice, so a missing season has to stop the fit.
        raw = fetch_season_csv(code, force=force)
        shaped = shape_closing_odds(raw, season)
        logger.info(f"Season {season}: {len(shaped)} closing-odds rows")
        frames.append(shaped)

    combined = pd.concat(frames, ignore_index=True)
    return combined.sort_values("date").reset_index(drop=True)


def _closing_price(row, column: str) -> Optional[float]:
    """One usable decimal price, or None if this book did not post it."""
    value = row.get(column)
    if value is None or pd.isna(value):
        return None
    price = float(value)
    return price if price > 1.0 else None


def _assert_priced_row(row) -> None:
    """
    Refuse a row that is missing a price COLUMN, as opposed to a price.

    An absent column and a NaN price are indistinguishable to ``row.get``, so
    without this the failure is silent and looks like data: the book is skipped,
    ``invert_fixture`` reports ``absent``, and the corpus reads as "the market did
    not quote" rather than as a caller bug.

    It is not hypothetical. ``DataFrame.itertuples`` renames ``PC>2.5`` and
    ``B365C>2.5`` to positional ``_7``-style names because they are not valid
    Python identifiers — while leaving ``PSCH`` alone, so the row looks half
    right. Iterate with ``iterrows``, or pass a mapping carrying the full column
    set. :func:`shape_closing_odds` always emits all of them, NaN where a book
    did not post.
    """
    keys = set(getattr(row, "index", row))
    missing = [column for column in market_columns() if column not in keys]
    if missing:
        raise KeyError(
            f"row is missing closing price columns {missing}; a book that did not "
            f"post is expressed as NaN, not as an absent column. "
            f"DataFrame.itertuples renames columns like 'PC>2.5' — use iterrows."
        )


def closing_market(
    row,
) -> Tuple[Dict[str, Dict[str, float]], Dict[str, Dict[str, Dict[str, float]]]]:
    """
    One closing-odds row reshaped into what ``market_rates.invert_fixture`` takes.

    Returns ``(h2h_by_book, totals_by_book)``:

        {"pinnacle": {"home": 1.9, "draw": 3.6, "away": 4.2}, "bet365": {...}}
        {"pinnacle": {"2.5": {"over": 1.9, "under": 2.0}}, ...}

    ``row`` is one row of :func:`load_closing_odds` — a ``Series`` from
    ``iterrows``, or any mapping keyed by the raw CSV column names.

    Totals lines are keyed by the STRING of the line because that is what
    ``invert_fixture`` regroups on; a float key survives its ``float(line)`` call
    but would not survive a JSON round trip, and the two shapes must stay
    interchangeable.

    A book missing any leg of a market is omitted from that market rather than
    emitted with NaN. That is load-bearing, not tidiness: ``devig._check`` rejects
    a NaN price, so an emitted NaN would be *dropped* inside
    ``aggregate_books`` — the consensus would come back one book thinner with the
    reason buried in its ``dropped`` map, and Pinnacle is missing on 170 of 380
    2526 rows, so this is the common case rather than an edge one. The two markets
    are independent: a book can appear in ``totals_by_book`` and not in
    ``h2h_by_book``.

    The Asian-handicap columns are carried by :func:`load_closing_odds` but not
    emitted here, because ``invert_fixture`` has no handicap constraint. Folding
    a handicap price into a totals line to make it fit would be fabricating a
    market that was never posted.
    """
    _assert_priced_row(row)
    h2h: Dict[str, Dict[str, float]] = {}
    totals: Dict[str, Dict[str, Dict[str, float]]] = {}

    for book, spec in CLOSING_BOOKS.items():
        prices = {
            side: _closing_price(row, column)
            for side, column in zip(("home", "draw", "away"), spec["h2h"])
        }
        if all(price is not None for price in prices.values()):
            h2h[book] = prices

        for line, (over_column, under_column) in spec.get("totals", {}).items():
            over = _closing_price(row, over_column)
            under = _closing_price(row, under_column)
            if over is None or under is None:
                continue
            totals.setdefault(book, {})[str(line)] = {"over": over, "under": under}

    return h2h, totals


def extract_odds_benchmark(df: pd.DataFrame) -> pd.DataFrame:
    """
    DEAD CODE — no importer, and the columns it reads are the wrong ones.

    Kept because deleting it is a separate decision from noticing it is unused,
    and because it is a worked example of the mistake :func:`load_closing_odds`
    exists to avoid: it normalises ``AvgH/AvgD/AvgA`` (an average ACROSS
    bookmakers) and ``PSH/PSD/PSA`` (Pinnacle's PRE-match price) as if each were
    one book's closing book. Neither carries a single bookmaker's margin, so the
    ``/total`` below is not a de-vig — it rescales by an overround that is partly
    an artefact of how many books quoted. Use :func:`load_closing_odds` with
    :func:`closing_market`, which reads only the ``*C*`` single-book closing
    columns, and let :mod:`pipeline.models.devig` remove the margin.

    Extract bookmaker odds as benchmark (NOT for model training).
    Converts decimal odds to implied probabilities.
    """
    odds_df = df[["match_id", "Date", "HomeTeam", "AwayTeam"]].copy()

    # Pinnacle odds preferred, fallback to Bet365, then average
    for suffix, label in [("PS", "pinnacle"), ("B365", "bet365"), ("Avg", "market_avg")]:
        h_col, d_col, a_col = f"{suffix}H", f"{suffix}D", f"{suffix}A"
        if all(c in df.columns for c in [h_col, d_col, a_col]):
            total = 1 / df[h_col] + 1 / df[d_col] + 1 / df[a_col]
            odds_df[f"implied_home_{label}"] = (1 / df[h_col]) / total
            odds_df[f"implied_draw_{label}"] = (1 / df[d_col]) / total
            odds_df[f"implied_away_{label}"] = (1 / df[a_col]) / total
            odds_df[f"odds_home_{label}"] = df[h_col]
            odds_df[f"odds_draw_{label}"] = df[d_col]
            odds_df[f"odds_away_{label}"] = df[a_col]

    # Over/Under 2.5 if available
    if "Avg>2.5" in df.columns and "Avg<2.5" in df.columns:
        total_ou = 1 / df["Avg>2.5"] + 1 / df["Avg<2.5"]
        odds_df["implied_over25"] = (1 / df["Avg>2.5"]) / total_ou
        odds_df["implied_under25"] = (1 / df["Avg<2.5"]) / total_ou

    return odds_df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    df = load_all_seasons()
    print(f"\nLoaded {len(df)} matches")
    print(f"Columns: {list(df.columns)}")
    print(f"\nSample:\n{df.tail(3)}")

    # Closing-book coverage, per season and per book. This is how the margin
    # medians quoted on CLOSING_BOOKS were measured; re-run it after any season
    # rolls over, because a book dropping a market shows up here and nowhere else.
    closing = load_closing_odds()
    print(f"\nClosing-odds rows: {len(closing)}")
    for season, frame in closing.groupby("season"):
        counts = {book: 0 for book in CLOSING_BOOKS}
        for _, row in frame.iterrows():
            for book in closing_market(row)[0]:
                counts[book] += 1
        print(f"  {season}: {len(frame)} matches, 1X2 coverage {counts}")
