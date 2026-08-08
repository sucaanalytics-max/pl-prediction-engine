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
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from pipeline.config import CURRENT_SEASON, FPL_PUBLIC_DIR, FPL_SIM, PREDICTIONS_DIR
from pipeline.decide.horizon import EVAL_HORIZON
from pipeline.learning.schedule import Phase, ScheduleState, resolve

logger = logging.getLogger(__name__)

DEFAULT_SITE_URL = "https://example.invalid/decisions"

# Phases whose implementation lands in a later increment. Listed explicitly so a
# run reports "not built" instead of silently doing nothing and exiting green.
NOT_YET_IMPLEMENTED: Dict[Phase, str] = {}


def _publish_evidence_view(
    claims: Sequence[Any],
    resolutions: Mapping[Any, Any],
    escalations: Sequence[Any],
    gameweek: int,
    bootstrap: Mapping[str, Any],
) -> None:
    """
    Write the claim-tree artifact the /evidence screen renders.

    Non-fatal by design, like everything else on this path: a projection that has
    been computed must not be lost because the reporting on it failed. Isolated in
    its own try so a failure here cannot also take down the resolution that the
    model depends on — the mistake made one level up in `_record_decision_impact`,
    where a narrow inner catch let an AttributeError abandon the whole function.
    """
    from pipeline.learning import evidence_view as view_module

    try:
        teams = {t["id"]: str(t.get("name") or "") for t in bootstrap.get("teams") or []}
        names = {
            int(e["id"]): (str(e.get("web_name") or ""), teams.get(e.get("team"), ""))
            for e in bootstrap.get("elements") or []
        }
        view = view_module.build(
            claims=claims,
            resolutions=resolutions,
            escalations=escalations,
            gameweek=gameweek,
            generated_at=datetime.now(timezone.utc)
            .isoformat().replace("+00:00", "Z"),
            names=names,
        )
        view_module.write(view, Path(FPL_PUBLIC_DIR))
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not publish the evidence view: %s", exc)


def _publish_sensitivity(gameweek: int, entry_label: str) -> None:
    """
    Write the robustness report the /decide screen renders.

    **Today this always publishes `measurable: false`,** and that is the correct
    output rather than a placeholder. Robustness is a statement about how wrong
    the projections have historically been, no gameweek has ever settled, and
    `sensitivity.measure_noise` therefore returns None. Publishing the honest
    "not measurable, and here is why" is what stops the screen inventing a
    survival percentage from a guessed sigma.

    It is wired now rather than when the data arrives so the path is exercised,
    the artifact exists for the frontend to render an absent state against, and
    the reachability guard can see the module.

    Non-fatal, like every other reporting step on this path: a projection that
    has been computed must not be lost because the reporting on it failed.
    """
    from pipeline.fpl.artifacts import write_json_atomically
    from pipeline.learning import sensitivity as sensitivity_module

    try:
        settled = _settled_outcomes(gameweek)
        noise = sensitivity_module.measure_noise(settled)
        report = sensitivity_module.assess(
            candidates=(),
            noise=noise,
            # Never called while `noise` is None, which is every run today. When
            # a sigma exists this is where the MILP re-solve is injected.
            solve_once=lambda _candidates: None,
        )
        payload = report.as_dict()
        payload["gameweek"] = int(gameweek)
        payload["entry_label"] = entry_label
        payload["generated_at"] = (
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        )
        payload["settled_gameweeks"] = len({r.get("gameweek") for r in settled})
        write_json_atomically(
            payload, Path(FPL_PUBLIC_DIR) / f"sensitivity_gw{gameweek:02d}_{entry_label}.json"
        )
    except Exception as exc:  # noqa: BLE001 - see the non-fatal note above
        logger.warning("could not publish the sensitivity report: %s", exc)


def _publish_public_xp(
    artifact_path: Any, bootstrap: Mapping[str, Any], gameweek: int,
) -> None:
    """
    Publish the per-player distributions the /players screen renders.

    Reads back the artifact just written rather than taking the in-memory
    object, so what the page shows is what actually landed on disk. A view built
    from memory would still render if the write had silently produced something
    different.

    Non-fatal: a projection that has been computed and validated must not be
    lost because the display copy of it failed.
    """
    import json as _json

    from pipeline.fpl import public_xp

    try:
        artifact = _json.loads(Path(artifact_path).read_text(encoding="utf-8"))
        teams = {t["id"]: str(t.get("name") or "") for t in bootstrap.get("teams") or []}
        positions = {
            1: "GKP", 2: "DEF", 3: "MID", 4: "FWD",
        }
        names = {
            int(e["id"]): (
                str(e.get("web_name") or ""),
                teams.get(e.get("team"), ""),
                positions.get(e.get("element_type")),
            )
            for e in bootstrap.get("elements") or []
        }
        view = public_xp.build(
            artifact,
            names,
            generated_at=datetime.now(timezone.utc)
            .isoformat().replace("+00:00", "Z"),
        )
        public_xp.write(view, Path(FPL_PUBLIC_DIR))
    except Exception as exc:  # noqa: BLE001 - see the non-fatal note above
        logger.warning("could not publish the public xp view for GW%s: %s", gameweek, exc)


def _settled_outcomes(gameweek: int) -> List[Dict[str, Any]]:
    """
    Per-player predicted-versus-actual rows from every sealed gameweek.

    Empty today: `predictions/ledger/` does not exist because nothing has been
    sealed. Returning `[]` rather than raising is what makes
    `_publish_sensitivity` publish an honest unmeasurable report instead of
    failing the run.
    """
    ledger_root = Path(PREDICTIONS_DIR) / "fpl" / "ledger"
    if not ledger_root.is_dir():
        return []

    rows: List[Dict[str, Any]] = []
    for outcome_path in sorted(ledger_root.glob("gw*/outcomes.json")):
        try:
            payload = json.loads(outcome_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            # One unreadable sealed week must not hide the others, but it must
            # not pass silently either: a shrinking sample changes every sigma.
            logger.warning("unreadable sealed outcomes at %s: %s", outcome_path, exc)
            continue
        for row in payload.get("players") or []:
            if not isinstance(row, dict):
                continue
            rows.append({
                "gameweek": payload.get("gameweek"),
                "element_id": row.get("element_id"),
                "position": row.get("position"),
                "team": row.get("team"),
                "predicted": row.get("predicted_points"),
                "actual": row.get("actual_points"),
            })
    return rows


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

    # Resolved availability evidence, where any has been recorded. Read BEFORE the
    # inputs are built so a manual press-conference claim can lower a projection.
    # Non-fatal: without it the model falls back to FPL's own fields, which is
    # exactly the behaviour before the evidence layer existed.
    evidence_view: Dict[int, Any] = {}
    evidence_summary: Dict[str, Any] = {}
    escalations: list = []
    try:
        from pipeline.learning.availability_conflicts import (
            availability_view, resolve_claims, summarise,
        )
        from pipeline.learning.availability_evidence import history as claim_history

        recorded = [
            claim for claim in claim_history(Path(predictions_dir))
            if int(claim.gameweek) == int(gameweek)
        ]
        if recorded:
            resolutions, escalations = resolve_claims(recorded)
            evidence_view = availability_view(resolutions)
            evidence_summary = summarise(resolutions, escalations)
            logger.info("availability evidence resolved: %s", evidence_summary)

            # Publish what the resolution decided AND what it beat. Written here
            # because this is the one place the claims, the resolutions and the
            # escalations all exist together; recomputing them for the export
            # would risk the page showing a different adjudication from the model.
            _publish_evidence_view(
                recorded, resolutions, escalations, int(gameweek), bootstrap,
            )
    except Exception as exc:  # noqa: BLE001 - see the non-fatal note above
        logger.warning("could not resolve availability evidence: %s", exc)

    inputs = build_fpl_inputs(
        bootstrap, archive, priors, rules, evidence=evidence_view
    )

    # Per-fixture goal rates, best source first. A flat rate for every fixture
    # gives a promoted side and the champions identical clean-sheet
    # probabilities, which measured as 0.066 predicted against 0.120 actual --
    # under-predicted by nearly half, with goals correspondingly over-predicted.
    exported = load_exported_rates(
        Path(predictions_dir) / "fixture_xg.json", current_gameweek=gameweek
    )
    strengths = None
    # Fitted ALWAYS, not only when the export is missing. Previously a successful
    # export left this None, so any fixture the export happened to miss — a week
    # beyond its horizon, a rearranged tie — fell straight past the archive tier
    # to a flat 1.45/1.20 for both sides. One archive aggregation is cheap; a
    # gameweek priced with no opponent information is not.
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

    horizon = _project_horizon(
        gameweek, fixtures_raw, teams, inputs, rules, exported, strengths,
    )
    xp_by_week, horizon_diagnostics = horizon if horizon else (None, [])

    # Record what was known about availability at this moment. The seal freezes
    # the bootstrap once per gameweek; this runs every three hours, so it is what
    # preserves the intra-week news PATH rather than only the deadline state.
    # Non-fatal: an unrecorded claim costs one observation, while failing the run
    # costs the forecast, which is irreplaceable.
    evidence: Dict[str, Any] = {}
    try:
        from pipeline.learning.availability_evidence import (
            claims_from_bootstrap, parse_coverage, record as record_claims,
        )

        claims = claims_from_bootstrap(
            bootstrap,
            int(gameweek),
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        record_claims(claims, Path(predictions_dir))
        evidence = parse_coverage(claims)
        evidence["resolution"] = evidence_summary
        # Every unresolved conflict, verbatim, so _deliver can surface it. The
        # projection was still made — conservatively — and the human needs to know
        # on what basis.
        evidence["escalations"] = [
            {"element_id": r.element_id, "claim_type": r.claim_type,
             "value": r.value, "detail": r.escalation}
            for r in escalations
        ]
        logger.info("availability evidence: %s", evidence)
    except Exception as exc:  # noqa: BLE001 - see the non-fatal note above
        logger.warning("availability evidence not recorded: %s", exc)

    written = export_gameweek_xp(
        draws,
        CURRENT_SEASON,
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        rules,
        predictions_dir,
        seed,
        specs,
    )

    # The display projection. Separate from the artifact above because that one
    # is optimiser input whose shape follows the model, while this is a stable
    # contract with the page — and a quarter of the size.
    _publish_public_xp(written["xp"], bootstrap, draws.gameweek)

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
        # Per-week availability and goal-rate provenance. Threaded out so it can
        # ride into the sealed record: these are the only observations by which
        # the horizon availability parameters become measurable.
        "horizon_diagnostics": horizon_diagnostics,
        # Parser coverage over the flagged population. Surfaced so a wording
        # change at FPL, which otherwise degrades silently to the old behaviour,
        # is visible in the run and in the seal.
        "availability_evidence": evidence,
    }


def _project_horizon(
    gameweek: int,
    fixtures_raw: Any,
    teams: Dict[int, Any],
    inputs: Any,
    rules: Any,
    exported: Any,
    strengths: Any,
) -> Optional[Tuple[list, list]]:
    """
    Expected points per player for each gameweek across the horizon.

    Returns ``(weeks, diagnostics)`` where ``weeks`` is a list of
    ``{element_id: xp}``, one per week starting at ``gameweek``.
    Keyed by id rather than position because the consumer aligns against a pool
    it builds itself, and a positional handoff between two modules that each
    order players independently is the R11 failure waiting to happen.

    Two things make a horizon projection different from repeating week 0:

    * **Fixtures differ per week**, which is the entire point. Rates come from
      the exported Dixon-Coles posterior, which now covers the horizon.
    * **Availability changes with distance, per player.** A player nailed today
      is less certain to start in six weeks — injuries, rotation and transfers
      accumulate. Measured in our own archive at 82.6 minutes for the current
      week falling to 56.3 by the sixth. But an *impaired* player moves the other
      way: a suspension expires, an injury heals, and projecting him to blank for
      eight straight weeks is simply wrong.

    **This used to be one scalar applied to the finished expected points.** That
    was wrong in a specific, measurable way: multiplying a total never crosses
    the 60-minute clean-sheet gate or the 1-minute appearance gate inside the
    simulator. Appearance points are sub-proportional to availability while clean
    sheets are super-proportional, so a uniform scalar on totals systematically
    mis-ranks defenders against forwards at long horizons. The haircut now goes
    in as role probabilities, before simulation, where both non-linearities act.

    Returns ``None`` rather than raising if the horizon cannot be built: a
    myopic decision is worse than a planned one but far better than none, and
    the caller labels it as such.
    """
    from pipeline.data.team_mapping import normalize_team_name
    from pipeline.models.fixture_rates import resolve_rates
    from pipeline.models.fpl_inputs import (
        club_kickoffs_by_gameweek,
        project_squads_at_horizon,
    )
    from pipeline.run_pipeline import stable_seed_entropy
    from pipeline.simulation.gameweek_sim import FixtureSpec, simulate_gameweek

    kickoffs_by_week = club_kickoffs_by_gameweek(fixtures_raw, teams)

    weeks: list = []
    diagnostics: list = []
    for offset in range(EVAL_HORIZON):
        target = int(gameweek) + offset
        specs = []
        week_sources: Dict[str, int] = {}
        for fixture in fixtures_raw:
            if fixture.get("event") != target or fixture.get("finished"):
                continue
            home = normalize_team_name(teams.get(fixture["team_h"], {}).get("name", ""))
            away = normalize_team_name(teams.get(fixture["team_a"], {}).get("name", ""))
            if not home or not away:
                continue
            match_id = str(fixture.get("id", f"{home}_{away}"))
            rates = resolve_rates(match_id, home, away, exported, strengths)
            week_sources[rates.source] = week_sources.get(rates.source, 0) + 1
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

        # Roles re-derived for THIS week. The availability path knows how each
        # player's absence is expected to end, so a suspension expires and an
        # injury heals instead of every flagged player blanking for eight weeks.
        week_squads = project_squads_at_horizon(
            inputs, horizon=offset, club_kickoffs=kickoffs_by_week.get(target, {})
        )

        # Fewer draws than the decision week. These feed a linear surrogate that
        # only has to rank candidates into a shortlist, and the simulator
        # re-scores the winner properly on full draws.
        week_draws = simulate_gameweek(
            specs, week_squads, inputs.events, rules,
            n_draws=FPL_SIM["n_draws_horizon"],
            seed_entropy=stable_seed_entropy(CURRENT_SEASON, target, "horizon"),
            all_element_ids=inputs.all_element_ids,
        )
        weeks.append(
            {
                int(row["element_id"]): float(row["xp"])
                for row in week_draws.summary_rows()
            }
        )

        # Recorded per week and threaded into the seal, because these are the
        # only numbers by which the horizon availability parameters can ever be
        # measured against outcomes. A flat_default here means a week was priced
        # with no opponent information at all, which used to be invisible.
        players = [p for squad in week_squads.values() for p in squad]
        diagnostics.append({
            "gameweek": target,
            "n_fixtures": len(specs),
            "goal_rate_sources": week_sources,
            "mean_expected_minutes": round(
                sum(p.roles.expected_minutes for p in players) / max(1, len(players)), 3
            ),
            "n_unavailable": sum(1 for p in players if p.roles.p_unavailable > 0.5),
        })
        if week_sources.get("flat_default"):
            logger.warning(
                "GW%s: %d fixture(s) priced at the flat default rate — no opponent "
                "information", target, week_sources["flat_default"],
            )

    if len(weeks) < 2:
        logger.warning(
            "horizon covers %d gameweek(s); the decision will be myopic", len(weeks)
        )
        return None
    logger.info(
        "horizon projected over %d gameweeks from GW%s; mean expected minutes %s",
        len(weeks), gameweek, [d["mean_expected_minutes"] for d in diagnostics],
    )
    return weeks, diagnostics


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
            # Per-week availability and rate provenance ride INTO the seal. This
            # is the only route by which the horizon availability parameters ever
            # become measurable against outcomes: without it, the numbers that
            # priced weeks 2-8 are gone by the time the results arrive.
            "horizon": outcome.get("horizon_diagnostics"),
            "availability_evidence": outcome.get("availability_evidence"),
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

    return _deliver(
        state, decisions, dry_run, outcome.get("availability_evidence") or {}
    )



def _announce(
    gameweek: int, title: str, body: str, severity: str = "info",
    suffix: str = "", detail: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Put a phase outcome in the feed.

    Non-fatal by design: these are status notes, and failing a settle or a
    score because the feed could not be written would trade the load-bearing
    step for the commentary about it. The decision path is different — there
    publication failure IS the failure, because the app is the only channel.
    """
    from pipeline.learning.messages import publish, status_message

    try:
        publish(
            [status_message(
                gameweek, title, body,
                datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                severity=severity, suffix=suffix, detail=detail,
            )],
            Path(PREDICTIONS_DIR), FPL_PUBLIC_DIR,
        )
    except Exception:
        logger.exception("could not publish the '%s' message for GW%s", title, gameweek)


def _deliver(
    state: ScheduleState,
    decisions: Dict[str, Dict[str, Path]],
    dry_run: bool,
    evidence: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Publish everything the agent has to say, to the app.

    **Ordering is the point.** The forecast is already sealed and the decision
    artifacts are already on disk before this runs, so a publication failure
    costs a red build rather than a lost observation — the gameweek stays
    measurable either way. But it returns non-zero, because the app is now the
    ONLY channel: a decision nobody can read is not a decision, and a green run
    would claim otherwise.
    """
    from pipeline.learning.messages import (
        PublicationError,
        decision_messages,
        publish,
        status_message,
    )

    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    hours_left = max(
        0.0, (state.deadline - datetime.now(timezone.utc)).total_seconds() / 3600.0
    )

    messages = []
    for label, written in decisions.items():
        payload = json.loads(Path(written["decision"]).read_text())
        messages.extend(decision_messages(payload, hours_left, created_at))

    if not messages:
        # A gameweek with no unplayed fixtures produces no proposal. Say so
        # rather than publishing nothing, or the feed goes quiet and silence is
        # indistinguishable from a broken agent.
        messages.append(
            status_message(
                state.gameweek,
                f"GW{state.gameweek} — no decision produced",
                "No unplayed fixtures were found for this gameweek, so there was "
                "nothing to decide. This is normal for a blank or completed week.",
                created_at,
                suffix="no-decision",
            )
        )

    # A wording change at FPL makes ban and return-date extraction stop working,
    # and the failure mode is a silent fallback to the previous behaviour — which
    # is exactly the kind of degradation nobody notices. Surfaced only when it is
    # both a large share and a real count, so one oddity does not cry wolf.
    if evidence:
        from pipeline.learning.availability_evidence import (
            should_escalate_parse_failures,
        )

        if should_escalate_parse_failures(evidence):
            messages.append(
                status_message(
                    state.gameweek,
                    f"GW{state.gameweek} — availability news is not being read",
                    f"{evidence['n_unparsed']} of {evidence['n_flagged']} flagged "
                    f"players have news the parser did not recognise "
                    f"({evidence['unparsed_share']:.0%}). Suspension end dates and "
                    f"expected return dates are not being extracted for them, so "
                    f"they are projected as open-ended absences — conservative, but "
                    f"a banned player who is back next week will look unavailable. "
                    f"FPL has probably changed its wording.",
                    created_at,
                    severity="warning",
                    kind="warning",
                    detail=dict(evidence),
                    suffix="news-parse",
                )
            )

    # Unresolved availability conflicts. The projection WAS made — conservatively,
    # using the least-available value — so this is a caveat rather than a failure.
    #
    # Severity is capped at `warning` deliberately. messages.py reserves `critical`
    # for a permanently lost observation or a decision that could not be made, and
    # a conflict on a player nobody owns is neither. Inflating it would devalue the
    # one severity that is supposed to stop you scrolling.
    for item in (evidence or {}).get("escalations", []) or []:
        messages.append(
            status_message(
                state.gameweek,
                f"GW{state.gameweek} — sources disagree on a player's availability",
                f"{item.get('detail') or 'Sources disagreed.'} The projection used "
                f"the more conservative reading, so this player may be understated "
                f"rather than overstated.",
                created_at,
                severity="warning",
                kind="warning",
                detail=dict(item),
                suffix=f"availability-conflict-{item.get('element_id')}",
            )
        )

    try:
        publish(messages, Path(PREDICTIONS_DIR), FPL_PUBLIC_DIR, dry_run=dry_run)
    except PublicationError as exc:
        logger.error(
            "could NOT publish the GW%s messages (%s). The forecast is sealed and "
            "the decision artifacts are written, so the gameweek remains "
            "measurable — but nobody can read it, so this run is a failure.",
            state.gameweek, exc,
        )
        return 1

    logger.info("published %d message(s) for GW%s", len(messages), state.gameweek)
    return 0



def _read_entry(config: Dict[str, Any], gameweek: int, bootstrap: Dict[str, Any]):
    """
    Read one entry's real position from FPL.

    Falls back to an empty state rather than raising. A squad that cannot be read
    is NOT the same as no squad, but the two are indistinguishable here — so the
    caller keeps its configured values and the decision path's own price
    guardrail flags the uncertainty. Failing the whole run instead would trade a
    degraded proposal for no proposal, and a missed deadline costs a gameweek.
    """
    from pipeline.fpl.entry_api import EntryError, EntryState, read_entry_state

    entry_id = config.get("entry_id")
    if not entry_id:
        return EntryState(entry_id=0, gameweek=int(gameweek))

    now_costs = {
        int(e["id"]): int(e.get("now_cost", 0))
        for e in bootstrap.get("elements", [])
    }
    try:
        return read_entry_state(int(entry_id), int(gameweek), now_costs)
    except EntryError as exc:
        logger.warning(
            "could not read entry %s (%s); falling back to configured squad state. "
            "If a squad IS held, selling prices will be wrong.",
            entry_id, exc,
        )
        return EntryState(entry_id=int(entry_id), gameweek=int(gameweek))


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

    state_gameweek = state.gameweek
    # Captured before the loop: the per-entry read below used to bind to `state`
    # and shadow the ScheduleState, which is why `state_gameweek` exists. Reading
    # the deadline inside the loop would have got the entry's, which has none.
    state_deadline = state.deadline.isoformat().replace("+00:00", "Z") if state.deadline else None
    bootstrap = outcome["_bootstrap"]

    written: Dict[str, Dict[str, Path]] = {}
    for label, config in FPL_ENTRIES.items():
        # Read the squad from FPL, not from config. The config values are a
        # manual override and a pre-season default; leaving them authoritative
        # meant that from GW2 onward `held` was always empty, so the agent
        # treated every gameweek as an opening build with the full 100.0m and
        # never once replayed a purchase price — the thing entry_api exists for.
        entry = _read_entry(config, state_gameweek, bootstrap)
        held = entry.squad or (config.get("squad") or [])
        decision = decide(
            gameweek=entry.gameweek,
            deadline=state_deadline,
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
            bank=(entry.bank if entry.squad else config.get("bank")) if held else None,
            free_transfers=entry.free_transfers if entry.squad
            else config.get("free_transfers", 1),
            purchase_prices=entry.purchase_prices or config.get("purchase_prices"),
            xp_by_week=xp_by_week,
        )
        for warning in decision.warnings:
            logger.warning("[%s] %s", label, warning)

        if dry_run:
            logger.info("[%s] dry run: not writing the decision artifact", label)
            continue

        # Read the OUTGOING decision before overwriting it: stage 2 of the delta
        # needs the move the human was previously told to make.
        previous = _previous_decision(predictions_dir, state_gameweek, label)

        written[label] = write_decision(
            decision, predictions_dir, public_dir=FPL_PUBLIC_DIR
        )
        _record_decision_impact(
            predictions_dir=predictions_dir,
            gameweek=entry.gameweek,
            entry_label=label,
            previous=previous,
            decision=decision,
            draws=draws_report,
            xp_rows=artifact["players"],
            rules=outcome["_rules"],
        )
        _publish_sensitivity(int(entry.gameweek), label)
    return written


def _previous_decision(
    predictions_dir: Path, gameweek: Optional[int], label: str
) -> Optional[Dict[str, Any]]:
    """
    The decision artifact this run is about to replace, or None.

    None on the first run of a gameweek, which is a real state and not an error:
    with no previous recommendation there is no cost of inaction to compute.
    """
    if not gameweek:
        return None
    path = (
        Path(predictions_dir) / "fpl"
        / f"decision_gw{int(gameweek):02d}_{label}.json"
    )
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("previous decision unreadable (%s); no impact computed", exc)
        return None


def _record_decision_impact(
    predictions_dir: Path,
    gameweek: Optional[int],
    entry_label: str,
    previous: Optional[Mapping[str, Any]],
    decision: Any,
    draws: Any,
    xp_rows: Sequence[Mapping[str, Any]],
    rules: Any,
) -> None:
    """
    Stage 2 of the news delta: what the availability changes did to the plan.

    Runs here rather than in the 15-minute poller because it needs the solver, and
    `pipeline/decide/milp.py` imports numpy at module level and scipy's `milp` at
    run time. The poller therefore emits the resolution change immediately and this
    fills in the decision half at the agent's own cadence.

    Deliberately non-fatal throughout: a decision that has been solved and written
    must not be lost because the reporting on it failed.
    """
    from pipeline.decide.milp import Plan
    from pipeline.decide.plan_eval import evaluate_plan
    from pipeline.learning import deltas as deltas_store

    try:
        pending = deltas_store.unenriched(deltas_store.history(predictions_dir))
        pending = [d for d in pending if int(d.get("gameweek", 0)) == int(gameweek or 0)]
        if not pending:
            return

        new_xp = {int(r["element_id"]): float(r.get("xp", 0.0)) for r in xp_rows}
        # The xp the PREVIOUS decision was made on, as recorded on that artifact.
        # Absent on older producers, in which case xp_moved is reported as unknown
        # rather than as zero movement.
        old_xp = {
            int(k): float(v)
            for k, v in ((previous or {}).get("xp_snapshot") or {}).items()
        }

        new_plan = decision.reported.plan.as_dict()
        previous_plan = ((previous or {}).get("decision") or {}).get("plan")

        # Re-score the OLD recommendation on the NEW draws. This is the half of
        # ev_cost_of_inaction that makes it a cost rather than a drift measurement.
        rescored: Optional[float] = None
        if previous_plan:
            try:
                # Built from the xp rows directly, NOT via `positions_of`: that
                # takes `Candidate` objects and reads `.element_id`, while these are
                # plain dicts from the artifact. Passing them raised AttributeError
                # — which the handler below did not catch, so it escaped to the
                # outer one and killed the entire impact assessment rather than
                # just the cost. Stage 2 silently produced nothing from the second
                # run of every gameweek onward, and said so only in a log line.
                positions = {
                    int(row["element_id"]): str(row.get("position") or "")
                    for row in xp_rows
                }
                restored = Plan(
                    squad=[int(p) for p in previous_plan["squad"]],
                    xi=[int(p) for p in previous_plan["xi"]],
                    captain=int(previous_plan["captain"]),
                    vice=int(previous_plan["vice"]),
                    transfers_in=[int(p) for p in previous_plan.get("transfers_in") or []],
                    transfers_out=[int(p) for p in previous_plan.get("transfers_out") or []],
                    hits=int(previous_plan.get("hits", 0)),
                    bank_after=int(previous_plan.get("bank_after", 0)),
                    objective=float(previous_plan.get("objective", 0.0)),
                    free_transfers_banked=int(previous_plan.get("free_transfers_banked", 0)),
                    free_transfers_after=int(previous_plan.get("free_transfers_after", 0)),
                )
                rescored = float(
                    evaluate_plan(restored, draws, positions, rules=rules,
                                  xp=new_xp).mean_points
                )
            except Exception as exc:  # noqa: BLE001
                # `evaluate_plan` raises KeyError when the old plan names a player
                # who has since left the draws. That is informative rather than
                # broken: the previous recommendation is no longer scoreable, so
                # the cost of inaction is genuinely unknown.
                #
                # Catching everything, deliberately. A narrower tuple let an
                # AttributeError through to the outer handler, which abandoned the
                # whole assessment — so a failure to compute ONE optional number
                # cost every impact record. The scope of a rescue has to match the
                # scope of what it is rescuing: this one owns the cost, and nothing
                # else.
                logger.info(
                    "[%s] previous plan not re-scoreable (%s); "
                    "ev_cost_of_inaction left unknown", entry_label, exc,
                )

        impacts = deltas_store.assess_impact(
            changes=pending,
            previous_plan=previous_plan,
            new_plan=new_plan,
            xp_before=old_xp,
            xp_after=new_xp,
            observed_at=decision.generated_at,
            gameweek=int(gameweek or 0),
            entry_label=entry_label,
            new_ev=float(decision.reported.mean_points),
            previous_plan_rescored_ev=rescored,
        )

        from pipeline.config import DELTA
        reportable = []
        for impact in impacts:
            keep, why = deltas_store.impact_is_reportable(impact, DELTA)
            if keep:
                reportable.append(impact)
            else:
                logger.info("[%s] impact not reported: %s", entry_label, why)
        if reportable:
            deltas_store.record(reportable, predictions_dir)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[%s] could not assess the decision impact (%s); the decision itself "
            "was written", entry_label, exc,
        )


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
    _announce(
        state.gameweek,
        f"GW{state.gameweek} — results are in"
        + ("" if final else " (provisional)"),
        "Outcomes have been recorded against the sealed forecast."
        + ("" if final else " Bonus points are still settling, so these may move."),
        suffix="settled" if final else "settled-provisional",
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
        _announce(
            state.gameweek or 0,
            f"GW{state.gameweek} was never sealed",
            "No pre-deadline forecast exists for this gameweek, so it can never "
            "be scored. This observation is permanently lost — it is one of 38 "
            "in a season and cannot be recovered. " + str(state.reason),
            severity="critical",
            suffix="missed-seal",
        )
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
