"""
Import settled per-gameweek player data from the community season archive.

What this buys
--------------
1. **A replay oracle.** ~29,757 rows of settled 2025-26 player data, each with
   ``total_points`` alongside every component stat. Since the 2026/27 points
   table is unchanged from 2025/26, ``score_player(row) == row.total_points``
   is testable on every one of those rows *before* a ball is kicked. That
   verifies the handful of scoring constants the API does not expose.
2. **Training data for the minutes and goal-share models**, which otherwise
   have a single pre-season aggregate per player and nothing else.
3. **Baselines.** The archive carries FPL's own per-gameweek ``xP``, so the
   "beat ``ep_next``" comparison is reproducible on historical gameweeks.

Boundaries
----------
This is a community mirror, not an official source. It is used for training
priors, baselines and test oracles only. It is **never** consulted in a live
decision path, and it is **never** a source of rules — rules come from the
official rules page and ``bootstrap-static``, signed in
``pipeline/knowledge/rules_2627.yaml``.

Joining across seasons
----------------------
The archive's ``element`` id is season-scoped and is reused for different
players in different seasons, so it must never be a cross-season join key.
Names are the only stable identifier the archive exposes. Players also change
club between seasons, so the team is a disambiguator for duplicate names, not
part of the key. Positions always come from the *current* bootstrap, never the
archive: FPL reclassifies players between seasons, and a stale position silently
corrupts both the scoring rules applied and the position priors fitted.
"""
import gzip
import logging
import unicodedata
from collections import defaultdict
from io import StringIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from pipeline.config import FPL_ARCHIVE_SEASONS, FPL_ARCHIVE_URL, PRIORS_DIR, SEASON_LABELS
from pipeline.data.team_mapping import normalize_team_name
from pipeline.utils import fetch_with_retry

logger = logging.getLogger(__name__)

# Columns required for the replay oracle. A season missing any of these cannot
# be used to verify the scoring function.
SCORING_COLUMNS = (
    "minutes",
    "goals_scored",
    "assists",
    "clean_sheets",
    "goals_conceded",
    "own_goals",
    "penalties_saved",
    "penalties_missed",
    "yellow_cards",
    "red_cards",
    "saves",
    "bonus",
    "total_points",
)

# Defensive-contribution columns. Absent before the mechanic existed, so a
# season lacking them supports the minutes and goal-share blocks only.
DEFCON_COLUMNS = (
    "clearances_blocks_interceptions",
    "recoveries",
    "tackles",
    "defensive_contribution",
)


def _normalise_name(name: str) -> str:
    """
    Fold a player name to a comparable key.

    Strips accents, punctuation and case, and collapses whitespace, so
    ``"Jérémy Doku"`` and ``"Jeremy Doku"`` agree.
    """
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(name))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    cleaned = "".join(c if c.isalnum() or c.isspace() else " " for c in stripped)
    return " ".join(cleaned.lower().split())


def archive_path(season: str, priors_dir: Optional[Path] = None) -> Path:
    """Local committed path for a season's archive extract."""
    priors_dir = Path(priors_dir) if priors_dir else PRIORS_DIR
    return priors_dir / f"merged_gw_{season}.csv.gz"


def fetch_archive_season(season: str) -> pd.DataFrame:
    """Download one season's merged gameweek data. Fails loudly."""
    label = SEASON_LABELS.get(season, season)
    url = FPL_ARCHIVE_URL.format(season_label=label)
    logger.info("Fetching season archive %s...", label)
    resp = fetch_with_retry(url, max_retries=3, timeout=120)
    frame = pd.read_csv(StringIO(resp.text))
    if frame.empty:
        raise ValueError(f"archive for {label} is empty")
    return frame


def store_archive_season(
    season: str, priors_dir: Optional[Path] = None, force: bool = False
) -> Path:
    """
    Download and commit one season's archive, gzipped.

    Idempotent: an existing extract is left alone unless ``force``, because the
    upstream file is mutable and a settled season should not silently change
    underneath a fitted parameter set.
    """
    path = archive_path(season, priors_dir)
    if path.exists() and not force:
        logger.info("%s already present — skipping.", path.name)
        return path

    frame = fetch_archive_season(season)
    missing = [c for c in SCORING_COLUMNS if c not in frame.columns]
    if missing:
        raise ValueError(
            f"archive for {season} lacks required scoring columns: {missing}"
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = frame.to_csv(index=False).encode("utf-8")
    path.write_bytes(gzip.compress(payload, compresslevel=9))

    has_defcon = all(c in frame.columns for c in DEFCON_COLUMNS)
    logger.info(
        "Stored %s: %d rows, GW %d-%d, defcon=%s (%.1f KB gzipped)",
        path.name,
        len(frame),
        int(frame["GW"].min()),
        int(frame["GW"].max()),
        has_defcon,
        path.stat().st_size / 1024,
    )
    return path


def load_archive_season(
    season: str, priors_dir: Optional[Path] = None
) -> pd.DataFrame:
    """Load a committed archive extract, canonicalising team names."""
    path = archive_path(season, priors_dir)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} does not exist. Run pipeline.learning.backfill to create it."
        )
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        frame = pd.read_csv(handle)

    frame["team_canonical"] = frame["team"].map(normalize_team_name)
    frame["name_key"] = frame["name"].map(_normalise_name)
    frame["season"] = season

    # Upstream occasionally emits a player-fixture row twice. (element, GW,
    # fixture) is the natural primary key: a double gameweek shares element and
    # GW but has DISTINCT fixtures, so this cannot drop a legitimate second
    # match.
    #
    # Silent and damaging if left. The rows are byte-identical, so the replay
    # oracle passes — it checks each row against itself — while every per-player
    # AGGREGATE double-counts. Measured on 2025-26: Junior Kroupi's season total
    # reads 140 instead of 113, a 24% overstatement, which flows straight into
    # the backtest's realised scoring and the event-rate fits.
    before = len(frame)
    frame = frame.drop_duplicates(subset=["element", "GW", "fixture"], keep="first")
    dropped = before - len(frame)
    if dropped:
        logger.warning(
            "%s: dropped %d duplicate player-fixture row(s); upstream emitted "
            "them twice and every per-player aggregate would double-count",
            season, dropped,
        )
    return frame.reset_index(drop=True)


def has_defcon(frame: pd.DataFrame) -> bool:
    """Whether a season's archive supports defensive-contribution fitting."""
    return all(column in frame.columns for column in DEFCON_COLUMNS)


def link_archive_to_priors(
    archive: pd.DataFrame, priors: Dict[str, Any]
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Attach current-season player identity to archive rows.

    Adds ``code``, ``element_id_current``, ``position_current`` and
    ``team_current``. Rows whose player is not in the current season keep NaN
    identity and are reported rather than dropped — a departed player's history
    is still valid training data for position-level priors.

    Match order: exact normalised full name, then ``web_name``. Duplicate names
    are disambiguated by canonical team, then left unmatched. Nothing is guessed.
    """
    by_full: Dict[str, List[dict]] = defaultdict(list)
    by_web: Dict[str, List[dict]] = defaultdict(list)
    for player in priors["players"]:
        full = _normalise_name(f"{player['first_name']} {player['second_name']}")
        by_full[full].append(player)
        by_web[_normalise_name(player["web_name"])].append(player)

    # NOTE: a `web_name`-token-containment stage used to live here, intended to
    # catch the archive's full registered names against FPL's short forms
    # ("Marc Cucurella Saseta" vs "Cucurella"). IT WAS REMOVED because it was
    # unsound in the containment direction it actually tested.
    #
    # The test was `web_tokens ⊆ archive_tokens`, so a single-token short name
    # matched ANY archive player whose registered name contained that token
    # anywhere — and `_disambiguate` accepted it whenever exactly one current
    # player carried that web_name, which is the normal case. Measured against
    # the committed archive: 41 of its 42 links were different people, including
    # "Lewis Dobbin" -> Rico Lewis, "Simon Moore" -> Mikey Moore, "John Stones"
    # -> John Victor (an outfielder's history onto a goalkeeper) and three
    # separate Gomeses collapsed onto one player.
    #
    # This function's own contract says a wrong link is worse than a missing one,
    # because it attributes one player's history to another. Deleting an unsound
    # heuristic is the correct fix; patching it into something subtler and still
    # wrong is not. The honest match rate is lower and is reported as such.

    def _disambiguate(
        candidates: List[dict], team_canonical: str
    ) -> Optional[dict]:
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            same_team = [c for c in candidates if c["team"] == team_canonical]
            if len(same_team) == 1:
                return same_team[0]
        # Ambiguous: refuse rather than pick arbitrarily. A wrong link is worse
        # than a missing one — it attributes one player's history to another.
        return None

    def resolve(name_key: str, team_canonical: str) -> Tuple[Optional[dict], str]:
        """Return (player, stage) using progressively looser matching."""
        match = _disambiguate(by_full.get(name_key, []), team_canonical)
        if match:
            return match, "full_name"

        match = _disambiguate(by_web.get(name_key, []), team_canonical)
        if match:
            return match, "web_name"

        tokens = name_key.split()
        if len(tokens) > 2:
            # "mateus goncalo espanha fernandes" -> "mateus fernandes"
            first_last = f"{tokens[0]} {tokens[-1]}"
            match = _disambiguate(by_full.get(first_last, []), team_canonical)
            if match:
                return match, "first_last"

        return None, "unmatched"

    unique_players = archive[["name_key", "team_canonical"]].drop_duplicates()
    resolved: Dict[Tuple[str, str], Optional[dict]] = {}
    stages: Dict[str, int] = defaultdict(int)
    for row in unique_players.itertuples():
        match, stage = resolve(row.name_key, row.team_canonical)
        resolved[(row.name_key, row.team_canonical)] = match
        stages[stage] += 1

    keys = list(zip(archive["name_key"], archive["team_canonical"]))
    archive = archive.copy()
    archive["code"] = [
        resolved[k]["code"] if resolved.get(k) else pd.NA for k in keys
    ]
    archive["element_id_current"] = [
        resolved[k]["element_id"] if resolved.get(k) else pd.NA for k in keys
    ]
    archive["position_current"] = [
        resolved[k]["position"] if resolved.get(k) else pd.NA for k in keys
    ]
    archive["team_current"] = [
        resolved[k]["team"] if resolved.get(k) else pd.NA for k in keys
    ]

    matched_players = sum(1 for v in resolved.values() if v)
    unmatched = sorted({k[0] for k, v in resolved.items() if not v})
    minutes_matched = int(archive.loc[archive["code"].notna(), "minutes"].sum())
    minutes_total = int(archive["minutes"].sum())

    # Split the unmatched by cause. A player from a relegated club is an
    # unfixable, expected miss; a player from a current club is a matching
    # defect and should be investigated, so the two must not be reported as one
    # number.
    current_teams = {player["team"] for player in priors["players"]}
    departed_club = sorted(
        {k[0] for k, v in resolved.items() if not v and k[1] not in current_teams}
    )
    current_club_unmatched = sorted(
        {k[0] for k, v in resolved.items() if not v and k[1] in current_teams}
    )
    unmatched_teams = sorted(
        {k[1] for k, v in resolved.items() if not v and k[1] not in current_teams}
    )

    report = {
        "n_rows": int(len(archive)),
        "n_rows_matched": int(archive["code"].notna().sum()),
        "n_archive_players": int(len(resolved)),
        "n_players_matched": matched_players,
        "player_match_rate": matched_players / max(1, len(resolved)),
        # The rate that actually matters: a departed squad regular carries far
        # more training signal than a departed academy substitute.
        "minutes_match_rate": minutes_matched / max(1, minutes_total),
        "match_stages": dict(stages),
        "unmatched_players": unmatched,
        "unmatched_departed_club": departed_club,
        "unmatched_current_club": current_club_unmatched,
        "departed_clubs": unmatched_teams,
    }

    logger.info(
        "Linked %d/%d archive players (%.1f%% of minutes). Stages: %s. "
        "Unmatched: %d from departed clubs %s (expected), %d from current "
        "clubs (investigate). Unmatched rows are retained for position priors.",
        matched_players,
        len(resolved),
        100 * report["minutes_match_rate"],
        dict(stages),
        len(departed_club),
        unmatched_teams,
        len(current_club_unmatched),
    )
    return archive, report


def backfill_all(
    seasons: Optional[List[str]] = None,
    priors_dir: Optional[Path] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Download and commit every configured archive season."""
    seasons = seasons or list(FPL_ARCHIVE_SEASONS)
    summary: Dict[str, Any] = {}
    for season in seasons:
        path = store_archive_season(season, priors_dir=priors_dir, force=force)
        frame = load_archive_season(season, priors_dir=priors_dir)
        summary[season] = {
            "path": str(path),
            "n_rows": int(len(frame)),
            "gameweeks": sorted(int(g) for g in frame["GW"].unique()),
            "has_defcon": has_defcon(frame),
            "n_players": int(frame["name_key"].nunique()),
        }
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.priors.snapshot import load_player_priors

    summary = backfill_all()
    for season, info in summary.items():
        print(
            f"{SEASON_LABELS.get(season, season)}: {info['n_rows']} rows, "
            f"GW {min(info['gameweeks'])}-{max(info['gameweeks'])}, "
            f"{info['n_players']} players, defcon={info['has_defcon']}"
        )

    priors = load_player_priors()
    for season in summary:
        frame = load_archive_season(season)
        _, report = link_archive_to_priors(frame, priors)
        print(
            f"{SEASON_LABELS.get(season, season)} link: "
            f"{report['n_players_matched']}/{report['n_archive_players']} players "
            f"({100 * report['player_match_rate']:.1f}%), "
            f"{100 * report['minutes_match_rate']:.1f}% of minutes matched"
        )
