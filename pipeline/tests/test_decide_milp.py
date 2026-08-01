"""
Tests for the squad MILP.

The failure this file exists to catch is R11 from the plan: a hand-assembled
MILP with a mis-indexed column produces a squad that is legal, plausible, and
about the wrong players. Every individual constraint is satisfied — it is just
describing different players than intended — so nothing downstream notices.

The defences, in the order they would catch it:

* ``test_index_bijection`` — the blocks tile the vector exactly, no overlap, no gap.
* ``test_objective_matches_manual_recompute`` — the solver's objective equals one
  computed from the returned player lists by a completely different route.
* the closure tests — squad size, positional quotas, club limit, cash.

An objective computed from the same matrices it is checking would prove nothing,
so ``recompute_objective`` deliberately works from element ids alone.
"""
from __future__ import annotations

import unittest

from pipeline.fpl.rules import load_rules

try:  # scipy is absent from the light CI job that runs the stdlib-only phases.
    import scipy.optimize  # noqa: F401

    HAVE_SCIPY = True
except ImportError:  # pragma: no cover
    HAVE_SCIPY = False

from pipeline.decide.milp import (
    BENCH_WEIGHT,
    FT_MARGINAL_VALUE,
    VICE_WEIGHT,
    Candidate,
    InfeasibleError,
    VarIndex,
    build_constraints,
    build_objective,
    derive_ft_schedule,
    ft_value,
    recompute_objective,
    solve,
)

RULES = load_rules()

# Enough players for a legal squad with real choices: 20 clubs is unnecessary,
# but fewer than 5 clubs makes the 3-per-club limit unsatisfiable for a 15-man
# squad, and a pool that cannot be solved tests nothing.
CLUBS = ["Arsenal", "Chelsea", "Everton", "Fulham", "Liverpool", "Newcastle"]
COUNTS = {"GKP": 6, "DEF": 15, "MID": 15, "FWD": 9}


def _pool(xp_scale: float = 1.0) -> list[Candidate]:
    """
    A deterministic candidate pool.

    Price and expected points are deliberately DECOUPLED. When xp is an affine
    function of price the most expensive player is always also the best and the
    best value, so an objective that ranked by cost would satisfy every test
    here — including the one asserting the captain is the highest scorer. The
    price tier is keyed on ``i % 8`` and the points tier on ``(i * 3) % 8``, a
    permutation of the same eight levels, so a genuine points-versus-cost
    trade-off exists and the budget still binds.
    """
    candidates: list[Candidate] = []
    element_id = 1
    for position, count in COUNTS.items():
        for i in range(count):
            price = 40 + (i % 8) * 10
            candidates.append(
                Candidate(
                    element_id=element_id,
                    position=position,
                    team=CLUBS[element_id % len(CLUBS)],
                    buy_price=price,
                    # Deliberately NOT equal to buy_price. When the two are the
                    # same the budget row cannot distinguish them, and crediting
                    # sales at now_cost -- the exact error the sell-on fee rule
                    # forbids -- passes every test in this file. Verified by
                    # mutation: with buy == sell it was undetectable.
                    sell_price=price - 5,
                    xp=xp_scale * (1.0 + 0.9 * ((i * 3) % 8)),
                )
            )
            element_id += 1
    return candidates


def _cheapest_legal_squad(pool: list[Candidate]) -> list[int]:
    """A legal starting squad, built greedily by price, respecting the club cap."""
    chosen: list[Candidate] = []
    per_club: dict[str, int] = {}
    for position, quota in RULES.quotas.items():
        taken = 0
        for c in sorted(pool, key=lambda c: (c.buy_price, c.element_id)):
            if c.position != position or taken >= quota:
                continue
            if per_club.get(c.team, 0) >= RULES.club_limit:
                continue
            chosen.append(c)
            per_club[c.team] = per_club.get(c.team, 0) + 1
            taken += 1
        assert taken == quota, f"could not fill {position}"
    return [c.element_id for c in chosen]


class TestVarIndex(unittest.TestCase):
    def test_index_bijection(self):
        """Blocks tile [0, size) exactly: every column owned by exactly one block."""
        index = VarIndex(n=7)
        seen: list[int] = []
        for name, block in index.blocks().items():
            columns = list(range(block.start, block.stop))
            self.assertEqual(len(columns), index.n, f"{name} is not n wide")
            seen.extend(columns)
        seen.append(index.hits)
        seen.extend(range(index.ft_bank.start, index.ft_bank.stop))

        self.assertEqual(len(seen), index.size, "blocks do not cover the vector")
        self.assertEqual(len(set(seen)), index.size, "blocks overlap")
        self.assertEqual(sorted(seen), list(range(index.size)), "blocks leave a gap")

    def test_ft_bank_has_one_slot_per_marginal(self):
        """
        A mismatch here silently truncates the free-transfer value: the objective
        would price four banked transfers when the schedule defines five.
        """
        index = VarIndex(n=7)
        width = index.ft_bank.stop - index.ft_bank.start
        self.assertEqual(width, len(FT_MARGINAL_VALUE))

    def test_blocks_are_contiguous_and_ordered(self):
        index = VarIndex(n=4)
        blocks = list(index.blocks().values())
        for earlier, later in zip(blocks, blocks[1:]):
            self.assertEqual(earlier.stop, later.start)


class TestFreeTransferValue(unittest.TestCase):
    def test_zero_is_exactly_zero(self):
        """V(0) = 0 by construction: holding nothing is worth nothing."""
        self.assertEqual(ft_value(0), 0.0)

    def test_marginals_are_non_increasing(self):
        """
        A rising marginal would make banking dominate using, and the agent would
        hoard transfers it never spends.
        """
        marginals = [ft_value(n) - ft_value(n - 1) for n in range(1, 6)]
        for earlier, later in zip(marginals, marginals[1:]):
            self.assertLessEqual(later, earlier, f"marginals rise: {marginals}")

    def test_first_transfer_matches_published_anchor(self):
        self.assertAlmostEqual(ft_value(1), 1.75)

    def test_ft_bank_caps_at_five(self):
        """Beyond the cap the value must flatten, not keep accruing."""
        self.assertEqual(ft_value(5), ft_value(6))
        self.assertEqual(ft_value(5), ft_value(99))


class TestObjectiveCoefficients(unittest.TestCase):
    """Dimensional tests: each coefficient lands in its own block, at its own size."""

    def setUp(self):
        self.pool = _pool()
        self.index = VarIndex(n=len(self.pool))
        self.c = build_objective(self.pool, self.index, RULES)

    def test_hit_costs_exactly_four(self):
        self.assertEqual(self.c[self.index.hits], -4.0)

    def test_starter_and_bench_sum_to_full_value(self):
        """
        A starter is worth his full xp. Since the coefficient is split across
        the squad and xi blocks, the two must sum to exactly 1.0 x xp — a split
        that does not close is a silent scaling of every projection.
        """
        for i, candidate in enumerate(self.pool):
            total = self.c[self.index.squad.start + i] + self.c[self.index.xi.start + i]
            self.assertAlmostEqual(total, candidate.xp, places=9)

    def test_benched_player_is_worth_the_bench_weight(self):
        for i, candidate in enumerate(self.pool):
            self.assertAlmostEqual(
                self.c[self.index.squad.start + i], BENCH_WEIGHT * candidate.xp
            )

    def test_captain_adds_a_second_full_share(self):
        """The armband doubles, so it adds one more xp on top of the starter's."""
        for i, candidate in enumerate(self.pool):
            self.assertAlmostEqual(self.c[self.index.captain.start + i], candidate.xp)

    def test_vice_is_weighted_not_doubled(self):
        for i, candidate in enumerate(self.pool):
            self.assertAlmostEqual(
                self.c[self.index.vice.start + i], VICE_WEIGHT * candidate.xp
            )

    def test_transfer_columns_carry_no_direct_value(self):
        """
        Buying is not itself rewarded — value arrives only through the squad the
        buy produces. A non-zero coefficient here would pay the solver to churn.
        """
        for block in (self.index.buy, self.index.sell):
            self.assertTrue((self.c[block] == 0.0).all())


class TestBudgetConstraint(unittest.TestCase):
    def test_bank_appears_at_tenths_scale(self):
        """
        The dimensional check from the plan: prices are tenths, so a candidate
        costing 45 must contribute exactly 45 to the budget row, not 4.5.
        """
        pool = _pool()
        index = VarIndex(n=len(pool))
        A, lo, hi = build_constraints(pool, index, RULES, [], 1000, 1)

        # The budget row is the one whose buy coefficients are the prices.
        budget_rows = [
            row for row in A
            if row[index.buy][0] == float(pool[0].buy_price)
        ]
        self.assertEqual(len(budget_rows), 1, "expected exactly one budget row")
        row = budget_rows[0]
        for i, candidate in enumerate(pool):
            self.assertEqual(row[index.buy.start + i], float(candidate.buy_price))
            self.assertEqual(row[index.sell.start + i], -float(candidate.sell_price))


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestSolve(unittest.TestCase):
    def setUp(self):
        self.pool = _pool()
        self.by_id = {c.element_id: c for c in self.pool}

    def test_initial_build_is_legal(self):
        """Closure assertions: every squad rule holds on the returned plan."""
        plan = solve(self.pool, RULES)[0]

        self.assertEqual(len(plan.squad), RULES.squad_size)
        self.assertEqual(len(set(plan.squad)), RULES.squad_size, "duplicate player")
        self.assertEqual(len(plan.xi), RULES.lineup_size)
        self.assertTrue(set(plan.xi) <= set(plan.squad), "starter outside the squad")

        for position, quota in RULES.quotas.items():
            got = sum(1 for p in plan.squad if self.by_id[p].position == position)
            self.assertEqual(got, quota, f"{position}: {got} != {quota}")

        for position, (low, high) in RULES.play_bounds.items():
            got = sum(1 for p in plan.xi if self.by_id[p].position == position)
            self.assertGreaterEqual(got, low)
            self.assertLessEqual(got, high)

        clubs: dict[str, int] = {}
        for p in plan.squad:
            clubs[self.by_id[p].team] = clubs.get(self.by_id[p].team, 0) + 1
        self.assertLessEqual(max(clubs.values()), RULES.club_limit)

        spend = sum(self.by_id[p].buy_price for p in plan.squad)
        self.assertLessEqual(spend, RULES.budget_tenths, "over budget")

    def test_captain_and_vice_are_distinct_and_start(self):
        plan = solve(self.pool, RULES)[0]
        self.assertNotEqual(plan.captain, plan.vice)
        self.assertIn(plan.captain, plan.xi)
        self.assertIn(plan.vice, plan.xi)

    def test_captain_is_the_highest_scoring_starter(self):
        """The armband is worth a full extra share, so it goes to the best player."""
        plan = solve(self.pool, RULES)[0]
        best = max(plan.xi, key=lambda p: self.by_id[p].xp)
        self.assertAlmostEqual(
            self.by_id[plan.captain].xp, self.by_id[best].xp, places=9
        )

    def test_objective_matches_manual_recompute(self):
        """
        The solver's objective must equal one recomputed from the player lists
        by an independent route, to 1e-6. This is the test that catches a
        mis-indexed column.
        """
        for plan in solve(self.pool, RULES, top_k=3):
            self.assertAlmostEqual(
                plan.objective, recompute_objective(plan, self.pool), delta=1e-6
            )

    def test_current_squad_is_feasible(self):
        """
        Holding an existing squad must always be available. If it were not, the
        solver would be forced to transfer every week regardless of merit.
        """
        squad = _cheapest_legal_squad(self.pool)
        plan = solve(
            self.pool, RULES, current_squad=squad, bank=0, free_transfers=0,
            max_transfers=0,
        )[0]
        self.assertEqual(sorted(plan.squad), sorted(squad))
        self.assertEqual(plan.hits, 0)
        self.assertEqual(plan.transfers_in, [])

    def test_no_transfers_means_no_hit(self):
        squad = _cheapest_legal_squad(self.pool)
        plan = solve(
            self.pool, RULES, current_squad=squad, bank=0, free_transfers=0,
            max_transfers=0,
        )[0]
        self.assertEqual(plan.hits, 0)

    def test_hit_cost_is_exactly_four(self):
        """
        A transfer beyond the free allowance costs 4 points, never 3.4 and never
        a decayed value. Verified by forcing two transfers on one free one and
        comparing against the same solve with two free transfers.
        """
        squad = _cheapest_legal_squad(self.pool)
        kwargs = dict(current_squad=squad, bank=1000, max_transfers=2)

        free = solve(self.pool, RULES, free_transfers=2, **kwargs)[0]
        paid = solve(self.pool, RULES, free_transfers=1, **kwargs)[0]

        self.assertEqual(len(paid.transfers_in), 2)
        self.assertEqual(paid.hits, 1)
        self.assertEqual(free.hits, 0)
        # Same squad on both sides, so the objectives differ by exactly the hit.
        self.assertEqual(sorted(paid.squad), sorted(free.squad))
        self.assertAlmostEqual(free.objective - paid.objective, 4.0, delta=1e-6)

    def test_hits_scale_linearly(self):
        """Two hits cost 8, not 4 and not 7.2 — the hit column is not a binary."""
        squad = _cheapest_legal_squad(self.pool)
        kwargs = dict(current_squad=squad, bank=1000, max_transfers=3)
        free = solve(self.pool, RULES, free_transfers=3, **kwargs)[0]
        paid = solve(self.pool, RULES, free_transfers=1, **kwargs)[0]
        self.assertEqual(paid.hits, 2)
        self.assertAlmostEqual(free.objective - paid.objective, 8.0, delta=1e-6)

    def test_top_k_returns_distinct_squads_in_order(self):
        plans = solve(self.pool, RULES, top_k=5)
        self.assertEqual(len(plans), 5)

        squads = [tuple(sorted(p.squad)) for p in plans]
        self.assertEqual(len(set(squads)), 5, "no-good cut did not exclude a squad")

        for better, worse in zip(plans, plans[1:]):
            self.assertGreaterEqual(better.objective + 1e-9, worse.objective)

    def _sell_price_scenario(self, target_price: int):
        """
        A squad with exactly one possible transfer, priced at the boundary.

        The held midfielder was bought at 40 and is now worth 60, so he sells for
        40 + floor(20 * 0.5) = 50, NOT 60. With a bank of zero, an upgrade priced
        between 51 and 60 is affordable if and only if the solver wrongly credits
        the sale at now_cost.
        """
        squad = _cheapest_legal_squad(self.pool)
        held_id = next(
            c.element_id for c in self.pool
            if c.element_id in set(squad) and c.position == "MID"
        )
        club = next(c.team for c in self.pool if c.element_id == held_id)
        target_id = next(
            c.element_id for c in self.pool
            if c.element_id not in set(squad) and c.position == "MID" and c.team == club
        )

        pool = []
        for c in self.pool:
            if c.element_id == held_id:
                pool.append(Candidate(**{**c.__dict__, "buy_price": 60, "sell_price": 50}))
            elif c.element_id == target_id:
                # Same club, so the club limit cannot be what blocks the move,
                # and a large xp gain so the FT value cannot be what blocks it.
                pool.append(Candidate(**{
                    **c.__dict__, "buy_price": target_price,
                    "sell_price": target_price, "xp": 30.0,
                }))
            else:
                # Everyone else priced out of reach, so this is the ONLY move
                # available and the test cannot pass via some unrelated transfer.
                pool.append(Candidate(**{**c.__dict__, "buy_price": 2000, "xp": 0.0}))
        return squad, pool, held_id, target_id

    def test_sale_credited_at_selling_price_not_now_cost(self):
        """
        A player who has risen sells for less than he now costs. Crediting the
        sale at now_cost overstates the bank on every sale, and the error
        compounds across a season into a squad FPL would reject.

        Priced at 55: affordable only on the wrong (now_cost = 60) credit, so the
        correct solver must decline despite a 30-point gain on offer.
        """
        squad, pool, _, target_id = self._sell_price_scenario(target_price=55)
        plan = solve(pool, RULES, current_squad=squad, bank=0, free_transfers=1)[0]

        self.assertEqual(
            plan.transfers_in, [],
            "solver bought a 55 player with only 50 raised: sale credited at now_cost",
        )
        self.assertEqual(plan.bank_after, 0)

    def test_the_same_move_is_taken_when_genuinely_affordable(self):
        """
        The companion direction. Without it the test above would pass on a solver
        that simply never transfers, which is a different bug with the same
        symptom.
        """
        squad, pool, held_id, target_id = self._sell_price_scenario(target_price=50)
        plan = solve(pool, RULES, current_squad=squad, bank=0, free_transfers=1)[0]

        self.assertEqual(plan.transfers_in, [target_id])
        self.assertEqual(plan.transfers_out, [held_id])
        self.assertEqual(plan.bank_after, 0, "50 raised, 50 spent")
        self.assertEqual(plan.hits, 0)

    def test_free_transfers_after_accrues_and_caps(self):
        squad = _cheapest_legal_squad(self.pool)
        unused = solve(
            self.pool, RULES, current_squad=squad, bank=0, free_transfers=1,
            max_transfers=0,
        )[0]
        self.assertEqual(unused.free_transfers_after, 2)

        capped = solve(
            self.pool, RULES, current_squad=squad, bank=0,
            free_transfers=RULES.max_banked_free_transfers, max_transfers=0,
        )[0]
        self.assertEqual(
            capped.free_transfers_after, RULES.max_banked_free_transfers
        )

    def _squad_with_one_weak_link(self, upgrade_gain: float):
        """
        A held squad, plus one available upgrade worth exactly ``upgrade_gain``.

        Everything not held is priced out of reach so the ONLY transfer the
        solver can make is the one under test. Without that, it would find some
        other move and the test would measure the wrong decision.
        """
        squad = _cheapest_legal_squad(self.pool)
        held = set(squad)
        worst = min(
            (c for c in self.pool if c.element_id in held and c.position == "MID"),
            key=lambda c: c.xp,
        )
        pool = []
        for c in self.pool:
            if c.element_id in held:
                pool.append(c)
            elif c.position == "MID" and c.team == worst.team:
                # The single legal upgrade. Priced at what the outgoing player
                # actually RAISES, not at what he now costs, so the swap is
                # exactly affordable from a zero bank and the test measures the
                # transfer threshold rather than the budget.
                pool.append(
                    Candidate(
                        element_id=c.element_id, position="MID", team=worst.team,
                        buy_price=worst.sell_price, sell_price=worst.sell_price,
                        xp=worst.xp + upgrade_gain,
                    )
                )
            else:
                pool.append(Candidate(**{**c.__dict__, "buy_price": 2000, "xp": 0.0}))
        return squad, pool

    def test_marginal_gain_below_ft_value_is_not_taken(self):
        """
        Restraint. A transfer gaining less than the free transfer is worth must
        be declined and the transfer banked — this is the mechanism by which the
        agent avoids losing to doing nothing.
        """
        squad, pool = self._squad_with_one_weak_link(upgrade_gain=0.5)
        plan = solve(pool, RULES, current_squad=squad, bank=0, free_transfers=1)[0]

        self.assertEqual(plan.transfers_in, [], "burned a transfer on a 0.5 gain")
        self.assertEqual(plan.free_transfers_banked, 1)

    def test_marginal_gain_above_ft_value_is_taken(self):
        """The mirror image: a clearly worthwhile upgrade must not be declined."""
        squad, pool = self._squad_with_one_weak_link(upgrade_gain=5.0)
        plan = solve(pool, RULES, current_squad=squad, bank=0, free_transfers=1)[0]

        self.assertEqual(len(plan.transfers_in), 1)
        self.assertEqual(plan.hits, 0)
        self.assertEqual(plan.free_transfers_banked, 0)

    def test_banking_is_capped_in_the_objective(self):
        """
        Holding more than the cap must not keep earning value, or the solver
        would rather bank forever than ever field an improved squad.
        """
        squad = _cheapest_legal_squad(self.pool)
        at_cap = solve(
            self.pool, RULES, current_squad=squad, bank=0,
            free_transfers=RULES.max_banked_free_transfers, max_transfers=0,
        )[0]
        self.assertEqual(at_cap.free_transfers_banked, RULES.max_banked_free_transfers)
        self.assertAlmostEqual(
            at_cap.objective,
            recompute_objective(at_cap, self.pool),
            delta=1e-6,
        )

    def test_hit_remains_feasible_with_the_bank_term(self):
        """
        Taking a hit sets the bank to zero. If the bank constraint's right-hand
        side went negative instead, the model would be infeasible exactly when a
        hit is worth taking — and would report that as "no legal squad exists".
        """
        squad = _cheapest_legal_squad(self.pool)
        plan = solve(
            self.pool, RULES, current_squad=squad, bank=1000,
            free_transfers=1, max_transfers=2,
        )[0]
        self.assertEqual(plan.hits, 1)
        self.assertEqual(plan.free_transfers_banked, 0)
        self.assertAlmostEqual(
            plan.objective, recompute_objective(plan, self.pool), delta=1e-6
        )

    def test_bank_must_be_given_when_a_squad_is_held(self):
        """
        Bank is cash in hand, not the total budget. Defaulting it to the budget
        with a squad held hands the optimiser a second 100.0m: measured on a
        73.0m held squad it returned a 115.0m team, over budget, with every
        assertion passing and nothing downstream re-checking cost.
        """
        squad = _cheapest_legal_squad(self.pool)
        with self.assertRaises(ValueError):
            solve(self.pool, RULES, current_squad=squad, free_transfers=5)

    def test_opening_build_still_defaults_to_the_full_budget(self):
        """The default is right when nothing is held — that case must not regress."""
        plan = solve(self.pool, RULES)[0]
        spend = sum(self.by_id[p].buy_price for p in plan.squad)
        self.assertLessEqual(spend, RULES.budget_tenths)

    def test_held_squad_cannot_exceed_the_budget(self):
        """
        The closure that the phantom-bank bug broke: whatever the solver does,
        the resulting squad must cost no more than budget minus remaining bank.
        """
        squad = _cheapest_legal_squad(self.pool)
        held_cost = sum(self.by_id[p].buy_price for p in squad)
        bank = RULES.budget_tenths - held_cost

        plan = solve(
            self.pool, RULES, current_squad=squad, bank=bank, free_transfers=5,
        )[0]
        cost = sum(self.by_id[p].buy_price for p in plan.squad)
        self.assertLessEqual(cost, RULES.budget_tenths)

    def test_owned_flags_disagreeing_with_current_squad_raise(self):
        """
        A pool flagging players owned while no squad is passed would build from
        scratch and report fifteen transfers in — a wildcard presented as a
        routine week.
        """
        squad = set(_cheapest_legal_squad(self.pool))
        pool = [
            Candidate(**{**c.__dict__, "owned": c.element_id in squad})
            for c in self.pool
        ]
        with self.assertRaises(ValueError):
            solve(pool, RULES, current_squad=(), bank=0)

    def test_duplicate_element_ids_raise(self):
        """
        Two columns for one footballer: the quota, club-limit and budget rows
        treat them as separate players, so he is selectable twice and his points
        counted twice while len(squad) == 15 still passes.
        """
        pool = list(self.pool) + [self.pool[0]]
        with self.assertRaises(InfeasibleError):
            solve(pool, RULES)

    def test_partial_squad_arithmetic(self):
        """
        slots_to_fill is otherwise only ever 15 or 0, so the mid-season
        partial-squad case the transfer-flow comment exists to justify is
        untested. Proven by mutation: replacing the formula with one that is
        identical at 15 and 0 passed every other test in this file.

        A 14-man squad must buy one player as a SLOT FILL, not a transfer.
        """
        full = _cheapest_legal_squad(self.pool)
        partial = full[:-1]
        dropped = self.by_id[full[-1]]

        plan = solve(
            self.pool, RULES, current_squad=partial,
            bank=dropped.buy_price, free_transfers=1, max_transfers=0,
        )[0]

        self.assertEqual(len(plan.squad), RULES.squad_size)
        self.assertEqual(len(plan.transfers_in), 1, "the empty slot was not filled")
        self.assertEqual(plan.transfers_out, [])
        self.assertEqual(plan.hits, 0, "filling an empty slot is not a transfer")
        self.assertEqual(plan.free_transfers_banked, 1, "the free transfer was spent")

    def test_armband_cannot_sit_on_the_bench(self):
        """
        The captain/vice row binds to the XI, not to the squad. Binding it to
        the squad is invisible on a pool where the best player always starts, so
        this uses two elite keepers — only one of whom can play.

        A benched vice can never inherit the armband, so the mutant produces a
        selection FPL would reject.
        """
        pool = [
            Candidate(**{**c.__dict__, "xp": 60.0}) if c.position == "GKP" and c.element_id <= 2
            else c
            for c in self.pool
        ]
        by_id = {c.element_id: c for c in pool}
        plan = solve(pool, RULES)[0]

        self.assertIn(plan.captain, plan.xi)
        self.assertIn(plan.vice, plan.xi)
        keepers_starting = [p for p in plan.xi if by_id[p].position == "GKP"]
        self.assertEqual(len(keepers_starting), 1, "more than one keeper started")

    def test_solver_failure_raises_not_returns(self):
        """
        An impossible pool must raise. Returning [] would be read by the caller
        as "nothing worth doing", and the squad would silently roll forward.
        """
        too_few = _pool()[:5]
        with self.assertRaises(InfeasibleError):
            solve(too_few, RULES)

    def test_empty_pool_raises(self):
        with self.assertRaises(InfeasibleError):
            solve([], RULES)

    def test_budget_actually_binds(self):
        """
        A budget the solver cannot exceed is only proven by one it wants to.
        With a tight budget the squad must cost less than with a loose one.
        """
        # Derived, not asserted: the club limit puts the true floor above the
        # naive per-position minimum, and hardcoding a number below it makes the
        # test infeasible for a reason that has nothing to do with the budget.
        floor = sum(
            self.by_id[p].buy_price for p in _cheapest_legal_squad(self.pool)
        )
        tight = floor + 30

        rich = solve(self.pool, RULES, bank=1000)[0]
        poor = solve(self.pool, RULES, bank=tight)[0]

        rich_cost = sum(self.by_id[p].buy_price for p in rich.squad)
        poor_cost = sum(self.by_id[p].buy_price for p in poor.squad)
        self.assertLessEqual(poor_cost, tight)
        self.assertGreater(rich_cost, poor_cost)
        self.assertGreater(rich.objective, poor.objective)


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestDeriveFtSchedule(unittest.TestCase):
    """
    The schedule this derives decides, every week, whether a transfer is taken
    or banked. It had no test at all, so an off-by-one in the differencing or a
    hit leaking into V(n) would have shifted all five marginals in the same
    direction while ``monotone_non_increasing`` stayed True — and the docstring
    invites a human to adopt the result.
    """

    def setUp(self):
        self.pool = _pool()
        self.by_id = {c.element_id: c for c in self.pool}
        squad = _cheapest_legal_squad(self.pool)
        held_cost = sum(self.by_id[p].buy_price for p in squad)
        self.scenario = (self.pool, squad, RULES.budget_tenths - held_cost)

    def test_returns_one_marginal_per_transfer(self):
        result = derive_ft_schedule([self.scenario], RULES, max_transfers=3)
        self.assertEqual(len(result["marginals"]), 3)
        self.assertEqual(result["n_scenarios"], 1)

    def test_marginals_are_never_negative(self):
        """
        V(n) is a maximum over a feasible set that grows with n, so it cannot
        fall. A negative marginal means a hit leaked into the objective — which
        is exactly what would happen if free_transfers and max_transfers were
        not pinned together.
        """
        result = derive_ft_schedule([self.scenario], RULES, max_transfers=4)
        for i, value in enumerate(result["marginals"], 1):
            self.assertGreaterEqual(value, -1e-9, f"marginal {i} is negative")

    def test_no_hit_is_ever_charged_during_derivation(self):
        """
        The measurement is of squad improvement. If a -4 were included, every
        marginal would be understated by up to 4 points with no outward sign.
        """
        pool, squad, bank = self.scenario
        for n in range(4):
            plan = solve(
                pool, RULES, current_squad=squad, bank=bank,
                free_transfers=n, max_transfers=n,
                ft_marginals=[0.0] * len(FT_MARGINAL_VALUE),
            )[0]
            self.assertEqual(plan.hits, 0, f"a hit was charged at n={n}")

    def test_ft_value_is_switched_off_during_derivation(self):
        """
        Leaving the value term on would pay the solver for banking and then
        report the payment back as the finding. Verified by checking a zeroed
        schedule really reaches the objective.
        """
        index = VarIndex(n=len(self.pool))
        zeroed = build_objective(
            self.pool, index, RULES, ft_marginals=[0.0] * len(FT_MARGINAL_VALUE)
        )
        self.assertTrue((zeroed[index.ft_bank] == 0.0).all())

        default = build_objective(self.pool, index, RULES)
        self.assertTrue((default[index.ft_bank] > 0.0).all())

    def test_wrong_length_schedule_is_rejected(self):
        """A short schedule would silently truncate the banked value."""
        index = VarIndex(n=len(self.pool))
        with self.assertRaises(ValueError):
            build_objective(self.pool, index, RULES, ft_marginals=[1.0, 0.5])

    def test_empty_scenarios_raise(self):
        with self.assertRaises(ValueError):
            derive_ft_schedule([], RULES)


if __name__ == "__main__":
    unittest.main()
