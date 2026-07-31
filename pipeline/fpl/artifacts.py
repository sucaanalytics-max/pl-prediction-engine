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
QUANTILE_KEYS = ("q10", "q50", "q90", "q99")


class ArtifactContractError(AssertionError):
    """An artifact failed a blocking check. Never swallow this."""


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
                "home_team": spec.home_team,
                "away_team": spec.away_team,
                "kickoff": spec.kickoff,
                "lambda_home": round(float(spec.lambda_home), 4),
                "mu_away": round(float(spec.mu_away), 4),
            }
            for spec in (fixture_specs or [])
        ],
        "players": draws.summary_rows(),
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
                "home_team": spec.home_team,
                "away_team": spec.away_team,
                "lambda_home": float(spec.lambda_home),
                "mu_away": float(spec.mu_away),
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
