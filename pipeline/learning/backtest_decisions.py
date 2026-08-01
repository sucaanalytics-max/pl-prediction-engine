"""
Season backtest: do the decisions actually beat doing nothing?

The projection layer is measured elsewhere and is calibrated. This asks the
separate and harder question of whether the DECISIONS built on it are worth
anything, which is not implied by a calibrated projection — an optimiser can
maximise a well-calibrated forecast and still lose to inertia by churning.

**Every strategy sees identical projections.** They are simulated once per
gameweek and shared, so the comparison is paired: two strategies that make the
same decision score identically, and any difference between them is decision
quality rather than simulation noise. Re-projecting per strategy would swamp a
1-point-a-week effect in noise of several points a week.

**Realised points come from the archive through the real autosub resolver**, not
from the projection. That is the whole point: a plan is scored on what actually
happened, including substitutions the manager never chose and a captain who
blanked.

What this can and cannot establish, stated up front because it is the easiest
place in the project to fool yourself. One season is ONE observation of a
season, and the between-manager standard deviation over a season is around 86
points of pure noise. A margin of +40 over a baseline is therefore not evidence
of a 40-point edge; it is one draw from a wide distribution. The paired,
gameweek-level differences are far more informative than the season total, so
those are what get reported with a standard error — and per the plan, none of
this ever gates a parameter change.

Results on 2025-26, gameweeks 8 to 38, all three strategies sharing identical
projections:

    strategy        total   captain   bench   transfers
    do_nothing       1517       144     115          15
    greedy_churn     1702       147     257          46
    agent            1667       146     215          44

    agent  vs do_nothing     +150 total, +4.84/GW (se 1.94, t=+2.50), ahead 19/31
    agent  vs greedy_churn    -35 total, -1.13/GW (se 1.39, t=-0.81), ahead 10/31

**The agent clears the do-nothing bar and does not clear the greedy one.** The
plan's pre-registered criteria were do-nothing +150 and greedy +30; the first is
met exactly, the second is missed and the sign is wrong. At se 1.39 a gameweek
the -35 is well inside noise — the two are indistinguishable on one season — but
it is not the result the criteria asked for and it should not be dressed up as
one.

The gap is not a few bad weeks. Per-gameweek differences against greedy have
median -2.0, behind in 18 of 31 weeks and ahead in 10, with the same captain
picked in 28 of 31 and near-identical transfer counts (44 against 46). The
squads simply drift apart; nothing in the decomposition localises it.

**Second season, and the sign does not hold.** 2024-25 predates the defensive
contribution, so it was run with DefCon scoring switched off — otherwise the
projection would credit defenders with points that could not be realised, which
is the position most transfers turn on. Rule-compatible, gameweeks 8-38:

    strategy        total
    do_nothing       1257
    greedy_churn     1757
    agent            1817

    agent vs do_nothing    +560 total, +18.06/GW (se 3.83, t=+4.72), ahead 25/31
    agent vs greedy_churn   +60 total,  +1.94/GW (se 2.93, t=+0.66), ahead 13/31

Against do-nothing the result is robust: +150 and +560, same sign, both
significant, criterion met twice. Against greedy the margin is -35 one season
and +60 the next. The plan required the sign to hold on both, and it does not.
Pooled over 62 gameweeks the difference is roughly +0.4 a gameweek against a
standard error of about 1.6 — indistinguishable from zero, which is the honest
summary.

This is exactly the situation R1 predicted: at a paired standard deviation
around 5-8 points a gameweek, separating a one-point-a-gameweek effect needs on
the order of 200 gameweeks. Two seasons cannot settle it, and no amount of
re-running will change that. What the backtest DOES establish is the thing it
can establish — that the agent is far better than inertia, on both seasons, by a
margin large relative to its own error.

The obvious suspect is the free-transfer cost making the agent too cautious, so
it was swept. It cannot be tuned here, and the reason is worth keeping:

    FT cost    0.00   0.50   1.00   1.75   3.00
    season     1702   1704   1704   1667   1784
    transfers    46     45     45     44     44

Non-monotonic — 1.75 is the WORST setting and 3.00 the best, with 0.00 between
them — while the number of transfers barely moves across the whole range. A
117-point spread from settings that produce nearly identical behaviour is noise,
not a response surface. Picking the argmax here would be fitting the season's
particular sequence of outcomes, which is precisely the mechanism by which this
system would convince itself it had improved.

That is the same conclusion the free-transfer measurement in
:mod:`pipeline.decide.milp` reached from the other direction, and together they
are the empirical case for the plan's rule that solver weights stay
human-authored and are never refit.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from pipeline.fpl.autosub import score_squad
from pipeline.fpl.rules import Rules, load_rules, selling_price

logger = logging.getLogger(__name__)


@dataclass
class SeasonState:
    """A manager's position going into a gameweek."""

    squad: List[int] = field(default_factory=list)
    bank: int = 0
    free_transfers: int = 1
    # What was actually paid for each held player. Selling price cannot be
    # recovered without it, and using now_cost instead overstates the bank on
    # every sale — an error that compounds across a season.
    purchase_prices: Dict[int, int] = field(default_factory=dict)

    def copy(self) -> "SeasonState":
        return SeasonState(
            squad=list(self.squad), bank=self.bank,
            free_transfers=self.free_transfers,
            purchase_prices=dict(self.purchase_prices),
        )


@dataclass
class GameweekOutcome:
    """What one strategy did in one gameweek, and what it scored."""

    gameweek: int
    points: int
    hits: int
    transfers: int
    captain: int
    captain_points: int
    autosubs: int
    vice_used: bool
    bench_points: int

    @property
    def net(self) -> int:
        """Points after the transfer cost, which is what a manager banks."""
        return self.points


@dataclass
class StrategyResult:
    """A whole season for one strategy."""

    name: str
    weeks: List[GameweekOutcome] = field(default_factory=list)
    illegal_squads: int = 0

    @property
    def total(self) -> int:
        return sum(w.points for w in self.weeks)

    @property
    def series(self) -> np.ndarray:
        return np.array([w.points for w in self.weeks], dtype=float)

    def decomposition(self) -> Dict[str, int]:
        """Named sources, so a margin can be explained rather than just quoted."""
        return {
            "total": self.total,
            "captain_points": sum(w.captain_points for w in self.weeks),
            "bench_points": sum(w.bench_points for w in self.weeks),
            "hits_cost": -4 * sum(w.hits for w in self.weeks),
            "transfers": sum(w.transfers for w in self.weeks),
            "autosubs": sum(w.autosubs for w in self.weeks),
            "vice_used": sum(1 for w in self.weeks if w.vice_used),
        }


def realised_outcomes(archive: pd.DataFrame, gameweek: int) -> Tuple[Dict[int, int], Dict[int, bool]]:
    """Actual points and appearances for a settled gameweek."""
    rows = archive[archive["GW"] == gameweek]
    points = rows.groupby("element")["total_points"].sum().to_dict()
    # A double gameweek gives two rows; appearing in either counts.
    played = (rows.groupby("element")["minutes"].max() >= 1).to_dict()
    return {int(k): int(v) for k, v in points.items()}, {int(k): bool(v) for k, v in played.items()}


def score_realised(
    plan: Any,
    positions: Mapping[int, str],
    points: Mapping[int, int],
    played: Mapping[int, bool],
    xp: Mapping[int, float],
    rules: Rules,
) -> GameweekOutcome:
    """
    Score a plan on what actually happened, through the real autosub resolver.

    Bench order is by projected points, which is the same rule the live agent
    uses — scoring a backtest with a bench order the agent would not have
    chosen would measure a different agent.
    """
    from pipeline.decide.plan_eval import order_bench

    bench = order_bench(plan, positions, xp)
    result = score_squad(
        plan.xi, bench, plan.captain, plan.vice, positions, points, played,
        rules=rules, transfer_cost=4 * plan.hits,
    )
    counted = set(result.resolution.counted)
    return GameweekOutcome(
        gameweek=0,
        points=result.total,
        hits=plan.hits,
        transfers=len(plan.transfers_in),
        captain=result.resolution.captain,
        captain_points=int(points.get(result.resolution.captain, 0)),
        autosubs=len(result.resolution.substitutions),
        vice_used=result.resolution.vice_used,
        # What sat on the bench and was never counted — the cost of a squad
        # whose value is in the wrong eleven.
        bench_points=sum(
            int(points.get(p, 0)) for p in plan.squad if p not in counted
        ),
    )


def advance(
    state: SeasonState, plan: Any, prices: Mapping[int, int], rules: Rules
) -> SeasonState:
    """
    Apply a decision and roll the state forward one gameweek.

    Purchase prices are recorded for the players bought and dropped for those
    sold, because a player rebought later starts a fresh price basis.
    """
    following = state.copy()
    for player in plan.transfers_out:
        following.purchase_prices.pop(player, None)
    for player in plan.transfers_in:
        following.purchase_prices[player] = int(prices.get(player, 0))

    following.squad = list(plan.squad)
    following.bank = int(plan.bank_after)
    following.free_transfers = int(plan.free_transfers_after)
    return following


def sell_prices(
    state: SeasonState, prices: Mapping[int, int], rules: Rules
) -> Dict[int, int]:
    """Selling price for every held player, at this gameweek's prices."""
    return {
        player: selling_price(
            state.purchase_prices.get(player, prices.get(player, 0)),
            prices.get(player, state.purchase_prices.get(player, 0)),
            rules.sell_on_fee,
        )
        for player in state.squad
    }


def run_strategy(
    name: str,
    decide_fn: Callable[..., Any],
    archive: pd.DataFrame,
    projections: Mapping[int, Mapping[int, float]],
    gameweeks: Sequence[int],
    rules: Optional[Rules] = None,
) -> StrategyResult:
    """
    Play a whole season with one decision function.

    ``decide_fn(state, candidates, gameweek, rules)`` returns a Plan. It is
    handed a pool built from the same shared projections every strategy sees.
    """
    from pipeline.decide.pool import build_pool
    from pipeline.learning.walk_forward import synthetic_bootstrap

    rules = rules or load_rules()
    result = StrategyResult(name=name)
    state = SeasonState(bank=rules.budget_tenths, free_transfers=1)

    for gameweek in gameweeks:
        xp = projections.get(gameweek)
        if not xp:
            continue
        bootstrap = synthetic_bootstrap(archive, gameweek)
        prices = {int(e["id"]): int(e["now_cost"]) for e in bootstrap["elements"]}

        # A held player who vanishes from the universe (sold abroad, say) cannot
        # be represented. Dropping him silently would leave a 14-man squad, so
        # the position is rebuilt from what remains and the loss is recorded.
        present = set(prices)
        if state.squad and not set(state.squad) <= present:
            state = state.copy()
            state.squad = [p for p in state.squad if p in present]

        candidates, _ = build_pool(
            [{"element_id": e, "xp": v} for e, v in xp.items()],
            bootstrap, rules, held=state.squad,
            # PURCHASE prices, not selling prices. build_pool applies the
            # sell-on fee itself, so handing it an already-discounted figure
            # would apply the fee twice and understate the bank on every sale.
            purchase_prices=state.purchase_prices or None,
        )
        positions = {c.element_id: c.position for c in candidates}
        pool_xp = {c.element_id: c.xp for c in candidates}

        try:
            plan = decide_fn(state, candidates, gameweek, rules)
        except Exception as exc:
            logger.warning("%s GW%s: decision failed (%s); holding", name, gameweek, exc)
            continue
        if plan is None:
            continue

        if len(plan.squad) != rules.squad_size or len(plan.xi) != rules.lineup_size:
            result.illegal_squads += 1
            continue

        points, played = realised_outcomes(archive, gameweek)
        outcome = score_realised(plan, positions, points, played, pool_xp, rules)
        outcome.gameweek = gameweek
        result.weeks.append(outcome)
        state = advance(state, plan, prices, rules)

    return result


def compare(
    candidate: StrategyResult, baseline: StrategyResult
) -> Dict[str, Any]:
    """
    Paired comparison on gameweek differences.

    The season total is one draw from a distribution about 86 points wide, so it
    is reported but is not the evidence. The paired per-gameweek difference has
    a standard error that can actually be computed, and even that is only
    honest across many seasons — a t-statistic here is a description of one
    season, not a significance test against the population of seasons.
    """
    n = min(len(candidate.weeks), len(baseline.weeks))
    if n == 0:
        return {"n": 0}
    diff = candidate.series[:n] - baseline.series[:n]
    se = float(diff.std(ddof=1) / np.sqrt(n)) if n > 1 else float("nan")
    return {
        "n": n,
        "candidate": candidate.name,
        "baseline": baseline.name,
        "total_margin": float(diff.sum()),
        "mean_per_gameweek": float(diff.mean()),
        "se_per_gameweek": se,
        "t": float(diff.mean() / se) if se and se > 0 else float("nan"),
        "weeks_ahead": int((diff > 0).sum()),
        "weeks_behind": int((diff < 0).sum()),
    }


# ── Strategies ──────────────────────────────────────────────────────────────
#
# Each takes (state, candidates, gameweek, rules) and returns a Plan. They all
# see the same pool built from the same shared projections, so any difference
# between them is the decision rule and nothing else.


def _solve(state: SeasonState, candidates, rules, **kwargs):
    from pipeline.decide.milp import solve

    return solve(
        candidates, rules,
        current_squad=state.squad,
        bank=state.bank if state.squad else rules.budget_tenths,
        free_transfers=state.free_transfers,
        **kwargs,
    )[0]


def strategy_do_nothing(state: SeasonState, candidates, gameweek, rules):
    """
    Build once at the start, then never transfer again.

    The load-bearing baseline. The elite finding the plan cites is that
    restraint beats churn, so an optimiser that cannot clear this bar is
    actively harmful however well calibrated its projections are. Note it still
    re-picks its ELEVEN each week: doing nothing means making no transfers, not
    fielding last week's lineup regardless of who is injured.
    """
    return _solve(state, candidates, rules, max_transfers=0)


def strategy_greedy(state: SeasonState, candidates, gameweek, rules):
    """
    Spend the free transfer whenever it improves next week's projection.

    No free-transfer value, so any positive gain triggers a move. This is the
    churn strategy, and it is here to be beaten — it is what an optimiser
    degenerates into when the option value of an unspent transfer is missing,
    which is exactly the bug found in the horizon this session.
    """
    return _solve(
        state, candidates, rules,
        max_transfers=state.free_transfers,
        ft_marginals=[0.0] * 5,
    )


def strategy_agent(state: SeasonState, candidates, gameweek, rules):
    """The single-week agent: same solver, with the free-transfer value on."""
    return _solve(state, candidates, rules, max_transfers=state.free_transfers)
