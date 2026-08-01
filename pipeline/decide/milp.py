"""
Squad optimisation as a mixed-integer linear program, solved with HiGHS.

This is stage one of two. The MILP proposes; the joint simulator disposes.

That split is deliberate and the reason is in FPL Review's own documentation:
their Linear Optimiser "guarantees optimal solution within the linear framework"
but "does not handle same team GKs", while their separate heuristic solver does
full autosub probability and "cannot guarantee total mathematical optimality".
They ship both because neither alone is right. We can do better than either by
letting the MILP enumerate the top-K candidate squads under a linear surrogate
and having the calibrated simulator score those candidates on the true
objective — exact autosub cascade, exact captaincy fallback, correlated clean
sheets.

The practical consequence is that the MILP's linear approximations only have to
be good enough to get the right squads into the shortlist. They do not have to be
the final word, which is why a single average bench weight is acceptable here
where it would not be in a one-stage design.

Deliberate choices, each argued rather than inherited:

* **No time decay.** FPL has no time preference — a point in GW38 is worth one
  point. A uniform discount on realised points is a bias, tolerated elsewhere as
  a proxy for forecast unreliability. We correct that where it belongs, by
  shrinking the forecast itself.
* **The hit is charged at face value, always.** A -4 is a certainty, not a
  forecast, so discounting it is a category error. With a 0.85 decay a hit
  planned five gameweeks out would cost 2.09 effective points, and the solver
  would plan hits it never takes — distorting today's decision through a
  phantom future. This is coherent ONLY because we have no decay; if a decay is
  ever added, the hit must be decayed with it.
* **Free transfers carry a non-increasing marginal value.** A flat value implies
  the fifth banked transfer is worth as much as the first, which makes the
  use-threshold invariant to how many you hold and causes hoarding.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from pipeline.fpl.rules import POSITIONS, Rules

logger = logging.getLogger(__name__)

# Marginal value of the nth banked free transfer, non-increasing, V(0) = 0.
# The first marginal is FPL Review's documented default.
#
# These stay human-authored, and that is a finding rather than a shortcut. Both
# halves of derive_ft_schedule were run against the real 2025-26 archive (real
# prices, ~780 candidates, 13 gameweeks):
#
#   transfer   projected   realised     bias      se       t
#          1       2.155     -0.504   +2.659   1.454   -0.35
#          2       1.283     -1.189   +2.472   1.417   -0.84
#          3       0.730      0.045   +0.685   0.785    0.06
#          4       0.447      0.278   +0.169   0.768    0.36
#          5       0.290      3.030   -2.740   1.678    1.81
#
# In projection space the marginals ARE non-increasing and marginals 2-5 land
# within 0.27 of the values below, so the shape is corroborated. But scored on
# what actually happened, only 34% of the projected gain survives and not one
# marginal is distinguishable from zero. The optimiser is choosing partly on its
# own estimation error, and the first transfer -- picking the single largest
# outlier out of ~780 candidates -- is where that bias is worst, which is
# exactly why the measured 2.155 exceeds the published 1.75.
#
# The per-gameweek residual sd is ~5.2 points, so separating a 1-point effect
# needs on the order of 200 gameweeks: five seasons. This independently
# reproduces the risk register's sigma ~ 5 estimate, and it means the schedule
# is not identifiable from one season however it is measured. Re-run
# derive_ft_schedule against real model projections when they exist, but treat
# any single-season result as a prior, never a fit.
FT_MARGINAL_VALUE: Tuple[float, ...] = (1.75, 1.35, 1.00, 0.60, 0.30)

# Single average bench weight. Justified only by the two-stage design: the
# simulator computes exact autosub value in stage two, so this needs to rank
# candidates, not price them. FPL Review's per-slot weights are 0.30/0.10/0.03
# plus 0.03 for the reserve keeper; their mean over four bench slots is ~0.115.
BENCH_WEIGHT = 0.115
VICE_WEIGHT = 0.05


class InfeasibleError(RuntimeError):
    """The MILP has no feasible solution. Never return a squad in this case."""


@dataclass(frozen=True)
class Candidate:
    """One player the optimiser may select."""

    element_id: int
    position: str
    team: str
    # Tenths of a million throughout. Float pounds would accumulate rounding
    # error against a hard budget constraint.
    buy_price: int
    sell_price: int
    xp: float
    owned: bool = False


@dataclass
class VarIndex:
    """
    The single source of truth for variable offsets.

    Every block's offset is computed here and nowhere else. A hand-maintained
    second copy is how a MILP produces a plausible-looking wrong squad that no
    assertion catches, because every constraint is individually satisfiable — it
    is just describing different players than intended.
    """

    n: int

    @property
    def squad(self) -> slice:
        return slice(0, self.n)

    @property
    def xi(self) -> slice:
        return slice(self.n, 2 * self.n)

    @property
    def captain(self) -> slice:
        return slice(2 * self.n, 3 * self.n)

    @property
    def vice(self) -> slice:
        return slice(3 * self.n, 4 * self.n)

    @property
    def buy(self) -> slice:
        return slice(4 * self.n, 5 * self.n)

    @property
    def sell(self) -> slice:
        return slice(5 * self.n, 6 * self.n)

    @property
    def hits(self) -> int:
        """Scalar: number of points hits taken (integer, >= 0)."""
        return 6 * self.n

    @property
    def ft_bank(self) -> slice:
        """
        One continuous variable per banked free transfer, each in [0, 1].

        This is the piecewise-linear encoding of the concave ``ft_value``. It
        needs no binaries and no ordering constraints: because the marginals are
        non-increasing, a maximiser fills the most valuable slot first of its own
        accord, so the sum of the filled slots is exactly V(banked). Ordering
        variables would be redundant, and integrality would add branching for
        nothing — at the optimum these land on 0 or 1 regardless.
        """
        start = 6 * self.n + 1
        return slice(start, start + len(FT_MARGINAL_VALUE))

    @property
    def size(self) -> int:
        return 6 * self.n + 1 + len(FT_MARGINAL_VALUE)

    def blocks(self) -> Dict[str, slice]:
        """The player-indexed blocks only: each is exactly ``n`` wide."""
        return {
            "squad": self.squad, "xi": self.xi, "captain": self.captain,
            "vice": self.vice, "buy": self.buy, "sell": self.sell,
        }


@dataclass
class Plan:
    """A proposed decision for one gameweek."""

    squad: List[int]
    xi: List[int]
    captain: int
    vice: int
    transfers_in: List[int]
    transfers_out: List[int]
    hits: int
    bank_after: int
    objective: float
    # Transfers left unspent this week, BEFORE next week's accrual. Kept
    # separate from free_transfers_after because that one is capped, and the cap
    # would make the objective's banked value unrecoverable from it.
    free_transfers_banked: int
    free_transfers_after: int

    def as_dict(self) -> Dict[str, Any]:
        return {
            "squad": sorted(self.squad), "xi": sorted(self.xi),
            "captain": self.captain, "vice": self.vice,
            "transfers_in": sorted(self.transfers_in),
            "transfers_out": sorted(self.transfers_out),
            "hits": self.hits, "bank_after": self.bank_after,
            "objective": round(self.objective, 6),
            "free_transfers_banked": self.free_transfers_banked,
            "free_transfers_after": self.free_transfers_after,
        }


def ft_value(banked: int) -> float:
    """
    Total value of holding ``banked`` free transfers. V(0) = 0 by construction.

    Non-increasing marginals: the fifth is worth far less than the first, both
    because squad improvement has diminishing returns and because the cap at five
    puts the last one at risk of being wasted entirely.
    """
    banked = max(0, int(banked))
    return float(sum(FT_MARGINAL_VALUE[: min(banked, len(FT_MARGINAL_VALUE))]))


def build_objective(
    candidates: Sequence[Candidate],
    index: VarIndex,
    rules: Rules,
    bench_weight: float = BENCH_WEIGHT,
    vice_weight: float = VICE_WEIGHT,
    ft_marginals: Optional[Sequence[float]] = None,
) -> np.ndarray:
    """
    Linear objective coefficients, for MAXIMISATION.

    A starter contributes his expected points. The captain contributes his again,
    because the armband doubles rather than replaces. A squad member outside the
    eleven contributes the bench weight — expressed as ``squad`` minus ``xi`` so
    that promoting a player into the eleven correctly nets the difference.
    """
    n = len(candidates)
    xp = np.array([c.xp for c in candidates], dtype=float)
    c = np.zeros(index.size, dtype=float)

    # Bench value attaches to squad membership; being picked for the eleven
    # upgrades it from the bench weight to the full value.
    c[index.squad] = bench_weight * xp
    c[index.xi] = (1.0 - bench_weight) * xp
    c[index.captain] = xp
    c[index.vice] = vice_weight * xp
    # Charged at face value. Not discounted, in any gameweek, ever.
    c[index.hits] = -4.0
    # Value of the transfers left unspent. Without this term an unused transfer
    # is worth nothing, so the solver spends one every week for any gain above
    # zero — the exact churn that loses to doing nothing over a season.
    #
    # Overridable so derive_ft_schedule can zero it out: measuring what a
    # transfer is worth while already paying the solver for holding one would
    # simply return the assumption it was given.
    marginals = FT_MARGINAL_VALUE if ft_marginals is None else ft_marginals
    if len(marginals) != len(FT_MARGINAL_VALUE):
        raise ValueError(
            f"ft_marginals must have {len(FT_MARGINAL_VALUE)} entries, got {len(marginals)}"
        )
    c[index.ft_bank] = np.array(marginals, dtype=float)
    return c


def build_constraints(
    candidates: Sequence[Candidate],
    index: VarIndex,
    rules: Rules,
    current_squad: Sequence[int],
    bank: int,
    free_transfers: int,
    max_transfers: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Build ``A``, ``lower``, ``upper`` for the full legality system.

    Every FPL rule that constrains a squad appears here explicitly. Anything
    absent is a rule we are silently ignoring, so the list is deliberately
    exhaustive rather than minimal.
    """
    n = len(candidates)
    held = set(current_squad)
    owned = np.array([1.0 if c.element_id in held else 0.0 for c in candidates])

    # A held player missing from the pool cannot be represented, so the transfer
    # arithmetic below would silently treat him as already sold and the solver
    # would field fourteen. Raise: this is a pool-construction bug, and a squad
    # quietly one player short is exactly the kind of plausible-wrong output the
    # whole MILP test suite exists to prevent.
    missing = held - {c.element_id for c in candidates}
    if missing:
        raise InfeasibleError(
            f"current squad members absent from the pool: {sorted(missing)}"
        )
    owned_count = int(owned.sum())

    A: List[np.ndarray] = []
    lo: List[float] = []
    hi: List[float] = []

    def row() -> np.ndarray:
        return np.zeros(index.size, dtype=float)

    # 15 players.
    r = row(); r[index.squad] = 1.0
    A.append(r); lo.append(rules.squad_size); hi.append(rules.squad_size)

    # Positional quotas in the squad, and play bounds in the eleven.
    for position in POSITIONS:
        mask = np.array([1.0 if c.position == position else 0.0 for c in candidates])

        r = row(); r[index.squad] = mask
        A.append(r); lo.append(rules.quotas[position]); hi.append(rules.quotas[position])

        low, high = rules.play_bounds[position]
        r = row(); r[index.xi] = mask
        A.append(r); lo.append(low); hi.append(high)

    # At most three from any one club.
    for team in sorted({c.team for c in candidates}):
        mask = np.array([1.0 if c.team == team else 0.0 for c in candidates])
        r = row(); r[index.squad] = mask
        A.append(r); lo.append(-np.inf); hi.append(rules.club_limit)

    # Eleven starters.
    r = row(); r[index.xi] = 1.0
    A.append(r); lo.append(rules.lineup_size); hi.append(rules.lineup_size)

    # One captain, one vice, both in the eleven, and distinct.
    r = row(); r[index.captain] = 1.0
    A.append(r); lo.append(1); hi.append(1)
    r = row(); r[index.vice] = 1.0
    A.append(r); lo.append(1); hi.append(1)

    for i in range(n):
        # xi <= squad
        r = row(); r[index.xi.start + i] = 1.0; r[index.squad.start + i] = -1.0
        A.append(r); lo.append(-np.inf); hi.append(0.0)
        # captain + vice <= xi  (both must start, and cannot be the same player)
        r = row()
        r[index.captain.start + i] = 1.0
        r[index.vice.start + i] = 1.0
        r[index.xi.start + i] = -1.0
        A.append(r); lo.append(-np.inf); hi.append(0.0)
        # Flow: squad = owned + buy - sell
        r = row()
        r[index.squad.start + i] = 1.0
        r[index.buy.start + i] = -1.0
        r[index.sell.start + i] = 1.0
        A.append(r); lo.append(owned[i]); hi.append(owned[i])
        # You cannot buy what you own, nor sell what you do not.
        r = row(); r[index.buy.start + i] = 1.0
        A.append(r); lo.append(-np.inf); hi.append(1.0 - owned[i])
        r = row(); r[index.sell.start + i] = 1.0
        A.append(r); lo.append(-np.inf); hi.append(owned[i])

    # Budget, in tenths. Buying is at buy price; selling realises SELL price,
    # which is purchase price plus half the rise rounded down — not now_cost.
    buy_price = np.array([c.buy_price for c in candidates], dtype=float)
    sell_price = np.array([c.sell_price for c in candidates], dtype=float)
    r = row()
    r[index.buy] = buy_price
    r[index.sell] = -sell_price
    A.append(r); lo.append(-np.inf); hi.append(float(bank))

    # Squad-size closure on the transfer flow. Summing the per-player flow rows
    # gives  sum(squad) = owned_count + sum(buy) - sum(sell),  and sum(squad) is
    # fixed at fifteen, so this is the difference the two must maintain.
    #
    # It is NOT simply sum(buy) == sum(sell). That holds only for an ongoing
    # fifteen-man squad; on the opening build nothing is owned, so it would force
    # sum(buy) == 0 and make a legal squad impossible. Writing it as a difference
    # covers both, and covers the mid-season case of a squad short of fifteen.
    slots_to_fill = float(rules.squad_size - owned_count)
    r = row(); r[index.buy] = 1.0; r[index.sell] = -1.0
    A.append(r); lo.append(slots_to_fill); hi.append(slots_to_fill)

    # Chargeable transfers are purchases beyond the slots that had to be filled.
    # On the opening build all fifteen are free slots, so a fresh squad costs
    # nothing — charging it 15 transfers would invent a -56 point hit at GW1.
    #
    # Hits are bounded below only. Minimising -4*hits pins them to exactly the
    # shortfall; an equality would be wrong whenever transfers < free_transfers,
    # forcing a negative hit count that pays the manager for restraint.
    r = row(); r[index.buy] = 1.0; r[index.hits] = -1.0
    A.append(r); lo.append(-np.inf); hi.append(float(free_transfers) + slots_to_fill)

    # What may be banked is what is left after the transfers actually made:
    #     sum(ft_bank) <= free_transfers - transfers + hits
    # The +hits term is what keeps this feasible once a hit is taken. Without it
    # the right-hand side goes negative while ft_bank is bounded below by zero,
    # and the whole model becomes infeasible the moment a hit is worth taking —
    # which would look exactly like "no legal squad exists".
    r = row()
    r[index.ft_bank] = 1.0
    r[index.buy] = 1.0
    r[index.hits] = -1.0
    A.append(r); lo.append(-np.inf); hi.append(float(free_transfers) + slots_to_fill)

    if max_transfers is not None:
        r = row(); r[index.buy] = 1.0
        A.append(r)
        lo.append(-np.inf)
        hi.append(float(max_transfers) + slots_to_fill)

    return np.array(A), np.array(lo), np.array(hi)


def _extract(
    x: np.ndarray,
    candidates: Sequence[Candidate],
    index: VarIndex,
    rules: Rules,
    bank: int,
    free_transfers: int,
    owned_count: int,
    objective: float,
) -> Plan:
    """
    Turn a solution vector into a Plan.

    Binaries are rounded at 0.5 rather than compared to 1.0: HiGHS returns
    values like 0.9999999998, and an exact comparison would silently drop a
    player from the squad and produce a fourteen-man team that passes every
    downstream check because nothing downstream re-counts.
    """
    def picked(block: slice) -> List[int]:
        chosen = np.where(x[block] > 0.5)[0]
        return [candidates[i].element_id for i in chosen]

    squad = picked(index.squad)
    xi = picked(index.xi)
    captain = picked(index.captain)
    vice = picked(index.vice)
    ins = picked(index.buy)
    outs = picked(index.sell)

    # These are guaranteed by the constraint system, so a violation means the
    # constraints and this extraction disagree about what the columns mean --
    # exactly the mis-indexing failure the VarIndex exists to prevent. Assert
    # rather than repair: a silently corrected squad is a wrong squad nobody sees.
    if len(squad) != rules.squad_size:
        raise AssertionError(f"solution has {len(squad)} squad members, expected {rules.squad_size}")
    if len(xi) != rules.lineup_size:
        raise AssertionError(f"solution has {len(xi)} starters, expected {rules.lineup_size}")
    if len(captain) != 1 or len(vice) != 1:
        raise AssertionError(f"solution has {len(captain)} captains and {len(vice)} vices")
    slots_to_fill = rules.squad_size - owned_count
    if len(ins) - len(outs) != slots_to_fill:
        raise AssertionError(
            f"{len(ins)} in vs {len(outs)} out does not fill {slots_to_fill} slots"
        )

    by_id = {c.element_id: c for c in candidates}
    spend = sum(by_id[p].buy_price for p in ins)
    raised = sum(by_id[p].sell_price for p in outs)

    # Purchases that merely fill an empty slot are not transfers. Counting them
    # would charge the opening squad fifteen transfers, i.e. a -56 point hit.
    transfers = len(ins) - slots_to_fill
    hits = max(0, transfers - free_transfers)
    remaining = max(0, free_transfers - transfers)

    return Plan(
        squad=squad,
        xi=xi,
        captain=captain[0],
        vice=vice[0],
        transfers_in=ins,
        transfers_out=outs,
        hits=hits,
        bank_after=int(bank - spend + raised),
        objective=float(objective),
        free_transfers_banked=remaining,
        # One free transfer accrues each week, capped. Computed here rather than
        # taken from the solver: it is a rule, not an optimisation outcome.
        free_transfers_after=min(rules.max_banked_free_transfers, remaining + 1),
    )


def solve(
    candidates: Sequence[Candidate],
    rules: Rules,
    current_squad: Sequence[int] = (),
    bank: Optional[int] = None,
    free_transfers: int = 1,
    top_k: int = 1,
    max_transfers: Optional[int] = None,
    mip_gap: float = 0.0,
    time_limit: float = 120.0,
    bench_weight: float = BENCH_WEIGHT,
    ft_marginals: Optional[Sequence[float]] = None,
) -> List[Plan]:
    """
    Solve for the best ``top_k`` distinct squads.

    Distinct means a different set of fifteen. Given a squad the best eleven,
    captain and vice are determined, so enumerating those separately would
    return the same team K times with the armband moved.

    K is reached by re-solving with a no-good cut excluding each squad already
    found. That is exact — every returned plan is the true optimum over what
    remains — where a heuristic top-K would give no such guarantee, and the
    whole point of stage one is to hand the simulator a shortlist it can trust
    to contain the right answer.

    Raises ``InfeasibleError`` rather than returning an empty list when the
    FIRST solve fails: no legal squad exists, and a caller that receives ``[]``
    will treat it as "no improvement available" and roll the current squad
    forward, which is a different and wrong decision.
    """
    from scipy.optimize import Bounds, LinearConstraint, milp

    if not candidates:
        raise InfeasibleError("no candidates supplied")

    index = VarIndex(n=len(candidates))
    bank = rules.budget_tenths if bank is None else int(bank)
    owned_count = len({c.element_id for c in candidates} & set(current_squad))

    # milp minimises, so the maximisation objective is negated exactly once,
    # here, and the sign is undone when reporting.
    c = -build_objective(
        candidates, index, rules, bench_weight=bench_weight,
        ft_marginals=ft_marginals,
    )
    A, lo, hi = build_constraints(
        candidates, index, rules, current_squad, bank, free_transfers, max_transfers
    )

    lower = np.zeros(index.size)
    upper = np.ones(index.size)
    # The hit count is a non-negative integer, not a binary: a double hit is two.
    upper[index.hits] = float(rules.squad_size)

    integrality = np.ones(index.size)
    # The free-transfer bank slots are continuous. Declaring them integer would
    # branch on variables that are already integral at every optimum, paying
    # search cost for nothing.
    integrality[index.ft_bank] = 0.0

    constraints = [LinearConstraint(A, lo, hi)]
    plans: List[Plan] = []

    for k in range(top_k):
        result = milp(
            c=c,
            constraints=constraints,
            integrality=integrality,
            bounds=Bounds(lower, upper),
            options={"mip_rel_gap": mip_gap, "time_limit": time_limit},
        )
        if not result.success or result.x is None:
            if k == 0:
                raise InfeasibleError(
                    f"no legal squad exists: {result.message} "
                    f"(pool={len(candidates)}, bank={bank}, ft={free_transfers})"
                )
            # Running out of distinct squads is normal when the pool is small.
            logger.info("only %d distinct plans available (asked for %d)", k, top_k)
            break

        plan = _extract(
            result.x, candidates, index, rules, bank, free_transfers, owned_count,
            -result.fun,
        )
        plans.append(plan)

        # No-good cut: at most 14 of these 15 may appear together again. This
        # forbids exactly one squad, so the next solve is the true runner-up.
        chosen = np.where(result.x[index.squad] > 0.5)[0]
        cut = np.zeros(index.size)
        cut[chosen] = 1.0
        constraints.append(
            LinearConstraint(cut.reshape(1, -1), -np.inf, float(rules.squad_size - 1))
        )

    return plans


def derive_ft_schedule(
    scenarios: Sequence[Tuple[Sequence[Candidate], Sequence[int], int]],
    rules: Rules,
    max_transfers: int = len(FT_MARGINAL_VALUE),
) -> Dict[str, Any]:
    """
    Measure what a free transfer is actually worth, instead of asserting it.

    For each scenario -- a candidate pool, a held squad and a bank -- solve with
    n transfers permitted and the free-transfer value term SWITCHED OFF, for n
    from 0 upward. ``V(n)`` is the squad improvement n transfers buy; the value
    of the nth transfer is ``V(n) - V(n-1)``.

    Zeroing the value term is what makes this a measurement rather than an echo.
    Leaving it on would pay the solver for banking transfers and then report the
    payment back as the finding.

    Two properties are worth checking in the result rather than assuming:

    * **Non-increasing marginals.** Expected from diminishing returns -- the
      first transfer fixes the worst player in the squad, the fifth fixes the
      fifth-worst -- but it is a claim about the real player market, and the
      whole point is to test it.
    * **The first marginal against 1.75**, FPL Review's published default. Close
      agreement is evidence the number is a property of the game rather than of
      either model.

    Returns the mean marginals with per-scenario detail, and no recommendation:
    adopting a schedule is a human decision, because Increment 9 excludes solver
    weights from automated refit for identifiability reasons.
    """
    zeros = [0.0] * len(FT_MARGINAL_VALUE)
    per_scenario: List[List[float]] = []

    for pool, squad, bank in scenarios:
        values: List[float] = []
        for n in range(max_transfers + 1):
            plan = solve(
                pool, rules, current_squad=squad, bank=bank,
                # free_transfers=n with max_transfers=n means the solver may use
                # up to n transfers and is never charged a hit for them, so the
                # objective difference is pure squad improvement.
                free_transfers=n, max_transfers=n, ft_marginals=zeros,
            )[0]
            values.append(plan.objective)
        per_scenario.append([values[n] - values[n - 1] for n in range(1, len(values))])

    if not per_scenario:
        raise ValueError("no scenarios supplied")

    means = [
        float(np.mean([s[i] for s in per_scenario]))
        for i in range(len(per_scenario[0]))
    ]
    monotone = all(later <= earlier + 1e-9 for earlier, later in zip(means, means[1:]))
    return {
        "n_scenarios": len(per_scenario),
        "marginals": means,
        "per_scenario": per_scenario,
        "monotone_non_increasing": monotone,
        "asserted": list(FT_MARGINAL_VALUE),
        "first_marginal_vs_published_1_75": means[0] - 1.75 if means else None,
    }


def recompute_objective(
    plan: Plan,
    candidates: Sequence[Candidate],
    bench_weight: float = BENCH_WEIGHT,
    vice_weight: float = VICE_WEIGHT,
) -> float:
    """
    Recompute a plan's objective directly from its player lists.

    Independent of the matrix algebra, and deliberately so — this is the check
    that the coefficients land in the columns the constraints think they do. If
    this and the solver disagree, the index is wrong.
    """
    xp = {c.element_id: c.xp for c in candidates}
    starters = sum(xp[p] for p in plan.xi)
    bench = sum(xp[p] for p in plan.squad if p not in set(plan.xi))
    return float(
        starters
        + bench_weight * bench
        + xp[plan.captain]
        + vice_weight * xp[plan.vice]
        - 4.0 * plan.hits
        + ft_value(plan.free_transfers_banked)
    )
