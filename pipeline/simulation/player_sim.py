"""
Joint per-draw player simulation: FPL points for every player, per simulation.

This is the object every downstream number is a functional of. The season team
reads its expectation; the weekly team reads its right tail. One simulator, two
objectives, off the same draws — which is only sound because the draws are
*joint*: within a single draw, a team's goals are allocated to specific players,
the assist on a goal goes to a teammate who was on the pitch at that minute, and
a clean sheet is derived from whether the opposition actually scored while this
player was playing.

Marginal models get that last part badly wrong. A clean sheet is one event shared
by a whole defence, so treating four defenders' clean sheets as independent
understates the variance of owning several by a factor of roughly the square root
of their number — and it is exactly the correlated upside the weekly team is
built to exploit.

Implementation shape: **loop over players, vectorise over draws.** A fixture has
around 36 relevant players and tens of thousands of draws, so a Python loop over
the small axis with numpy over the large one is both the fastest and the
clearest arrangement.

Declared approximations, all recorded in the output:

* goal minutes are uniform over 1-90, so concessions are slightly mispriced for
  players withdrawn near the hour;
* substitute appearances are drawn independently, so the number of substitutions
  in a draw is only right on average;
* bonus is sampled from an empirical conditional distribution, not from a BPS
  model, and carries no tail-fidelity claim.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from pipeline.config import PARAM_REGISTRY
from pipeline.fpl.rules import POSITIONS, Rules, load_rules
from pipeline.fpl.scoring import score_arrays
from pipeline.models.minutes import RoleProbabilities
from pipeline.models.player_events import PlayerEventRates, PlayerRates

logger = logging.getLogger(__name__)

POSITION_INDEX = {position: index for index, position in enumerate(POSITIONS)}

# Penalties awarded per team per match. Constant, not refit-eligible: with
# roughly one per team every eight matches there is no power to fit it per club,
# and a wrong value moves points by a fraction of one.
PENALTIES_PER_TEAM_MATCH = 0.13
PENALTY_CONVERSION_RATE = 0.79
# Straight or second-yellow dismissals per team per match.
REDS_PER_TEAM_MATCH = 0.05
# A reserve keeper appears only through injury or a dismissal to the starter.
KEEPER_SUBSTITUTION_RATE = 0.015


@dataclass(frozen=True)
class PlayerInput:
    """Everything the simulator needs about one player in one fixture."""

    element_id: int
    position: str
    roles: RoleProbabilities
    rates: PlayerRates
    # 1 = first-choice penalty taker. None = no listed duty.
    penalty_order: Optional[int] = None
    player_key: Any = None


@dataclass
class PlayerDraws:
    """Per-draw points and the components behind them."""

    element_ids: List[int] = field(default_factory=list)
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int64))
    minutes: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int16))
    goals: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int8))
    assists: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int8))
    clean_sheets: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int8))
    notes: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> List[Dict[str, Any]]:
        """Per-player distribution summary, in element order."""
        rows = []
        for index, element_id in enumerate(self.element_ids):
            column = self.points[:, index]
            rows.append(
                {
                    "element_id": element_id,
                    "xp": float(column.mean()),
                    "xp_sd": float(column.std()),
                    "p_appears": float((self.minutes[:, index] > 0).mean()),
                    "p_60": float((self.minutes[:, index] >= 60).mean()),
                    "e_minutes": float(self.minutes[:, index].mean()),
                    "e_goals": float(self.goals[:, index].mean()),
                    "e_assists": float(self.assists[:, index].mean()),
                    "p_clean_sheet": float((self.clean_sheets[:, index] > 0).mean()),
                    "p_goal": float((self.goals[:, index] > 0).mean()),
                    "p_ge_5": float((column >= 5).mean()),
                    "p_ge_10": float((column >= 10).mean()),
                    "q10": float(np.quantile(column, 0.10)),
                    "q50": float(np.quantile(column, 0.50)),
                    "q90": float(np.quantile(column, 0.90)),
                }
            )
        return rows


def _allocate_formation(
    expected: Dict[str, float], bounds: Dict[str, Tuple[int, int]], total: int
) -> Dict[str, int]:
    """
    Choose an outfield shape from expected starts, respecting FPL's bounds.

    Deterministic per fixture. Real managers' shapes are stable week to week, and
    drawing one per simulation would add variance the data cannot support.
    """
    groups = [g for g in ("DEF", "MID", "FWD")]
    weight_total = sum(max(0.0, expected.get(g, 0.0)) for g in groups) or 1.0
    raw = {g: total * max(0.0, expected.get(g, 0.0)) / weight_total for g in groups}

    counts = {g: int(np.clip(np.floor(raw[g]), bounds[g][0], bounds[g][1])) for g in groups}

    # Largest-remainder, but never past a bound.
    while sum(counts.values()) < total:
        candidates = [g for g in groups if counts[g] < bounds[g][1]]
        if not candidates:
            break
        pick = max(candidates, key=lambda g: raw[g] - counts[g])
        counts[pick] += 1
    while sum(counts.values()) > total:
        candidates = [g for g in groups if counts[g] > bounds[g][0]]
        if not candidates:
            break
        pick = min(candidates, key=lambda g: raw[g] - counts[g])
        counts[pick] -= 1
    return counts


def _sample_exact_count(
    probabilities: np.ndarray,
    count: int,
    n_draws: int,
    rng: np.random.Generator,
    max_attempts: int = 16,
) -> np.ndarray:
    """
    Sample a boolean matrix with exactly ``count`` selections per draw.

    Conditional Bernoulli by rejection: draw independently, keep the draws whose
    total is right, retry the rest. This preserves each player's marginal
    inclusion probability *conditional on the count*, which weighted sampling
    without replacement does not — and the marginal is what makes ``p_start`` in
    the ledger mean anything when it is later scored.

    Falls back to weighted selection without replacement for any draw still
    unresolved after ``max_attempts``, so it always terminates.
    """
    n_players = len(probabilities)
    selected = np.zeros((n_draws, n_players), dtype=bool)
    if n_players == 0 or count <= 0:
        return selected
    if count >= n_players:
        selected[:] = True
        return selected

    probabilities = np.clip(probabilities, 1e-6, 1 - 1e-6)
    unresolved = np.arange(n_draws)

    for _ in range(max_attempts):
        if unresolved.size == 0:
            break
        trial = rng.random((unresolved.size, n_players)) < probabilities[None, :]
        accepted = trial.sum(axis=1) == count
        if accepted.any():
            selected[unresolved[accepted]] = trial[accepted]
        unresolved = unresolved[~accepted]

    if unresolved.size:
        weights = probabilities / probabilities.sum()
        for draw in unresolved:
            picks = rng.choice(n_players, size=count, replace=False, p=weights)
            selected[draw, picks] = True
    return selected


def _categorical_rows(weights: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Draw one column index per row, proportional to that row's weights.

    Raises on a non-finite row rather than letting numpy's normalisation quietly
    send every goal to column 0. That is not hypothetical: two promoted clubs
    have identically zero prior expected goals, so a naive implementation
    attributes every one of their goals to whichever player happens to be first.
    A zero-weight row falls back to uniform over the eligible columns.
    """
    if not np.isfinite(weights).all():
        raise ValueError("non-finite weights in categorical draw")

    totals = weights.sum(axis=1)
    if (totals < 0).any():
        raise ValueError("negative weights in categorical draw")

    degenerate = totals <= 0
    if degenerate.any():
        eligible = weights.shape[1]
        weights = weights.copy()
        weights[degenerate] = 1.0 / max(1, eligible)
        totals = weights.sum(axis=1)

    cumulative = np.cumsum(weights, axis=1)
    draw = rng.random(weights.shape[0]) * totals
    return (cumulative < draw[:, None]).sum(axis=1).clip(0, weights.shape[1] - 1)


def _simulate_side(
    players: Sequence[PlayerInput],
    team_goals: np.ndarray,
    goal_minutes: np.ndarray,
    opposition_goal_minutes: np.ndarray,
    team_yellows: np.ndarray,
    events: PlayerEventRates,
    rules: Rules,
    rng: np.random.Generator,
) -> Dict[str, np.ndarray]:
    """Simulate one team's players against an already-drawn match state."""
    n_draws = len(team_goals)
    n_players = len(players)
    positions = [p.position for p in players]

    # ── Roles and on-pitch intervals ───────────────────────────────────────
    starts = np.zeros((n_draws, n_players), dtype=bool)

    keeper_indices = [i for i, p in enumerate(positions) if p == "GKP"]
    if keeper_indices:
        keeper_p = np.array([players[i].roles.p_start for i in keeper_indices])
        chosen = _sample_exact_count(keeper_p, 1, n_draws, rng)
        for local, index in enumerate(keeper_indices):
            starts[:, index] = chosen[:, local]

    expected_by_group = {
        group: sum(
            players[i].roles.p_start
            for i, position in enumerate(positions)
            if position == group
        )
        for group in ("DEF", "MID", "FWD")
    }
    formation = _allocate_formation(
        expected_by_group, rules.play_bounds, rules.lineup_size - 1
    )
    for group, count in formation.items():
        indices = [i for i, position in enumerate(positions) if position == group]
        if not indices:
            continue
        group_p = np.array([players[i].roles.p_start for i in indices])
        chosen = _sample_exact_count(group_p, min(count, len(indices)), n_draws, rng)
        for local, index in enumerate(indices):
            starts[:, index] = chosen[:, local]

    # Substitute appearances among non-starters, drawn independently, so the
    # number of substitutions in any single draw is only right on average.
    #
    # Calibrated at squad level first. The per-player conditional the minutes
    # model can estimate is P(appear | did not start), but the archive lists the
    # whole registered squad rather than the matchday twenty, so that quantity
    # is diluted by players who were never available to come on. Left
    # uncalibrated it produced 2.99 substitute appearances per fixture-team
    # against a measured 4.14. Renormalising the squad's total — rather than
    # applying a fixed multiplier — keeps this robust to how many players the
    # caller passes in.
    # RoleProbabilities.p_bench_appear is already unconditional — it has the
    # "did not start" factor baked in. The draw below applies `~starts` as a
    # mask, so feeding it that number would discount by the non-start
    # probability twice.
    # Goalkeepers are excluded from the outfield substitute pool and given a low
    # fixed rate instead. A reserve keeper comes on only for an injury or a
    # dismissal, so treating him as one of four interchangeable substitutes
    # produced two appearing keepers in a material share of draws — and the
    # measured 4.14 target is effectively all outfield.
    is_keeper = np.array([p.position == "GKP" for p in players])

    unconditional = np.array(
        [
            0.0 if keeper else max(0.0, player.roles.p_bench_appear)
            for keeper, player in zip(is_keeper, players)
        ]
    )
    total = unconditional.sum()
    target = float(PARAM_REGISTRY["minutes.substitutes_per_fixture"]["value"])
    bench_saturated = False
    if total > 0:
        # A squad with barely more than eleven plausible starters cannot supply
        # four substitutes. Forcing the target anyway would make every fringe
        # player a near-certain appearance, which is how a 19%-start defender
        # ends up projecting like a nailed one. Detect it and say so rather than
        # silently producing that.
        headroom_available = float((1.0 - starts.mean(axis=0)).sum())
        if headroom_available < target:
            bench_saturated = True
            logger.warning(
                "squad of %d has only %.2f non-starting slots against a target "
                "of %.2f substitute appearances; bench layer is saturated and "
                "fringe players will be over-projected. Pass a fuller squad.",
                n_players,
                headroom_available,
                target,
            )
        unconditional = unconditional * (target / total)

    # Convert to the conditional the mask needs, dividing by the REALISED
    # non-start rate rather than 1 - p_start. The exact-count sampler forces
    # eleven starters, so the realised rate is what actually gates the draw.
    realised_not_start = 1.0 - starts.mean(axis=0)
    conditional = np.divide(
        unconditional,
        np.maximum(realised_not_start, 1e-6),
        out=np.zeros_like(unconditional),
        where=realised_not_start > 1e-6,
    )

    # Clipping loses mass where a player saturates, so redistribute once over
    # the players with headroom to keep the squad total on target.
    clipped = np.clip(conditional, 0.0, 1.0)
    shortfall = float(
        ((conditional - clipped) * realised_not_start).sum()
    )
    if shortfall > 1e-9:
        headroom = (1.0 - clipped) * realised_not_start
        if headroom.sum() > 1e-9:
            clipped = np.clip(
                clipped + (1.0 - clipped) * (shortfall / headroom.sum()), 0.0, 1.0
            )
    conditional = clipped

    # Reserve keepers rejoin here, at their own much lower rate.
    conditional = np.where(is_keeper, KEEPER_SUBSTITUTION_RATE, conditional)

    bench_appear = np.zeros((n_draws, n_players), dtype=bool)
    for index in range(n_players):
        if conditional[index] <= 0:
            continue
        eligible = ~starts[:, index]
        bench_appear[:, index] = eligible & (rng.random(n_draws) < conditional[index])

    entry = np.full((n_draws, n_players), -1, dtype=np.int16)
    exit_minute = np.full((n_draws, n_players), -1, dtype=np.int16)

    for index, player in enumerate(players):
        started = starts[:, index]
        # Starters: on from minute 0. Whether they pass the hour is drawn from
        # p_60_if_start, which the minutes model calibrates directly; the shape
        # within each branch is approximate, but the 60-minute mass — the only
        # threshold the scoring function keys on — is not.
        p60 = player.roles.p_60_if_start
        long_branch = rng.random(n_draws) < p60
        mean_long = np.clip(
            (player.roles.minutes_if_start - (1 - p60) * 35.0) / max(p60, 1e-6),
            60.0,
            90.0,
        )
        # Two-point mixture on [60, 90] matching that conditional mean.
        share_full = np.clip((mean_long - 60.0) / 30.0, 0.0, 1.0)
        long_exit = np.where(rng.random(n_draws) < share_full, 90, rng.integers(60, 90, n_draws))
        short_exit = rng.integers(1, 60, n_draws)
        starter_exit = np.where(long_branch, long_exit, short_exit)

        came_on = bench_appear[:, index]
        bench_minutes = np.clip(player.roles.minutes_if_bench, 1, 89)
        bench_entry = np.clip(90 - rng.poisson(bench_minutes, n_draws), 1, 89)

        entry[:, index] = np.where(started, 0, np.where(came_on, bench_entry, -1))
        exit_minute[:, index] = np.where(
            started, starter_exit, np.where(came_on, 90, -1)
        )

    on_pitch = entry >= 0
    minutes = np.where(on_pitch, exit_minute - entry, 0).astype(np.int16)

    # ── Cards, with a red truncating the interval ──────────────────────────
    yellow = np.zeros((n_draws, n_players), dtype=np.int8)
    red = np.zeros((n_draws, n_players), dtype=np.int8)

    yellow_weights = np.array(
        [max(0.0, p.rates.yellow_per_90) for p in players]
    )
    for index in range(n_players):
        rate = yellow_weights[index] * np.maximum(minutes[:, index], 0) / 90.0
        yellow[:, index] = (rng.random(n_draws) < np.clip(rate, 0, 0.95)).astype(np.int8)

    red_rate = REDS_PER_TEAM_MATCH
    red_events = rng.random(n_draws) < red_rate
    if red_events.any():
        weights = np.where(on_pitch[red_events], np.maximum(yellow_weights, 1e-6), 0.0)
        culprit = _categorical_rows(weights, rng)
        rows = np.where(red_events)[0]
        red[rows, culprit] = 1
        card_minute = rng.integers(20, 91, len(rows))
        current_exit = exit_minute[rows, culprit]
        exit_minute[rows, culprit] = np.minimum(current_exit, card_minute)
        minutes = np.where(on_pitch, exit_minute - entry, 0).astype(np.int16)
        minutes = np.maximum(minutes, 0).astype(np.int16)

    # ── Penalties ──────────────────────────────────────────────────────────
    awarded = rng.poisson(PENALTIES_PER_TEAM_MATCH, n_draws)
    converted = rng.binomial(awarded, PENALTY_CONVERSION_RATE)
    converted = np.minimum(converted, np.minimum(team_goals, goal_minutes.shape[1]))
    missed = np.maximum(awarded - converted, 0)

    taker_order = np.array(
        [p.penalty_order if p.penalty_order else 99 for p in players]
    )
    taker_weight = np.where(taker_order == 1, 100.0, np.where(taker_order <= 3, 10.0, 0.0))

    # ── Goal and assist allocation, per goal slot ──────────────────────────
    goals = np.zeros((n_draws, n_players), dtype=np.int8)
    assists = np.zeros((n_draws, n_players), dtype=np.int8)
    penalties_missed = np.zeros((n_draws, n_players), dtype=np.int8)

    xg_share = np.array([max(1e-6, p.rates.xg_per_90) for p in players])
    xa_share = np.array([max(1e-6, p.rates.xa_per_90) for p in players])

    max_slots = goal_minutes.shape[1]
    for slot in range(max_slots):
        minute = goal_minutes[:, slot]
        live = minute > 0
        if not live.any():
            continue
        rows = np.where(live)[0]
        minute_live = minute[rows]

        available = (
            (entry[rows] >= 0)
            & (entry[rows] <= minute_live[:, None])
            & (exit_minute[rows] >= minute_live[:, None])
        )

        # A converted penalty in this slot goes to the designated taker if he is
        # on the pitch at that minute, not to a generic xG-weighted scorer.
        is_penalty = slot < converted[rows]
        weights = np.where(available, xg_share[None, :], 0.0)
        penalty_weights = np.where(available, taker_weight[None, :], 0.0)
        combined = np.where(
            is_penalty[:, None] & (penalty_weights.sum(axis=1, keepdims=True) > 0),
            penalty_weights,
            weights,
        )
        scorer = _categorical_rows(combined, rng)
        goals[rows, scorer] += 1

        # Assists are child events of this goal: same draw, same minute, and the
        # scorer cannot assist his own goal. Without this the score-and-assist
        # combination is impossible and the right tail is clipped.
        assisted = rng.random(len(rows)) < events.assisted_goal_fraction
        assist_weights = np.where(available, xa_share[None, :], 0.0)
        assist_weights[np.arange(len(rows)), scorer] = 0.0
        assist_weights[~assisted] = 0.0
        has_candidate = assist_weights.sum(axis=1) > 0
        if has_candidate.any():
            sub_rows = rows[has_candidate]
            assister = _categorical_rows(assist_weights[has_candidate], rng)
            assists[sub_rows, assister] += 1

    if missed.any():
        rows = np.where(missed > 0)[0]
        weights = np.where(on_pitch[rows], np.maximum(taker_weight, 1e-6)[None, :], 0.0)
        taker = _categorical_rows(weights, rng)
        penalties_missed[rows, taker] += 1

    # ── Concessions and clean sheets, from the interval ────────────────────
    conceded = np.zeros((n_draws, n_players), dtype=np.int16)
    for slot in range(opposition_goal_minutes.shape[1]):
        minute = opposition_goal_minutes[:, slot]
        live = minute > 0
        if not live.any():
            continue
        overlap = (
            live[:, None]
            & (entry >= 0)
            & (entry <= minute[:, None])
            & (exit_minute >= minute[:, None])
        )
        conceded += overlap.astype(np.int16)

    clean_sheet = ((minutes >= rules.long_play_threshold) & (conceded == 0)).astype(np.int8)

    # ── Saves and defensive contribution ───────────────────────────────────
    saves = np.zeros((n_draws, n_players), dtype=np.int16)
    defcon_actions = np.zeros((n_draws, n_players), dtype=np.int16)
    penalties_saved = np.zeros((n_draws, n_players), dtype=np.int8)

    for index, player in enumerate(players):
        exposure = np.maximum(minutes[:, index], 0) / 90.0
        if player.position == "GKP":
            saves[:, index] = rng.poisson(
                np.maximum(player.rates.saves_per_90, 0.0) * exposure
            )
        if player.rates.dc_per_90 > 0:
            defcon_actions[:, index] = rng.poisson(
                player.rates.dc_per_90 * exposure
            )

    # ── Bonus and scoring ──────────────────────────────────────────────────
    bonus = np.zeros((n_draws, n_players), dtype=np.int64)
    for index, player in enumerate(players):
        bonus[:, index] = events.sample_bonus(
            player.position,
            goals[:, index],
            assists[:, index],
            clean_sheet[:, index],
            rng,
        )
    bonus = np.where(minutes > 0, bonus, 0)

    position_index = np.array([POSITION_INDEX[p] for p in positions])[None, :]
    position_index = np.broadcast_to(position_index, minutes.shape)

    points = score_arrays(
        position_index=position_index,
        minutes=minutes,
        goals_scored=goals,
        assists=assists,
        goals_conceded=conceded,
        own_goals=np.zeros_like(goals),
        penalties_saved=penalties_saved,
        penalties_missed=penalties_missed,
        yellow_cards=yellow,
        red_cards=red,
        saves=saves,
        bonus=bonus,
        defcon_actions=defcon_actions,
        rules=rules,
    )

    return {
        "points": points,
        "minutes": minutes,
        "goals": goals,
        "assists": assists,
        "clean_sheets": clean_sheet,
        "conceded": conceded,
        "starts": starts.astype(np.int8),
        "bench_saturated": bench_saturated,
    }


def simulate_fixture_players(
    sims: Dict[str, Any],
    home_players: Sequence[PlayerInput],
    away_players: Sequence[PlayerInput],
    events: PlayerEventRates,
    rules: Optional[Rules] = None,
    rng: Optional[np.random.Generator] = None,
) -> PlayerDraws:
    """
    Simulate both sides of one fixture against a drawn match state.

    ``sims`` must come from
    :meth:`pipeline.simulation.montecarlo.MonteCarloSimulator.simulate_match_state`,
    so the goal minutes are present.
    """
    rules = rules or load_rules()
    generator = rng if rng is not None else np.random.default_rng()

    for required in ("home_goal_minutes", "away_goal_minutes"):
        if required not in sims:
            raise ValueError(
                f"{required} missing; use simulate_match_state, not simulate_match"
            )

    home = _simulate_side(
        home_players, sims["home_goals"], sims["home_goal_minutes"],
        sims["away_goal_minutes"], sims["home_yellows"], events, rules, generator,
    )
    away = _simulate_side(
        away_players, sims["away_goals"], sims["away_goal_minutes"],
        sims["home_goal_minutes"], sims["away_yellows"], events, rules, generator,
    )

    return PlayerDraws(
        element_ids=[p.element_id for p in home_players]
        + [p.element_id for p in away_players],
        points=np.concatenate([home["points"], away["points"]], axis=1),
        minutes=np.concatenate([home["minutes"], away["minutes"]], axis=1),
        goals=np.concatenate([home["goals"], away["goals"]], axis=1),
        assists=np.concatenate([home["assists"], away["assists"]], axis=1),
        clean_sheets=np.concatenate(
            [home["clean_sheets"], away["clean_sheets"]], axis=1
        ),
        notes={
            "goal_minute_model": sims.get("goal_minute_model", "unknown"),
            "bonus_method": "empirical_conditional_bucket",
            "bonus_tail_claim": False,
            "substitution_count_exact": False,
            "bench_appearance_calibrated_to": float(
                PARAM_REGISTRY["minutes.substitutes_per_fixture"]["value"]
            ),
            "bench_saturated": bool(
                home.get("bench_saturated") or away.get("bench_saturated")
            ),
            "n_draws": int(len(sims["home_goals"])),
        },
    )
