"""
Tests for a human-pinned wildcard week in the horizon MILP.

The chip changes three things in its week, all taken from the FPL rule as
``entry_api.replay_free_transfers`` already encodes it: transfers are unlimited
and cost no hits, they do not spend the free-transfer bank, and the week's +1
still accrues. The tests below check each of those on the solver's OWN columns
as well as on the published plan, because the plan replays the chain and a
replay cannot catch a formulation that disagrees with it.

The guard that matters most is the first: with no wildcard pinned, the model
must be the one that shipped before chips existed, to the last bit.
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

from pipeline.decide.horizon import build_horizon, solve_horizon
from pipeline.tests.test_decide_horizon import _cheapest_legal_squad, _flat, _pool

RULES = load_rules()
QUOTAS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}


def _rebuild_pool():
    """
    Fifteen held players worth 1 point a week and fifteen identical-priced
    replacements worth 2, spread over enough clubs that the club limit never
    binds. Over three weeks a move gains 3: more than a free transfer's use
    cost, less than a hit's 4 — so only the chip makes the full rebuild pay. Selling and buying prices are equal, which is exactly the case where
    a free move lets the solver sell and rebuy the same player for nothing.
    """
    pool, held, element_id = [], [], 1
    for position, quota in QUOTAS.items():
        for xp, keep in ((1.0, True), (2.0, False)):
            for _ in range(quota):
                pool.append(Candidate(
                    element_id=element_id, position=position,
                    team=f"Club{element_id % 20}",
                    buy_price=50, sell_price=50, xp=xp,
                ))
                if keep:
                    held.append(element_id)
                element_id += 1
    return pool, held


def _solve_columns(pool, xp_by_week, **kwargs):
    """Solve through build_horizon directly, so the raw columns can be read."""
    from scipy.optimize import Bounds, LinearConstraint, milp

    c, rows, lo, hi, index = build_horizon(pool, xp_by_week, RULES, **kwargs)
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
    assert result.success, result.message
    return result.x, index


class TestNoWildcardIsTheShippedModel(unittest.TestCase):
    def test_build_is_identical_with_and_without_an_explicit_none(self):
        pool = _pool()
        squad = _cheapest_legal_squad(pool)
        default = build_horizon(pool, _flat(pool, 4), RULES, current_squad=squad, bank=50)
        explicit = build_horizon(
            pool, _flat(pool, 4), RULES, current_squad=squad, bank=50,
            wildcard_week=None,
        )
        np.testing.assert_array_equal(default[0], explicit[0])
        self.assertEqual(len(default[1]), len(explicit[1]))
        for a, b in zip(default[1], explicit[1]):
            np.testing.assert_array_equal(a, b)
        self.assertEqual(default[2], explicit[2])
        self.assertEqual(default[3], explicit[3])

    @unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
    def test_objective_matches_the_pre_chip_model(self):
        """
        Golden values measured on the commit before chips existed (2be61c9c),
        with the same pool and projection. A change to any chip-free row or
        coefficient moves these.
        """
        pool = _pool()
        squad = _cheapest_legal_squad(pool)
        varied = [
            [c.xp * (1.0 + 0.15 * ((c.element_id * (w + 3)) % 7 - 3) / 3) for c in pool]
            for w in range(8)
        ]
        cases = {
            "opening build": (dict(xp_by_week=_flat(pool, 3)), 222.4565),
            "held, 1 FT": (
                dict(xp_by_week=varied, current_squad=squad, bank=50, free_transfers=1),
                470.11524999999926,
            ),
            "held, 3 FT": (
                dict(xp_by_week=varied, current_squad=squad, bank=50, free_transfers=3),
                474.61525000000023,
            ),
        }
        for name, (kwargs, golden) in cases.items():
            with self.subTest(name):
                plan = solve_horizon(pool, rules=RULES, **kwargs)[0]
                self.assertAlmostEqual(plan.objective, golden, places=6)
                self.assertIsNone(plan.wildcard_week)
                self.assertNotIn("wildcard_week", plan.as_dict())
                for week in plan.weeks:
                    self.assertIsNone(week.chip)
                    self.assertNotIn("chip", week.as_dict())


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestWildcardWeek(unittest.TestCase):
    def setUp(self):
        self.pool, self.held = _rebuild_pool()
        self.weeks = [[c.xp for c in self.pool] for _ in range(3)]

    def _solve(self, **kwargs):
        params = dict(current_squad=self.held, bank=0, free_transfers=2)
        params.update(kwargs)
        return solve_horizon(self.pool, self.weeks, RULES, **params)[0]

    def test_chip_week_rebuilds_with_no_hits_and_an_untouched_bank(self):
        plan = self._solve(wildcard_week=0)
        week = plan.weeks[0]
        self.assertGreaterEqual(len(week.transfers_in), 10, week.transfers_in)
        self.assertEqual(len(week.transfers_in), len(week.transfers_out))
        self.assertEqual(week.hits, 0)
        self.assertEqual(week.chip, "wildcard")
        # Entered with 2, left with 2, and the +1 still accrues.
        self.assertEqual(week.free_transfers_banked, 2)
        self.assertEqual(week.free_transfers_after, 3)

    def test_without_the_chip_the_same_rebuild_is_not_taken(self):
        """The contrast that shows the chip is doing the work."""
        plan = self._solve()
        self.assertLess(len(plan.weeks[0].transfers_in), 10)
        self.assertIsNone(plan.weeks[0].chip)

    def test_remaining_chain_after_the_chip_week_on_the_solver_columns(self):
        """
        Read the MILP's own held / remaining / hits columns and compare each
        week against the replay rule, with ``used = 0`` in the chip week. The
        published plan replays the same rule, so only the columns can disagree.
        """
        for wildcard_week, initial in ((0, 2), (1, 1), (1, 4), (2, 5)):
            with self.subTest(wildcard_week=wildcard_week, initial=initial):
                x, index = _solve_columns(
                    self.pool, self.weeks, current_squad=self.held, bank=0,
                    free_transfers=initial, wildcard_week=wildcard_week,
                )
                held_ft = initial
                for w in range(index.weeks):
                    wi = index.week(w)
                    bought = int(round(x[wi.buy].sum()))
                    used = 0 if w == wildcard_week else bought
                    self.assertEqual(int(round(x[wi.free_transfers])), held_ft, f"week {w}")
                    self.assertEqual(
                        int(round(x[wi.remaining])), max(0, held_ft - used), f"week {w}",
                    )
                    if w == wildcard_week:
                        self.assertEqual(int(round(x[wi.hits])), 0)
                    held_ft = min(
                        RULES.max_banked_free_transfers, max(0, held_ft - used) + 1,
                    )

    def test_published_chain_matches_the_replay_after_a_later_chip_week(self):
        plan = self._solve(wildcard_week=1, free_transfers=1)
        chip = plan.weeks[1]
        self.assertEqual(chip.chip, "wildcard")
        self.assertEqual(chip.hits, 0)
        entering = plan.weeks[0].free_transfers_after
        self.assertEqual(chip.free_transfers_banked, entering)
        self.assertEqual(
            chip.free_transfers_after,
            min(RULES.max_banked_free_transfers, entering + 1),
        )
        self.assertEqual(
            plan.weeks[2].free_transfers_banked,
            max(0, chip.free_transfers_after - len(plan.weeks[2].transfers_in)),
        )
        for w in (0, 2):
            self.assertIsNone(plan.weeks[w].chip)

    def test_chip_week_never_sells_and_rebuys_the_same_player(self):
        """
        Equal buy and sell prices make a same-week sell-and-rebuy free in cash.
        The structural row forbids it whatever the friction.
        """
        for friction in (0.0, 1.0):
            with self.subTest(friction=friction):
                plan = self._solve(wildcard_week=0, wildcard_friction=friction)
                week = plan.weeks[0]
                self.assertEqual(set(week.transfers_in) & set(week.transfers_out), set())

        c, rows, lo, hi, index = build_horizon(
            self.pool, self.weeks, RULES, current_squad=self.held, bank=0,
            wildcard_week=1,
        )
        wi = index.week(1)
        pairs = {
            (int(np.flatnonzero(r)[0]), int(np.flatnonzero(r)[1]))
            for r, h in zip(rows, hi)
            if h == 1.0 and np.count_nonzero(r) == 2
        }
        for i in range(index.n):
            self.assertIn((wi.buy.start + i, wi.sell.start + i), pairs, f"player {i}")

    def test_friction_replaces_the_free_transfer_use_cost(self):
        """A friction above the gain per move (3 over the horizon here) stops the rebuild."""
        plan = self._solve(wildcard_week=0, wildcard_friction=20.0)
        self.assertEqual(plan.weeks[0].transfers_in, [])

    def test_published_record_carries_the_chip(self):
        plan = self._solve(wildcard_week=1)
        payload = plan.as_dict()
        self.assertEqual(payload["wildcard_week"], 1)
        self.assertNotIn("chip", payload["now"])
        self.assertEqual(payload["provisional"][0]["chip"], "wildcard")
        self.assertEqual(payload["provisional"][0]["hits"], 0)

    def test_a_chip_outside_the_transfer_window_is_refused(self):
        for bad in (-1, 2, 3):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_horizon(
                    self.pool, self.weeks, RULES, current_squad=self.held, bank=0,
                    transfer_horizon=2, wildcard_week=bad,
                )
        with self.assertRaises(TypeError):
            build_horizon(
                self.pool, self.weeks, RULES, current_squad=self.held, bank=0,
                wildcard_week=True,
            )
        with self.assertRaises(ValueError):
            build_horizon(
                self.pool, self.weeks, RULES, current_squad=self.held, bank=0,
                wildcard_week=0, wildcard_friction=-1.0,
            )


@unittest.skipUnless(HAVE_SCIPY, "scipy/HiGHS not installed")
class TestDecideCarriesTheChip(unittest.TestCase):
    """The chip has to survive adjudication and reach the artifact."""

    def setUp(self):
        from pipeline.tests import test_decide_run as fixtures

        self.fx = fixtures
        self.held = self._weakest_legal_squad()

    def _weakest_legal_squad(self):
        xp = {row["element_id"]: row["xp"] for row in self.fx.XP_ROWS}
        positions = {1: 2, 2: 5, 3: 5, 4: 3}
        chosen, per_club = [], {}
        for element_type, quota in positions.items():
            pool = [e for e in self.fx.BOOTSTRAP["elements"] if e["element_type"] == element_type]
            taken = 0
            for e in sorted(pool, key=lambda e: (xp[e["id"]], e["id"])):
                if taken >= quota or per_club.get(e["team"], 0) >= RULES.club_limit:
                    continue
                chosen.append(e["id"])
                per_club[e["team"]] = per_club.get(e["team"], 0) + 1
                taken += 1
        return chosen

    def _decide(self, **kwargs):
        params = dict(
            gameweek=9, draws_select=self.fx._draws(seed=11),
            draws_report=self.fx._draws(seed=12), bootstrap=self.fx.BOOTSTRAP,
            rules=RULES, xp_rows=self.fx.XP_ROWS, shortlist_size=2,
            held=self.held, bank=1000, free_transfers=1,
            xp_by_week=[
                {row["element_id"]: row["xp"] for row in self.fx.XP_ROWS}
                for _ in range(3)
            ],
        )
        params.update(kwargs)
        return self.fx.decide(**params)

    def test_this_week_wildcard_reaches_the_published_plan_with_no_hits(self):
        decision = self._decide(wildcard_week=0)
        plan = decision.reported.plan
        self.assertEqual(plan.chip, "wildcard")
        self.assertEqual(plan.hits, 0)
        self.assertGreater(len(plan.transfers_in), 1)
        self.assertEqual(decision.horizon["wildcard_gameweek"], 9)
        public = self.fx.strip_for_publication(decision)
        self.assertEqual(public["decision"]["plan"]["chip"], "wildcard")
        self.assertEqual(public["decision"]["plan"]["hits"], 0)

    def test_a_later_wildcard_is_recorded_on_its_own_week(self):
        decision = self._decide(wildcard_week=1)
        self.assertEqual(decision.horizon["wildcard_gameweek"], 10)
        self.assertEqual(decision.horizon["provisional"][0]["chip"], "wildcard")
        self.assertIsNone(decision.reported.plan.chip)

    def test_a_wildcard_beyond_the_window_is_planned_without(self):
        decision = self._decide(wildcard_week=2, transfer_horizon=2)
        self.assertNotIn("wildcard_gameweek", decision.horizon)
        self.assertFalse(any("wildcard" in w for w in decision.warnings))

    def test_a_past_wildcard_is_refused(self):
        with self.assertRaises(ValueError):
            self._decide(wildcard_week=-1)

    def test_a_myopic_run_says_it_ignored_the_chip(self):
        decision = self._decide(xp_by_week=None, wildcard_week=0)
        self.assertIsNone(decision.horizon)
        self.assertTrue(any("wildcard" in w for w in decision.warnings), decision.warnings)


class TestWildcardOffsetFromConfig(unittest.TestCase):
    def test_absolute_gameweek_becomes_an_offset(self):
        from pipeline.learning.run_agent import _wildcard_offset

        self.assertIsNone(_wildcard_offset({}, 9, "owner"))
        self.assertIsNone(_wildcard_offset({"wildcard_gameweek": None}, 9, "owner"))
        self.assertEqual(_wildcard_offset({"wildcard_gameweek": 9}, 9, "owner"), 0)
        self.assertEqual(_wildcard_offset({"wildcard_gameweek": 11}, 9, "owner"), 2)
        with self.assertLogs("pipeline.learning.run_agent", level="WARNING"):
            self.assertIsNone(_wildcard_offset({"wildcard_gameweek": 8}, 9, "owner"))
        with self.assertLogs("pipeline.learning.run_agent", level="ERROR"):
            self.assertIsNone(_wildcard_offset({"wildcard_gameweek": "GW9"}, 9, "owner"))

    def test_the_notification_names_the_chip(self):
        from pipeline.learning.messages import decision_messages

        plan = {"transfers_in": list(range(13)), "hits": 0, "chip": "wildcard"}
        body = decision_messages(
            {"gameweek": 9, "entry_label": "owner", "decision": {"plan": plan}},
            None, "2026-10-25T00:00:00Z",
        )[0].body
        self.assertIn("WILDCARD", body)
        plain = decision_messages(
            {"gameweek": 9, "entry_label": "owner",
             "decision": {"plan": {**plan, "chip": None}}},
            None, "2026-10-25T00:00:00Z",
        )[0].body
        self.assertNotIn("chip", plain)

    def test_the_owner_default_is_no_chip(self):
        from pipeline.config import FPL_ENTRIES

        self.assertIsNone(FPL_ENTRIES["owner"]["wildcard_gameweek"])


if __name__ == "__main__":
    unittest.main()
