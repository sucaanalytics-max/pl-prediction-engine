"""
Per-fixture goal rates: how many goals each side is expected to score.

Why this exists, concretely. The first end-to-end scoring run measured clean
sheets at 0.066 predicted against 0.120 actual — under-predicted by nearly half —
and goals slightly over-predicted. Both errors point the same way and both trace
to the same cause: the agent was using a flat 1.55/1.20 for every fixture, so a
match against a promoted side and a match against the champions produced
identical clean-sheet probabilities.

Two sources, in order of preference:

1. **The Dixon-Coles posterior**, exported by the daily pipeline as
   ``predictions/fixture_xg.json``. The pipeline already fits it; it was simply
   never queried beyond the current matchweek. This is the right answer and is
   what the horizon will use.

2. **Archive-derived team strengths**, computed here. A fallback, not a rival:
   attack and defence multipliers from settled results, shrunk toward the league
   mean. Strictly better than a constant because it distinguishes opponents, and
   it works today without waiting for a pipeline run.

The fallback is deliberately simple and its provenance travels with the output,
so nothing downstream can mistake it for the posterior.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Pseudo-matches of shrinkage toward the league mean. A club with three results
# should not be credited with an extreme attack rating.
STRENGTH_SHRINKAGE = 6.0

# Home advantage as a multiplicative split of the league's mean goals. Derived
# from the archive at fit time; this is only the fallback if that fails.
DEFAULT_HOME_SHARE = 0.55


@dataclass(frozen=True)
class FixtureRates:
    """Expected goals for one fixture, with its provenance attached."""

    home_team: str
    away_team: str
    lambda_home: float
    mu_away: float
    source: str

    def as_tuple(self) -> Tuple[float, float]:
        return self.lambda_home, self.mu_away


class TeamStrengths:
    """
    Attack and defence multipliers per club, from settled results.

    A deliberately transparent model: each club has an attack multiplier and a
    defence multiplier relative to the league mean, and a fixture's rate is
    ``league_mean x home_attack x away_defence``, split by home advantage. It is
    a fallback for when the Dixon-Coles posterior is unavailable, so being
    interpretable and hard to get wrong matters more than being the last word.
    """

    def __init__(self) -> None:
        self.attack: Dict[str, float] = {}
        self.defence: Dict[str, float] = {}
        self.league_mean_goals: float = 1.4
        self.home_share: float = DEFAULT_HOME_SHARE
        self.fitted = False

    def fit(self, archive: pd.DataFrame) -> "TeamStrengths":
        """
        Fit from per-player archive rows by aggregating to team-fixture level.

        The archive is player-level, so team goals are recovered from
        ``team_h_score`` / ``team_a_score`` on the fixture rows rather than by
        summing player goals — summing would miss own goals and double-count
        nothing, but the scoreline is the direct observation and is exact.
        """
        required = {"fixture", "team_canonical", "was_home", "team_h_score", "team_a_score"}
        missing = required - set(archive.columns)
        if missing:
            raise ValueError(f"archive lacks columns needed for strengths: {sorted(missing)}")

        rows = archive[list(required)].drop_duplicates(subset=["fixture", "team_canonical"])
        rows = rows.dropna(subset=["team_h_score", "team_a_score"])
        if rows.empty:
            raise ValueError("no settled fixtures in the archive")

        scored, conceded = [], []
        for row in rows.itertuples():
            home = bool(row.was_home)
            scored.append(
                {
                    "team": row.team_canonical,
                    "goals_for": float(row.team_h_score if home else row.team_a_score),
                    "goals_against": float(row.team_a_score if home else row.team_h_score),
                    "home": home,
                }
            )
        frame = pd.DataFrame(scored)

        self.league_mean_goals = float(frame["goals_for"].mean())
        home_goals = frame.loc[frame["home"], "goals_for"].mean()
        away_goals = frame.loc[~frame["home"], "goals_for"].mean()
        total = home_goals + away_goals
        self.home_share = (
            float(home_goals / total) if total > 0 else DEFAULT_HOME_SHARE
        )

        mean = max(self.league_mean_goals, 1e-6)
        for team, group in frame.groupby("team"):
            n = float(len(group))
            # Shrunk toward 1.0, which is "exactly average".
            self.attack[team] = float(
                (group["goals_for"].sum() + STRENGTH_SHRINKAGE * mean)
                / ((n + STRENGTH_SHRINKAGE) * mean)
            )
            self.defence[team] = float(
                (group["goals_against"].sum() + STRENGTH_SHRINKAGE * mean)
                / ((n + STRENGTH_SHRINKAGE) * mean)
            )

        self.fitted = True
        logger.info(
            "team strengths fitted on %d team-fixtures: league mean %.3f goals, "
            "home share %.3f, attack range %.2f-%.2f",
            len(frame),
            self.league_mean_goals,
            self.home_share,
            min(self.attack.values()),
            max(self.attack.values()),
        )
        return self

    def rates(self, home_team: str, away_team: str) -> FixtureRates:
        """Expected goals for a fixture. Unknown clubs fall back to average."""
        total = self.league_mean_goals * 2.0
        home_base = total * self.home_share
        away_base = total * (1.0 - self.home_share)

        lambda_home = home_base * self.attack.get(home_team, 1.0) * self.defence.get(
            away_team, 1.0
        )
        mu_away = away_base * self.attack.get(away_team, 1.0) * self.defence.get(
            home_team, 1.0
        )
        return FixtureRates(
            home_team=home_team,
            away_team=away_team,
            # Clipped to a plausible band. An unshrunk product of two extreme
            # multipliers can otherwise produce a rate no PL fixture has ever had.
            lambda_home=float(np.clip(lambda_home, 0.2, 4.0)),
            mu_away=float(np.clip(mu_away, 0.2, 4.0)),
            source="archive_team_strengths",
        )


def export_fixture_xg(
    dc_model: Any,
    bootstrap: Dict[str, Any],
    fixtures_raw: List[Dict[str, Any]],
    predictions_dir: Path,
    horizon: int = 6,
    n_samples: int = 2000,
) -> Optional[Path]:
    """
    Export per-fixture goal rates across the horizon, from the Dixon-Coles posterior.

    The posterior yields lambda/mu for ANY pair of clubs at any future date — it
    was simply never queried beyond the current matchweek, which is why the FPL
    layer had to fall back to a flat rate for every fixture. Querying it for the
    next ``horizon`` gameweeks is the whole change; nothing about how the model is
    fitted moves.

    Purely additive by design. This writes a NEW file and touches no existing
    artifact, so ``latest.json`` is unchanged — a property worth preserving,
    because it is what lets the horizon land without any risk to the staking path.

    Returns ``None`` rather than raising when the model is unavailable: the
    consumer already falls back to archive-derived strengths and records that
    provenance per fixture, so a missing export degrades the FPL layer visibly
    instead of failing the daily prediction run that funds everything else.
    """
    from pipeline.data.team_mapping import normalize_team_name
    from pipeline.fpl.artifacts import write_json_atomically

    if dc_model is None or getattr(dc_model, "trace", None) is None:
        logger.warning("no fitted Dixon-Coles model; skipping fixture_xg export")
        return None

    events = [e for e in bootstrap.get("events", []) if not e.get("finished")]
    if not events:
        logger.info("no unfinished gameweeks; skipping fixture_xg export")
        return None
    first = min(int(e["id"]) for e in events)
    wanted = set(range(first, first + horizon))

    teams = {
        int(t["id"]): normalize_team_name(t.get("name", ""))
        for t in bootstrap.get("teams", [])
    }

    rows: List[Dict[str, Any]] = []
    unknown: set = set()
    for fixture in fixtures_raw:
        event = fixture.get("event")
        if event is None or int(event) not in wanted or fixture.get("finished"):
            continue
        home = teams.get(fixture.get("team_h"), "")
        away = teams.get(fixture.get("team_a"), "")
        if not home or not away:
            continue

        # Clubs the posterior has never seen fall back to its league-average
        # prior rather than being dropped. Recorded so a promoted side's fixtures
        # are identifiable downstream as prior-only rather than evidence-backed.
        for club in (home, away):
            if club not in getattr(dc_model, "team_index", {}):
                unknown.add(club)

        try:
            lam, mu = dc_model.get_lambda_mu_samples(home, away, n_samples)
        except Exception as exc:
            logger.warning("posterior query failed for %s v %s: %s", home, away, exc)
            continue

        rows.append(
            {
                "match_id": str(fixture.get("id", f"{home}_{away}")),
                "gameweek": int(event),
                "home_team": home,
                "away_team": away,
                "lambda_home": float(np.mean(lam)),
                "mu_away": float(np.mean(mu)),
                "kickoff": fixture.get("kickoff_time"),
                "prior_only": home in unknown or away in unknown,
            }
        )

    if not rows:
        logger.info("no horizon fixtures to export")
        return None

    payload = {
        "source": "dixon_coles_posterior",
        "horizon": int(horizon),
        "first_gameweek": first,
        "n_fixtures": len(rows),
        "prior_only_clubs": sorted(unknown),
        "fixtures": rows,
    }
    path = write_json_atomically(payload, Path(predictions_dir) / "fixture_xg.json")
    logger.info(
        "exported %d fixture rates across GW%d-%d%s",
        len(rows), first, first + horizon - 1,
        f" ({len(unknown)} prior-only clubs)" if unknown else "",
    )
    return path


def load_exported_rates(path: Path) -> Dict[str, FixtureRates]:
    """
    Load ``fixture_xg.json`` as written by the daily pipeline.

    Keyed by match id. Returns empty rather than raising when absent: the export
    is an optimisation, and the fallback is a correct if coarser answer.
    """
    path = Path(path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("could not read %s: %s", path, exc)
        return {}

    rates: Dict[str, FixtureRates] = {}
    for row in payload.get("fixtures", []):
        match_id = str(row.get("match_id", ""))
        if not match_id:
            continue
        rates[match_id] = FixtureRates(
            home_team=row.get("home_team", ""),
            away_team=row.get("away_team", ""),
            lambda_home=float(row.get("lambda_home", 0.0)),
            mu_away=float(row.get("mu_away", 0.0)),
            source=payload.get("source", "dixon_coles_posterior"),
        )
    logger.info("loaded %d exported fixture rates from %s", len(rates), path.name)
    return rates


def resolve_rates(
    match_id: str,
    home_team: str,
    away_team: str,
    exported: Optional[Dict[str, FixtureRates]] = None,
    strengths: Optional[TeamStrengths] = None,
) -> FixtureRates:
    """
    Best available rates for a fixture, preferring the exported posterior.

    Provenance is carried on the result so the artifact records which source was
    used per fixture — a horizon that silently mixes posterior and fallback rates
    would be impossible to calibrate.
    """
    if exported:
        found = exported.get(match_id)
        if found and found.lambda_home > 0 and found.mu_away > 0:
            return found

    if strengths is not None and strengths.fitted:
        return strengths.rates(home_team, away_team)

    # Last resort. Recorded as such so it is never mistaken for a model output.
    return FixtureRates(
        home_team=home_team,
        away_team=away_team,
        lambda_home=1.45,
        mu_away=1.20,
        source="flat_default",
    )
