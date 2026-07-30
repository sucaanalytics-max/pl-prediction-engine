"""
The FPL scoring function. Pure, deterministic, exhaustively tested.

No statistics live here. Given what a player actually did in a match and the
resolved rules, this returns what FPL pays for it. That is verifiable against
tens of thousands of settled real gameweeks, which is exactly what
:mod:`pipeline.fpl.replay` does.

Two implementations, deliberately:

* :func:`score_player` — scalar and readable. The canonical definition.
* :func:`score_arrays` — vectorised over numpy arrays, for scoring a
  ``(draws, players)`` simulation matrix without a Python loop.

A test asserts they agree on randomised inputs. If they ever diverge, the scalar
one is right.

Subtleties that are easy to get wrong, all verified against the settled prior
season:

* **Clean sheets and the concession penalty use the player's OWN
  ``goals_conceded``**, which FPL reports for time on the pitch only — never the
  opposition's final score. A defender substituted at 60 minutes with the score
  at 0-0 keeps his clean sheet even if his team then concedes twice.
* **A red card absorbs the yellow.** A second bookable offence costs -3 total,
  not -4.
* **Defensive Contribution does not stack** and its counted action set differs
  by position: recoveries count for midfielders and forwards but not defenders,
  and goalkeepers never earn it.
* **Bonus arrives already settled.** It is an input here, never modelled.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, Dict, Optional

import numpy as np

from pipeline.fpl.rules import POSITIONS, Rules, load_rules


@dataclass(frozen=True)
class PlayerMatch:
    """What one player did in one fixture."""

    position: str
    minutes: int = 0
    goals_scored: int = 0
    assists: int = 0
    # Goals conceded by the player's team WHILE THIS PLAYER WAS ON THE PITCH.
    goals_conceded: int = 0
    own_goals: int = 0
    penalties_saved: int = 0
    penalties_missed: int = 0
    yellow_cards: int = 0
    red_cards: int = 0
    saves: int = 0
    bonus: int = 0
    # Defensive-contribution components.
    clearances_blocks_interceptions: int = 0
    tackles: int = 0
    recoveries: int = 0

    def __post_init__(self) -> None:
        if self.position not in POSITIONS:
            raise ValueError(
                f"unknown position {self.position!r}; expected one of {POSITIONS}"
            )


@dataclass(frozen=True)
class ScoreBreakdown:
    """Points by component. ``total`` is the sum, by construction."""

    appearance: int = 0
    goals: int = 0
    assists: int = 0
    clean_sheet: int = 0
    goals_conceded: int = 0
    saves: int = 0
    penalties_saved: int = 0
    penalties_missed: int = 0
    cards: int = 0
    own_goals: int = 0
    defensive_contribution: int = 0
    bonus: int = 0

    @property
    def total(self) -> int:
        return sum(getattr(self, f.name) for f in fields(self))

    def as_dict(self) -> Dict[str, int]:
        payload = {f.name: getattr(self, f.name) for f in fields(self)}
        payload["total"] = self.total
        return payload


def defcon_count(
    position: str,
    clearances_blocks_interceptions: int = 0,
    tackles: int = 0,
    recoveries: int = 0,
    rules: Optional[Rules] = None,
) -> int:
    """
    Count of qualifying defensive actions for a position.

    Defenders: CBI + tackles. Midfielders and forwards: CBI + tackles +
    recoveries. Goalkeepers: always zero, regardless of what they did.

    This mirrors what ``elements[].defensive_contribution`` contains — a raw
    action count, *not* points. Recomputing it rather than reading that field is
    deliberate: FPL reclassifies players between seasons, and the counted set
    follows the position, so a cached count is wrong the moment a midfielder
    becomes a defender.
    """
    rules = rules or load_rules()
    available = {
        "clearances_blocks_interceptions": clearances_blocks_interceptions,
        "tackles": tackles,
        "recoveries": recoveries,
    }
    rule = rules.defcon[position]
    return sum(available[name] for name in rule.counts)


def _card_points(match: PlayerMatch, rules: Rules) -> int:
    """
    Card deduction for one player in one fixture.

    A red card absorbs the yellow: "Red card deductions include any points
    deducted for yellow cards", so a second bookable offence costs -3, not -4.
    """
    if match.red_cards > 0 and rules.red_absorbs_yellow:
        return rules.red_card_points
    return (
        match.yellow_cards * rules.yellow_card_points
        + match.red_cards * rules.red_card_points
    )


def score_player(
    match: PlayerMatch, rules: Optional[Rules] = None
) -> ScoreBreakdown:
    """Points for one player in one fixture, broken down by component."""
    rules = rules or load_rules()
    position = match.position

    if match.minutes <= 0:
        # No appearance point, but a card still costs. The rules define playing
        # in a Gameweek as "making an appearance on the pitch OR receiving a
        # yellow / red card", and a player can be booked without taking the
        # field. Verified against the settled prior season: exactly one such row
        # (0 minutes, 1 yellow card, -1 point) in 18,259 zero-minute rows. Every
        # other component was zero across all of them, including bonus.
        return ScoreBreakdown(cards=_card_points(match, rules))

    appearance = (
        rules.long_play
        if match.minutes >= rules.long_play_threshold
        else rules.short_play
    )

    goals = match.goals_scored * rules.goal_points[position]
    assists = match.assists * rules.assist_points

    # Clean sheet requires 60+ minutes AND nothing conceded while on the pitch.
    clean_sheet = 0
    if match.minutes >= rules.long_play_threshold and match.goals_conceded == 0:
        clean_sheet = rules.clean_sheet_points[position]

    # -1 per 2 conceded, goalkeepers and defenders only. The position
    # restriction is machine-readable (MID/FWD are 0); the divisor is not.
    conceded = (
        (match.goals_conceded // rules.goals_conceded_per_penalty)
        * rules.goals_conceded_points[position]
    )

    saves = (match.saves // rules.saves_per_point) * rules.save_points
    penalties_saved = match.penalties_saved * rules.penalty_save_points
    penalties_missed = match.penalties_missed * rules.penalty_miss_points

    cards = _card_points(match, rules)
    own_goals = match.own_goals * rules.own_goal_points

    threshold = rules.defcon[position].threshold
    defensive_contribution = 0
    if threshold is not None:
        count = defcon_count(
            position,
            match.clearances_blocks_interceptions,
            match.tackles,
            match.recoveries,
            rules,
        )
        if count >= threshold:
            # Awarded once, never in multiples.
            defensive_contribution = rules.defcon_points[position]

    return ScoreBreakdown(
        appearance=appearance,
        goals=goals,
        assists=assists,
        clean_sheet=clean_sheet,
        goals_conceded=conceded,
        saves=saves,
        penalties_saved=penalties_saved,
        penalties_missed=penalties_missed,
        cards=cards,
        own_goals=own_goals,
        defensive_contribution=defensive_contribution,
        bonus=match.bonus,
    )


def score_from_row(row: Dict[str, Any], position: str, rules: Optional[Rules] = None):
    """
    Score a settled data row (archive CSV or ``event/{gw}/live`` payload).

    ``position`` is passed explicitly rather than read from the row: reproducing
    a historical score needs the position FPL applied at the time, while
    projecting forward needs the current one. Making the caller choose stops
    that being decided by accident.
    """

    def _int(key: str) -> int:
        value = row.get(key, 0)
        if value is None or value == "":
            return 0
        return int(float(value))

    return score_player(
        PlayerMatch(
            position=position,
            minutes=_int("minutes"),
            goals_scored=_int("goals_scored"),
            assists=_int("assists"),
            goals_conceded=_int("goals_conceded"),
            own_goals=_int("own_goals"),
            penalties_saved=_int("penalties_saved"),
            penalties_missed=_int("penalties_missed"),
            yellow_cards=_int("yellow_cards"),
            red_cards=_int("red_cards"),
            saves=_int("saves"),
            bonus=_int("bonus"),
            clearances_blocks_interceptions=_int("clearances_blocks_interceptions"),
            tackles=_int("tackles"),
            recoveries=_int("recoveries"),
        ),
        rules=rules,
    )


def score_arrays(
    position_index: np.ndarray,
    minutes: np.ndarray,
    goals_scored: np.ndarray,
    assists: np.ndarray,
    goals_conceded: np.ndarray,
    own_goals: np.ndarray,
    penalties_saved: np.ndarray,
    penalties_missed: np.ndarray,
    yellow_cards: np.ndarray,
    red_cards: np.ndarray,
    saves: np.ndarray,
    bonus: np.ndarray,
    defcon_actions: np.ndarray,
    rules: Optional[Rules] = None,
) -> np.ndarray:
    """
    Vectorised scoring, for a whole simulation matrix at once.

    ``position_index`` indexes :data:`pipeline.fpl.rules.POSITIONS` and
    broadcasts against the other arrays. ``defcon_actions`` is the already
    position-appropriate action count (see :func:`defcon_count`), because the
    counted set varies by position and resolving it per element inside this
    function would defeat the vectorisation.

    Must agree with :func:`score_player` exactly; a test enforces that.
    """
    rules = rules or load_rules()

    def per_position(mapping: Dict[str, Any], default: Any = 0) -> np.ndarray:
        return np.array([mapping.get(p, default) for p in POSITIONS])

    goal_points = per_position(rules.goal_points)[position_index]
    cs_points = per_position(rules.clean_sheet_points)[position_index]
    gc_points = per_position(rules.goals_conceded_points)[position_index]
    dc_points = per_position(rules.defcon_points)[position_index]
    dc_threshold = per_position(
        {p: rules.defcon[p].threshold for p in POSITIONS}, default=None
    )
    # A null threshold (goalkeepers) can never be met; a sentinel above any
    # attainable action count expresses that without special-casing.
    dc_threshold = np.where(
        np.equal(dc_threshold, None), np.iinfo(np.int32).max, dc_threshold
    ).astype(np.int64)[position_index]

    played = minutes > 0
    long_play = minutes >= rules.long_play_threshold

    points = np.where(long_play, rules.long_play, rules.short_play)
    points = points + goals_scored * goal_points
    points = points + assists * rules.assist_points
    points = points + np.where(long_play & (goals_conceded == 0), cs_points, 0)
    points = points + (goals_conceded // rules.goals_conceded_per_penalty) * gc_points
    points = points + (saves // rules.saves_per_point) * rules.save_points
    points = points + penalties_saved * rules.penalty_save_points
    points = points + penalties_missed * rules.penalty_miss_points

    if rules.red_absorbs_yellow:
        cards = np.where(
            red_cards > 0,
            rules.red_card_points,
            yellow_cards * rules.yellow_card_points,
        )
    else:
        cards = (
            yellow_cards * rules.yellow_card_points
            + red_cards * rules.red_card_points
        )
    points = points + cards
    points = points + own_goals * rules.own_goal_points
    points = points + np.where(defcon_actions >= dc_threshold, dc_points, 0)
    points = points + bonus

    # A player who did not take the field scores only his card deduction; see
    # the zero-minute note in score_player.
    return np.where(played, points, cards).astype(np.int64)
