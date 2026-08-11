"""
Tests for the multi-gameweek MILP.

Two of these justify the whole module's existence, and neither is a legality
check:

* ``test_buys_ahead_of_a_fixture_swing`` — a one-week optimiser cannot buy a
  player whose run starts later, because it cannot see the run. If the horizon
  does not do this, it is an expensive way to reproduce H=1.
* ``test_evaluation_horizon_prices_the_terminal_squad`` — without weeks past the
  last transfer, ending the plan on a wrecked squad is free.

The rest guard the accrual chain, which is where the formulation is hardest: the
true rule ``ft[w+1] = min(5, max(0, ft[w] - used) + 1)`` has two
non-linearities, and both are encoded as inequalities that are only tight
because the objective pushes them there.
"""
from __future__ import annotations

import unittest

import numpy as np

from pipeline.decide.milp import Candidate
from pipeline.fpl.rules import load_rules

try:
    import scipy.optimize  # noqa: F401

    HAVE_SCIPY = True
except ImportError:  # pragma: no cover
    HAVE_SCIPY = False

from pipeline.decide.horizon import (
    EVAL_HORIZON,
    TRANSFER_HORIZON,
    HorizonIndex,
    build_horizon,
    solve_horizon,
)

RULES = load_rules()
CLUBS = ["Arsenal", "Chelsea", "Everton", "Fulham", "Liverpool", "Newcastle"]
COUNTS = {"GKP": 6, "DEF": 15, "MID": 15, "FWD": 9}


def _pool() -> list[Candidate]:
    candidates: list[Candidate] = []
    element_id = 1
    for position, count in COUNTS.items():
        for i in range(count):
            price = 40 + (i % 8) * 10
            candidates.append(
                Candidate(
                    element_id=element_id, position=position,
                    team=CLUBS[element_id % len(CLUBS)],
                    buy_price=price, sell_price=price - 5,
                    xp=1.0 + 0.9 * ((i * 3) % 8),
                )
            )
            element_id += 1
    return candidates


def _flat(pool, weeks):
    """Same expected points every week: no reason to transfer at all."""
    return [[c.xp for c in pool] for _ in range(weeks)]


def _cheapest_legal_squad(pool):
    chosen, per_club = [], {}
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
        assert taken == quota
    return [c.element_id for c in chosen]


class TestHorizonIndex(unittest.TestCase):
    def test_weeks_tile_the_vector_without_overlap(self):
        index = HorizonIndex(n=5, weeks=4)
        seen: list[int] = []
        for w in range(4):
            wi = index.week(w)
            for block in wi.blocks().values():
                seen.extend(range(block.start, block.stop))
            seen.extend([wi.hits, wi.free_transfers, wi.remaining])
            seen.extend(range(wi.ft_bank.start, wi.ft_bank.stop))

        self.assertEqual(len(seen), index.size, "weeks do not cover the vector")
        self.assertEqual(len(set(seen)), index.size, "weeks overlap")
        self.assertEqual(sorted(seen), list(range(index.size)), "gap in the vector")

    def test_week_out_of_range_raises(self):
        index = HorizonIndex(n=3, weeks=2)
        for bad in (-1, 2, 99):
            with self.assertRaises(IndexError):
                index.week(bad)

    def test_weeks_are_disjoint_pairwise(self):
        """A shared column between weeks would silently couple two gameweeks."""
        index = HorizonIndex(n=4, weeks=3)
        columns = []
        for w in range(3):
            wi = index.week(w)
            columns.append(set(range(wi.base, wi.base + wi.width)))
        self.assertEqual(columns[0] & columns[1], set())
        self.assertEqual(columns[1] & columns[2], set())


class TestBuildHorizon(unittest.TestCase):
    def test_mismatched_xp_row_raises(self):
        pool = _pool()
        with self.assertRaises(ValueError):
            build_horizon(pool, [[1.0] * (len(pool) - 1)], RULES)

    def test_empty_horizon_raises(self):
        with self.assertRaises(ValueError):
            build_horizon(_pool(), [], RULES)

    def test_bank_required_when_a_squad_is_held(self):
        pool = _pool()
        squad = _cheapest_legal_squad(pool)
        with self.assertRaises(ValueError):
            build_horizon(pool, _flat(pool, 2), RULES, current_squad=squad)

    def test_hit_costs_four_in_every_week(self):
        """
        Never discounted. With a decay a hit five weeks out would cost about two
        points, and the solver would plan hits it never takes — distorting this
        week's decision through a phantom future.

        The cost is split across two columns: the purchase carries
        -FT_USE_COST and the hit carries +FT_USE_COST, so a hit nets exactly -4
        rather than paying the free-transfer cost it never consumed. The NET is
        what must be four, which is why this sums them rather than reading the
        hits column alone.
        """
        pool = _pool()
        c, _, _, _, index = build_horizon(pool, _flat(pool, 5), RULES)
        for w in range(5):
            wi = index.week(w)
            self.assertAlmostEqual(
                c[wi.hits] + c[wi.buy][0], -4.0, places=9, msg=f"week {w}"
            )

    def test_only_the_final_week_banks_transfer_value(self):
        """
        The terminal bank is a boundary value — what transfers carried past the
        end of the horizon are worth — so it belongs in the last week only.

        It is NOT the anti-churn term. Over a long horizon it saturates at the
        cap regardless of early spending, which is what FT_USE_COST exists to
        fix; see test_negligible_gain_does_not_burn_a_transfer_at_any_horizon.
        """
        pool = _pool()
        c, _, _, _, index = build_horizon(pool, _flat(pool, 4), RULES)
        for w in range(3):
            self.assertTrue((c[index.week(w).ft_bank] == 0.0).all(), f"week {w}")
        self.assertTrue((c[index.week(3).ft_bank] > 0.0).all())


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestSolveHorizon(unittest.TestCase):
    def setUp(self):
        self.pool = _pool()
        self.by_id = {c.element_id: c for c in self.pool}

    def test_every_week_is_a_legal_squad(self):
        plan = solve_horizon(self.pool, _flat(self.pool, 3), RULES)[0]
        self.assertEqual(len(plan.weeks), 3)
        for w, week in enumerate(plan.weeks):
            self.assertEqual(len(week.squad), RULES.squad_size, f"week {w}")
            self.assertEqual(len(week.xi), RULES.lineup_size, f"week {w}")
            self.assertTrue(set(week.xi) <= set(week.squad), f"week {w}")
            self.assertIn(week.captain, week.xi)
            self.assertNotEqual(week.captain, week.vice)
            for position, quota in RULES.quotas.items():
                got = sum(1 for p in week.squad if self.by_id[p].position == position)
                self.assertEqual(got, quota, f"week {w} {position}")

    def test_squad_is_continuous_across_weeks(self):
        """
        Each week's squad must equal the previous one plus buys minus sells. A
        break in that chain would let the optimiser teleport into a squad it
        never paid for.
        """
        plan = solve_horizon(self.pool, _flat(self.pool, 3), RULES)[0]
        for w in range(1, len(plan.weeks)):
            previous = set(plan.weeks[w - 1].squad)
            expected = (previous - set(plan.weeks[w].transfers_out)) | set(
                plan.weeks[w].transfers_in
            )
            self.assertEqual(set(plan.weeks[w].squad), expected, f"week {w}")

    def test_flat_projection_produces_no_churn(self):
        """
        With identical points every week there is nothing to gain by
        transferring, so any move is the solver paying for noise.
        """
        plan = solve_horizon(self.pool, _flat(self.pool, 4), RULES)[0]
        for w, week in enumerate(plan.weeks[1:], start=1):
            self.assertEqual(week.transfers_in, [], f"week {w} churned")
            self.assertEqual(week.hits, 0, f"week {w} took a gratuitous hit")

    def test_opening_build_is_not_charged_transfers(self):
        plan = solve_horizon(self.pool, _flat(self.pool, 3), RULES, free_transfers=1)[0]
        self.assertEqual(plan.now.hits, 0)
        self.assertEqual(len(plan.now.transfers_in), RULES.squad_size)

    def test_cash_never_goes_negative_at_any_point(self):
        """
        Cumulative, not per-week: a per-week-only constraint would let the
        solver overdraw in week two and repay in week four.
        """
        plan = solve_horizon(self.pool, _flat(self.pool, 4), RULES)[0]
        for w, week in enumerate(plan.weeks):
            self.assertGreaterEqual(week.bank_after, 0, f"week {w} overdrawn")

    def test_buys_ahead_of_a_fixture_swing(self):
        """
        The reason the horizon exists. One midfielder is worthless for two weeks
        then excellent; a one-week optimiser can never see that and will not buy
        him. The horizon must, and must hold him into the good weeks.
        """
        squad = _cheapest_legal_squad(self.pool)
        held = set(squad)
        target = next(
            c for c in self.pool
            if c.element_id not in held and c.position == "MID"
            and c.team == self.by_id[
                next(p for p in squad if self.by_id[p].position == "MID")
            ].team
        )
        weak = min(
            (c for c in self.pool if c.element_id in held and c.position == "MID"),
            key=lambda c: c.xp,
        )

        pool = []
        for c in self.pool:
            if c.element_id == target.element_id:
                pool.append(Candidate(**{
                    **c.__dict__, "buy_price": weak.sell_price,
                    "sell_price": weak.sell_price, "xp": 0.0,
                }))
            elif c.element_id in held:
                pool.append(c)
            else:
                pool.append(Candidate(**{**c.__dict__, "buy_price": 2000, "xp": 0.0}))

        # Worthless in weeks 0-1, then far better than the man he replaces.
        by_index = {c.element_id: i for i, c in enumerate(pool)}
        xp_by_week = []
        for w in range(4):
            row = [c.xp for c in pool]
            row[by_index[target.element_id]] = 0.0 if w < 2 else 40.0
            xp_by_week.append(row)

        plan = solve_horizon(
            pool, xp_by_week, RULES, current_squad=squad, bank=0, free_transfers=1,
        )[0]
        bought = {p for week in plan.weeks for p in week.transfers_in}
        self.assertIn(
            target.element_id, bought,
            "the horizon did not buy into a fixture swing it could see",
        )
        self.assertIn(
            target.element_id, plan.weeks[-1].squad,
            "bought the swing player then sold him before it arrived",
        )

    def test_evaluation_horizon_prices_the_terminal_squad(self):
        """
        Weeks past the transfer horizon must be scored on the frozen squad. If
        they were not, ending on a wrecked squad would be free — the cost lands
        one week past where the objective can see.
        """
        plan = solve_horizon(
            self.pool, _flat(self.pool, 4), RULES, transfer_horizon=2,
        )[0]
        self.assertEqual(plan.transfer_horizon, 2)
        self.assertEqual(plan.eval_horizon, 4)
        for w in (2, 3):
            self.assertEqual(plan.weeks[w].transfers_in, [], f"week {w} transferred")
            self.assertEqual(plan.weeks[w].transfers_out, [], f"week {w} transferred")
            self.assertEqual(
                sorted(plan.weeks[w].squad), sorted(plan.weeks[1].squad),
                f"week {w} squad drifted after the transfer horizon",
            )

    def test_transfer_horizon_is_clamped_to_the_evaluation_horizon(self):
        plan = solve_horizon(
            self.pool, _flat(self.pool, 2), RULES, transfer_horizon=6,
        )[0]
        self.assertEqual(plan.transfer_horizon, 2)

    def test_free_transfers_accrue_one_a_week_and_cap(self):
        """
        The accrual chain, which is the hardest part of the formulation: the
        true rule has two non-linearities and both are encoded as inequalities
        that are only tight because the objective pushes them there.
        """
        squad = _cheapest_legal_squad(self.pool)
        plan = solve_horizon(
            self.pool, _flat(self.pool, 5), RULES,
            current_squad=squad, bank=0, free_transfers=1,
        )[0]
        # Nothing is worth transferring, so the bank should climb 1,2,3... and stop.
        banked = [w.free_transfers_banked for w in plan.weeks]
        for earlier, later in zip(banked, banked[1:]):
            self.assertGreaterEqual(later, earlier, f"bank fell without a transfer: {banked}")
        self.assertLessEqual(
            max(banked), RULES.max_banked_free_transfers,
            f"banked past the cap: {banked}",
        )

    def test_only_the_first_week_is_presented_as_a_commitment(self):
        plan = solve_horizon(self.pool, _flat(self.pool, 3), RULES)[0]
        payload = plan.as_dict()
        self.assertIn("now", payload)
        self.assertEqual(len(payload["provisional"]), 2)
        self.assertEqual(payload["now"], plan.now.as_dict())

    def test_defaults_match_the_documented_split(self):
        self.assertGreater(EVAL_HORIZON, TRANSFER_HORIZON)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestHorizonShortlist(unittest.TestCase):
    def setUp(self):
        self.pool = _pool()

    def test_top_k_returns_distinct_week_zero_squads(self):
        """
        Distinctness is on week 0 because week 0 is the only commitment. Two
        plans that field the same squad now and diverge in week four are the
        same decision, and offering both would fill the shortlist with choices
        nobody makes.
        """
        plans = solve_horizon(self.pool, _flat(self.pool, 3), RULES, top_k=4)
        self.assertEqual(len(plans), 4)
        squads = [tuple(sorted(p.now.squad)) for p in plans]
        self.assertEqual(len(set(squads)), 4, "week-0 squads repeated")

    def test_shortlist_is_ordered_by_objective(self):
        """
        Non-increasing to within solver tolerance. Exact comparison is wrong
        here: genuinely tied plans come back differing at the 1e-14 level, which
        is HiGHS arithmetic rather than a real ordering violation.
        """
        plans = solve_horizon(self.pool, _flat(self.pool, 3), RULES, top_k=3)
        objectives = [p.objective for p in plans]
        for better, worse in zip(objectives, objectives[1:]):
            self.assertGreaterEqual(
                better, worse - 1e-6, f"shortlist out of order: {objectives}"
            )

    def test_default_returns_a_single_plan(self):
        self.assertEqual(len(solve_horizon(self.pool, _flat(self.pool, 2), RULES)), 1)


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestAccrualChain(unittest.TestCase):
    """
    The accrual chain against the real rule, week by week.

    ft[w+1] = min(5, max(0, ft[w] - used[w]) + 1) has two non-linearities, both
    encoded as inequalities that are tight only because the objective pushes
    them there. That is an argument, not a proof, so it is checked numerically
    against the rule on every week of several scenarios.
    """

    def setUp(self):
        self.pool = _pool()
        self.squad = _cheapest_legal_squad(self.pool)

    def _check_chain(self, plan, initial_ft):
        held = initial_ft
        for w, week in enumerate(plan.weeks):
            used = len(week.transfers_in) - (
                RULES.squad_size - len(self.squad) if w == 0 else 0
            )
            self.assertGreaterEqual(used, 0, f"week {w}: negative transfer count")

            self.assertEqual(
                week.hits, max(0, used - held),
                f"week {w}: hits {week.hits} != max(0, {used} - {held})",
            )
            self.assertEqual(
                week.free_transfers_banked, max(0, held - used),
                f"week {w}: banked {week.free_transfers_banked} != max(0, {held} - {used})",
            )
            self.assertLessEqual(
                week.free_transfers_banked, RULES.max_banked_free_transfers,
                f"week {w}: banked past the cap",
            )
            expected_next = min(
                RULES.max_banked_free_transfers, max(0, held - used) + 1
            )
            self.assertEqual(
                week.free_transfers_after, expected_next,
                f"week {w}: next-week FT {week.free_transfers_after} != {expected_next}",
            )
            held = week.free_transfers_after

    def test_chain_holds_from_one_free_transfer(self):
        plan = solve_horizon(
            self.pool, _flat(self.pool, 5), RULES,
            current_squad=self.squad, bank=0, free_transfers=1,
        )[0]
        self._check_chain(plan, 1)

    def test_chain_holds_starting_at_the_cap(self):
        """Starting full, the bank must never exceed five however many weeks pass."""
        plan = solve_horizon(
            self.pool, _flat(self.pool, 5), RULES, current_squad=self.squad,
            bank=0, free_transfers=RULES.max_banked_free_transfers,
        )[0]
        self._check_chain(plan, RULES.max_banked_free_transfers)

    def test_chain_holds_with_zero_free_transfers(self):
        """From zero, any transfer at all is a hit."""
        plan = solve_horizon(
            self.pool, _flat(self.pool, 4), RULES,
            current_squad=self.squad, bank=0, free_transfers=0,
        )[0]
        self._check_chain(plan, 0)

    def test_solver_columns_agree_with_the_replayed_chain(self):
        """
        Read the MILP's OWN hits and remaining columns, not the replayed values.

        The previous version of this test compared two numbers ``_extract``
        derives from the same pair of scalars, so at most one could ever be
        positive and it could not fail for any solver output whatsoever. The
        formulation permits hits and remaining to be simultaneously large — the
        only bound is ``remaining <= ft - used + hits`` — and nothing would have
        noticed.
        """
        from scipy.optimize import Bounds, LinearConstraint, milp

        from pipeline.decide.horizon import build_horizon

        initial = 3
        c, rows, lo, hi, index = build_horizon(
            self.pool, _flat(self.pool, 4), RULES,
            current_squad=self.squad, bank=0, free_transfers=initial,
        )
        lower, upper = np.zeros(index.size), np.ones(index.size)
        integrality = np.ones(index.size)
        for w in range(index.weeks):
            wi = index.week(w)
            upper[wi.hits] = float(RULES.squad_size)
            upper[wi.free_transfers] = float(RULES.max_banked_free_transfers)
            upper[wi.remaining] = float(RULES.max_banked_free_transfers)
            integrality[wi.ft_bank] = 0.0

        result = milp(
            c=-c,
            constraints=[LinearConstraint(np.array(rows), np.array(lo), np.array(hi))],
            integrality=integrality, bounds=Bounds(lower, upper),
            options={"mip_rel_gap": 0.0, "time_limit": 120.0},
        )
        self.assertTrue(result.success)

        held = initial
        for w in range(index.weeks):
            wi = index.week(w)
            solver_hits = int(round(result.x[wi.hits]))
            solver_remaining = int(round(result.x[wi.remaining]))
            solver_held = int(round(result.x[wi.free_transfers]))
            bought = int(round(result.x[wi.buy].sum()))
            used = bought - (RULES.squad_size - len(self.squad) if w == 0 else 0)

            self.assertEqual(solver_held, held, f"week {w}: held column drifted")
            self.assertEqual(
                solver_hits, max(0, used - held),
                f"week {w}: solver charged {solver_hits} hits for {used} transfers "
                f"on {held} free",
            )
            self.assertEqual(
                solver_remaining, max(0, held - used),
                f"week {w}: solver's remaining column is {solver_remaining}, "
                f"true value {max(0, held - used)}",
            )
            self.assertFalse(
                solver_hits > 0 and solver_remaining > 0,
                f"week {w}: {solver_hits} hits alongside {solver_remaining} banked "
                f"— the solver inflated a hit to unlock bank value",
            )
            held = min(RULES.max_banked_free_transfers, max(0, held - used) + 1)

    def test_negligible_gain_does_not_burn_a_transfer_at_any_horizon(self):
        """
        The churn regression. A terminal-bank credit cannot carry the anti-churn
        threshold over a long horizon: one transfer accrues weekly and the bank
        caps at five, so by week five the terminal bank saturates whether or not
        early transfers were spent, and spending one became free.

        Measured before the fix: offered +0.01 a week, the single-week MILP
        declined while the six- and eight-week horizons both spent the transfer
        — churning for 0.08 projected points against a transfer worth 1.75.
        """
        held = set(self.squad)
        worst = min(
            (c for c in self.pool if c.element_id in held and c.position == "MID"),
            key=lambda c: c.xp,
        )
        pool = []
        for c in self.pool:
            if c.element_id in held:
                pool.append(c)
            elif c.position == "MID" and c.team == worst.team:
                pool.append(Candidate(**{
                    **c.__dict__, "buy_price": worst.sell_price,
                    "sell_price": worst.sell_price, "xp": worst.xp + 0.01,
                }))
            else:
                pool.append(Candidate(**{**c.__dict__, "buy_price": 2000, "xp": 0.0}))

        for weeks in (2, 4, 6, 8):
            plan = solve_horizon(
                pool, [[c.xp for c in pool] for _ in range(weeks)], RULES,
                current_squad=self.squad, bank=0, free_transfers=1,
            )[0]
            self.assertEqual(
                plan.now.transfers_in, [],
                f"eval={weeks}: burned a free transfer for +0.01 a week",
            )

    def test_worthwhile_gain_is_still_taken_at_every_horizon(self):
        """
        The companion. Without it the test above would pass on a horizon that
        simply never transfers, which is a different failure with one symptom.
        """
        held = set(self.squad)
        worst = min(
            (c for c in self.pool if c.element_id in held and c.position == "MID"),
            key=lambda c: c.xp,
        )
        pool = []
        for c in self.pool:
            if c.element_id in held:
                pool.append(c)
            elif c.position == "MID" and c.team == worst.team:
                pool.append(Candidate(**{
                    **c.__dict__, "buy_price": worst.sell_price,
                    "sell_price": worst.sell_price, "xp": worst.xp + 5.0,
                }))
            else:
                pool.append(Candidate(**{**c.__dict__, "buy_price": 2000, "xp": 0.0}))

        for weeks in (2, 4, 6, 8):
            plan = solve_horizon(
                pool, [[c.xp for c in pool] for _ in range(weeks)], RULES,
                current_squad=self.squad, bank=0, free_transfers=1,
            )[0]
            self.assertEqual(
                len(plan.now.transfers_in), 1,
                f"eval={weeks}: declined a +5.0/week upgrade",
            )

    def test_hit_costs_exactly_four_not_four_plus_the_use_cost(self):
        """
        A hit is not a free transfer being consumed. Charging both would price
        it at -5.75 and make the agent far too reluctant to take a correct hit.
        """
        c, _, _, _, index = build_horizon(self.pool, _flat(self.pool, 3), RULES)
        for w in range(3):
            wi = index.week(w)
            # buy carries -FT_USE_COST and hits carries +FT_USE_COST, so a hit
            # nets exactly -4 once its purchase is accounted for.
            self.assertAlmostEqual(
                c[wi.hits] + c[wi.buy][0], -4.0, places=9,
                msg=f"week {w}: a hit does not net -4",
            )

    def test_explicit_zero_transfer_horizon_is_reported_honestly(self):
        """
        `or` would treat 0 as unset. A plan solved with transfers forbidden
        everywhere would then be published claiming six weeks were available.
        """
        plan = solve_horizon(
            self.pool, _flat(self.pool, 4), RULES, current_squad=self.squad,
            bank=0, transfer_horizon=0,
        )[0]
        self.assertEqual(plan.transfer_horizon, 0)
        self.assertEqual(sum(len(w.transfers_in) for w in plan.weeks), 0)
