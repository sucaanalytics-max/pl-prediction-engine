"""
The 1X2 hold guards and the same-fixture correlated-direction cap.

## Why they exist

The Kelly review of 2026-10-25 found every published selection at the flat
2.5% per-bet cap, so the card was simply the top edges ranked by how far the
model disagreed with the market. On the sealed GW1-7 ledger the 35 1X2 bets won
7 against 10.9 model-expected and 6.5 market-expected. The flagship case on the
2026-10-24 card: Hull City v Brentford home win at model 0.389 against ~0.195
de-vigged — a promoted club with 7 matches in the training window — staked at
the cap, alongside `Under 2.5` on the same fixture, which wins in the same
"Brentford underdeliver" world.

## What these tests hold

Direction, again. A guard may HOLD (stake 0, published in `held_bets` with a
reason) or GROUP (share one cap); it may never raise a stake, and the market
price may only veto — never feed the edge.
"""

from __future__ import annotations

import copy
import random
import unittest
from unittest import mock

import pandas as pd

from pipeline.config import RISK
from pipeline.risk import kelly
from pipeline.risk.kelly import (
    ONE_X_TWO_GUARDS,
    apply_portfolio_limits,
    check_portfolio_exposure,
    correlation_key,
    find_value_bets,
    kelly_stake,
    matches_in_window,
    one_x_two_hold_reasons,
)
from pipeline.validation.artifacts import validate_prediction_output

BANK = 1000.0
SINGLE_CAP = RISK["max_stake_pct"] / 2  # half-Kelly basis, as the nesting rule
ESTABLISHED = 114  # three full seasons


def bet(market, market_type, edge=0.10, stake=25.0, gap=0.02, favourite="home"):
    b = {
        "market": market, "market_type": market_type, "edge": edge,
        "model_prob": 0.4, "implied_prob": 0.4 - edge,
        "half_kelly": stake, "full_kelly": stake * 2,
        "half_kelly_pct": stake / BANK, "full_kelly_pct": stake * 2 / BANK,
    }
    if market_type == "1x2":
        b["market_gap_1x2"] = gap
        b["market_favourite"] = favourite
    return b


def card(*specs):
    return [
        {"fixture": {"home_team": home, "away_team": away}, "value_bets": list(bets)}
        for home, away, bets in specs
    ]


def counts_for(predictions, overrides=None):
    out = {}
    for p in predictions:
        out[p["fixture"]["home_team"]] = ESTABLISHED
        out[p["fixture"]["away_team"]] = ESTABLISHED
    out.update(overrides or {})
    return out


def staked(predictions):
    return {
        (p["fixture"]["home_team"], b["market"]): b["half_kelly_pct"]
        for p in predictions for b in p.get("value_bets") or []
    }


def held(predictions):
    return {
        (p["fixture"]["home_team"], b["market"]): b
        for p in predictions for b in p.get("held_bets") or []
    }


def unguarded_stakes(predictions, bankroll=BANK):
    """
    The portfolio pass exactly as it was before the guards: every selection,
    no holds, no correlated cap. Re-implemented here rather than imported so the
    reference cannot drift with the code it checks.
    """
    rows = []
    for p in copy.deepcopy(predictions):
        fx = p["fixture"]
        match = f"{fx['home_team']} v {fx['away_team']}"
        for b in p.get("value_bets") or []:
            rows.append((b, {**b, "match": match, "home_team": fx["home_team"],
                             "away_team": fx["away_team"]}, fx["home_team"]))
    rows.sort(key=lambda r: (-float(r[0].get("edge") or 0), r[1]["match"], str(r[0].get("market"))))
    accepted, out = [], {}
    for b, ctx, home in rows:
        allowed = check_portfolio_exposure(accepted, ctx, bankroll, correlated_cap=False)["adjusted_stake"]
        out[(home, b["market"])] = allowed / bankroll
        if allowed > 0:
            accepted.append({**ctx, "stake": allowed})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Guard 1: club new to the training window
# ─────────────────────────────────────────────────────────────────────────────

class NewToWindowGuardTests(unittest.TestCase):
    def test_the_measured_case_is_held_not_staked(self):
        # Hull City, 7 matches in the window after the Dixon-Coles fix.
        predictions = card(("Hull City", "Brentford", [bet("Home Win", "1x2", gap=0.02)]))
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts={"Hull City": 7, "Brentford": ESTABLISHED})
        self.assertEqual(staked(predictions), {})
        h = held(predictions)[("Hull City", "Home Win")]
        self.assertTrue(any("Hull City" in r and "new_to_training_window" in r
                            for r in h["hold_reasons"]), h["hold_reasons"])

    def test_the_away_club_is_checked_too(self):
        predictions = card(("Fulham", "Coventry City", [bet("Away Win", "1x2")]))
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts={"Fulham": ESTABLISHED, "Coventry City": 0})
        self.assertIn(("Fulham", "Away Win"), held(predictions))

    def test_the_boundary_is_strictly_below_the_threshold(self):
        n = ONE_X_TWO_GUARDS["min_matches_in_window"]
        below = one_x_two_hold_reasons(bet("Home Win", "1x2"), "X", "Y", {"X": n - 1, "Y": ESTABLISHED})
        at = one_x_two_hold_reasons(bet("Home Win", "1x2"), "X", "Y", {"X": n, "Y": ESTABLISHED})
        self.assertTrue(below)
        self.assertEqual(at, [])

    def test_a_returning_club_carries_its_earlier_season(self):
        # Ipswich 2026-27: promoted, but 38 matches from 2024-25 are in the window.
        predictions = card(("Ipswich", "Liverpool", [bet("Home Win", "1x2")]))
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts={"Ipswich": 41, "Liverpool": ESTABLISHED})
        self.assertIn(("Ipswich", "Home Win"), staked(predictions))

    def test_only_1x2_is_guarded(self):
        predictions = card(("Hull City", "Brentford", [bet("Under 2.5 Goals", "over_under")]))
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts={"Hull City": 7, "Brentford": ESTABLISHED})
        self.assertIn(("Hull City", "Under 2.5 Goals"), staked(predictions))
        self.assertEqual(held(predictions), {})


class MatchesInWindowTests(unittest.TestCase):
    def test_counts_both_home_and_away_rows(self):
        frame = pd.DataFrame({"HomeTeam": ["A", "B", "A"], "AwayTeam": ["B", "C", "C"]})
        self.assertEqual(matches_in_window(frame, ["A", "B", "C"]), {"A": 2, "B": 2, "C": 2})

    def test_a_club_absent_from_the_frame_counts_zero(self):
        # Absent from the training frame IS the promoted case: the posterior has
        # never seen it. Zero is the answer, and zero holds.
        frame = pd.DataFrame({"HomeTeam": ["A"], "AwayTeam": ["B"]})
        self.assertEqual(matches_in_window(frame, ["Hull City"]), {"Hull City": 0})

    def test_an_unreadable_frame_yields_nothing_rather_than_zeros(self):
        self.assertEqual(matches_in_window(None, ["A"]), {})
        self.assertEqual(matches_in_window(pd.DataFrame({"x": [1]}), ["A"]), {})


# ─────────────────────────────────────────────────────────────────────────────
# Fail-safe: unknown holds, it never passes
# ─────────────────────────────────────────────────────────────────────────────

class FailSafeTests(unittest.TestCase):
    def test_no_counts_supplied_holds_every_1x2_selection(self):
        predictions = card(
            ("A", "B", [bet("Home Win", "1x2", edge=0.12)]),
            ("C", "D", [bet("Draw", "1x2", edge=0.11)]),
        )
        apply_portfolio_limits(predictions, bankroll=BANK)  # counts omitted
        self.assertEqual(staked(predictions), {})
        for b in held(predictions).values():
            self.assertTrue(any(r.startswith("matches_in_window_unknown") for r in b["hold_reasons"]))

    def test_a_club_missing_from_the_counts_is_held(self):
        predictions = card(("A", "B", [bet("Home Win", "1x2")]))
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts={"A": ESTABLISHED})
        self.assertIn(("A", "Home Win"), held(predictions))

    def test_a_non_numeric_or_nan_count_is_held(self):
        for bad in ("lots", float("nan"), None, True):
            reasons = one_x_two_hold_reasons(bet("Home Win", "1x2"), "A", "B",
                                             {"A": bad, "B": ESTABLISHED})
            self.assertTrue(any("unknown" in r for r in reasons), (bad, reasons))

    def test_a_missing_market_gap_is_held(self):
        b = bet("Home Win", "1x2")
        del b["market_gap_1x2"]
        reasons = one_x_two_hold_reasons(b, "A", "B", {"A": ESTABLISHED, "B": ESTABLISHED})
        self.assertIn("market_gap_unknown", reasons)

    def test_find_value_bets_reports_no_gap_when_a_1x2_price_is_missing(self):
        # Two of three prices: the gap cannot be measured, so it is None, and
        # None holds downstream.
        preds = {"probabilities": {"1x2": {"home": 0.6, "draw": 0.25, "away": 0.15}}}
        bets = find_value_bets(preds, {"odds_home_bet365": 3.0, "odds_draw_bet365": 3.0})
        self.assertTrue(bets)
        for b in bets:
            self.assertIsNone(b["market_gap_1x2"])


# ─────────────────────────────────────────────────────────────────────────────
# Guard 2: model adrift from the market — and the firewall
# ─────────────────────────────────────────────────────────────────────────────

# Hull City v Brentford, 2026-10-24, after the DC fix: model 0.389/0.278/0.333.
HULL_PROBS = {"probabilities": {"1x2": {"home": 0.389, "draw": 0.278, "away": 0.333}}}
HULL_ODDS = {"odds_home_bet365": 5.1, "odds_draw_bet365": 4.0, "odds_away_bet365": 1.85}


class MarketGapGuardTests(unittest.TestCase):
    def test_the_gap_is_measured_fixture_wide(self):
        bets = find_value_bets(HULL_PROBS, HULL_ODDS)
        home = next(b for b in bets if b["market"] == "Home Win")
        nv = kelly.devig_implied_prob({"home": 5.1, "draw": 4.0, "away": 1.85})
        expected = max(abs(HULL_PROBS["probabilities"]["1x2"][k] - nv[k]) for k in nv)
        self.assertAlmostEqual(home["market_gap_1x2"], expected, places=12)
        self.assertEqual(home["market_favourite"], "away")

    def test_the_hull_case_is_held_on_the_gap_even_with_counts_established(self):
        bets = find_value_bets(HULL_PROBS, HULL_ODDS)
        predictions = card(("Hull City", "Brentford", bets))
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts={"Hull City": ESTABLISHED, "Brentford": ESTABLISHED})
        h = held(predictions)
        self.assertIn(("Hull City", "Home Win"), h)
        self.assertTrue(any(r.startswith("model_market_gap_1x2")
                            for r in h[("Hull City", "Home Win")]["hold_reasons"]))

    def test_the_boundary_is_strictly_above_the_threshold(self):
        cut = ONE_X_TWO_GUARDS["max_market_gap"]
        counts = {"A": ESTABLISHED, "B": ESTABLISHED}
        self.assertEqual(one_x_two_hold_reasons(bet("Home Win", "1x2", gap=cut), "A", "B", counts), [])
        self.assertTrue(one_x_two_hold_reasons(bet("Home Win", "1x2", gap=cut + 1e-6), "A", "B", counts))


class FirewallTests(unittest.TestCase):
    """The market price may only VETO. It must never move an edge, a model
    probability, or a stake to any value other than zero or the unguarded one."""

    def test_find_value_bets_edges_are_exactly_kelly_stake(self):
        bets = find_value_bets(HULL_PROBS, HULL_ODDS)
        h2h = {"home": 5.1, "draw": 4.0, "away": 1.85}
        for b in bets:
            key = {"Home Win": "home", "Draw": "draw", "Away Win": "away"}[b["market"]]
            direct = kelly_stake(HULL_PROBS["probabilities"]["1x2"][key], h2h[key], BANK,
                                 min_edge=kelly.EDGE_THRESHOLDS["1x2"],
                                 market_odds=h2h, outcome_key=key)
            for field in ("edge", "model_prob", "implied_prob", "half_kelly",
                          "full_kelly", "half_kelly_pct", "full_kelly_pct"):
                self.assertEqual(b[field], direct[field], field)

    def test_the_gap_annotation_cannot_reach_the_edge(self):
        # Replace the annotation with absurd values: nothing on the edge path moves.
        clean = find_value_bets(HULL_PROBS, HULL_ODDS)
        with mock.patch.object(kelly, "_one_x_two_market_context", return_value=(9.9, "home")):
            poisoned = find_value_bets(HULL_PROBS, HULL_ODDS)
        strip = lambda bs: [{k: v for k, v in b.items()
                             if k not in ("market_gap_1x2", "market_favourite")} for b in bs]
        self.assertEqual(strip(clean), strip(poisoned))

    def test_the_gap_is_a_binary_veto_not_a_scaler(self):
        counts = {"A": ESTABLISHED, "B": ESTABLISHED}
        unguarded = 25.0 / BANK
        for gap in [0.0, 0.03, 0.0999, 0.1, 0.1001, 0.2, 0.5]:
            predictions = card(("A", "B", [bet("Home Win", "1x2", gap=gap)]))
            apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=counts)
            got = staked(predictions).get(("A", "Home Win"), 0.0)
            self.assertIn(round(got, 12), (0.0, round(unguarded, 12)), gap)

    def test_the_guards_never_rewrite_edge_or_probabilities(self):
        predictions = card(("Hull City", "Brentford", find_value_bets(HULL_PROBS, HULL_ODDS)))
        before = {b["market"]: (b["edge"], b["model_prob"], b["implied_prob"])
                  for b in predictions[0]["value_bets"]}
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts={"Hull City": 7})
        for b in predictions[0]["value_bets"] + predictions[0]["held_bets"]:
            self.assertEqual((b["edge"], b["model_prob"], b["implied_prob"]), before[b["market"]])


# ─────────────────────────────────────────────────────────────────────────────
# Correlated direction: same fixture, favourite underdelivers
# ─────────────────────────────────────────────────────────────────────────────

def ctx(b, match="H v A"):
    return {**b, "match": match}


class CorrelationKeyTests(unittest.TestCase):
    def test_underdog_win_and_under_share_a_key(self):
        self.assertIsNotNone(correlation_key(ctx(bet("Home Win", "1x2", favourite="away"))))
        self.assertEqual(correlation_key(ctx(bet("Home Win", "1x2", favourite="away"))),
                         correlation_key(ctx(bet("Under 2.5 Goals", "over_under"))))

    def test_draw_and_under_share_a_key(self):
        self.assertEqual(correlation_key(ctx(bet("Draw", "1x2"))),
                         correlation_key(ctx(bet("Under 3.5 Goals", "over_under"))))

    def test_the_favourites_win_is_not_in_the_group(self):
        self.assertIsNone(correlation_key(ctx(bet("Away Win", "1x2", favourite="away"))))

    def test_an_unplaceable_favourite_is_grouped(self):
        self.assertIsNotNone(correlation_key(ctx(bet("Home Win", "1x2", favourite=None))))

    def test_overs_and_corners_are_not_in_the_group(self):
        self.assertIsNone(correlation_key(ctx(bet("Over 2.5 Goals", "over_under"))))
        self.assertIsNone(correlation_key(ctx(bet("Corners Under 10.5", "corners"))))

    def test_different_fixtures_do_not_share(self):
        self.assertNotEqual(correlation_key(ctx(bet("Draw", "1x2"), "A v B")),
                            correlation_key(ctx(bet("Under 2.5 Goals", "over_under"), "C v D")))


class CorrelatedCapTests(unittest.TestCase):
    COUNTS = {"Hull City": ESTABLISHED, "Brentford": ESTABLISHED}

    def test_underdog_win_plus_under_share_one_per_bet_cap(self):
        # The Hull v Brentford pair, guards satisfied so only the cap is tested.
        predictions = card(("Hull City", "Brentford", [
            bet("Home Win", "1x2", edge=0.19, favourite="away"),
            bet("Under 2.5 Goals", "over_under", edge=0.08),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=self.COUNTS)
        self.assertLessEqual(sum(staked(predictions).values()), SINGLE_CAP + 1e-9)
        # The higher-edge leg keeps the stake.
        self.assertEqual(list(staked(predictions)), [("Hull City", "Home Win")])

    def test_draw_plus_two_unders_share_one_cap(self):
        predictions = card(("Hull City", "Brentford", [
            bet("Draw", "1x2", edge=0.12),
            bet("Under 2.5 Goals", "over_under", edge=0.10),
            bet("Under 3.5 Goals", "over_under", edge=0.09),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=self.COUNTS)
        self.assertLessEqual(sum(staked(predictions).values()), SINGLE_CAP + 1e-9)

    def test_the_favourites_win_plus_under_keep_their_own_caps(self):
        predictions = card(("Hull City", "Brentford", [
            bet("Away Win", "1x2", edge=0.12, favourite="away"),
            bet("Under 2.5 Goals", "over_under", edge=0.10),
        ]))
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=self.COUNTS)
        self.assertAlmostEqual(sum(staked(predictions).values()), 2 * SINGLE_CAP, places=9)

    def test_the_same_pair_on_different_fixtures_is_not_merged(self):
        predictions = card(
            ("A", "B", [bet("Draw", "1x2", edge=0.12)]),
            ("C", "D", [bet("Under 2.5 Goals", "over_under", edge=0.10)]),
        )
        apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=counts_for(predictions))
        self.assertAlmostEqual(sum(staked(predictions).values()), 2 * SINGLE_CAP, places=9)


# ─────────────────────────────────────────────────────────────────────────────
# The property that matters most: no stake ever grows
# ─────────────────────────────────────────────────────────────────────────────

class NeverIncreasesTests(unittest.TestCase):
    def test_holding_the_top_bet_does_not_free_room_for_the_next(self):
        # Nine selections at 2.5% across directions: baseline keeps 8 (the 20%
        # total), dropping the 9th. Holding the top one must NOT promote the 9th.
        markets = [("Home Win", "1x2"), ("BTTS Yes", "btts"), ("BTTS No", "btts"),
                   ("Over 2.5 Goals", "over_under"), ("Under 2.5 Goals", "over_under"),
                   ("BTTS Yes", "btts"), ("BTTS No", "btts"), ("Over 3.5 Goals", "over_under"),
                   ("BTTS Yes", "btts")]
        predictions = card(*[
            (f"H{i}", f"A{i}", [bet(m, t, edge=0.30 - i * 0.01)]) for i, (m, t) in enumerate(markets)
        ])
        baseline = unguarded_stakes(predictions)
        self.assertEqual(baseline[("H8", "BTTS Yes")], 0.0, "fixture premise: 9th is capped out")
        apply_portfolio_limits(predictions, bankroll=BANK,
                               team_match_counts=counts_for(predictions, {"H0": 3}))
        self.assertIn(("H0", "Home Win"), held(predictions))
        self.assertNotIn(("H8", "BTTS Yes"), staked(predictions))

    def test_random_cards_never_exceed_the_unguarded_stake(self):
        rng = random.Random(20261025)
        menu = [("Home Win", "1x2"), ("Draw", "1x2"), ("Away Win", "1x2"),
                ("Under 2.5 Goals", "over_under"), ("Under 3.5 Goals", "over_under"),
                ("Over 2.5 Goals", "over_under"), ("BTTS Yes", "btts"), ("BTTS No", "btts")]
        for trial in range(300):
            specs = []
            for i in range(rng.randint(1, 10)):
                picks = rng.sample(menu, rng.randint(1, 4))
                specs.append((f"H{i}", f"A{i}", [
                    bet(m, t, edge=round(rng.uniform(0.05, 0.30), 4),
                        stake=rng.choice([25.0, 25.0, 12.0, 40.0]),
                        gap=rng.choice([0.02, 0.08, 0.12, 0.25, None]),
                        favourite=rng.choice(["home", "away", None]))
                    for m, t in picks
                ]))
            predictions = card(*specs)
            counts = {}
            for p in predictions:
                for side in ("home_team", "away_team"):
                    choice = rng.choice([ESTABLISHED, ESTABLISHED, 5, 0, None])
                    if choice is not None:
                        counts[p["fixture"][side]] = choice
            baseline = unguarded_stakes(predictions)
            base_total = sum(baseline.values())
            apply_portfolio_limits(predictions, bankroll=BANK, team_match_counts=counts)
            after = staked(predictions)
            for key, pct in after.items():
                self.assertLessEqual(pct, baseline[key] + 1e-12, (trial, key))
                self.assertGreater(baseline[key], 0.0, (trial, key))
            self.assertLessEqual(sum(after.values()), base_total + 1e-12, trial)
            for b in held(predictions).values():
                for field in ("full_kelly", "half_kelly", "full_kelly_pct", "half_kelly_pct"):
                    self.assertEqual(b[field], 0.0)


# ─────────────────────────────────────────────────────────────────────────────
# Publishing: held, not dropped; and the artifact validator agrees
# ─────────────────────────────────────────────────────────────────────────────

class PublishingTests(unittest.TestCase):
    def _held_card(self):
        predictions = card(("Hull City", "Brentford", [
            bet("Home Win", "1x2", edge=0.19, gap=0.19, favourite="away"),
            bet("Under 2.5 Goals", "over_under", edge=0.08),
        ]))
        summary = apply_portfolio_limits(predictions, bankroll=BANK,
                                         team_match_counts={"Hull City": 7, "Brentford": ESTABLISHED})
        return predictions, summary

    def test_a_held_selection_is_published_at_zero_with_reasons(self):
        predictions, _ = self._held_card()
        b = held(predictions)[("Hull City", "Home Win")]
        for field in ("full_kelly", "half_kelly", "full_kelly_pct", "half_kelly_pct"):
            self.assertEqual(b[field], 0.0, field)
        self.assertEqual(b["recommendation"], "hold_for_review")
        self.assertEqual(len(b["hold_reasons"]), 2)  # new-to-window AND gap
        self.assertNotIn(("Hull City", "Home Win"), staked(predictions))

    def test_value_bets_still_never_carry_a_zero_stake(self):
        predictions, _ = self._held_card()
        for p in predictions:
            for b in p["value_bets"]:
                self.assertGreater(b["half_kelly_pct"], 0)

    def test_the_summary_counts_and_names_the_holds(self):
        _, summary = self._held_card()
        self.assertEqual(summary["n_held"], 1)
        self.assertEqual(summary["held"][0]["market"], "Home Win")
        self.assertEqual(summary["n_bets_before"], 2)
        self.assertEqual(summary["n_bets_after"], 1)

    def test_the_validator_rejects_a_held_selection_with_a_stake(self):
        predictions, _ = self._held_card()
        output = {"metadata": {}, "predictions": predictions}
        self.assertFalse([e for e in validate_prediction_output(output) if "held_bets" in e])
        predictions[0]["held_bets"][0]["half_kelly_pct"] = 0.025
        self.assertTrue([e for e in validate_prediction_output(output) if "held_bets" in e])


class GuardValuesTests(unittest.TestCase):
    """Pinned to literals: loosening a guard must mean editing this test."""

    def test_min_matches_in_window_is_ten(self):
        self.assertEqual(RISK["min_matches_in_window_1x2"], 10)
        self.assertEqual(ONE_X_TWO_GUARDS["min_matches_in_window"], 10)

    def test_max_market_gap_is_ten_points(self):
        self.assertEqual(RISK["max_market_gap_1x2"], 0.10)
        self.assertEqual(ONE_X_TWO_GUARDS["max_market_gap"], 0.10)

    def test_the_correlated_cap_is_on_by_default(self):
        import inspect
        default = inspect.signature(check_portfolio_exposure).parameters["correlated_cap"].default
        self.assertIs(default, True)


class GuardWiringTests(unittest.TestCase):
    def test_the_pipeline_passes_training_window_counts(self):
        from pathlib import Path
        source = (Path(__file__).resolve().parents[1] / "run_pipeline.py").read_text(encoding="utf-8")
        self.assertIn("matches_in_window(\n        features,", source)
        self.assertIn("team_match_counts=team_match_counts", source)
        self.assertIn('"n_held_by_guards"', source)


if __name__ == "__main__":
    unittest.main()
