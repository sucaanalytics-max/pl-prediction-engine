"""
Minutes and role model: will this player play, and for how long.

This is the largest single source of expected-points error. A state-of-the-art
attacking model still loses on aggregate through minutes alone, because most
player-gameweeks are zeros and getting the zeros wrong swamps getting the
haulers right.

Three roles per fixture, exhaustive and mutually exclusive: **start**,
**appear as a substitute**, **unused**. Their probabilities sum to 1 before the
availability gate and are scaled by it afterwards, so the gate can never push
mass outside [0, 1].

Estimation is empirical-Bayes with explicit shrinkage rather than a filter. A
player with two fixtures of history is pulled hard toward his position's prior;
a player with thirty is barely moved. Nothing is excluded for a low sample —
exclusion would silently delete exactly the rotation-risk players the optimiser
most needs an honest number for. Every prediction carries the weight of its own
evidence so a caller can tell a well-supported 0.9 from a prior-driven one.

Availability comes from FPL's `status` and `chance_of_playing_next_round`. That
field is sparse and lags, so a missing value is treated as *no information* and
falls back to the status — never as 100%.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.fpl.rules import POSITIONS, normalise_position

logger = logging.getLogger(__name__)

# FPL availability status codes.
STATUS_AVAILABLE = "a"
STATUS_DOUBTFUL = "d"
STATUS_INJURED = "i"
STATUS_SUSPENDED = "s"
STATUS_UNAVAILABLE = "u"
STATUS_NOT_IN_SQUAD = "n"

# A player FPL has marked unavailable or removed from the squad cannot play.
# These are hard gates, not priors: no amount of history overrides them.
HARD_GATE_STATUSES = frozenset({STATUS_UNAVAILABLE, STATUS_NOT_IN_SQUAD})

# Fallback when a player has no Premier League history at all (a signing from
# abroad). Deliberately pessimistic on starting: an unknown player is more
# likely to be squad filler than an immediate starter, and the alternative —
# assuming the position mean — would have the optimiser buy unknowns eagerly.
NEW_SIGNING_START_RATE = 0.35


def _param(name: str) -> float:
    return float(PARAM_REGISTRY[name]["value"])


@dataclass(frozen=True)
class RoleProbabilities:
    """Role distribution and minutes expectations for one player-fixture."""

    p_start: float
    p_bench_appear: float
    p_unused: float
    minutes_if_start: float
    minutes_if_bench: float
    p_60_if_start: float
    availability: float
    # Fixtures of the player's own history behind this estimate. 0 means the
    # numbers are entirely prior-driven; the optimiser must not treat a
    # prior-only projection as equal to an evidence-backed one.
    evidence_fixtures: int
    evidence_weight: float
    gate_reason: Optional[str] = None

    @property
    def p_appears(self) -> float:
        return self.p_start + self.p_bench_appear

    @property
    def p_60(self) -> float:
        """P(60+ minutes). A substitute appearance essentially never reaches it."""
        return self.p_start * self.p_60_if_start

    @property
    def expected_minutes(self) -> float:
        return (
            self.p_start * self.minutes_if_start
            + self.p_bench_appear * self.minutes_if_bench
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "p_start": self.p_start,
            "p_bench_appear": self.p_bench_appear,
            "p_unused": self.p_unused,
            "p_appears": self.p_appears,
            "p_60": self.p_60,
            "minutes_if_start": self.minutes_if_start,
            "minutes_if_bench": self.minutes_if_bench,
            "p_60_if_start": self.p_60_if_start,
            "expected_minutes": self.expected_minutes,
            "availability": self.availability,
            "evidence_fixtures": self.evidence_fixtures,
            "evidence_weight": self.evidence_weight,
            "gate_reason": self.gate_reason,
        }


def availability(
    status: Optional[str],
    chance_of_playing: Optional[float],
    news_age_days: Optional[float] = None,
) -> Tuple[float, Optional[str]]:
    """
    Probability the player is available, and the reason if it is gated.

    Order matters. A hard-gate status wins outright. Otherwise an explicit
    ``chance_of_playing`` is believed, because it is FPL's own judgement. Only
    when that is absent do we fall back to the status — and a missing value
    never means "fine".
    """
    code = (status or STATUS_AVAILABLE).strip().lower()

    if code in HARD_GATE_STATUSES:
        return 0.0, f"status_{code}"

    if chance_of_playing is not None:
        chance = float(chance_of_playing)
        if chance <= 0:
            return 0.0, "chance_of_playing_zero"
        return min(1.0, chance / 100.0), None

    if code == STATUS_AVAILABLE:
        return 1.0, None

    # A stale note on an otherwise-available player stops suppressing him: FPL
    # often leaves an old flag in place after a return.
    stale_after = _param("minutes.news_staleness_days")
    if news_age_days is not None and news_age_days > stale_after:
        return 1.0, "news_stale"

    if code == STATUS_DOUBTFUL:
        return _param("minutes.doubtful_default"), "doubtful_no_chance_field"
    if code in (STATUS_INJURED, STATUS_SUSPENDED):
        return _param("minutes.injured_default"), f"status_{code}_no_chance_field"

    return 0.0, f"unrecognised_status_{code}"


def horizon_availability_factor(horizon: int) -> float:
    """
    How much a current availability estimate should be discounted ``horizon``
    gameweeks ahead. 1.0 for the immediate gameweek.

    A player fit today may be injured, rested or out of the side in six weeks.
    That risk accumulates but does not compound forever — it reverts toward a
    long-run base rate — so this is ``floor + (1 - floor) * rho^h`` rather than a
    geometric decay.

    Without this, the horizon treats a GW+6 projection as being as certain as a
    GW+1 one, which measurably overstates far-horizon availability by around
    15% and makes distant fixtures look more attractive than they are.
    """
    floor = _param("minutes.horizon_availability_floor")
    rho = _param("minutes.horizon_availability_rho")
    return float(floor + (1.0 - floor) * rho ** max(0, int(horizon)))


def _shrink(
    observed_numerator: float,
    observed_denominator: float,
    prior: float,
    strength: float,
) -> float:
    """Posterior mean of a rate under a conjugate prior of ``strength`` pseudo-observations."""
    return (observed_numerator + strength * prior) / (observed_denominator + strength)


class MinutesModel:
    """
    Fitted role and minutes model.

    ``fit`` consumes settled per-fixture history — the linked season archive, and
    in-season the current campaign's rows appended. It is deliberately a
    frequency model with shrinkage rather than a classifier: with one observation
    per player per fixture and a heavily zero-inflated target, a well-specified
    hierarchical rate is both more honest and more interpretable than a fitted
    black box, and its parameters are few enough to actually identify.
    """

    def __init__(self) -> None:
        self.by_player: Dict[Any, Dict[str, float]] = {}
        self.by_position: Dict[str, Dict[str, float]] = {}
        self.fitted = False

    @staticmethod
    def _fixture_index(frame: pd.DataFrame) -> pd.Series:
        """
        A monotonic ordering of fixtures within and across seasons.

        Built from (season, GW) when a season column exists. Ordering on GW alone
        across concatenated seasons interleaves them — last season's GW38 would
        sort after this season's GW1 — which is exactly the defect that crippled
        the recency baseline in the backtest.
        """
        gameweek = pd.to_numeric(frame.get("GW", 0), errors="coerce").fillna(0)
        if "season" in frame.columns:
            seasons = sorted(str(s) for s in frame["season"].dropna().unique())
            rank = {season: index for index, season in enumerate(seasons)}
            offset = frame["season"].astype(str).map(rank).fillna(0) * 38
            return offset + gameweek
        return gameweek

    def fit(
        self,
        history: pd.DataFrame,
        key: str = "code",
        position_column: str = "position_current",
    ) -> "MinutesModel":
        """
        Fit from settled per-fixture rows.

        ``position_column`` defaults to the *current* classification, not the
        historical one: FPL reclassifies players between seasons, and a position
        prior built from stale labels is wrong for exactly the players whose
        role changed.
        """
        required = {"minutes", "starts", key, position_column}
        missing = required - set(history.columns)
        if missing:
            raise ValueError(f"history is missing required columns: {sorted(missing)}")

        frame = history.copy()
        frame["minutes"] = pd.to_numeric(frame["minutes"], errors="coerce").fillna(0)
        frame["starts"] = pd.to_numeric(frame["starts"], errors="coerce").fillna(0)
        frame["_position"] = frame[position_column].map(normalise_position)
        frame = frame[frame["_position"].notna()]

        # Recency weighting. Without it every fixture counts equally, so a player
        # who started 30 of 38 last season but has been benched for the last five
        # still projects as a starter. Measured consequence: a trivial
        # five-fixture recency heuristic beat this model on Brier and on both MAE
        # bands, losing only on calibration. Uniform weighting was the deficiency.
        #
        # Weights are relative to the most recent fixture in the TRAINING data,
        # shared across players, so someone who stopped playing months ago is
        # correctly discounted rather than merely having fewer rows.
        frame["_fixture_index"] = self._fixture_index(frame)
        half_life = _param("minutes.recency_half_life_fixtures")
        latest = float(frame["_fixture_index"].max()) if len(frame) else 0.0
        age = latest - frame["_fixture_index"].astype(float)
        frame["_w"] = 0.5 ** (age / max(half_life, 1e-6))

        started = frame["starts"] > 0
        appeared = frame["minutes"] > 0

        # Position-level priors first: they are what individual players shrink
        # toward, so they must be computed over everyone.
        for position in POSITIONS:
            rows = frame[frame["_position"] == position]
            if rows.empty:
                self.by_position[position] = {
                    "start_rate": NEW_SIGNING_START_RATE,
                    "minutes_if_start": 80.0,
                    "minutes_if_bench": 20.0,
                    "p_60_if_start": 0.8,
                    "bench_appear_rate": 0.3,
                }
                continue
            rows_started = rows[rows["starts"] > 0]
            rows_bench = rows[(rows["starts"] == 0) & (rows["minutes"] > 0)]
            rows_not_started = rows[rows["starts"] == 0]
            self.by_position[position] = {
                "start_rate": float((rows["starts"] > 0).mean()),
                "minutes_if_start": float(rows_started["minutes"].mean())
                if len(rows_started)
                else 80.0,
                "minutes_if_bench": float(rows_bench["minutes"].mean())
                if len(rows_bench)
                else 20.0,
                "p_60_if_start": float((rows_started["minutes"] >= 60).mean())
                if len(rows_started)
                else 0.8,
                "bench_appear_rate": float((rows_not_started["minutes"] > 0).mean())
                if len(rows_not_started)
                else 0.3,
            }

        grouped = frame.groupby(key, dropna=True)
        for player_key, rows in grouped:
            rows_started = rows[rows["starts"] > 0]
            rows_not_started = rows[rows["starts"] == 0]
            rows_bench = rows_not_started[rows_not_started["minutes"] > 0]
            positions = rows["_position"].dropna()
            # Every count is a recency-weighted sum. `n_fixtures` becomes an
            # effective sample size, which is also the right input to the
            # evidence weight surfaced downstream: thirty stale fixtures should
            # not read as strong evidence.
            self.by_player[player_key] = {
                "n_fixtures": float(rows["_w"].sum()),
                "n_starts": float(rows.loc[rows["starts"] > 0, "_w"].sum()),
                "n_not_started": float(rows_not_started["_w"].sum()),
                "n_bench_appearances": float(rows_bench["_w"].sum()),
                "sum_minutes_if_start": float(
                    (rows_started["minutes"] * rows_started["_w"]).sum()
                ),
                "n_started_rows": float(rows_started["_w"].sum()),
                "sum_minutes_if_bench": float(
                    (rows_bench["minutes"] * rows_bench["_w"]).sum()
                ),
                "n_60_starts": float(
                    rows_started.loc[rows_started["minutes"] >= 60, "_w"].sum()
                ),
                "raw_fixtures": int(len(rows)),
                "position": positions.iloc[-1] if len(positions) else None,
            }

        self.fitted = True
        logger.info(
            "MinutesModel fitted on %d rows: %d players, position start rates %s",
            len(frame),
            len(self.by_player),
            {p: round(v["start_rate"], 3) for p, v in self.by_position.items()},
        )
        return self

    def predict(
        self,
        position: str,
        player_key: Any = None,
        status: Optional[str] = STATUS_AVAILABLE,
        chance_of_playing: Optional[float] = None,
        news_age_days: Optional[float] = None,
        fallback_start_rate: Optional[float] = None,
        horizon: int = 0,
    ) -> RoleProbabilities:
        """
        Role probabilities for one player-fixture.

        ``fallback_start_rate`` lets a caller supply a prior-season rate for a
        player with no per-fixture history — for instance ``starts / 38`` from the
        committed pre-season snapshot. It is used only as the shrinkage target,
        never as the answer, and it is clipped: a naive ``starts / matches_played``
        with the wrong denominator produced values above 8 in testing.
        """
        canonical = normalise_position(position)
        if canonical is None:
            raise ValueError(f"cannot predict for position {position!r}")

        prior = self.by_position.get(canonical) or {
            "start_rate": NEW_SIGNING_START_RATE,
            "minutes_if_start": 80.0,
            "minutes_if_bench": 20.0,
            "p_60_if_start": 0.8,
            "bench_appear_rate": 0.3,
        }

        start_prior = prior["start_rate"]
        if fallback_start_rate is not None:
            start_prior = float(np.clip(fallback_start_rate, 0.0, 1.0))

        stats = self.by_player.get(player_key) if player_key is not None else None
        n_fixtures = int(stats.get("raw_fixtures", 0)) if stats else 0
        n_effective = float(stats["n_fixtures"]) if stats else 0.0

        if stats:
            p_start = _shrink(
                stats["n_starts"], stats["n_fixtures"], start_prior,
                _param("minutes.start_shrinkage"),
            )
            p_bench_given_not_start = _shrink(
                stats["n_bench_appearances"], stats["n_not_started"],
                prior["bench_appear_rate"], _param("minutes.start_shrinkage"),
            )
            minutes_if_start = _shrink(
                stats["sum_minutes_if_start"], stats["n_started_rows"],
                prior["minutes_if_start"], _param("minutes.minutes_shrinkage"),
            )
            minutes_if_bench = _shrink(
                stats["sum_minutes_if_bench"], stats["n_bench_appearances"],
                prior["minutes_if_bench"], _param("minutes.minutes_shrinkage"),
            )
            p_60_if_start = _shrink(
                stats["n_60_starts"], stats["n_started_rows"],
                prior["p_60_if_start"], _param("minutes.p60_shrinkage"),
            )
        else:
            p_start = start_prior
            p_bench_given_not_start = prior["bench_appear_rate"]
            minutes_if_start = prior["minutes_if_start"]
            minutes_if_bench = prior["minutes_if_bench"]
            p_60_if_start = prior["p_60_if_start"]

        avail, gate_reason = availability(status, chance_of_playing, news_age_days)

        # Discount availability with forecast horizon. Applied to the AVAILABILITY
        # term rather than to the role split, so it reduces the chance of
        # featuring at all without distorting the start-versus-bench mix — which
        # is what an accumulating injury and rotation hazard actually does.
        if horizon > 0:
            avail *= horizon_availability_factor(horizon)

        # Roles are exhaustive before gating; the gate then scales the two
        # appearing branches and the residual accrues to "unused". This ordering
        # is what keeps every probability inside [0, 1] by construction.
        ungated_start = float(np.clip(p_start, 0.0, 1.0))
        ungated_bench = float(np.clip(p_bench_given_not_start, 0.0, 1.0)) * (
            1.0 - ungated_start
        )
        p_start = ungated_start * avail
        p_bench_appear = ungated_bench * avail
        p_bench_appear = float(np.clip(p_bench_appear, 0.0, 1.0 - p_start))
        p_unused = 1.0 - p_start - p_bench_appear

        strength = _param("minutes.start_shrinkage")
        evidence_weight = (
            n_effective / (n_effective + strength) if strength > 0 else 0.0
        )

        result = RoleProbabilities(
            p_start=p_start,
            p_bench_appear=p_bench_appear,
            p_unused=float(np.clip(p_unused, 0.0, 1.0)),
            minutes_if_start=float(np.clip(minutes_if_start, 0.0, 90.0)),
            minutes_if_bench=float(np.clip(minutes_if_bench, 0.0, 90.0)),
            p_60_if_start=float(np.clip(p_60_if_start, 0.0, 1.0)),
            availability=avail,
            evidence_fixtures=n_fixtures,
            evidence_weight=float(evidence_weight),
            gate_reason=gate_reason,
        )

        # Cheap, and it has already caught a real defect: a p_start above 1 makes
        # every downstream probability meaningless while still looking plausible
        # in an artifact.
        total = result.p_start + result.p_bench_appear + result.p_unused
        if not 0.999 <= total <= 1.001:
            raise AssertionError(
                f"role probabilities sum to {total}, not 1 "
                f"(start={result.p_start}, bench={result.p_bench_appear}, "
                f"unused={result.p_unused})"
            )
        return result
