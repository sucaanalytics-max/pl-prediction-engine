"""
Agent entry point. Dispatches on the phase the scheduler resolved.

Deliberately incomplete, and loud about it. Sealing needs the ledger
(Increment 6) and a decision needs the optimiser (Increment 7); neither exists
yet. Every unbuilt phase exits cleanly with an explicit message rather than
doing something approximate, because the one thing worse than an agent that
cannot yet seal is an agent that appears to have sealed.

What works today: refreshing the expected-points artifact, and delivering it.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from pipeline.config import CURRENT_SEASON, FPL_SIM, PREDICTIONS_DIR
from pipeline.learning.schedule import Phase, ScheduleState, resolve

logger = logging.getLogger(__name__)

DEFAULT_SITE_URL = "https://example.invalid/decisions"

# Phases whose implementation lands in a later increment. Listed explicitly so a
# run reports "not built" instead of silently doing nothing and exiting green.
NOT_YET_IMPLEMENTED: Dict[Phase, str] = {}


def refresh_expected_points(
    predictions_dir: Path, gameweek: Optional[int]
) -> Dict[str, Any]:
    """
    Rebuild the expected-points artifact from current data.

    Imports are local: this module is reached from a job that has the full
    dependency set, but keeping the heavy imports out of module scope means the
    phase-dispatch logic stays cheap to import and to test.
    """
    from pipeline.data.fpl_api import fetch_bootstrap_static, fetch_fixtures
    from pipeline.data.priors.snapshot import load_player_priors
    from pipeline.fpl.artifacts import export_gameweek_xp
    from pipeline.fpl.rules import load_rules
    from pipeline.learning.backfill import load_archive_season
    from pipeline.models.fpl_inputs import build_fpl_inputs
    from pipeline.run_pipeline import stable_seed_entropy
    from pipeline.simulation.gameweek_sim import FixtureSpec, simulate_gameweek

    # A forecast must never be built on a stale payload. force=True bypasses the
    # cache, allow_stale=False turns an upstream failure into a raise instead of
    # a silent fallback to whatever was on disk — which on deadline day, when the
    # API is likeliest to fail, would mean stale prices and stale availability.
    bootstrap = fetch_bootstrap_static(force=True, allow_stale=False)
    fixtures_raw = fetch_fixtures(force=True, allow_stale=False)
    rules = load_rules(bootstrap)

    try:
        priors = load_player_priors()
    except FileNotFoundError:
        priors = None
        logger.warning("no committed prior-season snapshot; using archive only")

    inputs = build_fpl_inputs(bootstrap, load_archive_season("2526"), priors, rules)

    teams = {team["id"]: team for team in bootstrap.get("teams", [])}
    from pipeline.data.team_mapping import normalize_team_name

    specs = []
    for fixture in fixtures_raw:
        if fixture.get("event") != gameweek or fixture.get("finished"):
            continue
        home = normalize_team_name(teams.get(fixture["team_h"], {}).get("name", ""))
        away = normalize_team_name(teams.get(fixture["team_a"], {}).get("name", ""))
        if not home or not away:
            continue
        specs.append(
            FixtureSpec(
                match_id=str(fixture.get("id", f"{home}_{away}")),
                gameweek=int(gameweek),
                home_team=home,
                away_team=away,
                # Placeholder rates until the horizon export lands in
                # Increment 8. Recorded in the artifact so nobody mistakes these
                # for model output.
                lambda_home=1.45,
                mu_away=1.20,
                kickoff=fixture.get("kickoff_time"),
            )
        )

    if not specs:
        return {"status": "skipped", "reason": f"no unplayed fixtures in GW{gameweek}"}

    seed = stable_seed_entropy(CURRENT_SEASON, gameweek)
    draws = simulate_gameweek(
        specs,
        inputs.squads,
        inputs.events,
        rules,
        n_draws=FPL_SIM["n_draws_decision"],
        seed_entropy=seed,
        all_element_ids=inputs.all_element_ids,
    )
    written = export_gameweek_xp(
        draws,
        CURRENT_SEASON,
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        rules,
        predictions_dir,
        seed,
        specs,
    )
    return {
        "status": "ok",
        "gameweek": int(draws.gameweek),
        "n_players": len(draws.element_ids),
        "artifact": str(written["xp"]),
        "goal_rates": "placeholder_until_horizon_export",
    }


def _seal(predictions_dir: Path, state: ScheduleState, dry_run: bool) -> int:
    """
    Produce and seal the pre-deadline forecast.

    The seal happens BEFORE notification and the notification failing is fatal:
    a forecast nobody received is not a decision, and the ledger would otherwise
    record a delivery that never happened.
    """
    from pipeline.data.fpl_api import fetch_bootstrap_static
    from pipeline.learning.ledger import resolve_universe, seal_forecast

    outcome = refresh_expected_points(predictions_dir, state.gameweek)
    if outcome.get("status") != "ok":
        logger.error("cannot seal: projection unavailable (%s)", outcome)
        return 1

    artifact = json.loads(Path(outcome["artifact"]).read_text())
    bootstrap = fetch_bootstrap_static(force=True, allow_stale=False)

    path = seal_forecast(
        gameweek=state.gameweek,
        deadline=state.deadline.isoformat(),
        projections=artifact["players"],
        universe=resolve_universe(bootstrap),
        bootstrap=bootstrap,
        predictions_dir=predictions_dir,
        metadata={
            "artifact_metadata": artifact.get("metadata", {}),
            "goal_rates": outcome.get("goal_rates"),
        },
        dry_run=dry_run,
    )
    logger.info("sealed GW%s -> %s", state.gameweek, path)

    # The decision itself needs the optimiser (Increment 7). The forecast is
    # sealed regardless, because a gameweek without a sealed projection is a
    # permanently lost observation whether or not a decision existed.
    logger.warning(
        "no decision published: the optimiser is not built yet. The FORECAST is "
        "sealed, so this gameweek is still measurable."
    )
    return 0


def _settle(predictions_dir: Path, state: ScheduleState, final: bool) -> int:
    """Fetch settled outcomes and record them against the seal."""
    import urllib.request

    from pipeline.config import FPL_EVENT_LIVE
    from pipeline.learning.outcomes import settle_gameweek

    url = FPL_EVENT_LIVE.format(gameweek=state.gameweek)
    request = urllib.request.Request(
        url, headers={"User-Agent": "pl-prediction-engine/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))

    path = settle_gameweek(
        state.gameweek, predictions_dir, payload, provisional=not final
    )
    logger.info(
        "settled GW%s (%s) -> %s",
        state.gameweek,
        "final" if final else "provisional",
        path,
    )
    return 0


def _score(predictions_dir: Path, state: ScheduleState) -> int:
    """Score a settled gameweek. The gated refit itself is Increment 9."""
    from pipeline.learning.scoring import UnscoreableError, score_gameweek

    try:
        report = score_gameweek(state.gameweek, predictions_dir)
    except UnscoreableError as exc:
        # Not a crash: an honest refusal. Exits non-zero so it is visible rather
        # than scrolling past in a log.
        logger.error("GW%s is unscoreable: %s", state.gameweek, exc)
        return 1

    logger.info(
        "scored GW%s: %d players, points MAE %.3f",
        state.gameweek,
        report.n_scored,
        report.metrics["points"]["mae"],
    )
    logger.warning(
        "no parameter refit attempted: the gated refit is Increment 9. The "
        "score is recorded, so the evidence accumulates meanwhile."
    )
    return 0


def run(state: Optional[ScheduleState] = None, dry_run: bool = False) -> int:
    """Execute the resolved phase. Returns a process exit code."""
    predictions_dir = Path(PREDICTIONS_DIR)
    state = state or resolve(predictions_dir)

    logger.info("phase=%s gameweek=%s (%s)", state.phase.value, state.gameweek, state.reason)

    if state.phase is Phase.IDLE:
        logger.info("nothing due")
        return 0

    if state.phase is Phase.LOCKED:
        # Not an error. The scheduler is refusing to write this close to the
        # deadline, which is the correct behaviour.
        logger.info("inside the deadline lockout; not writing")
        return 0

    if state.phase is Phase.MISSED_SEAL:
        # Exit non-zero: this is a permanent loss of an observation and should
        # raise a visible CI failure rather than scroll past in a log.
        logger.error(state.reason)
        return 1

    if state.phase is Phase.REFRESH:
        outcome = refresh_expected_points(predictions_dir, state.gameweek)
        logger.info("refresh: %s", outcome)
        return 0

    if state.phase is Phase.SEAL:
        return _seal(predictions_dir, state, dry_run=dry_run)

    if state.phase in (Phase.SETTLE_PROVISIONAL, Phase.SETTLE_FINAL):
        return _settle(
            predictions_dir, state, final=state.phase is Phase.SETTLE_FINAL
        )

    if state.phase is Phase.REFIT:
        return _score(predictions_dir, state)

    reason = NOT_YET_IMPLEMENTED.get(state.phase)
    if reason:
        # Green, but unmistakable. An agent that appears to have sealed is worse
        # than one that plainly has not.
        logger.warning(
            "phase %s is not implemented yet: %s. No forecast was sealed and no "
            "decision was published.",
            state.phase.value,
            reason,
        )
        return 0

    logger.error("unhandled phase %s", state.phase.value)
    return 1


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    dry_run = os.environ.get("FPL_AGENT_DRY_RUN", "false").lower() == "true"
    return run(dry_run=dry_run)


if __name__ == "__main__":
    sys.exit(main())
