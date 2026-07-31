"""
Assemble simulator inputs from the live bootstrap and the committed archive.

The bridge between "data the pipeline already has" and "what the player
simulator needs". Three sources, each authoritative for something different:

* **live bootstrap** — identity, position, price, availability and set-piece
  duty. Always current, and the only source for a player's status today.
* **committed archive** — per-fixture history, which is what the minutes and
  rate models are fitted on. Never a source of position or availability.
* **committed pre-season priors** — a fallback start rate for players with no
  per-fixture history, and the GW1 purchase-price baseline.

Positions always come from the bootstrap. FPL reclassifies players between
seasons, and a stale position changes both the scoring rules applied and the
defensive-contribution counted set.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pandas as pd

from pipeline.data.team_mapping import normalize_team_name
from pipeline.fpl.rules import POSITIONS, Rules, load_rules, normalise_position
from pipeline.models.minutes import MinutesModel
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.player_sim import PlayerInput

logger = logging.getLogger(__name__)

# A prior-season aggregate is spread over a full campaign.
PRIOR_SEASON_FIXTURES = 38


@dataclass
class FplInputs:
    """Fitted models plus per-club squads, ready to simulate."""

    minutes_model: MinutesModel
    events: PlayerEventRates
    squads: Dict[str, List[PlayerInput]]
    all_element_ids: List[int]
    diagnostics: Dict[str, Any]


def _news_age_days(news_added: Optional[str], now: pd.Timestamp) -> Optional[float]:
    if not news_added:
        return None
    try:
        stamp = pd.Timestamp(news_added)
        if stamp.tzinfo is None:
            stamp = stamp.tz_localize("UTC")
        return float((now - stamp).total_seconds() / 86400.0)
    except (ValueError, TypeError):
        return None


def build_fpl_inputs(
    bootstrap: Dict[str, Any],
    archive: pd.DataFrame,
    priors: Optional[Dict[str, Any]] = None,
    rules: Optional[Rules] = None,
    key: str = "name_key",
    now: Optional[pd.Timestamp] = None,
) -> FplInputs:
    """
    Fit the player models and assemble one squad per club.

    ``archive`` must carry ``name_key`` and ``position_norm`` — see
    :func:`pipeline.learning.backfill.load_archive_season`.
    """
    rules = rules or load_rules(bootstrap)
    now = now or pd.Timestamp.now(tz="UTC")

    frame = archive.copy()
    if "position_norm" not in frame.columns:
        frame["position_norm"] = frame["position"].map(normalise_position)
    frame = frame[frame["position_norm"].notna()]

    minutes_model = MinutesModel().fit(
        frame, key=key, position_column="position_norm"
    )
    events = PlayerEventRates().fit(
        frame, key=key, position_column="position_norm", rules=rules
    )

    from pipeline.learning.backfill import _normalise_name

    prior_starts: Dict[str, float] = {}
    if priors:
        for player in priors.get("players", []):
            name = _normalise_name(
                f"{player.get('first_name', '')} {player.get('second_name', '')}"
            )
            starts = player.get("starts") or 0
            if name and starts:
                prior_starts[name] = min(1.0, starts / PRIOR_SEASON_FIXTURES)

    teams = {team["id"]: team for team in bootstrap.get("teams", [])}
    element_types = {
        et["id"]: et["singular_name_short"]
        for et in bootstrap.get("element_types", [])
    }

    squads: Dict[str, List[PlayerInput]] = {}
    all_element_ids: List[int] = []
    no_history = 0
    gated = 0

    for element in bootstrap.get("elements", []):
        position = normalise_position(element_types.get(element.get("element_type")))
        if position is None:
            continue

        raw_team = teams.get(element.get("team"), {}).get("name", "")
        team = normalize_team_name(raw_team) if raw_team else ""
        if not team:
            continue

        player_key = _normalise_name(
            f"{element.get('first_name', '')} {element.get('second_name', '')}"
        )
        has_history = player_key in minutes_model.by_player
        if not has_history:
            no_history += 1

        roles = minutes_model.predict(
            position=position,
            player_key=player_key,
            status=element.get("status", "a"),
            chance_of_playing=element.get("chance_of_playing_next_round"),
            news_age_days=_news_age_days(element.get("news_added"), now),
            fallback_start_rate=prior_starts.get(player_key),
        )
        if roles.gate_reason:
            gated += 1

        element_id = int(element["id"])
        all_element_ids.append(element_id)
        squads.setdefault(team, []).append(
            PlayerInput(
                element_id=element_id,
                position=position,
                roles=roles,
                rates=events.rates(position, player_key),
                penalty_order=element.get("penalties_order"),
                player_key=player_key,
            )
        )

    diagnostics = {
        "n_clubs": len(squads),
        "n_players": len(all_element_ids),
        "n_without_history": no_history,
        "n_availability_gated": gated,
        "n_with_prior_start_fallback": len(prior_starts),
        "archive_rows_fitted": int(len(frame)),
    }
    logger.info("FPL inputs assembled: %s", diagnostics)

    return FplInputs(
        minutes_model=minutes_model,
        events=events,
        squads=squads,
        all_element_ids=all_element_ids,
        diagnostics=diagnostics,
    )


def fixture_specs_from_predictions(
    predictions: Sequence[Dict[str, Any]], gameweek: int
) -> List[Any]:
    """
    Build fixture specs from the pipeline's own match predictions.

    ``expected_goals`` is the already-blended ensemble expectation, so this reuses
    the existing model rather than re-deriving goal rates — and it means the FPL
    layer hooks in without touching the Monte Carlo loop.
    """
    from pipeline.simulation.gameweek_sim import FixtureSpec

    specs = []
    for prediction in predictions:
        fixture = prediction.get("fixture", {})
        expected = prediction.get("expected_goals", {})
        home = normalize_team_name(fixture.get("home_team", ""))
        away = normalize_team_name(fixture.get("away_team", ""))
        if not home or not away:
            continue
        specs.append(
            FixtureSpec(
                match_id=str(prediction.get("match_id", f"{home}_{away}")),
                gameweek=int(fixture.get("gameweek") or gameweek),
                home_team=home,
                away_team=away,
                lambda_home=float(expected.get("home", 0.0) or 0.0),
                mu_away=float(expected.get("away", 0.0) or 0.0),
                kickoff=fixture.get("date"),
            )
        )
    return specs
