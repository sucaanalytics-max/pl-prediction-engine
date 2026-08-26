"""
Gameweek-level orchestration: run every fixture and combine per player.

Double and blank gameweeks are the whole reason this layer exists. The existing
frontend engine mishandles both — it slices *fixtures* rather than gameweeks, so
a double silently shortens the horizon and its second match is dropped from
captain expected value, while a blank falls through to a zero default.

Here:

* **Double gameweek** — a player appears once in the output, with his two
  fixtures summed *on the same draw index*. Fixtures are independent matches, so
  pairing draw d of one with draw d of the other is a legitimate coupling: it
  preserves each fixture's marginals and gives the correct distribution of the
  player's combined total, including its tail.
* **Blank gameweek** — the player is still present, with ``fixtures: []``,
  ``xp: 0.0`` and ``blank: true``. Never absent. A universe that changes shape
  between gameweeks cannot be scored consistently, and an absent player is
  indistinguishable from a player nobody projected.

Declared approximation: role draws are independent across a club's two fixtures
in a double, so the probability of two starts is p^2. Real rotation makes it
lower. A shared per-player rotation latent would fix it and is not yet fitted.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

import numpy as np

from pipeline.fpl.rules import Rules, load_rules
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.montecarlo import MonteCarloSimulator
from pipeline.simulation.player_sim import PlayerInput, simulate_fixture_players

logger = logging.getLogger(__name__)


def stable_hash(value: str) -> int:
    """
    Deterministic hash, stable across processes.

    Python's built-in ``hash`` is salted per interpreter, so using it to derive a
    simulation seed would make runs irreproducible while looking deterministic.
    """
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


@dataclass(frozen=True)
class FixtureSpec:
    """One fixture to simulate, with its blended goal rates."""

    match_id: str
    gameweek: int
    home_team: str
    away_team: str
    lambda_home: float
    mu_away: float
    kickoff: Optional[str] = None
    # Where lambda_home/mu_away came from: "market_blend" when odds anchored the
    # fixture, "dixon_coles_posterior" beyond the priced horizon, or
    # "ensemble_unanchored" on the legacy path. Carried here so the published
    # artifact can state it per fixture without a second lookup.
    rate_source: Optional[str] = None


@dataclass
class GameweekDraws:
    """Combined per-player point draws for one gameweek."""

    gameweek: int
    element_ids: List[int] = field(default_factory=list)
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int64))
    minutes: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int32))
    goals: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int16))
    assists: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int16))
    clean_sheets: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.int16))
    # element_id -> the fixtures that player featured in, in kickoff order.
    fixtures_by_element: Dict[int, List[str]] = field(default_factory=dict)
    # element_id -> "GKP"/"DEF"/"MID"/"FWD". Retained because a points
    # decomposition is position-dependent: a clean sheet is worth 4 to a
    # defender and 0 to a forward, so attributing one without the position
    # would credit strikers with points they cannot score.
    position_by_element: Dict[int, str] = field(default_factory=dict)
    # element_id -> how many of the player's own fixtures stand behind his minutes
    # estimate. 0 means the numbers are entirely prior-driven.
    #
    # Carried for the same reason as the position: it is per-player metadata the
    # arrays cannot hold, and a consumer that cannot see it makes a wrong call.
    # `RoleProbabilities.evidence_fixtures` says in its own comment that "the
    # optimiser must not treat a prior-only projection as equal to an
    # evidence-backed one" — and it was computed one module earlier and dropped
    # here, so `minutes_conflicts` classified fringe players by expected minutes
    # alone. A prior-only 20 minutes and a thirty-fixture 20 minutes were the same
    # row, which is precisely the distinction that report exists to draw.
    evidence_by_element: Dict[int, int] = field(default_factory=dict)
    notes: Dict[str, Any] = field(default_factory=dict)

    @property
    def n_draws(self) -> int:
        return int(self.points.shape[0])

    def index_of(self, element_id: int) -> int:
        return self.element_ids.index(element_id)


    def _decomposition(
        self, index: int, element_id: int, rules: Optional[Rules],
    ) -> Optional[Dict[str, float]]:
        """
        Where the expected points come from.

        Nobody in the category exposes this, and it is what makes a 6.4
        inspectable: 6.4 built from appearance points and a clean sheet is a
        different holding from 6.4 built from a 15% chance of a hat-trick.

        ``other`` is the residual — bonus, cards, saves, DefCon, own goals and
        the goals-conceded penalty — and is computed by subtraction rather than
        modelled, so the parts always sum to ``xp`` exactly. Reporting a
        decomposition whose parts do not add up to the headline is worse than
        reporting none.
        """
        if rules is None:
            return None
        position = self.position_by_element.get(element_id)
        if position is None:
            # No position, no clean-sheet value. Guessing one would credit a
            # forward with four points he cannot score.
            return None

        minutes = self.minutes[:, index]
        appearance = float(
            np.where(
                minutes >= rules.long_play_threshold,
                rules.long_play,
                np.where(minutes > 0, rules.short_play, 0),
            ).mean()
        )
        goals = float(self.goals[:, index].mean()) * rules.goal_points.get(position, 0)
        assists = float(self.assists[:, index].mean()) * rules.assist_points
        clean_sheets = float(
            (self.clean_sheets[:, index] > 0).mean()
        ) * rules.clean_sheet_points.get(position, 0)

        total = float(self.points[:, index].mean())
        return {
            "appearance": round(appearance, 4),
            "goals": round(goals, 4),
            "assists": round(assists, 4),
            "clean_sheets": round(clean_sheets, 4),
            "other": round(total - appearance - goals - assists - clean_sheets, 4),
        }

    def summary_rows(self, rules: Optional[Rules] = None) -> List[Dict[str, Any]]:
        """
        Per-player distribution summary.

        Both objectives read from here: the season team takes ``xp``, the weekly
        team takes the tail probabilities and quantiles. Reporting a mean alone
        would make the weekly objective unimplementable.

        ``mode`` and ``decomposition`` exist because a mean is actively
        misleading for a right-skewed distribution, and FPL points are wildly
        right-skewed. A midfielder with ``xp 6.4`` most often returns **2** —
        the mean is dragged by a haul that happens one week in six. Publishing
        only the mean is what every competitor does; publishing the mode beside
        it costs one line and changes the decision.

        ``decomposition`` is supplied only when ``rules`` is passed, because the
        value of a clean sheet depends on position and inventing one would
        credit forwards with points they cannot score.
        """
        rows: List[Dict[str, Any]] = []
        for index, element_id in enumerate(self.element_ids):
            column = self.points[:, index]
            fixtures = self.fixtures_by_element.get(element_id, [])
            rows.append(
                {
                    "mode": _mode_of(column),
                    "decomposition": self._decomposition(index, element_id, rules),
                    "element_id": int(element_id),
                    "fixtures": list(fixtures),
                    "n_fixtures": len(fixtures),
                    "blank": len(fixtures) == 0,
                    "xp": float(column.mean()),
                    "xp_sd": float(column.std()),
                    "p_appears": float((self.minutes[:, index] > 0).mean()),
                    "p_60": float((self.minutes[:, index] >= 60).mean()),
                    "e_minutes": float(self.minutes[:, index].mean()),
                    # Published so a consumer can tell a prior-driven estimate from
                    # an evidence-backed one at the same expected minutes. See the
                    # field's note on `GameweekDraws`.
                    "evidence_fixtures": int(
                        self.evidence_by_element.get(int(element_id), 0)
                    ),
                    "e_goals": float(self.goals[:, index].mean()),
                    "e_assists": float(self.assists[:, index].mean()),
                    "p_goal": float((self.goals[:, index] > 0).mean()),
                    "p_multi_goal": float((self.goals[:, index] > 1).mean()),
                    "p_clean_sheet": float((self.clean_sheets[:, index] > 0).mean()),
                    "p_ge_2": float((column >= 2).mean()),
                    "p_ge_5": float((column >= 5).mean()),
                    "p_ge_10": float((column >= 10).mean()),
                    "p_ge_15": float((column >= 15).mean()),
                    "q10": float(np.quantile(column, 0.10)),
                    # The interquartile pair. The frontend has threaded q25 and
                    # q75 into its distribution glyph since it was written and
                    # the glyph has been omitting the box, because nothing
                    # computed them — the design derived them from the standard
                    # deviation, which is a normal assumption this distribution
                    # does not satisfy: a haul is a rare large draw, not a wide
                    # symmetric one.
                    "q25": float(np.quantile(column, 0.25)),
                    "q50": float(np.quantile(column, 0.50)),
                    "q75": float(np.quantile(column, 0.75)),
                    "q90": float(np.quantile(column, 0.90)),
                    "q99": float(np.quantile(column, 0.99)),
                    # Monte Carlo standard error of xp, so a caller can tell a
                    # real difference between two players from sampling noise.
                    "mc_se": float(column.std() / max(1.0, np.sqrt(len(column)))),
                }
            )
        return rows


def _mode_of(column: "np.ndarray") -> Optional[int]:
    """
    The most frequent point total.

    Ties break to the LOWEST total. FPL point distributions are bimodal at the
    bottom — 0 for not playing and 1 or 2 for playing without returning — and a
    tie between them broken upward would report the optimistic half of a
    coin flip as the typical outcome.
    """
    if column.size == 0:
        return None
    values, counts = np.unique(column, return_counts=True)
    best = counts.max()
    return int(values[counts == best].min())


def simulate_gameweek(
    fixtures: Sequence[FixtureSpec],
    squads: Mapping[str, Sequence[PlayerInput]],
    events: PlayerEventRates,
    rules: Optional[Rules] = None,
    n_draws: int = 10_000,
    seed_entropy: int = 0,
    all_element_ids: Optional[Sequence[int]] = None,
) -> GameweekDraws:
    """
    Simulate every fixture in a gameweek and combine per player.

    ``all_element_ids`` fixes the output universe. Any id in it that does not
    feature in a fixture is emitted as a blank rather than omitted, which is what
    keeps the universe stable across gameweeks so paired comparisons remain valid.

    Seeding is derived from ``(seed_entropy, match_id)`` via a spawned
    ``SeedSequence``, so a rerun with the same parameters is bit-identical and a
    diff in the output means a real parameter change — not a reseed.
    """
    rules = rules or load_rules()

    ordered: List[int] = []
    seen = set()
    for team_players in squads.values():
        for player in team_players:
            if player.element_id not in seen:
                seen.add(player.element_id)
                ordered.append(player.element_id)
    for element_id in all_element_ids or ():
        if element_id not in seen:
            seen.add(element_id)
            ordered.append(int(element_id))

    position_of = {}
    evidence_of = {}
    for team_players in squads.values():
        for player in team_players:
            position_of[player.element_id] = player.position
            evidence_of[player.element_id] = int(
                getattr(player.roles, "evidence_fixtures", 0) or 0
            )

    n_players = len(ordered)
    column_of = {element_id: index for index, element_id in enumerate(ordered)}

    points = np.zeros((n_draws, n_players), dtype=np.int64)
    minutes = np.zeros((n_draws, n_players), dtype=np.int32)
    goals = np.zeros((n_draws, n_players), dtype=np.int16)
    assists = np.zeros((n_draws, n_players), dtype=np.int16)
    clean_sheets = np.zeros((n_draws, n_players), dtype=np.int16)
    fixtures_by_element: Dict[int, List[str]] = {}

    simulator = MonteCarloSimulator(n_simulations=n_draws)
    skipped: List[str] = []

    for fixture in fixtures:
        home = squads.get(fixture.home_team)
        away = squads.get(fixture.away_team)
        if not home or not away:
            # A fixture we cannot field is skipped and reported. Simulating it
            # with an empty squad would emit confident zeros for both clubs.
            skipped.append(fixture.match_id)
            logger.warning(
                "no squad for %s or %s; skipping fixture %s",
                fixture.home_team,
                fixture.away_team,
                fixture.match_id,
            )
            continue

        sequence = np.random.SeedSequence(
            entropy=seed_entropy, spawn_key=(stable_hash(fixture.match_id),)
        )
        rng = np.random.default_rng(sequence)
        # The legacy simulate_match path uses numpy's global state, so it must be
        # seeded too or the goal draws would vary between otherwise identical runs.
        np.random.seed(int(stable_hash(fixture.match_id) % (2**32)))

        sims = simulator.simulate_match_state(
            fixture.lambda_home, fixture.mu_away, rng=rng
        )
        draws = simulate_fixture_players(sims, home, away, events, rules, rng)

        for local, element_id in enumerate(draws.element_ids):
            column = column_of[element_id]
            # `+=` is what makes a double gameweek correct: the same player's two
            # fixtures accumulate on the same draw index.
            points[:, column] += draws.points[:, local]
            minutes[:, column] += draws.minutes[:, local]
            goals[:, column] += draws.goals[:, local]
            assists[:, column] += draws.assists[:, local]
            clean_sheets[:, column] += draws.clean_sheets[:, local]
            fixtures_by_element.setdefault(element_id, []).append(fixture.match_id)

    doubles = sum(1 for ids in fixtures_by_element.values() if len(ids) > 1)
    blanks = n_players - len(fixtures_by_element)

    return GameweekDraws(
        gameweek=int(fixtures[0].gameweek) if fixtures else 0,
        element_ids=ordered,
        points=points,
        minutes=minutes,
        goals=goals,
        assists=assists,
        clean_sheets=clean_sheets,
        fixtures_by_element=fixtures_by_element,
        position_by_element=dict(position_of),
        evidence_by_element=dict(evidence_of),
        notes={
            "n_draws": int(n_draws),
            "n_fixtures": len(fixtures),
            "n_fixtures_skipped": len(skipped),
            "skipped_fixtures": skipped,
            "n_players": n_players,
            "n_double_gameweek_players": doubles,
            "n_blank_gameweek_players": blanks,
            "seed_entropy": int(seed_entropy),
            "dgw_rotation_correlation_modelled": False,
        },
    )
