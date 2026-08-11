"""
The rules of Fantasy Premier League, resolved from the API where possible.

Split by provenance, because the two halves have different failure modes:

* **API-derived** — the whole scoring table, squad size, positional quotas,
  budget, club limit, sell-on fee, banked-transfer cap and the chip calendar all
  live in `bootstrap-static` under `game_config.scoring`, `game_settings`,
  `element_types` and `chips`. These are authoritative and can change without
  notice, so they are read at runtime and diffed against what we expect.
* **Signed constants** — a handful of rules FPL publishes in prose but not in
  JSON: the `saves ÷ 3` and `goals conceded ÷ 2` divisors, the 60-minute
  threshold, the Defensive Contribution thresholds and counted action sets, and
  the fact that a red card absorbs the yellow deduction. These come from
  `pipeline/knowledge/rules_2627.yaml`, each with a primary-source URL, and are
  verified empirically by the replay oracle rather than trusted.

Drift handling is deliberately tiered (`verify_against_bootstrap`):

* **CRITICAL** — squad size, quotas, budget, club limit, sell-on fee, transfer
  cap. A change here invalidates every squad the optimiser has ever produced,
  so it raises.
* **SCORING** — the points table. A change is reported as a structured diff and
  marks the layer degraded. It does not raise: the daily match-prediction
  pipeline must keep running, and a wrong FPL points table cannot corrupt it.
* **INFORMATIONAL** — unknown chips. Recorded, and a guardrail elsewhere
  forbids recommending a chip we do not model.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

logger = logging.getLogger(__name__)

RULES_PATH = Path(__file__).resolve().parent.parent / "knowledge" / "rules_2627.yaml"

POSITIONS: Tuple[str, ...] = ("GKP", "DEF", "MID", "FWD")

# The API says "GKP"; the community season archive says "GK". Same position.
POSITION_ALIASES: Dict[str, str] = {
    "GKP": "GKP",
    "GK": "GKP",
    "GKP1": "GKP",
    "DEF": "DEF",
    "MID": "MID",
    "FWD": "FWD",
}

# Positions that existed in a past season but carry no scoring rules now.
# "AM" is the 2024/25 Assistant Manager chip: 322 archive rows, and every
# `mng_*` key in game_config.scoring is 0 for 2026/27, so it is gone. Such rows
# must be excluded explicitly rather than counted as unknown — an excluded row
# and an unrecognised one mean very different things for data quality.
RETIRED_POSITIONS: Tuple[str, ...] = ("AM",)


def normalise_position(raw: Any) -> Optional[str]:
    """
    Map a position label to the canonical set, or ``None`` if it has no rules.

    ``None`` means "deliberately not scoreable" for a retired position and
    "unrecognised" otherwise; callers distinguish via
    :func:`is_retired_position`.
    """
    if raw is None:
        return None
    return POSITION_ALIASES.get(str(raw).strip().upper())


def is_retired_position(raw: Any) -> bool:
    """Whether a label is a known position from a season whose rules are gone."""
    return raw is not None and str(raw).strip().upper() in RETIRED_POSITIONS

# Expected API values. Diffed against the live payload, never used in place of
# it, so a silent FPL change surfaces as a diff rather than as wrong output.
EXPECTED_SCORING: Dict[str, Any] = {
    "short_play": 1,
    "long_play": 2,
    "goals_scored": {"GKP": 10, "DEF": 6, "MID": 5, "FWD": 4},
    "assists": 3,
    "clean_sheets": {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0},
    "goals_conceded": {"GKP": -1, "DEF": -1, "MID": 0, "FWD": 0},
    "saves": 1,
    "penalties_saved": 5,
    "penalties_missed": -2,
    "yellow_cards": -1,
    "red_cards": -3,
    "own_goals": -2,
    "defensive_contribution": {"GKP": 0, "DEF": 2, "MID": 2, "FWD": 2},
}

EXPECTED_SETTINGS: Dict[str, Any] = {
    "squad_squadsize": 15,
    "squad_squadplay": 11,
    "squad_team_limit": 3,
    "squad_total_spend": 1000,       # tenths of a million
    "transfers_sell_on_fee": 0.5,
    "max_extra_free_transfers": 4,   # so at most 1 + 4 = 5 banked
    "element_sell_at_purchase_price": False,
    "ui_currency_multiplier": 10,
}

EXPECTED_QUOTAS: Dict[str, int] = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
EXPECTED_PLAY_BOUNDS: Dict[str, Tuple[int, int]] = {
    "GKP": (1, 1),
    "DEF": (3, 5),
    "MID": (2, 5),
    "FWD": (1, 3),
}

KNOWN_CHIPS: Tuple[str, ...] = ("wildcard", "freehit", "bboost", "3xc")

CRITICAL = "critical"
SCORING = "scoring"
INFORMATIONAL = "informational"


class RuleDriftError(RuntimeError):
    """A rule we build squads against has changed. Never swallow this."""


@dataclass(frozen=True)
class DefconRule:
    """Threshold and counted action set for one position."""

    threshold: Optional[int]
    counts: Tuple[str, ...]


@dataclass(frozen=True)
class Rules:
    """Fully resolved rules. Immutable; construct via :func:`load_rules`."""

    season: str
    # Scoring
    short_play: int
    long_play: int
    long_play_threshold: int
    goal_points: Dict[str, int]
    assist_points: int
    clean_sheet_points: Dict[str, int]
    goals_conceded_points: Dict[str, int]
    goals_conceded_per_penalty: int
    save_points: int
    saves_per_point: int
    penalty_save_points: int
    penalty_miss_points: int
    yellow_card_points: int
    red_card_points: int
    red_absorbs_yellow: bool
    own_goal_points: int
    defcon_points: Dict[str, int]
    defcon: Dict[str, DefconRule]
    # Squad and transfers
    squad_size: int
    lineup_size: int
    club_limit: int
    budget_tenths: int
    quotas: Dict[str, int]
    play_bounds: Dict[str, Tuple[int, int]]
    sell_on_fee: float
    max_banked_free_transfers: int
    # Provenance
    source: str = "signed_yaml_only"
    degraded: bool = False
    drift: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)
    unmodelled_chips: Tuple[str, ...] = field(default_factory=tuple)

    @property
    def budget(self) -> float:
        """Budget in millions, for display only. Arithmetic uses tenths."""
        return self.budget_tenths / 10


def _require_signed(entry: Dict[str, Any], path: str) -> Any:
    """Extract a signed rule value, refusing anything lacking provenance."""
    if not isinstance(entry, dict):
        raise ValueError(f"rules entry {path} must be a mapping")
    for key in ("verified_by", "verified_on"):
        if key not in entry:
            raise ValueError(
                f"rules entry {path} is missing '{key}'. Every non-API rule must "
                "cite a primary source before any module reads it."
            )
    if "value" not in entry:
        raise ValueError(f"rules entry {path} is missing 'value'")
    return entry["value"]


@lru_cache(maxsize=4)
def load_signed_rules(path: Optional[Path] = None) -> Dict[str, Any]:
    """Load and validate the signed, non-API rules."""
    path = Path(path) if path else RULES_PATH
    document = yaml.safe_load(path.read_text())

    divisors = document["divisors"]
    minutes = document["minutes"]
    defcon_block = document["defensive_contribution"]
    cards = document["cards"]

    # The defcon block signs the whole section rather than each position, so
    # validate it once and propagate.
    for key in ("verified_by", "verified_on"):
        if key not in defcon_block:
            raise ValueError(
                f"defensive_contribution is missing '{key}'"
            )

    thresholds: Dict[str, DefconRule] = {}
    for position in POSITIONS:
        spec = defcon_block["thresholds"][position]
        thresholds[position] = DefconRule(
            threshold=spec["value"],
            counts=tuple(spec.get("counts") or ()),
        )

    return {
        "season": str(document["season"]),
        "saves_per_point": _require_signed(
            divisors["saves_per_point"], "divisors.saves_per_point"
        ),
        "goals_conceded_per_penalty": _require_signed(
            divisors["goals_conceded_per_penalty"],
            "divisors.goals_conceded_per_penalty",
        ),
        "long_play_threshold": _require_signed(
            minutes["long_play_threshold"], "minutes.long_play_threshold"
        ),
        "defcon": thresholds,
        "defcon_stacks": defcon_block["stacks"]["value"],
        "red_absorbs_yellow": _require_signed(
            cards["red_absorbs_yellow"], "cards.red_absorbs_yellow"
        ),
    }


def _coerce_int(raw: Any, expected: int, label: str, drift: List[Dict[str, Any]]) -> int:
    """
    Coerce an API scoring value to int, recording drift rather than raising.

    A null or non-numeric value must degrade, not crash. The documented contract
    is that SCORING-tier drift is reported and marks the layer degraded while the
    daily match-prediction pipeline keeps running; a bare TypeError out of
    int(None) breaks that promise, and FPL has every freedom to null a field
    mid-season.
    """
    try:
        return int(raw)
    except (TypeError, ValueError):
        drift.append(
            {
                "tier": SCORING,
                "rule": f"scoring.{label}",
                "expected": expected,
                "actual": raw,
                "detail": "not coercible to int; using expected value",
            }
        )
        logger.error(
            "scoring.%s is %r, not a number; falling back to %s and marking the "
            "FPL layer degraded",
            label,
            raw,
            expected,
        )
        return int(expected)


def _positional(
    raw: Any,
    expected: Dict[str, Any],
    label: str,
    drift: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, int]:
    """Coerce a per-position API mapping, recording drift on anything unusable."""
    drift = drift if drift is not None else []
    if isinstance(raw, dict):
        return {
            p: _coerce_int(raw.get(p, expected[p]), expected[p], f"{label}.{p}", drift)
            for p in POSITIONS
        }
    drift.append(
        {
            "tier": SCORING,
            "rule": f"scoring.{label}",
            "expected": "per-position mapping",
            "actual": type(raw).__name__,
            "detail": "not a mapping; using expected values",
        }
    )
    logger.error(
        "scoring.%s is not a mapping (%r); using expected values and marking the "
        "FPL layer degraded",
        label,
        raw,
    )
    return dict(expected)


def verify_against_bootstrap(bootstrap: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Diff the live API rules against what this code was written for.

    Returns a list of drift records, each with a ``tier``. Raises
    :class:`RuleDriftError` if any CRITICAL rule moved — those invalidate squad
    legality itself, so continuing would produce confidently illegal teams.
    """
    drift: List[Dict[str, Any]] = []

    settings = bootstrap.get("game_settings", {}) or {}
    for key, expected in EXPECTED_SETTINGS.items():
        if key not in settings:
            drift.append(
                {"tier": CRITICAL, "rule": f"game_settings.{key}",
                 "expected": expected, "actual": None, "detail": "absent"}
            )
            continue
        actual = settings[key]
        if isinstance(expected, float):
            matches = abs(float(actual) - expected) < 1e-9
        else:
            matches = actual == expected
        if not matches:
            drift.append(
                {"tier": CRITICAL, "rule": f"game_settings.{key}",
                 "expected": expected, "actual": actual}
            )

    by_short = {
        et.get("singular_name_short"): et
        for et in bootstrap.get("element_types", []) or []
    }
    for position, quota in EXPECTED_QUOTAS.items():
        element_type = by_short.get(position)
        if element_type is None:
            drift.append(
                {"tier": CRITICAL, "rule": f"element_types.{position}",
                 "expected": quota, "actual": None, "detail": "absent"}
            )
            continue
        if element_type.get("squad_select") != quota:
            drift.append(
                {"tier": CRITICAL, "rule": f"element_types.{position}.squad_select",
                 "expected": quota, "actual": element_type.get("squad_select")}
            )
        low, high = EXPECTED_PLAY_BOUNDS[position]
        if (element_type.get("squad_min_play"), element_type.get("squad_max_play")) != (low, high):
            drift.append(
                {"tier": CRITICAL, "rule": f"element_types.{position}.play_bounds",
                 "expected": [low, high],
                 "actual": [element_type.get("squad_min_play"),
                            element_type.get("squad_max_play")]}
            )

    scoring = (bootstrap.get("game_config", {}) or {}).get("scoring", {}) or {}
    if not scoring:
        drift.append(
            {"tier": SCORING, "rule": "game_config.scoring",
             "expected": "present", "actual": None, "detail": "absent"}
        )
    for key, expected in EXPECTED_SCORING.items():
        if key not in scoring:
            drift.append(
                {"tier": SCORING, "rule": f"scoring.{key}",
                 "expected": expected, "actual": None, "detail": "absent"}
            )
            continue
        actual = scoring[key]
        if isinstance(expected, dict):
            for position, value in expected.items():
                if isinstance(actual, dict) and actual.get(position) != value:
                    drift.append(
                        {"tier": SCORING, "rule": f"scoring.{key}.{position}",
                         "expected": value,
                         "actual": actual.get(position) if isinstance(actual, dict) else actual}
                    )
        elif actual != expected:
            drift.append(
                {"tier": SCORING, "rule": f"scoring.{key}",
                 "expected": expected, "actual": actual}
            )

    for chip in bootstrap.get("chips", []) or []:
        name = chip.get("name")
        if name and name not in KNOWN_CHIPS:
            drift.append(
                {"tier": INFORMATIONAL, "rule": f"chips.{name}",
                 "expected": "one of " + ", ".join(KNOWN_CHIPS), "actual": name,
                 "detail": "unmodelled chip"}
            )

    critical = [d for d in drift if d["tier"] == CRITICAL]
    if critical:
        raise RuleDriftError(
            "FPL squad rules have changed; every squad this code builds would be "
            f"suspect. Drift: {critical}"
        )
    return drift


def load_rules(
    bootstrap: Optional[Dict[str, Any]] = None,
    signed_path: Optional[Path] = None,
) -> Rules:
    """
    Resolve the full rule set.

    With ``bootstrap``, the scoring table and squad settings come from the live
    API and are diffed against expectations. Without it, the expected values are
    used — fine for pure unit tests, never for a sealed forecast.
    """
    signed = load_signed_rules(signed_path)

    drift: List[Dict[str, Any]] = []
    unmodelled: List[str] = []
    source = "signed_yaml_only"
    scoring: Dict[str, Any] = dict(EXPECTED_SCORING)
    settings: Dict[str, Any] = dict(EXPECTED_SETTINGS)
    quotas: Dict[str, int] = dict(EXPECTED_QUOTAS)
    play_bounds: Dict[str, Tuple[int, int]] = dict(EXPECTED_PLAY_BOUNDS)

    if bootstrap is not None:
        drift = verify_against_bootstrap(bootstrap)
        unmodelled = [
            d["actual"] for d in drift if d["tier"] == INFORMATIONAL
        ]
        source = "bootstrap+signed_yaml"

        live_scoring = (bootstrap.get("game_config", {}) or {}).get("scoring", {}) or {}
        if live_scoring:
            scalars = (
                "short_play", "long_play", "assists", "saves", "penalties_saved",
                "penalties_missed", "yellow_cards", "red_cards", "own_goals",
            )
            positional = (
                "goals_scored", "clean_sheets", "goals_conceded",
                "defensive_contribution",
            )
            scoring = {
                key: _coerce_int(
                    live_scoring.get(key, EXPECTED_SCORING[key]),
                    EXPECTED_SCORING[key],
                    key,
                    drift,
                )
                for key in scalars
            }
            scoring.update(
                {
                    key: _positional(
                        live_scoring.get(key), EXPECTED_SCORING[key], key, drift
                    )
                    for key in positional
                }
            )

        live_settings = bootstrap.get("game_settings", {}) or {}
        for key in EXPECTED_SETTINGS:
            if key in live_settings:
                settings[key] = live_settings[key]

        by_short = {
            et.get("singular_name_short"): et
            for et in bootstrap.get("element_types", []) or []
        }
        for position in POSITIONS:
            element_type = by_short.get(position)
            if element_type:
                quotas[position] = int(element_type.get("squad_select", quotas[position]))
                play_bounds[position] = (
                    int(element_type.get("squad_min_play", play_bounds[position][0])),
                    int(element_type.get("squad_max_play", play_bounds[position][1])),
                )

    scoring_drift = [d for d in drift if d["tier"] == SCORING]
    if scoring_drift:
        logger.error(
            "FPL scoring table drift detected (%d differences); FPL layer marked "
            "degraded: %s",
            len(scoring_drift),
            scoring_drift,
        )

    return Rules(
        season=signed["season"],
        short_play=scoring["short_play"],
        long_play=scoring["long_play"],
        long_play_threshold=int(signed["long_play_threshold"]),
        goal_points=scoring["goals_scored"],
        assist_points=scoring["assists"],
        clean_sheet_points=scoring["clean_sheets"],
        goals_conceded_points=scoring["goals_conceded"],
        goals_conceded_per_penalty=int(signed["goals_conceded_per_penalty"]),
        save_points=scoring["saves"],
        saves_per_point=int(signed["saves_per_point"]),
        penalty_save_points=scoring["penalties_saved"],
        penalty_miss_points=scoring["penalties_missed"],
        yellow_card_points=scoring["yellow_cards"],
        red_card_points=scoring["red_cards"],
        red_absorbs_yellow=bool(signed["red_absorbs_yellow"]),
        own_goal_points=scoring["own_goals"],
        defcon_points=scoring["defensive_contribution"],
        defcon=signed["defcon"],
        squad_size=int(settings["squad_squadsize"]),
        lineup_size=int(settings["squad_squadplay"]),
        club_limit=int(settings["squad_team_limit"]),
        budget_tenths=int(settings["squad_total_spend"]),
        quotas=quotas,
        play_bounds=play_bounds,
        sell_on_fee=float(settings["transfers_sell_on_fee"]),
        max_banked_free_transfers=int(settings["max_extra_free_transfers"]) + 1,
        source=source,
        degraded=bool(scoring_drift),
        drift=tuple(drift),
        unmodelled_chips=tuple(unmodelled),
    )


def selling_price(purchase_tenths: int, now_cost_tenths: int, sell_on_fee: float = 0.5) -> int:
    """
    Selling price in tenths: purchase price plus the retained share of any rise,
    rounded down. A fall is passed on in full.

    FPL keeps 50% of the profit and rounds against the manager, so a 0.3m rise
    returns 0.1m, not 0.15m.
    """
    if now_cost_tenths <= purchase_tenths:
        return int(now_cost_tenths)
    rise = now_cost_tenths - purchase_tenths
    return int(purchase_tenths + int(rise * (1.0 - sell_on_fee)))
