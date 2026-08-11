"""
Walk-forward projection over a completed season, for calibration.

Every tail claim the weekly objective makes — ``p_ge_10`` above all — is only
worth what the measurement behind it is worth, and the measurements so far were
not worth much. Two flaws, both of which this module exists to remove:

**Universe mismatch.** Projecting 2025-26 gameweeks from the 2026-27 pre-season
bootstrap matched barely half the player rows, because clubs are promoted,
players are sold and element ids are re-issued every season. Half a universe
produces a number, and the number is meaningless. Here the universe is built
from the season's OWN archive rows, so a player is projected if and only if he
was actually in a squad that gameweek.

**Leakage.** The obvious way to fit team strengths is on the whole archive,
which includes the gameweek being predicted and every gameweek after it. That
makes the defence ratings partly a readout of the results being forecast. Here
everything — minutes, event rates, team strengths — is fitted on data STRICTLY
before the target gameweek, refitted for each one.

The cost of doing it properly is that the model is weakest exactly where the
archive is thinnest, early in the season. That is honest rather than
unfortunate: it is the same position the agent is in during a real August.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from pipeline.fpl.rules import POSITIONS, Rules, load_rules, normalise_position

logger = logging.getLogger(__name__)

# Gameweeks before this are excluded by default. A projection built on one or
# two rounds of a new season is dominated by its priors, so including them
# measures the prior rather than the model.
DEFAULT_MIN_GAMEWEEK = 8

# FPL element_type codes, in the order rules.POSITIONS uses.
ELEMENT_TYPE_IDS = {"GKP": 1, "DEF": 2, "MID": 3, "FWD": 4}


@dataclass
class WalkForwardResult:
    """Forecasts and realised outcomes, aligned, across the evaluated weeks."""

    forecasts: List[Dict[str, Any]] = field(default_factory=list)
    actuals: List[float] = field(default_factory=list)
    gameweeks: List[int] = field(default_factory=list)
    n_unmatched: int = 0
    rate_source: str = ""

    @property
    def coverage(self) -> float:
        """
        Share of realised player-gameweeks the projection actually covered.

        The number that made the previous attempt worthless: at 0.48 the report
        describes a different population from the one it claims to.
        """
        total = len(self.actuals) + self.n_unmatched
        return len(self.actuals) / total if total else 0.0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n": len(self.actuals),
            "gameweeks": sorted(set(self.gameweeks)),
            "coverage": round(self.coverage, 4),
            "n_unmatched": self.n_unmatched,
            "rate_source": self.rate_source,
        }


def synthetic_bootstrap(archive: pd.DataFrame, gameweek: int) -> Dict[str, Any]:
    """
    Build a bootstrap-shaped payload from the archive's own rows.

    A real season's contemporaneous ``bootstrap-static`` is not archived, so it
    is reconstructed from what the archive does record: who was in a squad that
    gameweek, at what position, for what club and price.

    Prices come from the target gameweek because that is what the manager would
    have faced; everything used to FIT anything comes from earlier weeks only.
    Taking a price from the future would be leakage in the transfer decision,
    but this harness never makes a transfer decision — it measures projections.
    """
    if archive[archive["GW"] == gameweek].empty:
        raise ValueError(f"no archive rows for GW{gameweek}")

    # The universe is everyone active in the season up to and including this
    # gameweek, NOT only those with a row in it. A player whose club has a blank
    # gameweek has no row, and restricting to rows would delete him from the
    # game entirely — a squad holding him would shrink below fifteen and, on an
    # empty bank, become genuinely unsolvable. Real FPL lists every player
    # whether or not his team plays; he simply scores nothing.
    #
    # Prices come from his most recent appearance on or before this gameweek,
    # which is the last price actually observed.
    history = archive[archive["GW"] <= gameweek].sort_values("GW")
    rows = history.drop_duplicates(subset=["element"], keep="last")

    teams = sorted(archive["team_canonical"].dropna().unique())
    team_ids = {name: i + 1 for i, name in enumerate(teams)}

    elements = []
    for row in rows.itertuples():
        position = normalise_position(row.position)
        if position not in ELEMENT_TYPE_IDS:
            continue
        elements.append(
            {
                "id": int(row.element),
                "element_type": ELEMENT_TYPE_IDS[position],
                "team": team_ids.get(row.team_canonical, 1),
                "now_cost": int(row.value),
                "status": "a",
                "web_name": str(getattr(row, "name", row.element)),
                "first_name": "",
                "second_name": str(getattr(row, "name", row.element)),
                "chance_of_playing_next_round": None,
            }
        )

    return {
        "elements": elements,
        "teams": [{"id": i, "name": n, "short_name": n[:3].upper()}
                  for n, i in team_ids.items()],
        "element_types": [
            {"id": i, "singular_name_short": p} for p, i in ELEMENT_TYPE_IDS.items()
        ],
        "events": [],
        "game_settings": {},
    }


def fixture_specs(
    archive: pd.DataFrame, gameweek: int, strengths: Optional[Any] = None
) -> List[Any]:
    """
    Fixtures actually played in ``gameweek``, with goal rates attached.

    ``strengths`` must have been fitted on data before ``gameweek``. Passing one
    fitted on the whole archive would make the defence ratings a partial readout
    of the very results being forecast.
    """
    from pipeline.models.fixture_rates import FixtureRates
    from pipeline.simulation.gameweek_sim import FixtureSpec

    specs = []
    for fixture_id, group in archive[archive["GW"] == gameweek].groupby("fixture"):
        sides = group.drop_duplicates(subset=["team_canonical"])
        home = sides.loc[sides["was_home"] == True, "team_canonical"]  # noqa: E712
        away = sides.loc[sides["was_home"] == False, "team_canonical"]  # noqa: E712
        if len(home) != 1 or len(away) != 1:
            # A fixture with one side missing cannot be simulated jointly, and
            # simulating it with a synthetic opponent would invent a clean sheet.
            continue
        h, a = home.iloc[0], away.iloc[0]
        rates = (
            strengths.rates(h, a)
            if strengths is not None and getattr(strengths, "fitted", False)
            else FixtureRates(h, a, 1.45, 1.20, "flat_default")
        )
        specs.append(
            FixtureSpec(
                match_id=str(fixture_id), gameweek=int(gameweek),
                home_team=h, away_team=a,
                lambda_home=rates.lambda_home, mu_away=rates.mu_away,
            )
        )
    return specs


def project_gameweek(
    archive: pd.DataFrame,
    gameweek: int,
    rules: Optional[Rules] = None,
    n_draws: int = 3000,
    use_fitted_rates: bool = True,
    seed_entropy: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], List[float], int]:
    """
    Project one gameweek from data strictly before it, and pair with outcomes.

    Returns ``(forecast_rows, realised_points, n_unmatched)``.
    """
    from pipeline.models.fixture_rates import TeamStrengths
    from pipeline.models.fpl_inputs import build_fpl_inputs
    from pipeline.simulation.gameweek_sim import simulate_gameweek

    rules = rules or load_rules()
    train = archive[archive["GW"] < gameweek]
    if train.empty:
        raise ValueError(f"no training data before GW{gameweek}")

    strengths = None
    if use_fitted_rates:
        try:
            # Fitted on the PAST only. This is the leakage guard.
            strengths = TeamStrengths().fit(train)
        except ValueError as exc:
            logger.warning("GW%s: strengths unfittable (%s); using flat rates", gameweek, exc)

    bootstrap = synthetic_bootstrap(archive, gameweek)
    inputs = build_fpl_inputs(bootstrap, train, None, rules)
    specs = fixture_specs(archive, gameweek, strengths)
    if not specs:
        return [], [], 0

    draws = simulate_gameweek(
        specs, inputs.squads, inputs.events, rules, n_draws=n_draws,
        seed_entropy=gameweek if seed_entropy is None else seed_entropy,
        all_element_ids=inputs.all_element_ids,
    )

    realised = (
        archive[archive["GW"] == gameweek]
        .groupby("element")["total_points"].sum().to_dict()
    )
    forecasts: List[Dict[str, Any]] = []
    actuals: List[float] = []
    matched = set()
    for row in draws.summary_rows():
        element_id = int(row["element_id"])
        if row.get("blank") or element_id not in realised:
            continue
        forecasts.append(row)
        actuals.append(float(realised[element_id]))
        matched.add(element_id)

    # Anyone who really played but was not projected. Silently dropping them
    # would let the report describe a different population from the one it names.
    unmatched = sum(
        1 for e, p in realised.items()
        if e not in matched and archive[(archive.GW == gameweek) & (archive.element == e)]["minutes"].max() >= 1
    )
    return forecasts, actuals, unmatched


def walk_forward(
    archive: pd.DataFrame,
    gameweeks: Optional[Sequence[int]] = None,
    rules: Optional[Rules] = None,
    n_draws: int = 3000,
    use_fitted_rates: bool = True,
    min_gameweek: int = DEFAULT_MIN_GAMEWEEK,
) -> WalkForwardResult:
    """
    Project every requested gameweek from its own past and pool the results.

    Pooling across gameweeks is what makes the tail measurable at all: a single
    round has too few high scores to estimate P(>=10) to any useful precision.
    """
    rules = rules or load_rules()
    if gameweeks is None:
        available = sorted(int(g) for g in archive["GW"].dropna().unique())
        gameweeks = [g for g in available if g >= min_gameweek]

    result = WalkForwardResult(
        rate_source="archive_team_strengths" if use_fitted_rates else "flat_default"
    )
    for gameweek in gameweeks:
        try:
            forecasts, actuals, unmatched = project_gameweek(
                archive, gameweek, rules, n_draws, use_fitted_rates
            )
        except ValueError as exc:
            logger.warning("GW%s skipped: %s", gameweek, exc)
            continue
        if not forecasts:
            continue
        result.forecasts.extend(forecasts)
        result.actuals.extend(actuals)
        result.gameweeks.extend([gameweek] * len(actuals))
        result.n_unmatched += unmatched

    logger.info(
        "walk-forward over %d gameweeks: %d player-weeks, coverage %.3f, rates %s",
        len(set(result.gameweeks)), len(result.actuals), result.coverage,
        result.rate_source,
    )
    return result
