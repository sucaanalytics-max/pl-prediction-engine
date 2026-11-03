"""
The outfield h=0 start reversion and the season-phase gate that turns it on.

`minutes.h0_start_target_keep` (kappa) makes an outfield player's keep
kappa * rho^h at EVERY h, so h=0 reverts part of the way toward his own long-run
start rate and the sealed row moves. It applies only once the predicted season has
`minutes.h0_start_target_min_settled_gw` settled gameweeks: early in a season the
long-run rate is mostly last season's, and an always-on kappa measured harmful at
GW2-10.

What these pin, from the design review of 2026-10-31:
* one gameweek short of the threshold is bit-identical to having no gate at all;
* at the threshold, keep is exactly kappa * rho^h;
* keepers never move, and kappa = 1 is the identity;
* the count comes from THIS season's rows. At GW1 the fit frame is all last
  season, and "gameweeks of the latest season" would read 38 and switch it on;
* whether it fired reaches the seal header and the conflicts report as JSON.
"""
from __future__ import annotations

import json
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.models.minutes import (
    MinutesModel,
    _shrink,
    availability_state,
    h0_start_gate_state,
    settled_gameweeks_in_season,
)

PIPELINE = Path(__file__).resolve().parents[1]
KAPPA = "minutes.h0_start_target_keep"
MIN_SETTLED = "minutes.h0_start_target_min_settled_gw"
RHO = "minutes.horizon_start_target_rho"
HALF_LIFE = "minutes.horizon_start_target_half_life"
FIT = availability_state("a", None)
HORIZONS = range(0, 6)


def _patched(name, value):
    return mock.patch.dict(PARAM_REGISTRY[name], {"value": value})


def _row(name, season, gw, started, position):
    return {
        "name_key": name, "position_norm": position, "season": season, "GW": gw,
        "minutes": 90 if started else 0, "starts": int(started),
    }


def _frame(current_gameweeks=12):
    """
    Last season in full, then `current_gameweeks` of this one.

    `breakout` was a squad player last season and has started every week of this
    one, so his recent rate sits well above his long-run rate and kappa has
    something to act on. `rotation` alternates. The keepers are a nailed No. 1
    and a No. 2 who never plays.
    """
    rows = []
    for gw in range(1, 39):
        rows.append(_row("breakout", "2526", gw, gw % 4 == 0, "MID"))
        rows.append(_row("rotation", "2526", gw, gw % 2 == 0, "DEF"))
        rows.append(_row("anchor", "2526", gw, True, "DEF"))
        rows.append(_row("number_one", "2526", gw, True, "GKP"))
        rows.append(_row("number_two", "2526", gw, False, "GKP"))
    for gw in range(1, current_gameweeks + 1):
        rows.append(_row("breakout", "2627", gw, True, "MID"))
        rows.append(_row("rotation", "2627", gw, gw % 2 == 1, "DEF"))
        rows.append(_row("anchor", "2627", gw, True, "DEF"))
        rows.append(_row("number_one", "2627", gw, gw % 5 != 0, "GKP"))
        rows.append(_row("number_two", "2627", gw, gw % 5 == 0, "GKP"))
    return pd.DataFrame(rows)


PLAYERS = (
    ("breakout", "MID"), ("rotation", "DEF"), ("anchor", "DEF"),
    ("number_one", "GKP"), ("number_two", "GKP"),
)


def _fit(settled, frame=None):
    return MinutesModel().fit(
        _frame() if frame is None else frame, key="name_key",
        position_column="position_norm", settled_gameweeks_in_season=settled,
    )


def _all_roles(model, players=PLAYERS):
    return {
        (name, h): asdict(model.predict(position, name, availability_override=FIT, horizon=h))
        for name, position in players
        for h in HORIZONS
    }


class GateBoundaryTests(unittest.TestCase):
    def test_one_short_of_the_threshold_is_bit_identical_to_no_gate(self):
        today = _all_roles(_fit(None))
        self.assertEqual(_all_roles(_fit(9)), today)
        self.assertEqual(_all_roles(_fit(0)), today)

    def test_at_the_threshold_keep_is_kappa_times_rho_to_the_h(self):
        off, on = _fit(9), _fit(10)
        self.assertTrue(on.h0_start_gate["active"])
        kappa = PARAM_REGISTRY[KAPPA]["value"]
        rho = PARAM_REGISTRY[RHO]["value"]
        self.assertLess(kappa, 1.0)

        stats = off.by_player["breakout"]
        long_run = _shrink(
            stats["n_starts_long"], stats["n_fixtures_long"],
            off.by_position["MID"]["start_rate"],
            PARAM_REGISTRY["minutes.start_shrinkage"]["value"],
        )
        today = off.predict("MID", "breakout", availability_override=FIT, horizon=0)
        reverted = on.predict("MID", "breakout", availability_override=FIT, horizon=0)
        # Fit and no news, so availability is 1 at h=0 and p_start is the role.
        self.assertEqual(today.availability, 1.0)
        self.assertGreater(today.p_start - long_run, 0.1, "fixture has no gap to revert")
        self.assertAlmostEqual(
            reverted.p_start, long_run + (today.p_start - long_run) * kappa, places=12
        )

        for h in range(1, 6):
            before = off.predict("MID", "breakout", availability_override=FIT, horizon=h)
            after = on.predict("MID", "breakout", availability_override=FIT, horizon=h)
            self.assertEqual(before.availability, after.availability)
            gap_before = before.p_start / before.availability - long_run
            gap_after = after.p_start / after.availability - long_run
            # Today's horizon gap is already rho^h of the h=0 gap; kappa scales it.
            self.assertAlmostEqual(gap_after, gap_before * kappa, places=12)
            self.assertAlmostEqual(
                gap_after, (today.p_start - long_run) * kappa * rho ** h, places=12
            )

    def test_it_moves_the_sealed_h0_row_for_outfielders(self):
        """The invariant the old comments stated is now false, deliberately."""
        off, on = _fit(9), _fit(10)
        before = off.predict("MID", "breakout", availability_override=FIT, horizon=0)
        after = on.predict("MID", "breakout", availability_override=FIT, horizon=0)
        self.assertLess(after.p_start, before.p_start)
        self.assertLess(after.p_appears, before.p_appears)
        self.assertLess(after.expected_minutes, before.expected_minutes)

    def test_keepers_do_not_move_at_any_count(self):
        keepers = (("number_one", "GKP"), ("number_two", "GKP"))
        today = _all_roles(_fit(None), keepers)
        for settled in (0, 9, 10, 20, 38):
            self.assertEqual(_all_roles(_fit(settled), keepers), today, settled)

    def test_kappa_one_is_the_identity(self):
        today = _all_roles(_fit(None))
        with _patched(KAPPA, 1.0):
            on = _fit(38)
        self.assertTrue(on.h0_start_gate["active"])
        self.assertEqual(on.h0_start_gate["kappa_effective"], 1.0)
        self.assertEqual(_all_roles(on), today)

    def test_a_player_with_no_history_is_untouched(self):
        unknown = (("new_signing", "MID"),)
        self.assertEqual(_all_roles(_fit(38), unknown), _all_roles(_fit(None), unknown))

    def test_the_pool_path_is_never_entered_at_h0(self):
        """With the own-rate target off there is nothing to revert toward."""
        with _patched(HALF_LIFE, 0.0):
            today = _all_roles(_fit(None))
            on = _fit(38)
        self.assertFalse(on.h0_start_gate["active"])
        self.assertEqual(on.h0_start_gate["kappa_effective"], 1.0)
        with _patched(HALF_LIFE, 0.0):
            self.assertEqual(_all_roles(on), today)

    def test_the_threshold_is_read_from_the_registry(self):
        with _patched(MIN_SETTLED, 12):
            self.assertFalse(h0_start_gate_state(11)["active"])
            self.assertTrue(h0_start_gate_state(12)["active"])


class SeasonPhaseCountTests(unittest.TestCase):
    def test_no_rows_passed_is_none_and_the_gate_is_off(self):
        self.assertIsNone(settled_gameweeks_in_season(None))
        self.assertFalse(h0_start_gate_state(None)["active"])

    def test_gw1_is_zero_however_much_last_season_the_frame_holds(self):
        """The trap: the fit frame at GW1 is 38 gameweeks of last season."""
        self.assertEqual(settled_gameweeks_in_season(pd.DataFrame({"GW": []})), 0)
        self.assertEqual(settled_gameweeks_in_season(pd.DataFrame()), 0)
        last_season_only = _frame(current_gameweeks=0)
        self.assertEqual(last_season_only["GW"].nunique(), 38)
        model = _fit(settled_gameweeks_in_season(last_season_only[
            last_season_only["season"] == "2627"
        ]), frame=last_season_only)
        self.assertEqual(model.h0_start_gate["settled_gameweeks"], 0)
        self.assertFalse(model.h0_start_gate["active"])

    def test_a_double_gameweek_counts_once(self):
        rows = pd.DataFrame({"GW": [1, 1, 2, 2, 2, 3]})
        self.assertEqual(settled_gameweeks_in_season(rows), 3)

    def test_a_fully_void_gameweek_has_no_rows_and_does_not_count(self):
        rows = pd.DataFrame({"GW": [1, 2, 4, 5]})
        self.assertEqual(settled_gameweeks_in_season(rows), 4)

    def test_the_record_is_plain_json(self):
        state = h0_start_gate_state(np.int64(10))
        self.assertEqual(json.loads(json.dumps(state)), state)
        self.assertEqual(
            set(state), {"settled_gameweeks", "min_settled", "active", "kappa_effective"}
        )


class RegistryTests(unittest.TestCase):
    def test_kappa_cannot_exceed_one(self):
        """keep <= 1 keeps p_start a convex combination, so no clip fires silently."""
        low, high = PARAM_REGISTRY[KAPPA]["bounds"]
        self.assertLessEqual(high, 1.0)
        self.assertGreater(low, 0.0)

    def test_the_threshold_is_a_whole_number_of_gameweeks(self):
        value = PARAM_REGISTRY[MIN_SETTLED]["value"]
        self.assertEqual(int(value), value)
        self.assertEqual(PARAM_REGISTRY[MIN_SETTLED]["tier"], "C")


class LiveInputsTests(unittest.TestCase):
    """Through build_fpl_inputs, on the committed archive, as the agent runs it."""

    @classmethod
    def setUpClass(cls):
        from pipeline.fpl.rules import load_rules
        from pipeline.learning.backfill import load_archive_season
        from pipeline.learning.walk_forward import synthetic_bootstrap

        cls.archive = load_archive_season("2526")
        cls.bootstrap = synthetic_bootstrap(cls.archive, 38)
        cls.rules = load_rules()

    def _inputs(self, current_season):
        from pipeline.models.fpl_inputs import build_fpl_inputs

        return build_fpl_inputs(
            self.bootstrap, self.archive, rules=self.rules,
            current_season=current_season,
        )

    def _season(self, gameweeks):
        from pipeline.models.fpl_inputs import current_season_rows

        element = next(e for e in self.bootstrap["elements"] if e["element_type"] == 3)
        live = {
            gw: {"elements": [{
                "id": element["id"], "stats": {"minutes": 90, "starts": 1},
                "explain": [{"fixture": 100,
                             "stats": [{"identifier": "minutes", "value": 90, "points": 0}]}],
            }]}
            for gw in gameweeks
        }
        return current_season_rows(self.bootstrap, live, season="2627")

    def test_gw1_with_only_last_season_is_off(self):
        for current in (None, self._season([])):
            gate = self._inputs(current).diagnostics["h0_start_gate"]
            self.assertFalse(gate["active"], gate)
            self.assertNotEqual(gate["settled_gameweeks"], 38)

    def test_the_count_is_this_seasons_gameweeks(self):
        gate = self._inputs(self._season(range(1, 10))).diagnostics["h0_start_gate"]
        self.assertEqual((gate["settled_gameweeks"], gate["active"]), (9, False))
        gate = self._inputs(self._season(range(1, 11))).diagnostics["h0_start_gate"]
        self.assertEqual((gate["settled_gameweeks"], gate["active"]), (10, True))


class BacktestCountTests(unittest.TestCase):
    def test_each_refit_counts_the_predicted_seasons_settled_gameweeks(self):
        """Not `past`, which leads with all of the prior season."""
        from pipeline.learning import backtest

        prior = _frame(current_gameweeks=0).rename(columns={"position_norm": "position"})
        prior["season"] = "2425"
        current = _frame(current_gameweeks=12)
        current = current[current["season"] == "2627"].rename(
            columns={"position_norm": "position"}
        )
        frames = {"2425": prior, "2526": current}
        seen = []
        real_fit = MinutesModel.fit

        def spy(model, *args, **kwargs):
            seen.append(kwargs.get("settled_gameweeks_in_season"))
            return real_fit(model, *args, **kwargs)

        with mock.patch(
            "pipeline.learning.backfill.load_archive_season",
            side_effect=lambda season, priors_dir=None: frames[season].copy(),
        ), mock.patch.object(MinutesModel, "fit", spy):
            backtest.backtest_minutes(season="2526", prior_season="2425")

        self.assertEqual(seen, list(range(0, 12)))


class ProvenanceTests(unittest.TestCase):
    def test_round_trips_through_json(self):
        from pipeline.models.fpl_inputs import h0_start_gate_provenance

        record = h0_start_gate_provenance({"h0_start_gate": {
            "settled_gameweeks": np.int64(10), "min_settled": 10,
            "active": np.bool_(True), "kappa_effective": np.float64(0.8),
        }})
        self.assertEqual(json.loads(json.dumps(record)), record)
        self.assertEqual(record["settled_gameweeks"], 10)

    def test_absent_is_none_and_never_raises(self):
        from pipeline.models.fpl_inputs import h0_start_gate_provenance

        self.assertIsNone(h0_start_gate_provenance({}))
        self.assertIsNone(h0_start_gate_provenance(None))
        self.assertIsNone(h0_start_gate_provenance(object()))

    def test_the_seal_header_carries_it(self):
        source = (PIPELINE / "learning" / "run_agent.py").read_text()
        seal = source[source.index("def _seal("):source.index("def _announce(")]
        self.assertIn('"h0_start_gate": outcome.get("h0_start_gate")', seal)

    def test_both_xp_producers_stamp_it(self):
        for path in (PIPELINE / "learning" / "run_agent.py", PIPELINE / "run_pipeline.py"):
            source = path.read_text()
            self.assertIn('"h0_start_gate": h0_start_gate', source, path.name)


class ConflictsReportTests(unittest.TestCase):
    def test_the_gate_sits_beside_the_thresholds(self):
        from pipeline.learning import minutes_conflicts

        gate = h0_start_gate_state(10)
        xp = {"metadata": {"h0_start_gate": gate}, "players": []}
        payload = minutes_conflicts.to_artifact(
            [], {}, generated_at="2026-11-20T00:00:00Z",
            gate=minutes_conflicts.h0_start_gate(xp),
        )
        self.assertEqual(payload["h0_start_gate"], gate)
        self.assertEqual(payload["thresholds"]["nailed_minutes"], 75.0)

    def test_an_older_projection_reports_null_not_absent(self):
        from pipeline.learning import minutes_conflicts

        self.assertIsNone(minutes_conflicts.h0_start_gate({"metadata": {}}))
        self.assertIsNone(minutes_conflicts.h0_start_gate({}))
        payload = minutes_conflicts.to_artifact([], {}, generated_at="x")
        self.assertIn("h0_start_gate", payload)
        self.assertIsNone(payload["h0_start_gate"])


if __name__ == "__main__":
    unittest.main()
