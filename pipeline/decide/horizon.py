"""
Multi-gameweek planning: the same squad problem, solved over H weeks at once.

Multi-gameweek planning is the one mechanism the peer-reviewed literature names
as a success factor, and the reason is structural rather than statistical. A
one-week optimiser cannot see a fixture swing: it will not buy a player whose
run starts in three weeks, and it will not decline a marginal upgrade now in
order to hold the cash for a better one later. Both are ordinary, repeated
decisions, and getting them wrong costs points every single week.

**Why the horizon is longer than the plan.** Transfers are only decided for the
first ``transfer_horizon`` weeks, but the squad is EVALUATED over
``eval_horizon`` weeks. Without that split the optimiser has an incentive to end
the plan holding a squad with terrible upcoming fixtures — the cost lands one
week past where it can see, so as far as the objective is concerned it does not
exist. Evaluating two weeks past the last transfer prices that terminal squad.

**Only the first week is acted on.** The rest of the plan exists to inform it,
and is re-solved from scratch next week against fresh data. Publishing week
three as a commitment would be false precision: by then prices, injuries and the
projection itself have all moved.

**The full league fits, so nothing is filtered.** Measured on the real 2025-26
archive with all 780 candidates:

    eval=1 transfer=1    0.4s    ~4,680 binaries
    eval=3 transfer=3    1.3s   ~14,040 binaries
    eval=6 transfer=6    5.7s   ~28,080 binaries
    eval=8 transfer=6    8.1s   ~37,440 binaries   <- production default

Eight seconds for the production configuration, which removes the reason to
pre-filter the pool by value. That matters more than the speed: a filter is
invisible downstream, because the artifact reports the best plan over whatever
the pool contained and an excluded player leaves no trace in any counterfactual.

Two simplifications, both stated rather than buried:

* **Prices are static across the horizon.** Modelling rises would require
  forecasting other managers' transfers, and the error in that forecast would
  exceed the effect being modelled.
* **Chips are not free variables.** No defensible reserve-price estimator
  exists — a discounted max-of-expectations under-prices by Jensen and
  guarantees burning them early — so they stay pinned human inputs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from pipeline.decide.milp import (
    BENCH_WEIGHT,
    FT_MARGINAL_VALUE,
    VICE_WEIGHT,
    Candidate,
    InfeasibleError,
    Plan,
    SolverLimitError,
)
from pipeline.fpl.rules import POSITIONS, Rules

logger = logging.getLogger(__name__)

# Weeks of transfer decisions, and weeks of scoring. The gap is what stops the
# optimiser leaving a wrecked terminal squad just past its own line of sight.
TRANSFER_HORIZON = 6
EVAL_HORIZON = 8


@dataclass
class WeekIndex:
    """
    Column offsets for one gameweek inside the horizon vector.

    Same single-source-of-truth discipline as the H=1 VarIndex, and more
    necessary here: with H weeks the opportunity to mis-address a block scales
    with H, and the symptom is unchanged — a legal, plausible plan about the
    wrong players.
    """

    n: int
    week: int
    base: int

    def _block(self, k: int) -> slice:
        start = self.base + k * self.n
        return slice(start, start + self.n)

    @property
    def squad(self) -> slice:
        return self._block(0)

    @property
    def xi(self) -> slice:
        return self._block(1)

    @property
    def captain(self) -> slice:
        return self._block(2)

    @property
    def vice(self) -> slice:
        return self._block(3)

    @property
    def buy(self) -> slice:
        return self._block(4)

    @property
    def sell(self) -> slice:
        return self._block(5)

    @property
    def hits(self) -> int:
        return self.base + 6 * self.n

    @property
    def free_transfers(self) -> int:
        """Free transfers HELD entering this week."""
        return self.base + 6 * self.n + 1

    @property
    def remaining(self) -> int:
        """Free transfers left after this week's moves, before accrual."""
        return self.base + 6 * self.n + 2

    @property
    def ft_bank(self) -> slice:
        start = self.base + 6 * self.n + 3
        return slice(start, start + len(FT_MARGINAL_VALUE))

    @property
    def width(self) -> int:
        return 6 * self.n + 3 + len(FT_MARGINAL_VALUE)

    def blocks(self) -> Dict[str, slice]:
        return {
            "squad": self.squad, "xi": self.xi, "captain": self.captain,
            "vice": self.vice, "buy": self.buy, "sell": self.sell,
        }


@dataclass
class HorizonIndex:
    """The whole horizon vector, one WeekIndex per gameweek."""

    n: int
    weeks: int

    def week(self, w: int) -> WeekIndex:
        if not 0 <= w < self.weeks:
            raise IndexError(f"week {w} outside horizon of {self.weeks}")
        stride = 6 * self.n + 3 + len(FT_MARGINAL_VALUE)
        return WeekIndex(n=self.n, week=w, base=w * stride)

    @property
    def size(self) -> int:
        return self.weeks * (6 * self.n + 3 + len(FT_MARGINAL_VALUE))


@dataclass
class HorizonPlan:
    """A plan across the horizon. Only ``weeks[0]`` is ever acted on."""

    weeks: List[Plan] = field(default_factory=list)
    objective: float = 0.0
    transfer_horizon: int = 0
    eval_horizon: int = 0

    @property
    def now(self) -> Plan:
        """This week's decision — the only part that is a commitment."""
        return self.weeks[0]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "objective": round(self.objective, 6),
            "transfer_horizon": self.transfer_horizon,
            "eval_horizon": self.eval_horizon,
            "now": self.now.as_dict(),
            # Explicitly labelled provisional. Publishing these as commitments
            # would be false precision: prices, injuries and the projection all
            # move before any of them is acted on.
            "provisional": [p.as_dict() for p in self.weeks[1:]],
        }


def build_horizon(
    candidates: Sequence[Candidate],
    xp_by_week: Sequence[Sequence[float]],
    rules: Rules,
    current_squad: Sequence[int] = (),
    bank: Optional[int] = None,
    free_transfers: int = 1,
    transfer_horizon: Optional[int] = None,
    bench_weight: float = BENCH_WEIGHT,
    vice_weight: float = VICE_WEIGHT,
) -> Tuple[np.ndarray, List[np.ndarray], List[float], List[float], HorizonIndex]:
    """
    Assemble the horizon MILP.

    ``xp_by_week[w][i]`` is candidate ``i``'s expected points in week ``w``. Its
    length sets the EVALUATION horizon; ``transfer_horizon`` (defaulting to
    ``TRANSFER_HORIZON``) sets how many of those weeks may contain transfers.
    Weeks past the transfer horizon are scored on the squad already held, which
    is what gives the terminal squad a price.

    Returns ``(objective, rows, lower, upper, index)`` for maximisation; the
    caller negates once for scipy's minimise convention.
    """
    n = len(candidates)
    weeks = len(xp_by_week)
    if not n:
        raise InfeasibleError("no candidates supplied")
    if not weeks:
        raise ValueError("xp_by_week is empty; the horizon must span at least one week")
    for w, row in enumerate(xp_by_week):
        if len(row) != n:
            raise ValueError(
                f"xp_by_week[{w}] has {len(row)} entries for {n} candidates"
            )

    transfer_horizon = TRANSFER_HORIZON if transfer_horizon is None else transfer_horizon
    transfer_horizon = min(transfer_horizon, weeks)

    held = set(current_squad)
    missing = held - {c.element_id for c in candidates}
    if missing:
        raise InfeasibleError(f"held players absent from the pool: {sorted(missing)}")
    owned_count = len(held)

    if bank is None:
        if owned_count:
            raise ValueError(
                "bank must be given when a squad is held; it is cash in hand, "
                "and defaulting it to the full budget would invent money"
            )
        bank = rules.budget_tenths
    bank = int(bank)

    index = HorizonIndex(n=n, weeks=weeks)
    c = np.zeros(index.size, dtype=float)
    rows: List[np.ndarray] = []
    lo: List[float] = []
    hi: List[float] = []

    def row() -> np.ndarray:
        return np.zeros(index.size, dtype=float)

    owned = np.array([1.0 if x.element_id in held else 0.0 for x in candidates])
    buy_price = np.array([x.buy_price for x in candidates], dtype=float)
    sell_price = np.array([x.sell_price for x in candidates], dtype=float)

    for w in range(weeks):
        wi = index.week(w)
        xp = np.asarray(xp_by_week[w], dtype=float)
        can_transfer = w < transfer_horizon

        # ── Objective for this week ──────────────────────────────────────
        c[wi.squad] = bench_weight * xp
        c[wi.xi] = (1.0 - bench_weight) * xp
        c[wi.captain] = xp
        c[wi.vice] = vice_weight * xp
        # Face value in EVERY week. Discounting a certain cost is a category
        # error, and with a decay a hit planned five weeks out would cost about
        # two points — so the solver would plan hits it never takes and distort
        # today's decision through a phantom future.
        c[wi.hits] = -4.0
        # Only the final week's bank carries value. Crediting every week would
        # pay the solver repeatedly for carrying the same transfer forward.
        if w == weeks - 1:
            c[wi.ft_bank] = np.array(FT_MARGINAL_VALUE, dtype=float)

        # ── Squad legality, identical every week ─────────────────────────
        r = row(); r[wi.squad] = 1.0
        rows.append(r); lo.append(rules.squad_size); hi.append(rules.squad_size)

        for position in POSITIONS:
            mask = np.array([1.0 if x.position == position else 0.0 for x in candidates])
            r = row(); r[wi.squad] = mask
            rows.append(r); lo.append(rules.quotas[position]); hi.append(rules.quotas[position])

            low, high = rules.play_bounds[position]
            r = row(); r[wi.xi] = mask
            rows.append(r); lo.append(low); hi.append(high)

        for team in sorted({x.team for x in candidates}):
            mask = np.array([1.0 if x.team == team else 0.0 for x in candidates])
            r = row(); r[wi.squad] = mask
            rows.append(r); lo.append(-np.inf); hi.append(rules.club_limit)

        r = row(); r[wi.xi] = 1.0
        rows.append(r); lo.append(rules.lineup_size); hi.append(rules.lineup_size)
        r = row(); r[wi.captain] = 1.0
        rows.append(r); lo.append(1); hi.append(1)
        r = row(); r[wi.vice] = 1.0
        rows.append(r); lo.append(1); hi.append(1)

        for i in range(n):
            r = row(); r[wi.xi.start + i] = 1.0; r[wi.squad.start + i] = -1.0
            rows.append(r); lo.append(-np.inf); hi.append(0.0)
            r = row()
            r[wi.captain.start + i] = 1.0
            r[wi.vice.start + i] = 1.0
            r[wi.xi.start + i] = -1.0
            rows.append(r); lo.append(-np.inf); hi.append(0.0)

        # ── Squad continuity ─────────────────────────────────────────────
        # Week 0 flows from what is actually held; later weeks flow from the
        # previous week's squad. This chain is what makes the plan a plan
        # rather than H independent one-week solves.
        for i in range(n):
            r = row()
            r[wi.squad.start + i] = 1.0
            r[wi.buy.start + i] = -1.0
            r[wi.sell.start + i] = 1.0
            if w == 0:
                rows.append(r); lo.append(owned[i]); hi.append(owned[i])
            else:
                r[index.week(w - 1).squad.start + i] = -1.0
                rows.append(r); lo.append(0.0); hi.append(0.0)

        if not can_transfer:
            # Past the transfer horizon the squad is frozen, so these weeks
            # price the terminal squad rather than letting the optimiser keep
            # improving it for free.
            r = row(); r[wi.buy] = 1.0
            rows.append(r); lo.append(0.0); hi.append(0.0)
            r = row(); r[wi.sell] = 1.0
            rows.append(r); lo.append(0.0); hi.append(0.0)

        # ── Transfer accounting ──────────────────────────────────────────
        slots = float(rules.squad_size - owned_count) if w == 0 else 0.0

        r = row(); r[wi.buy] = 1.0; r[wi.sell] = -1.0
        rows.append(r); lo.append(slots); hi.append(slots)

        # Cash is cumulative: the bank may never go negative at any point in the
        # plan, not merely at the end. A per-week-only constraint would let the
        # solver overdraw in week 2 and repay in week 4.
        r = row()
        for v in range(w + 1):
            vi = index.week(v)
            r[vi.buy] += buy_price
            r[vi.sell] -= sell_price
        rows.append(r); lo.append(-np.inf); hi.append(float(bank))

        # hits >= transfers - free_transfers_held
        r = row()
        r[wi.buy] = 1.0
        r[wi.hits] = -1.0
        r[wi.free_transfers] = -1.0
        rows.append(r); lo.append(-np.inf); hi.append(slots)

        # remaining <= held - transfers + hits.
        # The +hits term keeps this feasible once a hit is taken, exactly as in
        # the single-week model: without it the bound goes negative while
        # `remaining` is bounded below by zero, and the model becomes infeasible
        # precisely when a hit is worth taking.
        r = row()
        r[wi.remaining] = 1.0
        r[wi.buy] = 1.0
        r[wi.free_transfers] = -1.0
        r[wi.hits] = -1.0
        rows.append(r); lo.append(-np.inf); hi.append(slots)

        # remaining >= held - transfers, the matching LOWER bound.
        #
        # Without it `remaining` is only capped from above, and in any week where
        # it does not bind the objective the solver is free to leave it slack.
        # Measured: a five-week plan starting on a full bank reported [3,3,4,5]
        # banked transfers when the true chain is [3,4,5,5]. The decision was
        # still correct — the chain is pulled tight from the valued final week —
        # but a plan that understates the bank misinforms whoever reads it and
        # feeds a wrong starting position into next week's solve.
        #
        # Non-binding when a hit is taken (the right-hand side goes negative and
        # the variable's own zero lower bound takes over), which is exactly right.
        r = row()
        r[wi.remaining] = 1.0
        r[wi.buy] = 1.0
        r[wi.free_transfers] = -1.0
        rows.append(r); lo.append(slots); hi.append(np.inf)

        # Entering week 0 we hold what we hold; later weeks accrue one, capped.
        if w == 0:
            r = row(); r[wi.free_transfers] = 1.0
            rows.append(r); lo.append(float(free_transfers)); hi.append(float(free_transfers))
        else:
            prev = index.week(w - 1)
            r = row()
            r[wi.free_transfers] = 1.0
            r[prev.remaining] = -1.0
            rows.append(r); lo.append(-np.inf); hi.append(1.0)

        # The banked value claimed at the end cannot exceed what is actually left.
        r = row()
        r[wi.ft_bank] = 1.0
        r[wi.remaining] = -1.0
        rows.append(r); lo.append(-np.inf); hi.append(0.0)

    return c, rows, lo, hi, index


def solve_horizon(
    candidates: Sequence[Candidate],
    xp_by_week: Sequence[Sequence[float]],
    rules: Rules,
    current_squad: Sequence[int] = (),
    bank: Optional[int] = None,
    free_transfers: int = 1,
    transfer_horizon: Optional[int] = None,
    time_limit: float = 300.0,
    mip_gap: float = 0.0,
    bench_weight: float = BENCH_WEIGHT,
    top_k: int = 1,
) -> List[HorizonPlan]:
    """
    Solve the horizon. Returns ``top_k`` plans, best first.

    Distinctness is enforced on **week 0's squad**, not on the whole plan. Week 0
    is the only part that is acted on, so two plans that field the same eleven
    this week and diverge in week four are the same decision — offering both as
    alternatives would fill the shortlist with choices nobody makes.

    Each returned plan is the best plan *conditional on* a different week-0
    squad, which is exactly the shortlist the simulator should adjudicate: the
    horizon decides which squads are worth considering given the future, and the
    simulator picks among them on the true objective for the week being played.
    """
    from scipy.optimize import Bounds, LinearConstraint, milp

    c, rows, lo, hi, index = build_horizon(
        candidates, xp_by_week, rules, current_squad, bank, free_transfers,
        transfer_horizon, bench_weight,
    )
    weeks = index.weeks
    bank_value = rules.budget_tenths if bank is None else int(bank)

    lower = np.zeros(index.size)
    upper = np.ones(index.size)
    integrality = np.ones(index.size)
    for w in range(weeks):
        wi = index.week(w)
        upper[wi.hits] = float(rules.squad_size)
        upper[wi.free_transfers] = float(rules.max_banked_free_transfers)
        upper[wi.remaining] = float(rules.max_banked_free_transfers)
        # Bank slots stay continuous: the concave schedule puts them at 0 or 1
        # at every optimum anyway, so declaring them integer would branch for
        # nothing — and with H weeks that cost is multiplied by H.
        integrality[wi.ft_bank] = 0.0

    constraints = [LinearConstraint(np.array(rows), np.array(lo), np.array(hi))]
    plans: List[HorizonPlan] = []
    first_week = index.week(0)

    for k in range(top_k):
        result = milp(
            c=-c,
            constraints=constraints,
            integrality=integrality,
            bounds=Bounds(lower, upper),
            options={"mip_rel_gap": mip_gap, "time_limit": time_limit},
        )

        status = int(getattr(result, "status", 4))
        if status == 1:
            if k == 0:
                raise SolverLimitError(
                    f"horizon solve hit a limit: {result.message}. A legal plan may "
                    f"well exist — raise time_limit or shorten the horizon. NOT "
                    f"infeasibility."
                )
            # Later iterations are shortlist depth, not correctness. Log loudly
            # rather than silently returning a shorter list that reads as
            # "these were all the options".
            logger.warning(
                "horizon hit a limit after %d of %d plans; the shortlist is "
                "TRUNCATED, not exhausted", k, top_k,
            )
            break
        if not result.success or result.x is None:
            if k == 0:
                raise InfeasibleError(
                    f"no legal plan over {weeks} weeks (status {status}): {result.message}"
                )
            logger.info("only %d distinct week-0 squads available (asked %d)", k, top_k)
            break

        plans.append(
            _extract_horizon(
                result.x, candidates, index, rules, bank_value, free_transfers,
                len(current_squad), transfer_horizon or TRANSFER_HORIZON, -result.fun,
            )
        )

        chosen = np.where(result.x[first_week.squad] > 0.5)[0]
        cut = np.zeros(index.size)
        cut[first_week.squad.start + chosen] = 1.0
        constraints.append(
            LinearConstraint(cut.reshape(1, -1), -np.inf, float(rules.squad_size - 1))
        )

    return plans


def _extract_horizon(
    x: np.ndarray,
    candidates: Sequence[Candidate],
    index: HorizonIndex,
    rules: Rules,
    bank: int,
    free_transfers: int,
    owned_count: int,
    transfer_horizon: int,
    objective: float,
) -> HorizonPlan:
    """Turn a horizon solution into one Plan per week."""
    by_id = {c.element_id: c for c in candidates}
    plans: List[Plan] = []
    running_bank = bank
    # The free-transfer chain is REPLAYED here from the transfers actually made,
    # not read out of the solver. A MILP variable only has to be correct where it
    # binds the objective, so an unbinding week can carry a slack value that is
    # feasible but not the truth. The rule is deterministic given the transfers,
    # so replaying it is both simpler and exact.
    held_ft = int(free_transfers)

    for w in range(index.weeks):
        wi = index.week(w)

        def picked(block: slice) -> List[int]:
            return [candidates[i].element_id for i in np.where(x[block] > 0.5)[0]]

        squad = picked(wi.squad)
        xi = picked(wi.xi)
        captain = picked(wi.captain)
        vice = picked(wi.vice)
        ins = picked(wi.buy)
        outs = picked(wi.sell)

        if len(squad) != rules.squad_size or len(xi) != rules.lineup_size:
            raise AssertionError(
                f"week {w}: {len(squad)} squad, {len(xi)} starters — the index and "
                f"the constraints disagree about what the columns mean"
            )
        if len(captain) != 1 or len(vice) != 1:
            raise AssertionError(f"week {w}: {len(captain)} captains, {len(vice)} vices")

        spend = sum(by_id[p].buy_price for p in ins)
        raised = sum(by_id[p].sell_price for p in outs)
        running_bank = running_bank - spend + raised

        slots = rules.squad_size - owned_count if w == 0 else 0
        transfers = len(ins) - slots
        remaining = max(0, held_ft - transfers)
        after = min(rules.max_banked_free_transfers, remaining + 1)

        plans.append(
            Plan(
                squad=squad, xi=xi, captain=captain[0], vice=vice[0],
                transfers_in=ins, transfers_out=outs,
                hits=max(0, transfers - held_ft),
                bank_after=int(running_bank),
                objective=0.0,
                free_transfers_banked=remaining,
                free_transfers_after=after,
            )
        )
        held_ft = after

    return HorizonPlan(
        weeks=plans,
        objective=float(objective),
        transfer_horizon=min(transfer_horizon, index.weeks),
        eval_horizon=index.weeks,
    )
