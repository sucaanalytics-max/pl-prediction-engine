"""
Agent entry point. Dispatches on the phase the scheduler resolved.

The full pre-deadline path now runs: refresh the projection, seal it, then
propose a squad for each entry. The one remaining stub is the gated refit
(Increment 9), which exits with an explicit message rather than doing something
approximate — the one thing worse than an agent that cannot yet refit is an
agent that appears to have refitted.

**Ordering is deliberate: seal first, decide second.** Every gameweek without a
sealed projection is a permanently lost observation, and at 38 a season that is
the scarcest resource in the project. A decision can be recomputed from the same
inputs tomorrow; the proof that a forecast predated kickoff cannot. So the
decision runs inside a try and its failure never un-seals the forecast.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from pipeline.config import CURRENT_SEASON, FPL_PUBLIC_DIR, FPL_SIM, PREDICTIONS_DIR
from pipeline.decide.horizon import EVAL_HORIZON
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
    from pipeline.models.fixture_rates import (
        TeamStrengths,
        load_exported_rates,
        resolve_rates,
    )
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

    archive = load_archive_season("2526")
    inputs = build_fpl_inputs(bootstrap, archive, priors, rules)

    # Per-fixture goal rates, best source first. A flat rate for every fixture
    # gives a promoted side and the champions identical clean-sheet
    # probabilities, which measured as 0.066 predicted against 0.120 actual --
    # under-predicted by nearly half, with goals correspondingly over-predicted.
    exported = load_exported_rates(Path(predictions_dir) / "fixture_xg.json")
    strengths = None
    if not exported:
        try:
            strengths = TeamStrengths().fit(archive)
        except ValueError as exc:
            # Not fatal: resolve_rates falls back to a flat default and records
            # that provenance on every fixture, so a degraded run is visible in
            # the artifact rather than silently indistinguishable from a good one.
            logger.warning("could not fit team strengths (%s); rates will be flat", exc)

    teams = {team["id"]: team for team in bootstrap.get("teams", [])}
    from pipeline.data.team_mapping import normalize_team_name

    specs = []
    sources: Dict[str, int] = {}
    for fixture in fixtures_raw:
        if fixture.get("event") != gameweek or fixture.get("finished"):
            continue
        home = normalize_team_name(teams.get(fixture["team_h"], {}).get("name", ""))
        away = normalize_team_name(teams.get(fixture["team_a"], {}).get("name", ""))
        if not home or not away:
            continue
        match_id = str(fixture.get("id", f"{home}_{away}"))
        rates = resolve_rates(match_id, home, away, exported, strengths)
        sources[rates.source] = sources.get(rates.source, 0) + 1
        specs.append(
            FixtureSpec(
                match_id=match_id,
                gameweek=int(gameweek),
                home_team=home,
                away_team=away,
                lambda_home=rates.lambda_home,
                mu_away=rates.mu_away,
                kickoff=fixture.get("kickoff_time"),
            )
        )

    if not specs:
        return {"status": "skipped", "reason": f"no unplayed fixtures in GW{gameweek}"}

    logger.info("fixture goal rates by source: %s", sources)

    def run_stream(stream: str):
        return simulate_gameweek(
            specs,
            inputs.squads,
            inputs.events,
            rules,
            n_draws=FPL_SIM["n_draws_decision"],
            seed_entropy=stable_seed_entropy(CURRENT_SEASON, gameweek, stream),
            all_element_ids=inputs.all_element_ids,
        )

    seed = stable_seed_entropy(CURRENT_SEASON, gameweek)
    draws = run_stream("fpl")

    xp_by_week = _project_horizon(
        gameweek, fixtures_raw, teams, inputs, rules, exported, strengths,
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
        "goal_rates": sources,
        # In-memory only, for the decision stage. Deliberately not serialised:
        # draws are a deterministic function of the committed params plus the
        # seed, so persisting ~45 MB/day would buy nothing over regenerating.
        "_draws": draws,
        "_bootstrap": bootstrap,
        "_rules": rules,
        # Built lazily by the caller — a REFRESH run has no use for a second
        # stream and simulating one would double the cost of the common path.
        "_second_stream": run_stream,
        "_xp_by_week": xp_by_week,
    }


def _project_horizon(
    gameweek: int,
    fixtures_raw: Any,
    teams: Dict[int, Any],
    inputs: Any,
    rules: Any,
    exported: Any,
    strengths: Any,
) -> Optional[list]:
    """
    Expected points per player for each gameweek across the horizon.

    Returns a list of ``{element_id: xp}``, one per week starting at ``gameweek``.
    Keyed by id rather than position because the consumer aligns against a pool
    it builds itself, and a positional handoff between two modules that each
    order players independently is the R11 failure waiting to happen.

    Two things make a horizon projection different from repeating week 0:

    * **Fixtures differ per week**, which is the entire point. Rates come from
      the exported Dixon-Coles posterior, which now covers the horizon.
    * **Availability decays with distance.** A player nailed today is less
      certain to start in six weeks — injuries, rotation and transfers all
      accumulate. Measured in our own archive at 82.6 minutes for the current
      week falling to 56.3 by the sixth. Without this the horizon would treat a
      week-six projection as being as reliable as this week's and plan
      confidently on it.

    Returns ``None`` rather than raising if the horizon cannot be built: a
    myopic decision is worse than a planned one but far better than none, and
    the caller labels it as such.
    """
    from pipeline.data.team_mapping import normalize_team_name
    from pipeline.models.fixture_rates import resolve_rates
    from pipeline.models.minutes import horizon_availability_factor
    from pipeline.run_pipeline import stable_seed_entropy
    from pipeline.simulation.gameweek_sim import FixtureSpec, simulate_gameweek

    weeks: list = []
    for offset in range(EVAL_HORIZON):
        target = int(gameweek) + offset
        specs = []
        for fixture in fixtures_raw:
            if fixture.get("event") != target or fixture.get("finished"):
                continue
            home = normalize_team_name(teams.get(fixture["team_h"], {}).get("name", ""))
            away = normalize_team_name(teams.get(fixture["team_a"], {}).get("name", ""))
            if not home or not away:
                continue
            match_id = str(fixture.get("id", f"{home}_{away}"))
            rates = resolve_rates(match_id, home, away, exported, strengths)
            specs.append(
                FixtureSpec(
                    match_id=match_id, gameweek=target,
                    home_team=home, away_team=away,
                    lambda_home=rates.lambda_home, mu_away=rates.mu_away,
                    kickoff=fixture.get("kickoff_time"),
                )
            )

        if not specs:
            # A genuinely empty gameweek (or one past the published schedule).
            # Stopping is right: padding with zeros would tell the optimiser
            # every player blanks, and it would plan around a fiction.
            break

        # Fewer draws than the decision week. These feed a linear surrogate that
        # only has to rank candidates into a shortlist, and the simulator
        # re-scores the winner properly on full draws.
        week_draws = simulate_gameweek(
            specs, inputs.squads, inputs.events, rules,
            n_draws=FPL_SIM["n_draws_horizon"],
            seed_entropy=stable_seed_entropy(CURRENT_SEASON, target, "horizon"),
            all_element_ids=inputs.all_element_ids,
        )
        decay = horizon_availability_factor(offset)
        weeks.append(
            {
                int(row["element_id"]): float(row["xp"]) * decay
                for row in week_draws.summary_rows()
            }
        )

    if len(weeks) < 2:
        logger.warning(
            "horizon covers %d gameweek(s); the decision will be myopic", len(weeks)
        )
        return None
    logger.info("horizon projected over %d gameweeks from GW%s", len(weeks), gameweek)
    return weeks


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

    # The forecast is sealed BEFORE any decision is attempted, and stays sealed
    # even if the decision fails. A gameweek without a sealed projection is a
    # permanently lost observation, and losing it because an optimiser raised
    # would be trading the irreplaceable record for the replaceable output.
    try:
        decisions = _decide_for_entries(predictions_dir, state, outcome, dry_run)
    except Exception:
        logger.exception(
            "decision failed for GW%s; the FORECAST is sealed so the gameweek "
            "remains measurable, but no proposal was published",
            state.gameweek,
        )
        return 1

    for label, written in decisions.items():
        logger.info("decision (%s) -> %s", label, written["decision"])

    return _deliver(state, decisions, dry_run)


def _deliver(
    state: ScheduleState, decisions: Dict[str, Dict[str, Path]], dry_run: bool
) -> int:
    """
    Send the proposal, and make a delivery failure visible.

    **Ordering is the point.** The forecast is already sealed and the artifacts
    are already on disk before this runs, so a mail server outage costs a red
    build rather than a lost observation — the gameweek stays measurable either
    way. But it does return non-zero: a decision nobody received is not a
    decision, and a green run would say it was delivered when it was not.

    That is also why a missing SMTP configuration fails here rather than being
    checked up front. Refusing to seal because mail is unconfigured would trade
    the irreplaceable thing for the recoverable one.
    """
    from pipeline.learning.notify import NotificationError, notify

    if not decisions:
        logger.warning("nothing to deliver: no decision artifacts were written")
        return 0

    site_url = os.environ.get("FPL_SITE_URL", DEFAULT_SITE_URL)
    hours_left = max(
        0.0, (state.deadline - datetime.now(timezone.utc)).total_seconds() / 3600.0
    )
    payload = {
        "gameweek": state.gameweek,
        "deadline": state.deadline.isoformat(),
        "teams": [
            json.loads(Path(written["decision"]).read_text())
            for written in decisions.values()
        ],
    }

    try:
        result = notify(
            payload, site_url, hours_left,
            # A dry run must never mail a real recipient, and must not fail the
            # run for not having done so.
            require_delivery=not dry_run,
        )
    except NotificationError as exc:
        logger.error(
            "decision NOT delivered for GW%s (%s). The forecast is sealed and "
            "the artifacts are written, so the gameweek remains measurable — but "
            "nobody was told, so this run is a failure.",
            state.gameweek, exc,
        )
        return 1

    logger.info("delivered via %s", result.delivered or "nothing (dry run)")
    return 0


def _decide_for_entries(
    predictions_dir: Path, state: ScheduleState, outcome: Dict[str, Any], dry_run: bool
) -> Dict[str, Dict[str, Path]]:
    """
    Produce a proposal for each entry, on two independent draw streams.

    The two mandates use the SAME draws and differ only in the functional
    applied to them: the season team maximises expected points, the weekly team
    maximises a right-tail probability. That is only coherent because clean
    sheets are drawn jointly — with independent marginals the tail would be a
    function of the mean and the two teams would be the same squad.
    """
    from pipeline.config import FPL_ENTRIES
    from pipeline.decide.run_decide import decide, write_decision

    artifact = json.loads(Path(outcome["artifact"]).read_text())
    draws_select = outcome["_draws"]
    xp_by_week = outcome.get("_xp_by_week") or None
    # A second stream costs one more simulation and is what makes the reported
    # score honest rather than the maximum of a noisy sample.
    draws_report = outcome["_second_stream"]("fpl_report")

    written: Dict[str, Dict[str, Path]] = {}
    for label, config in FPL_ENTRIES.items():
        held = config.get("squad") or []
        decision = decide(
            gameweek=state.gameweek,
            draws_select=draws_select,
            draws_report=draws_report,
            bootstrap=outcome["_bootstrap"],
            rules=outcome["_rules"],
            xp_rows=artifact["players"],
            entry_label=label,
            objective=config["objective"],
            held=held,
            # No squad held means the opening build, where the whole budget is
            # cash. With a squad, the bank must be supplied — defaulting it
            # would invent 100.0m that does not exist.
            bank=config.get("bank") if held else None,
            free_transfers=config.get("free_transfers", 1),
            purchase_prices=config.get("purchase_prices"),
            xp_by_week=xp_by_week,
        )
        for warning in decision.warnings:
            logger.warning("[%s] %s", label, warning)

        if dry_run:
            logger.info("[%s] dry run: not writing the decision artifact", label)
            continue
        written[label] = write_decision(
            decision, predictions_dir, public_dir=FPL_PUBLIC_DIR
        )
    return written


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

    # Record what the FIELD scored, while it is still available. Both figures
    # live on bootstrap-static's events array for the current season only: they
    # are not in the public archive and cannot be recovered later, so a gameweek
    # that goes unrecorded is gone for good. Without them the weekly team's
    # calibration gate can never open.
    #
    # Deliberately non-fatal. Settlement is the load-bearing step here; losing
    # one field observation is a cost, but failing the settle over it would risk
    # the outcome record that everything else is scored against.
    try:
        from pipeline.data.fpl_api import fetch_bootstrap_static
        from pipeline.learning.field_observations import extract, record

        observation = extract(
            fetch_bootstrap_static(force=True, allow_stale=False),
            state.gameweek,
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            provisional=not final,
        )
        if observation is not None:
            record(observation, predictions_dir)
    except Exception:
        logger.exception(
            "could not record the field observation for GW%s; settlement stands, "
            "but this gameweek's average_entry_score and highest_score are lost "
            "and the field model has one fewer calibration point",
            state.gameweek,
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
    from pipeline.learning.gates import MIN_OBSERVATIONS
    from pipeline.learning.params import active

    current = active(predictions_dir)
    logger.info(
        "active parameter set: v%d (%s)", current.version,
        current.reason or "no reason recorded",
    )

    # The gates exist and the store exists; what is missing is the block fitter
    # that proposes a candidate. Until then this reports the position honestly
    # rather than doing something approximate — an agent that appears to have
    # refitted is worse than one that plainly has not.
    logger.warning(
        "no refit proposed: the per-block fitter is not built. The gates "
        "(pipeline/learning/gates.py) and the versioned store "
        "(pipeline/learning/params.py) are in place, and a candidate needs at "
        "least %d scored gameweeks before the confidence sequence can promote "
        "anything, so the evidence accumulates meanwhile.",
        MIN_OBSERVATIONS,
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
