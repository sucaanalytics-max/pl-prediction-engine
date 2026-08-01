"""
Per-90 event rates for players, with shrinkage toward position priors.

These are the intensities the simulator draws from: goal and assist share within
a team, saves, defensive-contribution actions, cards, and an empirical bonus
lookup. Rates only — no scoring, no allocation, no randomness. The simulator owns
all of that.

Shrinkage is in pseudo-minutes rather than pseudo-appearances, because a rate
estimated from 200 minutes deserves less weight than the same rate from 2,000
even if both came from ten appearances.

Bonus is handled by an **empirical conditional lookup** rather than a model:
bonus depends on the whole match's BPS across 22 players, which is not
identifiable from one player's own drawn events. Instead we record the realised
distribution of bonus given (position, goals, assists, clean sheet) and sample
from it. Drawing from the distribution rather than using its mean matters — a
mean flattens exactly the players you would captain, and the right tail is what
the weekly objective maximises. This is still an approximation and the artifact
declares it as one; no tail-fidelity claim is made for bonus.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.fpl.rules import POSITIONS, Rules, load_rules, normalise_position
from pipeline.models.minutes import MinutesModel

logger = logging.getLogger(__name__)

# Per-90 quantities the simulator needs, and the archive column each derives
# from. Defensive contribution is deliberately absent: it is stored as component
# rates and summed for whichever position is being scored.
RATE_COLUMNS = {
    "xg_per_90": "expected_goals",
    "xa_per_90": "expected_assists",
    "saves_per_90": "saves",
    "yellow_per_90": "yellow_cards",
}

# Fallback rates for a player with no Premier League history, by position.
# Deliberately modest: an unknown player should not out-project a known one.
FALLBACK_RATES = {
    "GKP": {"xg_per_90": 0.002, "xa_per_90": 0.01, "saves_per_90": 2.6,
            "yellow_per_90": 0.06, "cbi_per_90": 1.2,
            "tackles_per_90": 0.05, "recoveries_per_90": 4.0},
    "DEF": {"xg_per_90": 0.05, "xa_per_90": 0.06, "saves_per_90": 0.0,
            "yellow_per_90": 0.20, "cbi_per_90": 4.8,
            "tackles_per_90": 1.7, "recoveries_per_90": 3.5},
    "MID": {"xg_per_90": 0.15, "xa_per_90": 0.15, "saves_per_90": 0.0,
            "yellow_per_90": 0.18, "cbi_per_90": 1.9,
            "tackles_per_90": 1.6, "recoveries_per_90": 4.0},
    "FWD": {"xg_per_90": 0.35, "xa_per_90": 0.15, "saves_per_90": 0.0,
            "yellow_per_90": 0.14, "cbi_per_90": 1.1,
            "tackles_per_90": 0.9, "recoveries_per_90": 3.0},
}


def _param(name: str) -> float:
    return float(PARAM_REGISTRY[name]["value"])


@dataclass(frozen=True)
class PlayerRates:
    """
    Shrunk per-90 rates for one player.

    Defensive contribution is stored as its COMPONENT rates, never as a single
    pre-summed ``dc_per_90``. The counted set is position-dependent — recoveries
    count for midfielders and forwards but not defenders — so a summed rate is
    silently wrong for any player FPL has reclassified between seasons, and it is
    wrong in the direction that matters: a midfielder's recovery-inflated rate
    judged against a defender's lower threshold.

    Measured before this was restructured: 10 players had rates fitted under
    their old position while the simulator applied their new one. Mats Wieffer
    (MID -> DEF) carried dc_per_90 11.94 from the midfield counted set against
    the defender threshold of 10, giving P(+2 | 90 min) of 0.752 where 0.269 was
    correct — overstating his expected points by roughly one per 90.

    ``position`` here records what the rates were FITTED on, for provenance.
    ``defcon_rate`` takes the position to apply.
    """

    position: str
    xg_per_90: float
    xa_per_90: float
    saves_per_90: float
    yellow_per_90: float
    cbi_per_90: float
    tackles_per_90: float
    recoveries_per_90: float
    minutes_observed: float
    evidence_weight: float

    def defcon_rate(self, position: str, rules: Optional[Rules] = None) -> float:
        """
        Qualifying defensive actions per 90 for the GIVEN position.

        Always computed from components against the position actually being
        scored, so a reclassified player cannot carry a stale counted set.
        """
        rules = rules or load_rules()
        canonical = normalise_position(position)
        if canonical is None:
            return 0.0
        available = {
            "clearances_blocks_interceptions": self.cbi_per_90,
            "tackles": self.tackles_per_90,
            "recoveries": self.recoveries_per_90,
        }
        return sum(available[name] for name in rules.defcon[canonical].counts)

    def as_dict(self) -> Dict[str, float]:
        return {
            "xg_per_90": self.xg_per_90,
            "xa_per_90": self.xa_per_90,
            "saves_per_90": self.saves_per_90,
            "yellow_per_90": self.yellow_per_90,
            "cbi_per_90": self.cbi_per_90,
            "tackles_per_90": self.tackles_per_90,
            "recoveries_per_90": self.recoveries_per_90,
            "minutes_observed": self.minutes_observed,
            "evidence_weight": self.evidence_weight,
        }


class PlayerEventRates:
    """Fitted per-90 rates plus the empirical bonus lookup."""

    def __init__(self) -> None:
        self.by_player: Dict[Any, PlayerRates] = {}
        self.by_position: Dict[str, Dict[str, float]] = {}
        # (position, goals, assists, clean_sheet) -> realised bonus values.
        self.bonus_samples: Dict[Tuple[str, int, int, int], np.ndarray] = {}
        self.assisted_goal_fraction: float = 0.75
        self.penalty_goal_fraction: float = 0.10
        self.fitted = False

    def fit(
        self,
        history: pd.DataFrame,
        key: str = "name_key",
        position_column: str = "position_norm",
        rules: Optional[Rules] = None,
    ) -> "PlayerEventRates":
        rules = rules or load_rules()
        frame = history.copy()
        frame["position_resolved"] = frame[position_column].map(normalise_position)
        frame = frame[frame["position_resolved"].notna()].copy()

        numeric = [
            "minutes", "goals_scored", "assists", "clean_sheets", "bonus",
            "yellow_cards", "saves", "expected_goals", "expected_assists",
        ]
        for column in numeric:
            if column in frame.columns:
                frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0)
            else:
                frame[column] = 0.0

        has_defcon_components = all(
            column in frame.columns
            for column in ("clearances_blocks_interceptions", "tackles", "recoveries")
        )
        if has_defcon_components:
            for column in ("clearances_blocks_interceptions", "tackles", "recoveries"):
                frame[column] = pd.to_numeric(
                    frame[column], errors="coerce"
                ).fillna(0)
        else:
            for column in ("clearances_blocks_interceptions", "tackles", "recoveries"):
                frame[column] = 0.0

        # Position priors, over players with meaningful exposure so that the
        # prior reflects footballers rather than the mass of unused substitutes.
        for position in POSITIONS:
            rows = frame[
                (frame["position_resolved"] == position) & (frame["minutes"] > 0)
            ]
            if rows.empty:
                self.by_position[position] = dict(FALLBACK_RATES[position])
                continue
            minutes = max(1.0, float(rows["minutes"].sum()))
            self.by_position[position] = {
                "xg_per_90": 90.0 * float(rows["expected_goals"].sum()) / minutes,
                "xa_per_90": 90.0 * float(rows["expected_assists"].sum()) / minutes,
                "saves_per_90": 90.0 * float(rows["saves"].sum()) / minutes,
                "yellow_per_90": 90.0 * float(rows["yellow_cards"].sum()) / minutes,
                "cbi_per_90": 90.0
                * float(rows["clearances_blocks_interceptions"].sum()) / minutes,
                "tackles_per_90": 90.0 * float(rows["tackles"].sum()) / minutes,
                "recoveries_per_90": 90.0 * float(rows["recoveries"].sum()) / minutes,
            }

        # Recency weighting, in exposure terms. The minutes model already does
        # this and it improved its Brier by 29%; the identical defect sat here
        # untouched, so a player's form from eight months ago counted as heavily
        # as last week. Weights multiply MINUTES, because these are per-90 rates:
        # down-weighting a stale appearance must shrink its exposure and its
        # events together or the ratio is unchanged.
        frame["_fixture_index"] = MinutesModel._fixture_index(frame)
        half_life = _param("events.recency_half_life_fixtures")
        latest = float(frame["_fixture_index"].max()) if len(frame) else 0.0
        frame["_w"] = 0.5 ** (
            (latest - frame["_fixture_index"].astype(float)) / max(half_life, 1e-6)
        )

        strength = _param("events.rate_shrinkage_per90")
        for player_key, rows in frame.groupby(key, dropna=True):
            positions = rows["position_resolved"].dropna()
            position = positions.iloc[-1] if len(positions) else "MID"
            prior = self.by_position.get(position, FALLBACK_RATES[position])
            weights = rows["_w"]
            minutes = float((rows["minutes"] * weights).sum())

            def rate(column: str, prior_key: str) -> float:
                total = float((rows[column] * weights).sum())
                return (90.0 * total + strength * prior[prior_key]) / (
                    minutes + strength
                )

            self.by_player[player_key] = PlayerRates(
                position=position,
                xg_per_90=rate("expected_goals", "xg_per_90"),
                xa_per_90=rate("expected_assists", "xa_per_90"),
                saves_per_90=rate("saves", "saves_per_90"),
                yellow_per_90=rate("yellow_cards", "yellow_per_90"),
                cbi_per_90=rate("clearances_blocks_interceptions", "cbi_per_90"),
                tackles_per_90=rate("tackles", "tackles_per_90"),
                recoveries_per_90=rate("recoveries", "recoveries_per_90"),
                minutes_observed=minutes,
                evidence_weight=minutes / (minutes + strength),
            )

        # Empirical bonus, conditioned on the events a draw actually produces.
        played = frame[frame["minutes"] > 0]
        for keys, rows in played.groupby(
            [
                "position_resolved",
                played["goals_scored"].clip(0, 2).astype(int),
                played["assists"].clip(0, 2).astype(int),
                played["clean_sheets"].clip(0, 1).astype(int),
            ]
        ):
            self.bonus_samples[tuple(keys)] = rows["bonus"].to_numpy(dtype=np.int64)

        total_goals = float(played["goals_scored"].sum())
        total_assists = float(played["assists"].sum())
        if total_goals > 0:
            self.assisted_goal_fraction = float(
                np.clip(total_assists / total_goals, 0.0, 1.0)
            )

        self.fitted = True
        logger.info(
            "PlayerEventRates fitted on %d rows: %d players, assisted-goal "
            "fraction %.3f, %d bonus buckets",
            len(frame),
            len(self.by_player),
            self.assisted_goal_fraction,
            len(self.bonus_samples),
        )
        return self

    def rates(self, position: str, player_key: Any = None) -> PlayerRates:
        """Rates for a player, falling back to the position prior."""
        canonical = normalise_position(position)
        if canonical is None:
            raise ValueError(f"cannot resolve rates for position {position!r}")

        existing = self.by_player.get(player_key) if player_key is not None else None
        if existing is not None:
            return existing

        prior = self.by_position.get(canonical, FALLBACK_RATES[canonical])
        return PlayerRates(
            position=canonical,
            xg_per_90=prior["xg_per_90"],
            xa_per_90=prior["xa_per_90"],
            saves_per_90=prior["saves_per_90"],
            yellow_per_90=prior["yellow_per_90"],
            cbi_per_90=prior["cbi_per_90"],
            tackles_per_90=prior["tackles_per_90"],
            recoveries_per_90=prior["recoveries_per_90"],
            minutes_observed=0.0,
            evidence_weight=0.0,
        )

    def sample_bonus(
        self,
        position: str,
        goals: np.ndarray,
        assists: np.ndarray,
        clean_sheet: np.ndarray,
        rng: np.random.Generator,
    ) -> np.ndarray:
        """
        Draw bonus for a vector of simulated outcomes.

        Sampling from the realised distribution within each bucket rather than
        taking its mean: the mean flattens the players most likely to be
        captained, and the right tail is precisely what the weekly objective
        maximises.
        """
        canonical = normalise_position(position) or "MID"
        goals = np.asarray(goals)
        assists = np.asarray(assists)
        clean_sheet = np.asarray(clean_sheet)
        out = np.zeros(len(goals), dtype=np.int64)

        buckets = set(
            zip(
                np.clip(goals, 0, 2).astype(int),
                np.clip(assists, 0, 2).astype(int),
                np.clip(clean_sheet, 0, 1).astype(int),
            )
        )
        for goal_count, assist_count, cs in buckets:
            mask = (
                (np.clip(goals, 0, 2).astype(int) == goal_count)
                & (np.clip(assists, 0, 2).astype(int) == assist_count)
                & (np.clip(clean_sheet, 0, 1).astype(int) == cs)
            )
            samples = self.bonus_samples.get(
                (canonical, int(goal_count), int(assist_count), int(cs))
            )
            if samples is None or len(samples) == 0:
                # No observation of this combination: fall back to the same
                # combination ignoring the clean sheet, then to zero. Never
                # invent a bonus.
                samples = self.bonus_samples.get(
                    (canonical, int(goal_count), int(assist_count), 0)
                )
            if samples is None or len(samples) == 0:
                continue
            out[mask] = rng.choice(samples, size=int(mask.sum()), replace=True)
        return out
