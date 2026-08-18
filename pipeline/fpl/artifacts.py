"""
The expected-points artifact: build it, assert it, write it atomically.

Every claim in this file is checked before anything reaches disk. That is the
repo's existing idiom (`pipeline/validation/artifacts.py`) applied to the FPL
layer, and it exists because the pipeline runs unattended: a swallowed
inconsistency here becomes a confidently wrong squad recommendation with nothing
in the output revealing it.

The write is deliberately all-or-nothing. On failure the artifact is **not
written at all** rather than left partial or stale-looking, because a stale
`xp_gw` file is worse than a missing one — a missing file is obviously missing.

Companion `sim_params` file records the parameters and seed rather than any
binary. The draw matrices are a deterministic function of those, so they are
regenerable and never persisted: at tens of megabytes a day they would buy
nothing but bloat.
"""
from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from pipeline.config import FPL_SIM, PARAM_REGISTRY
from pipeline.fpl.rules import Rules

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"

# Tail probabilities must be non-increasing across these thresholds.
TAIL_KEYS = ("p_ge_2", "p_ge_5", "p_ge_10", "p_ge_15")
QUANTILE_KEYS = ("q10", "q25", "q50", "q75", "q90", "q99")

# ── fixture_xg.json ──────────────────────────────────────────────────────
# The three provenance labels `blend_log` can return. An unlisted value means the
# blend grew a fourth branch and the consumer's per-row source handling — which
# decides whether a rate is market-informed at all — was not updated with it.
RATE_SOURCES = ("market_blend", "dixon_coles_posterior+level", "dixon_coles_posterior")

# Every value a FixtureSpec.rate_source can legitimately carry, across BOTH
# real callers of build_xp_artifact/export_gameweek_xp: the daily lane
# (pipeline/run_pipeline.py, via fixture_specs_from_fixture_xg /
# fixture_specs_from_predictions) and the FPL agent's seal
# (pipeline/learning/run_agent.py::refresh_expected_points, via
# pipeline.models.fixture_rates.resolve_rates). A contract check exists to
# catch a NULL — nobody wired provenance — not to police which legitimate
# source was used, so THIS set must stay a superset of every real producer:
# a legitimate value rejected here does not just fail a check, it aborts an
# irrecoverable seal. Traced by reading every producer directly, not assumed:
#
#   RATE_SOURCES (above)             blend_log's per-row rate_source in
#                                     fixture_xg.json, and what
#                                     load_exported_rates' normal path re-reads.
#   "dixon_coles_posterior+market_blend"
#                                     fixture_rates.py::export_fixture_xg's
#                                     PAYLOAD-level `source` field.
#                                     load_exported_rates falls back to this
#                                     when a row is missing its own
#                                     rate_source (a pre-anchor or legacy
#                                     file) — distinct from every RATE_SOURCES
#                                     string, so it is not covered above.
#   "archive_team_strengths"         TeamStrengths.rates() (fixture_rates.py);
#                                     resolve_rates' fallback when
#                                     fixture_xg.json has no rate for a fixture.
#   "flat_default"                   resolve_rates' last resort
#                                     (fixture_rates.py) when strengths are
#                                     not fitted either.
#   "ensemble_unanchored"            fixture_specs_from_predictions
#                                     (fpl_inputs.py) — the daily lane's own
#                                     fallback when fixture_xg.json is absent,
#                                     unreadable or malformed.
#   "unknown"                        fixture_specs_from_fixture_xg
#                                     (fpl_inputs.py), when a fixture_xg.json
#                                     row has a usable rate but is missing its
#                                     own rate_source — a deliberate non-null
#                                     sentinel, not a bug, and it flows
#                                     through the exact daily-lane call site
#                                     this task wired in.
#
# An unrecognised string is still rejected: a typo, or a genuinely new branch
# nobody added here, must fail loudly rather than slip through as if it were
# one of these. See test_fpl_artifacts.py's ContractAcceptsEveryRealProducer
# for the durable guard: it exercises the real producer functions above and
# asserts every string they can actually return is a member of this tuple, so
# a future producer emitting a fourth value fails in CI rather than at a
# gameweek deadline.
ACCEPTED_RATE_SOURCES = RATE_SOURCES + (
    "dixon_coles_posterior+market_blend",
    "archive_team_strengths",
    "flat_default",
    "ensemble_unanchored",
    "unknown",
)

# Rates outside this are not football results. Wider than market_rates' own
# [0.15, 5.0] acceptance band on purpose: this is the last line, and it should
# fire on a units error or a mislabelled side, not on a solver's edge case.
MIN_FIXTURE_RATE = 0.1
MAX_FIXTURE_RATE = 5.0

# These two mirror `market_rates.STATUS_CONVERGED` and `level_correction`'s
# `clamp` default. Restated as literals rather than imported because importing
# market_rates pulls in dixon_coles and therefore PyMC, which this module — read
# by every FPL consumer — has no business loading. Restating them also makes them
# a contract the producer must satisfy rather than a tautology it defines.
MARKET_STATUS_CONVERGED = "converged"
MAX_LEVEL_CORRECTION = 0.20

# lambda/mu/supremacy/total_goals are exported at round(x, 6), and supremacy is
# rounded AFTER subtracting unrounded rates. Each rounding moves a value by up to
# 5e-7, so the recomputed difference can disagree by 1e-6 with nothing wrong.
FIXTURE_ROUNDING_TOLERANCE = 2e-6


class ArtifactContractError(AssertionError):
    """An artifact failed a blocking check. Never swallow this."""


def _spec_gameweek(spec: Any) -> Optional[int]:
    """
    The gameweek a fixture spec belongs to, or None when it cannot say.

    Never raises. `FixtureSpec.gameweek` is a required field, so None here
    means the spec came from something other than the four real producers —
    and the two emitters below are on the irrecoverable seal path
    (run_agent.refresh_expected_points -> export_gameweek_xp), where a
    TypeError raised while ASSEMBLING the artifact would lose the gameweek
    outright. Degrading to an unlabelled fixture is recoverable; raising here
    is not.
    """
    value = getattr(spec, "gameweek", None)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def validate_xp_artifact(artifact: Dict[str, Any]) -> List[str]:
    """
    Return every contract violation found. Empty means the artifact is sound.

    Collect-then-report rather than fail-fast: when something has gone wrong it
    is far more useful to see all of it at once than the first instance.
    """
    problems: List[str] = []

    metadata = artifact.get("metadata")
    if not isinstance(metadata, dict):
        return ["metadata missing or not an object"]

    for required in (
        "schema_version", "season", "gameweek", "generated_at", "n_draws",
        "bonus_method", "goal_minute_model", "fpl_rules_source",
    ):
        if required not in metadata:
            problems.append(f"metadata.{required} missing")

    # A published fixture with a null rate_source is indistinguishable from
    # one nobody ever wired provenance for, and an unrecognised value means
    # the blend grew a branch this artifact's consumers were never told
    # about. Both fail the contract here rather than reach disk unchallenged.
    # ACCEPTED_RATE_SOURCES (module level, above) is a superset of every real
    # producer, not just RATE_SOURCES — this must never reject a legitimate
    # value, because both real callers of this check feed an irrecoverable
    # seal (pipeline/learning/run_agent.py) or a daily lane whose failure here
    # silently drops that day's FPL projections (pipeline/run_pipeline.py).
    fixtures = artifact.get("fixtures")
    if fixtures is not None and not isinstance(fixtures, list):
        problems.append("fixtures present but not a list")
    else:
        accepted_rate_sources = set(ACCEPTED_RATE_SOURCES)
        for fixture in fixtures or []:
            label = f"fixture {fixture.get('home_team')} v {fixture.get('away_team')}"
            rate_source = fixture.get("rate_source")
            if not rate_source:
                problems.append(f"{label}: rate_source is null or missing")
            elif rate_source not in accepted_rate_sources:
                problems.append(
                    f"{label}: rate_source {rate_source!r} is not a "
                    f"recognised value (expected one of "
                    f"{sorted(accepted_rate_sources)})"
                )

    # Every fixture belongs to the gameweek the artifact claims.
    #
    # The descope this phase rests on has one exit criterion — "every fixture
    # simulated belongs to one gameweek" — and until now it was guarded only
    # by a `gameweeks=[gameweek]` keyword at a single call site plus an AST
    # test. GameweekDraws labels itself `int(fixtures[0].gameweek)`, so a
    # mixed list silently reports the first fixture's week while carrying
    # points accumulated across all of them. This branch shipped exactly that
    # 8x inflation once behind a green suite. It also covers the fallback
    # path (fixture_specs_from_predictions), which has no gameweek filter at
    # all.
    #
    # A fixture that states NO gameweek is not a violation. _spec_gameweek
    # degrades to None rather than raise, and both callers of this check feed
    # an irrecoverable seal or a daily lane whose failure here drops that
    # day's FPL projections — so this must fire on a demonstrated mismatch
    # and on nothing else.
    claimed_gameweek = metadata.get("gameweek")
    if claimed_gameweek is not None:
        try:
            claimed_gameweek = int(claimed_gameweek)
        except (TypeError, ValueError):
            claimed_gameweek = None
    if claimed_gameweek is not None:
        for fixture in (fixtures if isinstance(fixtures, list) else []):
            if not isinstance(fixture, dict):
                continue
            fixture_gameweek = fixture.get("gameweek")
            if fixture_gameweek is None:
                continue
            try:
                fixture_gameweek = int(fixture_gameweek)
            except (TypeError, ValueError):
                continue
            if fixture_gameweek != claimed_gameweek:
                label = (
                    f"fixture {fixture.get('home_team')} v "
                    f"{fixture.get('away_team')}"
                )
                problems.append(
                    f"{label}: gameweek {fixture_gameweek} does not match "
                    f"metadata.gameweek {claimed_gameweek}; every fixture "
                    "simulated must belong to one gameweek, or the summed "
                    "per-player totals describe more weeks than the artifact "
                    "claims"
                )

    players = artifact.get("players")
    if not isinstance(players, list):
        return problems + ["players missing or not a list"]
    if not players:
        problems.append("players is empty")

    seen_ids = set()
    for player in players:
        element_id = player.get("element_id")
        label = f"player {element_id}"

        if element_id in seen_ids:
            problems.append(f"{label}: duplicate element_id")
        seen_ids.add(element_id)

        # Catch non-finite values here rather than at serialisation, so the
        # message names the player and field instead of the whole payload.
        for key, value in player.items():
            if isinstance(value, float) and not math.isfinite(value):
                problems.append(f"{label}: {key} is {value}, not a finite number")

        # Probabilities in range.
        for key in ("p_appears", "p_60", "p_goal", "p_multi_goal",
                    "p_clean_sheet", *TAIL_KEYS):
            value = player.get(key)
            if value is None:
                problems.append(f"{label}: {key} missing")
            elif not 0.0 - 1e-9 <= float(value) <= 1.0 + 1e-9:
                problems.append(f"{label}: {key}={value} outside [0, 1]")

        # Logical nesting. Sixty minutes implies an appearance; two goals imply
        # one. A violation here means the draws and the summary disagree.
        if player.get("p_60") is not None and player.get("p_appears") is not None:
            if float(player["p_60"]) > float(player["p_appears"]) + 1e-9:
                problems.append(
                    f"{label}: p_60 {player['p_60']} exceeds p_appears "
                    f"{player['p_appears']}"
                )
        if player.get("p_multi_goal") is not None and player.get("p_goal") is not None:
            if float(player["p_multi_goal"]) > float(player["p_goal"]) + 1e-9:
                problems.append(
                    f"{label}: p_multi_goal exceeds p_goal"
                )

        # Tail probabilities non-increasing.
        tail = [player.get(key) for key in TAIL_KEYS]
        if all(value is not None for value in tail):
            for earlier, later, low, high in zip(
                tail, tail[1:], TAIL_KEYS, TAIL_KEYS[1:]
            ):
                if float(later) > float(earlier) + 1e-9:
                    problems.append(f"{label}: {high} exceeds {low}")

        # Quantiles monotone.
        quantiles = [player.get(key) for key in QUANTILE_KEYS]
        if all(value is not None for value in quantiles):
            for earlier, later, low, high in zip(
                quantiles, quantiles[1:], QUANTILE_KEYS, QUANTILE_KEYS[1:]
            ):
                if float(later) < float(earlier) - 1e-9:
                    problems.append(f"{label}: {high} below {low}")

        # A blank gameweek must be an explicit zero, not an omission.
        if player.get("blank"):
            if player.get("fixtures"):
                problems.append(f"{label}: blank but has fixtures")
            if abs(float(player.get("xp", 0.0))) > 1e-9:
                problems.append(f"{label}: blank but xp is non-zero")
        elif not player.get("fixtures"):
            problems.append(f"{label}: not blank but has no fixtures")

        if float(player.get("xp_sd", 0.0)) < -1e-9:
            problems.append(f"{label}: negative xp_sd")
        if float(player.get("e_minutes", 0.0)) < -1e-9:
            problems.append(f"{label}: negative e_minutes")

    return problems


def assert_valid_xp_artifact(artifact: Dict[str, Any]) -> None:
    """Raise :class:`ArtifactContractError` if the artifact is unsound."""
    problems = validate_xp_artifact(artifact)
    if problems:
        shown = problems[:20]
        suffix = "" if len(problems) <= 20 else f" (+{len(problems) - 20} more)"
        raise ArtifactContractError(
            f"{len(problems)} contract violation(s): " + "; ".join(shown) + suffix
        )


def _bracket_slack(row_weight: float, level: float) -> float:
    """
    How far past the DC/market bracket the league level correction can push a rate.

    ``blend_log`` produces ``log lam = log dc + w*L + e*(D - L)`` with
    ``D = log(market/dc)``, ``L`` the raw league correction and
    ``e = w * market.weight`` — so ``e == w`` only when this fixture's market
    earned full trust. Below that, the level term keeps weight ``w - e`` while the
    fixture-specific term is down-weighted to ``e``, and the result can land past
    the market's own number. The overshoot is exactly ``(e - 1)*D + (w - e)*L``,
    bounded by ``w*|L|`` in log space, which is what this returns as a multiplier.

    Measured, so this is not a hypothetical: at the registry weight w = 0.55, a
    two-book market (market weight 1/3) overshoots whenever ``D < 0.449*L``. With
    the league correction at the 0.0233 the sample export actually produced, a
    fixture whose market agreed with the posterior to within 0.5% came out 0.45%
    ABOVE the market — a healthy run that a strict bracket would have refused to
    write. The worst case across every reachable (market weight, L, D) is 10.3%,
    at the ±0.20 level clamp, inside the 11.6% this bound allows.

    Small in practice, so the check stays sharp: 1.3% on the sample export, against
    the 7.4% displacement a sign error on a 15% market disagreement produces.
    """
    return math.exp(float(row_weight) * abs(float(level)))


def validate_fixture_xg(payload: Dict[str, Any]) -> List[str]:
    """
    Return every contract violation in a ``fixture_xg.json`` payload.

    Collect-then-report, as :func:`validate_xp_artifact`. This file is the only
    thing standing between the market anchor and the projection layer: the rates
    here set every clean-sheet and goal probability the horizon optimiser ranks on,
    and a swapped home/away or a wrong-sign blend weight produces a payload that
    is entirely well-formed and entirely inverted.
    """
    problems: List[str] = []

    if not isinstance(payload, dict):
        return ["payload is not an object"]

    for required in (
        "schema_version", "source", "statistical_component", "horizon",
        "first_gameweek", "n_fixtures", "market", "fixtures",
    ):
        if required not in payload:
            problems.append(f"{required} missing")

    rows = payload.get("fixtures")
    if not isinstance(rows, list):
        return problems + ["fixtures missing or not a list"]
    if not rows:
        problems.append("fixtures is empty")
    if payload.get("n_fixtures") is not None and len(rows) != payload["n_fixtures"]:
        problems.append(
            f"n_fixtures says {payload['n_fixtures']} but {len(rows)} rows are present"
        )

    market_meta = payload.get("market")
    if not isinstance(market_meta, dict):
        problems.append("market metadata missing or not an object")
        market_meta = {}

    # ── 5. The blend's own parameters are in range ───────────────────────
    base_weight = market_meta.get("blend_weight")
    if base_weight is None:
        problems.append("market.blend_weight missing")
    elif not 0.0 <= float(base_weight) <= 1.0:
        problems.append(
            f"market.blend_weight={base_weight} outside [0, 1]; a weight outside "
            f"the unit interval is not a blend"
        )

    level = market_meta.get("level_correction")
    if not isinstance(level, dict):
        problems.append("market.level_correction missing or not an object")
        level = {}
    for side in ("home", "away"):
        value = level.get(side)
        if value is None:
            problems.append(f"market.level_correction.{side} missing")
        elif not abs(float(value)) <= MAX_LEVEL_CORRECTION + 1e-9:
            problems.append(
                f"market.level_correction.{side}={value} exceeds the "
                f"{MAX_LEVEL_CORRECTION} clamp; that is a data problem, and it is "
                f"applied to EVERY gameweek including unpriced ones"
            )

    prior_only_weight = float(PARAM_REGISTRY["market.prior_only_weight"]["value"])

    seen_ids = set()
    gameweeks = set()
    for row in rows:
        match_id = row.get("match_id")
        label = (
            f"fixture {match_id} "
            f"({row.get('home_team')} v {row.get('away_team')})"
        )

        # ── 6. Ids are unique ────────────────────────────────────────────
        # The consumer keys rates BY match_id, so a duplicate silently discards
        # one fixture's rates and serves the other's for both.
        if match_id in seen_ids:
            problems.append(f"{label}: duplicate match_id")
        seen_ids.add(match_id)

        # Named field and fixture rather than "the payload has a NaN", which is
        # all the serialiser's own allow_nan guard could tell you.
        for key, value in row.items():
            if isinstance(value, float) and not math.isfinite(value):
                problems.append(f"{label}: {key} is {value}, not a finite number")

        # ── 3. Rates are plausible, spreads are non-negative ─────────────
        for key in ("lambda_home", "mu_away", "lambda_home_dc", "mu_away_dc"):
            value = row.get(key)
            if value is None:
                problems.append(f"{label}: {key} missing")
            elif not MIN_FIXTURE_RATE <= float(value) <= MAX_FIXTURE_RATE:
                problems.append(
                    f"{label}: {key}={value} outside "
                    f"[{MIN_FIXTURE_RATE}, {MAX_FIXTURE_RATE}] goals"
                )
        for key in ("lambda_home_sd", "mu_away_sd"):
            value = row.get(key)
            if value is not None and float(value) < -1e-9:
                problems.append(f"{label}: negative {key}")

        # ── 4. The derived fields agree with the rates they derive from ──
        # Cheap, and it is the check that catches a consumer reading a stale
        # supremacy after someone re-scales the rates without recomputing it.
        home, away = row.get("lambda_home"), row.get("mu_away")
        if home is not None and away is not None:
            for key, expected in (
                ("supremacy", float(home) - float(away)),
                ("total_goals", float(home) + float(away)),
            ):
                actual = row.get(key)
                if actual is None:
                    problems.append(f"{label}: {key} missing")
                elif abs(float(actual) - expected) > FIXTURE_ROUNDING_TOLERANCE:
                    problems.append(
                        f"{label}: {key}={actual} but lambda_home/mu_away give "
                        f"{expected:.6f}"
                    )

        # ── 2. Provenance is one of three values, and it is honest ───────
        source = row.get("rate_source")
        if source not in RATE_SOURCES:
            problems.append(
                f"{label}: rate_source={source!r} is not one of {RATE_SOURCES}"
            )

        market = row.get("market")
        converged = (
            isinstance(market, dict)
            and market.get("status") == MARKET_STATUS_CONVERGED
        )
        row_weight = None
        if base_weight is not None:
            row_weight = (
                max(float(base_weight), prior_only_weight)
                if row.get("prior_only") else float(base_weight)
            )

        if source == "market_blend" and not converged:
            state = "absent" if not isinstance(market, dict) else repr(
                market.get("status")
            )
            problems.append(
                f"{label}: rate_source is market_blend but its market is {state}"
            )
        # The converse holds only where the blend weight is positive. Weight zero
        # is a deliberate true no-op — it exists so the anchor's contribution can
        # be isolated — and it leaves a converged market attached to a row the
        # blend correctly did not touch.
        if converged and source != "market_blend" and (row_weight or 0.0) > 0.0:
            problems.append(
                f"{label}: has a converged market at weight {row_weight} but "
                f"rate_source is {source!r}, so the anchor was computed and dropped"
            )

        # ── 1. The blend lies between the posterior and the market ───────
        # The strongest single check here. A wrong-sign weight moves the rate away
        # from the market, a swapped home/away moves lambda_home toward the away
        # market rate, and a units error leaves the bracket entirely — all three
        # land outside, and none of them changes the shape of the payload.
        if converged and row_weight is not None:
            for blended_key, dc_key, level_key in (
                ("lambda_home", "lambda_home_dc", "home"),
                ("mu_away", "mu_away_dc", "away"),
            ):
                blended = row.get(blended_key)
                posterior = row.get(dc_key)
                anchor = market.get(blended_key)
                if blended is None or posterior is None or anchor is None:
                    continue
                if not MIN_FIXTURE_RATE <= float(anchor) <= MAX_FIXTURE_RATE:
                    problems.append(
                        f"{label}: market.{blended_key}={anchor} outside "
                        f"[{MIN_FIXTURE_RATE}, {MAX_FIXTURE_RATE}] goals"
                    )
                    continue
                slack = _bracket_slack(row_weight, level.get(level_key, 0.0))
                low = min(float(posterior), float(anchor)) / slack
                high = max(float(posterior), float(anchor)) * slack
                if not low - 1e-6 <= float(blended) <= high + 1e-6:
                    problems.append(
                        f"{label}: {blended_key}={blended} is outside the "
                        f"posterior/market bracket [{low:.6f}, {high:.6f}] "
                        f"(dc={posterior}, market={anchor})"
                    )

        # ── 7a. Every row states its gameweek ────────────────────────────
        gameweek = row.get("gameweek")
        if gameweek is None:
            problems.append(
                f"{label}: gameweek missing; the staleness check in "
                f"load_exported_rates has nothing to compare against"
            )
        else:
            gameweeks.add(int(gameweek))

    # ── 7b. The exported weeks are one unbroken run inside the horizon ───
    #
    # Contiguity is checked from the LOWEST exported gameweek rather than from
    # `first_gameweek`, and the asymmetry is deliberate. `first_gameweek` is the
    # lowest UNFINISHED event, while rows are filtered on per-fixture `finished`,
    # and FPL flips those independently — so a week whose matches have all been
    # played but whose event flag has not yet moved legitimately exports nothing,
    # and demanding a row at `first_gameweek` would fail the export every Sunday
    # night. A gap in the MIDDLE has no such excuse: it means a week's fixtures
    # were dropped, and the horizon optimiser would plan straight through it.
    if gameweeks:
        first = payload.get("first_gameweek")
        horizon = payload.get("horizon")
        expected = set(range(min(gameweeks), max(gameweeks) + 1))
        if gameweeks != expected:
            problems.append(
                f"exported gameweeks {sorted(gameweeks)} are not contiguous; "
                f"missing {sorted(expected - gameweeks)}"
            )
        if first is not None and min(gameweeks) < int(first):
            problems.append(
                f"gameweek {min(gameweeks)} is below first_gameweek {first}"
            )
        if first is not None and horizon is not None:
            last = int(first) + int(horizon) - 1
            if max(gameweeks) > last:
                problems.append(
                    f"gameweek {max(gameweeks)} is beyond the horizon "
                    f"(first_gameweek {first} + horizon {horizon} ends at {last})"
                )

    return problems


def assert_valid_fixture_xg(payload: Dict[str, Any]) -> None:
    """Raise :class:`ArtifactContractError` if ``fixture_xg.json`` is unsound."""
    problems = validate_fixture_xg(payload)
    if problems:
        shown = problems[:20]
        suffix = "" if len(problems) <= 20 else f" (+{len(problems) - 20} more)"
        raise ArtifactContractError(
            f"fixture_xg: {len(problems)} contract violation(s): "
            + "; ".join(shown) + suffix
        )


def build_xp_artifact(
    draws,
    season: str,
    generated_at: str,
    rules: Rules,
    fixture_specs: Optional[List[Any]] = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the artifact from a :class:`GameweekDraws`."""
    notes = dict(draws.notes)
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "season": season,
        "gameweek": int(draws.gameweek),
        "generated_at": generated_at,
        "n_draws": int(notes.get("n_draws", draws.n_draws)),
        "n_players": len(draws.element_ids),
        # Approximations are metadata, not folklore. A consumer that cannot see
        # them cannot know what the numbers do and do not support.
        "bonus_method": "empirical_conditional_bucket",
        "bonus_tail_claim": False,
        "goal_minute_model": notes.get("goal_minute_model", "uniform_1_90"),
        "substitution_count_exact": False,
        "dgw_rotation_correlation_modelled": notes.get(
            "dgw_rotation_correlation_modelled", False
        ),
        "fpl_rules_source": rules.source,
        "fpl_rules_degraded": bool(rules.degraded),
        "unmodelled_chips": list(rules.unmodelled_chips),
        "parameters": {
            name: spec["value"] for name, spec in sorted(PARAM_REGISTRY.items())
        },
        "required": bool(FPL_SIM.get("required", False)),
    }
    metadata.update(extra_metadata or {})

    artifact = {
        "metadata": metadata,
        "fixtures": [
            {
                "match_id": spec.match_id,
                # Stated per fixture so the one-gameweek guarantee is a
                # property of the ARTIFACT rather than of a keyword argument
                # at one call site. GameweekDraws labels itself
                # int(fixtures[0].gameweek), so a mixed spec list silently
                # publishes the first fixture's week over several weeks of
                # accumulated points; without this field no consumer and no
                # contract check could detect it.
                "gameweek": _spec_gameweek(spec),
                "home_team": spec.home_team,
                "away_team": spec.away_team,
                "kickoff": spec.kickoff,
                "lambda_home": round(float(spec.lambda_home), 4),
                "mu_away": round(float(spec.mu_away), 4),
                "rate_source": spec.rate_source,
            }
            for spec in (fixture_specs or [])
        ],
        # `rules` gives every row its points decomposition; without it the
        # clean-sheet share cannot be attributed and the field is omitted.
        "players": draws.summary_rows(rules),
        "diagnostics": notes,
    }
    return artifact


def build_sim_params(
    season: str,
    gameweek: int,
    generated_at: str,
    seed_entropy: int,
    n_draws: int,
    fixture_specs: List[Any],
) -> Dict[str, Any]:
    """
    Everything needed to regenerate the draws, and nothing else.

    No binaries. The draw matrices are a deterministic function of these values
    plus pinned numpy, so persisting tens of megabytes of them daily would buy
    only bloat and a class of round-tripping bug.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "season": season,
        "gameweek": int(gameweek),
        "generated_at": generated_at,
        "seed_entropy": int(seed_entropy),
        "n_draws": int(n_draws),
        "parameters": {
            name: {"value": spec["value"], "tier": spec["tier"]}
            for name, spec in sorted(PARAM_REGISTRY.items())
        },
        "fixtures": [
            {
                "match_id": spec.match_id,
                # Same reason as build_xp_artifact: the regeneration record
                # must show which week each fixture belonged to, or a rerun
                # cannot tell a mixed list from a single-week one.
                "gameweek": _spec_gameweek(spec),
                "home_team": spec.home_team,
                "away_team": spec.away_team,
                "lambda_home": float(spec.lambda_home),
                "mu_away": float(spec.mu_away),
                "rate_source": spec.rate_source,
            }
            for spec in fixture_specs
        ],
    }


def write_json_atomically(payload: Dict[str, Any], path: Path) -> Path:
    """
    Write via a temporary file and rename, so no reader ever sees a half-file.

    A crash mid-write would otherwise leave a truncated artifact that parses as
    far as it goes, which is the most dangerous possible failure: partially valid.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        # allow_nan=False is the point. Python happily emits bare NaN and
        # Infinity, which Python itself re-reads but which are NOT valid JSON —
        # the browser's JSON.parse rejects them. Without this a single
        # non-finite value produces a file that looks fine on this side and
        # breaks the page silently. Better to raise here.
        serialised = json.dumps(
            payload, indent=2, sort_keys=False, allow_nan=False
        )
    except ValueError as exc:
        temporary.unlink(missing_ok=True)
        raise ArtifactContractError(
            f"refusing to write {path.name}: payload is not valid JSON ({exc}). "
            "A non-finite value would parse in Python and fail in the browser."
        ) from exc
    temporary.write_text(serialised + "\n")
    os.replace(temporary, path)
    return path


def export_gameweek_xp(
    draws,
    season: str,
    generated_at: str,
    rules: Rules,
    predictions_dir: Path,
    seed_entropy: int,
    fixture_specs: Optional[List[Any]] = None,
) -> Dict[str, Path]:
    """
    Validate, then write ``xp_gw{NN}.json`` and ``sim_params_gw{NN}.json``.

    Raises before writing anything if the artifact fails its contract. Callers in
    the daily pipeline are expected to catch that and record it in health.json
    while leaving the match-prediction artifacts untouched — the FPL layer is not
    yet load-bearing, and it must not be able to take the betting pages down.
    """
    artifact = build_xp_artifact(
        draws, season, generated_at, rules, fixture_specs
    )
    assert_valid_xp_artifact(artifact)

    directory = Path(predictions_dir) / "fpl"
    gameweek = f"{int(draws.gameweek):02d}"

    written = {
        "xp": write_json_atomically(artifact, directory / f"xp_gw{gameweek}.json"),
        "sim_params": write_json_atomically(
            build_sim_params(
                season, draws.gameweek, generated_at, seed_entropy,
                draws.n_draws, fixture_specs or [],
            ),
            directory / f"sim_params_gw{gameweek}.json",
        ),
    }
    logger.info(
        "wrote FPL xp artifact for GW%s: %d players, %d draws",
        gameweek,
        len(draws.element_ids),
        draws.n_draws,
    )
    return written
