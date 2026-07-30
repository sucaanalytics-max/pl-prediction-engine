"""
Replay oracle: verify the scoring function against settled real gameweeks.

The 2026/27 points table is unchanged from 2025/26 — only the Bonus Points
System was rebalanced, and bonus arrives already settled, so it cannot affect
reproduction of ``total_points``. That makes the committed prior-season archive a
complete oracle: for every settled player-gameweek, ``score_player`` must return
exactly the points FPL awarded.

This is the only independent check on the six constants the API does not
expose — the ``saves ÷ 3`` and ``goals conceded ÷ 2`` divisors, the 60-minute
threshold, and the two Defensive Contribution thresholds with their
position-dependent counted sets. ``verify_against_bootstrap`` cannot reach them.

It also runs today, pre-season, on tens of thousands of rows. No waiting for GW1.
"""
from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from pipeline.fpl.rules import (
    POSITIONS,
    Rules,
    is_retired_position,
    load_rules,
    normalise_position,
)
from pipeline.fpl.scoring import defcon_count, score_from_row

logger = logging.getLogger(__name__)


@dataclass
class ReplayReport:
    """Outcome of replaying one season."""

    season: str
    n_rows: int = 0
    n_exact: int = 0
    n_scoreable: int = 0
    mismatches: List[Dict[str, Any]] = field(default_factory=list)
    causes: Counter = field(default_factory=Counter)
    # Independent check of the position-dependent DC counted set against the
    # archive's own precomputed action count.
    defcon_rows_checked: int = 0
    defcon_rows_agreeing: int = 0
    # Rows from a season whose position no longer has scoring rules (the
    # 2024/25 Assistant Manager). Excluded by design, reported so the exclusion
    # is visible rather than silent.
    n_retired_position: int = 0

    @property
    def exact_rate(self) -> float:
        return self.n_exact / max(1, self.n_scoreable)

    @property
    def defcon_agreement_rate(self) -> float:
        return self.defcon_rows_agreeing / max(1, self.defcon_rows_checked)

    def summary(self) -> str:
        return (
            f"{self.season}: {self.n_exact}/{self.n_scoreable} exact "
            f"({100 * self.exact_rate:.3f}%), "
            f"{len(self.mismatches)} mismatches; "
            f"DC action-count agreement "
            f"{100 * self.defcon_agreement_rate:.3f}% "
            f"of {self.defcon_rows_checked} rows"
            + (
                f"; {self.n_retired_position} rows excluded (retired position)"
                if self.n_retired_position
                else ""
            )
        )


def _classify(delta: int, row: Dict[str, Any]) -> str:
    """Attribute a mismatch to a named cause rather than leaving it unexplained."""
    red = int(float(row.get("red_cards") or 0))
    yellow = int(float(row.get("yellow_cards") or 0))
    minutes = int(float(row.get("minutes") or 0))
    saves = int(float(row.get("saves") or 0))
    conceded = int(float(row.get("goals_conceded") or 0))

    if red and yellow and abs(delta) == 1:
        return "second_yellow_card_encoding"
    if red:
        return "red_card_other"
    if minutes == 0 and delta != 0:
        return "points_without_minutes"
    if saves and abs(delta) <= 2:
        return "saves_divisor"
    if conceded and abs(delta) <= 2:
        return "concession_divisor"
    if abs(delta) == 2:
        return "defensive_contribution"
    return f"unexplained_delta_{delta:+d}"


def replay_season(
    season: str = "2526",
    rules: Optional[Rules] = None,
    priors_dir: Optional[Path] = None,
    max_mismatch_examples: int = 200,
) -> ReplayReport:
    """
    Score every settled row of a season and compare with ``total_points``.

    Positions come from the archive, i.e. the classification FPL applied at the
    time. Using current positions here would produce spurious mismatches for
    reclassified players and hide real defects.
    """
    from pipeline.learning.backfill import has_defcon, load_archive_season

    rules = rules or load_rules()
    frame = load_archive_season(season, priors_dir=priors_dir)
    report = ReplayReport(season=season, n_rows=len(frame))

    season_has_defcon = has_defcon(frame)
    if not season_has_defcon:
        logger.info(
            "%s predates defensive contribution; scoring without it.", season
        )

    records = frame.to_dict("records")
    for row in records:
        raw_position = row.get("position")
        position = normalise_position(raw_position)
        if position is None:
            # Not scoreable. Counting it as a pass would inflate the rate, and
            # conflating a retired position with an unrecognised label would
            # hide a real vocabulary change behind an expected exclusion.
            if is_retired_position(raw_position):
                report.n_retired_position += 1
            else:
                report.causes[f"unknown_position_{raw_position}"] += 1
            continue

        if not season_has_defcon:
            # Blank the components so the DC term is structurally zero rather
            # than silently reading absent columns as 0 and looking correct.
            row = {
                **row,
                "clearances_blocks_interceptions": 0,
                "tackles": 0,
                "recoveries": 0,
            }

        report.n_scoreable += 1
        expected = int(float(row.get("total_points") or 0))
        actual = score_from_row(row, position, rules=rules).total

        if actual == expected:
            report.n_exact += 1
        else:
            delta = actual - expected
            cause = _classify(delta, row)
            report.causes[cause] += 1
            if len(report.mismatches) < max_mismatch_examples:
                report.mismatches.append(
                    {
                        "name": row.get("name"),
                        "position": position,
                        "gameweek": row.get("GW"),
                        "expected": expected,
                        "actual": actual,
                        "delta": delta,
                        "cause": cause,
                        "minutes": row.get("minutes"),
                        "goals_scored": row.get("goals_scored"),
                        "assists": row.get("assists"),
                        "goals_conceded": row.get("goals_conceded"),
                        "saves": row.get("saves"),
                        "yellow_cards": row.get("yellow_cards"),
                        "red_cards": row.get("red_cards"),
                        "own_goals": row.get("own_goals"),
                        "bonus": row.get("bonus"),
                    }
                )

        # Cross-check our understanding of the counted action set against the
        # archive's own precomputed count. This is independent of total_points.
        if season_has_defcon:
            archive_count = row.get("defensive_contribution")
            if archive_count is not None and str(archive_count) != "":
                report.defcon_rows_checked += 1
                recomputed = defcon_count(
                    position,
                    int(float(row.get("clearances_blocks_interceptions") or 0)),
                    int(float(row.get("tackles") or 0)),
                    int(float(row.get("recoveries") or 0)),
                    rules,
                )
                if recomputed == int(float(archive_count)):
                    report.defcon_rows_agreeing += 1

    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    for season in ("2526", "2425"):
        result = replay_season(season)
        print(result.summary())
        if result.causes:
            print("  causes:")
            for cause, count in result.causes.most_common():
                print(f"    {count:6d}  {cause}")
        for example in result.mismatches[:5]:
            print(f"    e.g. {example}")
