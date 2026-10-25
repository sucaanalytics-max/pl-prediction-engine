"""
Two minutes-model corrections, each a registry switch with an exact-no-op OFF value.

`minutes.horizon_start_target_half_life` — horizon weeks revert a player's start
probability toward HIS OWN long-run start rate rather than toward his position's
pool. The pool counts every registered squad member, so it dragged a nailed
keeper toward a 0.25 GK start rate made of second and third choices.

`minutes.injury_exit_p60_strength` — a start cut short by injury is removed from
the P(60 | start) fit, and the position's exit rate is multiplied back in, so the
exclusion cannot inflate anyone. Red cards are not injury exits.

Measured 2026-10-25; the registry entries carry the numbers.
"""
from __future__ import annotations

import unittest
from unittest import mock

import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.models import fpl_inputs
from pipeline.models.minutes import (
    AVAILABILITY_AT_DEADLINE,
    MinutesModel,
    _shrink,
    availability_state,
    horizon_availability_factor,
    horizon_start_reversion,
)

TARGET_HL = "minutes.horizon_start_target_half_life"
TARGET_RHO = "minutes.horizon_start_target_rho"
EXIT = "minutes.injury_exit_p60_strength"
FIT = availability_state("a", None)


def _params(**values):
    """Patch registry values; keys use '__' for '.'."""
    patches = [
        mock.patch.dict(PARAM_REGISTRY[k.replace("__", ".")], {"value": v})
        for k, v in values.items()
    ]

    class _Ctx:
        def __enter__(self):
            for p in patches:
                p.start()

        def __exit__(self, *exc):
            for p in patches:
                p.stop()

    return _Ctx()


def _off():
    return _params(minutes__horizon_start_target_half_life=0.0,
                   minutes__injury_exit_p60_strength=0.0)


def _row(name, gw, minutes, started, position="DEF", red=0, avail=None):
    row = {"name_key": name, "position_norm": position, "GW": gw, "season": "2627",
           "minutes": minutes, "starts": int(started), "red_cards": red}
    if avail is not None:
        row[AVAILABILITY_AT_DEADLINE] = avail
    return row


def _fit(rows):
    return MinutesModel().fit(pd.DataFrame(rows), key="name_key", position_column="position_norm")


def _keeper_club(n=30):
    """One club's keepers: a nailed No. 1 and two who never play."""
    rows = []
    for gw in range(1, n + 1):
        rows.append(_row("number_one", gw, 90, True, "GKP"))
        rows.append(_row("number_two", gw, 0, False, "GKP"))
        rows.append(_row("number_three", gw, 0, False, "GKP"))
    return rows


def _defenders(exit_gw=None, red=False, flagged=None, n=12):
    """`subject` starts 90 every week except a 20-minute start at `exit_gw`,
    then misses the next gameweek. Two clean team-mates fix the position rates."""
    rows = []
    for gw in range(1, n + 1):
        if gw == exit_gw:
            rows.append(_row("subject", gw, 20, True, red=int(red)))
        elif exit_gw is not None and gw == exit_gw + 1:
            rows.append(_row("subject", gw, 0, False, avail=flagged))
        else:
            rows.append(_row("subject", gw, 90, True))
        rows.append(_row("mate_a", gw, 90, True))
        rows.append(_row("mate_b", gw, 90 if gw % 4 else 70, True))
    return rows


class OffIsAnExactNoOpTests(unittest.TestCase):
    """At the OFF values the fit and every prediction are the pre-existing ones."""

    def test_off_carries_no_new_statistics(self):
        with _off():
            model = _fit(_keeper_club() + _defenders(exit_gw=6))
        for stats in model.by_player.values():
            for key in ("n_fixtures_long", "n_starts_long", "n_started_rows_p60",
                        "injury_exit_starts"):
                self.assertNotIn(key, stats)
        for prior in model.by_position.values():
            self.assertNotIn("p_60_if_start_clean", prior)
            self.assertNotIn("injury_exit_rate", prior)

    def test_off_horizon_is_the_pool_reversion_formula_bit_for_bit(self):
        with _off():
            model = _fit(_keeper_club() + _defenders(exit_gw=6))
            for name, position in (("number_one", "GKP"), ("number_two", "GKP"),
                                   ("subject", "DEF")):
                p0 = model.predict(position, name, availability_override=FIT).p_start
                pool = model.by_position[position]["start_rate"]
                for h in range(1, 9):
                    got = model.predict(position, name, availability_override=FIT,
                                        horizon=h).p_start
                    expected = (p0 + (pool - p0) * horizon_start_reversion(h)) \
                        * horizon_availability_factor(h)
                    self.assertEqual(got, expected, (name, h))

    def test_off_p60_is_the_plain_shrunk_rate_bit_for_bit(self):
        with _off():
            model = _fit(_defenders(exit_gw=6))
            stats = model.by_player["subject"]
            expected = _shrink(stats["n_60_starts"], stats["n_started_rows"],
                               model.by_position["DEF"]["p_60_if_start"],
                               PARAM_REGISTRY["minutes.p60_shrinkage"]["value"])
            got = model.predict("DEF", "subject", availability_override=FIT).p_60_if_start
        self.assertEqual(got, expected)

    def test_horizon_target_never_moves_the_sealed_week(self):
        rows = _keeper_club() + _defenders(exit_gw=6)
        with _params(minutes__horizon_start_target_half_life=0.0):
            off = _fit(rows)
            a = [off.predict("GKP", k, availability_override=FIT).as_dict()
                 for k in ("number_one", "number_two")]
        with _params(minutes__horizon_start_target_half_life=12.0):
            on = _fit(rows)
            b = [on.predict("GKP", k, availability_override=FIT).as_dict()
                 for k in ("number_one", "number_two")]
        self.assertEqual(a, b)


class NailedKeeperHorizonTests(unittest.TestCase):
    """The case that motivated the change: a No. 1 must not fade to the pool."""

    def test_nailed_keeper_keeps_his_role_across_the_horizon(self):
        rows = _keeper_club()
        with _params(minutes__horizon_start_target_half_life=0.0):
            off = _fit(rows)
            off_h3 = off.predict("GKP", "number_one", availability_override=FIT, horizon=3)
        with _params(minutes__horizon_start_target_half_life=12.0):
            on = _fit(rows)
            on_h3 = on.predict("GKP", "number_one", availability_override=FIT, horizon=3)
            pool = on.by_position["GKP"]["start_rate"]
        self.assertAlmostEqual(pool, 1 / 3, places=6)
        # Pool path: pulled ~38% of the way to a 1/3 pool, then the availability factor.
        self.assertLess(off_h3.p_start, 0.65)
        # Own-rate path: only the availability factor remains for a player whose
        # recent form IS his long-run role (ungated he even firms up, because
        # today's estimate is shrunk harder than the long-run one).
        h0 = on.predict("GKP", "number_one", availability_override=FIT).p_start
        ungated = on_h3.p_start / horizon_availability_factor(3)
        self.assertGreater(ungated, 0.95)
        self.assertGreaterEqual(ungated, h0)
        self.assertGreater(on_h3.p_start - off_h3.p_start, 0.2)

    def test_unused_backup_does_not_drift_up_toward_the_pool(self):
        rows = _keeper_club()
        with _params(minutes__horizon_start_target_half_life=0.0):
            off = _fit(rows).predict("GKP", "number_two", availability_override=FIT, horizon=6)
        with _params(minutes__horizon_start_target_half_life=12.0):
            on = _fit(rows).predict("GKP", "number_two", availability_override=FIT, horizon=6)
        self.assertGreater(off.p_start, 0.1)  # the pool path invents starts for him
        self.assertLess(on.p_start, 0.05)

    def test_dropped_regular_drifts_back_toward_his_long_run_role(self):
        rows = [_row("dropped", gw, 90 if gw <= 26 else 0, gw <= 26, "GKP") for gw in range(1, 31)]
        rows += [_row("usurper", gw, 0 if gw <= 26 else 90, gw > 26, "GKP") for gw in range(1, 31)]
        with _params(minutes__horizon_start_target_half_life=12.0):
            model = _fit(rows)
            path = [model.predict("GKP", "dropped", availability_override=FIT, horizon=h).p_start
                    / horizon_availability_factor(h) for h in range(0, 7)]
        self.assertTrue(all(b > a for a, b in zip(path, path[1:])), path)

    def test_no_history_keeps_its_prior(self):
        with _params(minutes__horizon_start_target_half_life=12.0):
            model = _fit(_keeper_club())
            h0 = model.predict("GKP", "unknown", fallback_start_rate=0.9, availability_override=FIT)
            h4 = model.predict("GKP", "unknown", fallback_start_rate=0.9,
                               availability_override=FIT, horizon=4)
        self.assertAlmostEqual(h4.p_start, h0.p_start * horizon_availability_factor(4), places=12)


class InjuryExitLabelTests(unittest.TestCase):

    def _labels(self, rows):
        frame = pd.DataFrame(rows)
        frame["_fixture_index"] = MinutesModel._fixture_index(frame)
        labels = MinutesModel._injury_exit_rows(frame, "name_key")
        return frame.assign(_ie=labels.to_numpy())

    def test_short_start_then_absent_regular_is_an_exit(self):
        f = self._labels(_defenders(exit_gw=6))
        hit = f[f._ie > 0]
        self.assertEqual(hit[["name_key", "GW"]].values.tolist(), [["subject", 6]])

    def test_flag_at_next_deadline_labels_even_if_he_then_played(self):
        rows = _defenders(n=10)
        rows = [r for r in rows if not (r["name_key"] == "subject" and r["GW"] in (5, 6))]
        rows += [_row("subject", 5, 30, True), _row("subject", 6, 25, False, avail=0.75)]
        f = self._labels(rows)
        self.assertEqual(f[(f._ie > 0)][["name_key", "GW"]].values.tolist(), [["subject", 5]])

    def test_a_known_clean_flag_overrides_the_absence_proxy(self):
        # Fit at the next deadline (1.0) and then not picked: dropped, not hurt.
        f = self._labels(_defenders(exit_gw=6, flagged=1.0))
        self.assertEqual(int(f._ie.sum()), 0)

    def test_non_regular_short_start_is_not_an_exit_by_proxy(self):
        rows = [_row("fringe", gw, 0, False) for gw in range(1, 6)]
        rows += [_row("fringe", 6, 30, True), _row("fringe", 7, 0, False)]
        self.assertEqual(int(self._labels(rows)._ie.sum()), 0)

    def test_latest_start_is_never_labelled(self):
        rows = [_row("p", gw, 90, True) for gw in range(1, 6)] + [_row("p", 6, 15, True)]
        self.assertEqual(int(self._labels(rows)._ie.sum()), 0)

    def test_own_red_card_is_not_an_injury_exit(self):
        # Sent off after 20 minutes, then banned: flagged at 0 and absent.
        f = self._labels(_defenders(exit_gw=6, red=True, flagged=0.0))
        self.assertEqual(int(f._ie.sum()), 0)


class InjuryExitFitTests(unittest.TestCase):

    def test_exit_row_moves_only_the_p60_fit(self):
        rows = _defenders(exit_gw=10)
        with _params(minutes__injury_exit_p60_strength=0.0):
            off = _fit(rows)
        with _params(minutes__injury_exit_p60_strength=1.0):
            on = _fit(rows)
            on_pred = on.predict("DEF", "subject", availability_override=FIT)
        with _params(minutes__injury_exit_p60_strength=0.0):
            off_pred = off.predict("DEF", "subject", availability_override=FIT)
        a, b = off.by_player["subject"], on.by_player["subject"]
        for key in ("n_fixtures", "n_starts", "n_not_started", "n_bench_appearances",
                    "sum_minutes_if_start", "n_started_rows", "n_60_starts"):
            self.assertEqual(a[key], b[key], key)
        self.assertEqual(b["injury_exit_starts"], 1.0)
        self.assertLess(b["n_started_rows_p60"], b["n_started_rows"])
        self.assertEqual(on_pred.p_start, off_pred.p_start)
        self.assertEqual(on_pred.minutes_if_start, off_pred.minutes_if_start)
        self.assertEqual(on_pred.p_bench_appear, off_pred.p_bench_appear)
        self.assertGreater(on_pred.p_60_if_start, off_pred.p_60_if_start + 0.05)

    def test_red_card_short_start_is_unchanged_when_nobody_exits(self):
        rows = _defenders(exit_gw=10, red=True, flagged=0.0)
        with _params(minutes__injury_exit_p60_strength=0.0):
            off = _fit(rows).predict("DEF", "subject", availability_override=FIT)
        with _params(minutes__injury_exit_p60_strength=1.0):
            model = _fit(rows)
            on = model.predict("DEF", "subject", availability_override=FIT)
        self.assertEqual(model.by_position["DEF"]["injury_exit_rate"], 0.0)
        self.assertEqual(model.by_player["subject"]["injury_exit_starts"], 0.0)
        self.assertAlmostEqual(on.p_60_if_start, off.p_60_if_start, places=12)

    def test_population_rate_stops_the_exclusion_inflating_him(self):
        rows = _defenders(exit_gw=10)
        with _params(minutes__injury_exit_p60_strength=1.0):
            model = _fit(rows)
            prior = model.by_position["DEF"]
            stats = model.by_player["subject"]
            got = model.predict("DEF", "subject", availability_override=FIT).p_60_if_start
            naive = _shrink(stats["n_60_starts"], stats["n_started_rows_p60"],
                            prior["p_60_if_start_clean"],
                            PARAM_REGISTRY["minutes.p60_shrinkage"]["value"])
        # The position's exit-free rate times its exit-free P(60) IS its P(60).
        self.assertGreater(prior["injury_exit_rate"], 0.0)
        self.assertAlmostEqual(
            (1 - prior["injury_exit_rate"]) * prior["p_60_if_start_clean"],
            prior["p_60_if_start"], places=12,
        )
        # Deleting his exit alone would project him as if exits never happen.
        self.assertAlmostEqual(got, (1 - prior["injury_exit_rate"]) * naive, places=12)
        self.assertLess(got, naive)
        self.assertLess(got, 1.0 - prior["injury_exit_rate"] + 1e-12)

    def test_clean_players_pay_the_population_rate(self):
        rows = _defenders(exit_gw=10)
        with _params(minutes__injury_exit_p60_strength=0.0):
            off = _fit(rows).predict("DEF", "mate_a", availability_override=FIT)
        with _params(minutes__injury_exit_p60_strength=1.0):
            model = _fit(rows)
            on = model.predict("DEF", "mate_a", availability_override=FIT)
        self.assertLess(on.p_60_if_start, off.p_60_if_start)


class WiringTests(unittest.TestCase):

    def test_injury_exit_switch_makes_the_live_callers_join_flags(self):
        with _params(minutes__fit_now_absence_credit=0.0,
                     minutes__unavailable_fixture_retention=1.0,
                     minutes__injury_exit_p60_strength=1.0):
            self.assertTrue(fpl_inputs.deadline_availability_in_use())
        with _params(minutes__fit_now_absence_credit=0.0,
                     minutes__unavailable_fixture_retention=1.0,
                     minutes__injury_exit_p60_strength=0.0):
            self.assertFalse(fpl_inputs.deadline_availability_in_use())

    def test_current_season_rows_carry_red_cards_per_fixture(self):
        bootstrap = {
            "element_types": [{"id": 2, "singular_name_short": "DEF"}],
            "elements": [{"id": 7, "first_name": "A", "second_name": "B", "element_type": 2}],
        }
        live = {"elements": [{
            "id": 7, "stats": {"minutes": 110, "starts": 2},
            "explain": [
                {"fixture": 1, "stats": [{"identifier": "minutes", "value": 20},
                                         {"identifier": "red_cards", "value": 1}]},
                {"fixture": 2, "stats": [{"identifier": "minutes", "value": 90}]},
            ],
        }]}
        rows = fpl_inputs.current_season_rows(bootstrap, {5: live}, season="2627")
        self.assertEqual(dict(zip(rows["fixture"], rows["red_cards"])), {1: 1, 2: 0})


if __name__ == "__main__":
    unittest.main()
