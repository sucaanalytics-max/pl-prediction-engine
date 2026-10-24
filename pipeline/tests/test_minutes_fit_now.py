"""
A player who is fit again must not keep paying for the matches he missed injured.

`minutes.fit_now_absence_credit` removes the Bayes share P(unavailable | did not
play) from each non-appearance at a flagged deadline — but ONLY in the fit used
when the player is fit at the prediction deadline (`is_fit_now`). That gate is
what separates it from `minutes.unavailable_fixture_retention`, which applied the
same correction to players still flagged and lost on calibration because FPL's
graded flags resolve far below face value. Measured on the sealed ledger
2026-10-25; the registry entry carries the numbers.

These tests pin the contract: the correction reaches exactly the fit-now players
with a flagged absence, it is inert for everyone else, and the live callers both
attach the flags it needs without ever being able to fail a refresh (the agent's
refresh is also the seal's).
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.models import fpl_inputs
from pipeline.models.minutes import (
    AVAILABILITY_AT_DEADLINE,
    MinutesModel,
    availability_state,
    is_fit_now,
)

CREDIT = "minutes.fit_now_absence_credit"
RETENTION = "minutes.unavailable_fixture_retention"
PIPELINE = Path(__file__).resolve().parent.parent


def _credit(value):
    return mock.patch.dict(PARAM_REGISTRY[CREDIT], {"value": value})


def _rows(name, sequence, position="DEF"):
    """One row per fixture from (minutes, started, availability_at_deadline)."""
    return [
        {
            "name_key": name, "position_norm": position, "GW": gameweek,
            "minutes": minutes, "starts": int(started),
            AVAILABILITY_AT_DEADLINE: available,
        }
        for gameweek, (minutes, started, available) in enumerate(sequence, start=1)
    ]


POOL = (
    [row for i in range(3) for row in _rows(f"regular {i}", [(90, True, 1.0)] * 6)]
    + [row for i in range(3) for row in _rows(f"filler {i}", [(0, False, 1.0)] * 6)]
)

# Four starts, then two matches out at 0% (the Porro / Maatsen shape).
RETURNING = _rows("back", [(90, True, 1.0)] * 4 + [(0, False, 0.0)] * 2)
# The same six fixtures, the last two missed while FIT: dropped, not injured.
DROPPED = _rows("dropped", [(90, True, 1.0)] * 4 + [(0, False, 1.0)] * 2)
# The healthy reference: the two flagged fixtures never entered the data.
HEALTHY = _rows("back", [(90, True, 1.0)] * 4)

FIT = availability_state("a", None)
FIT_100 = availability_state("a", 100)
STILL_OUT = availability_state("i", 0)
KNOCK = availability_state("d", 75)


def _fit(rows, credit=None):
    frame = pd.DataFrame(POOL + rows)
    if credit is None:
        return MinutesModel().fit(frame, key="name_key", position_column="position_norm")
    with _credit(credit):
        return MinutesModel().fit(frame, key="name_key", position_column="position_norm")


def _roles(model, player, state, horizon=0):
    return model.predict("DEF", player, availability_override=state, horizon=horizon)


class RegistryTests(unittest.TestCase):
    def test_default_is_the_measured_value_inside_its_bounds(self):
        entry = PARAM_REGISTRY[CREDIT]
        low, high = entry["bounds"]
        self.assertEqual(entry["value"], 1.0)
        self.assertTrue(low <= entry["value"] <= high)
        self.assertIn("MEASURED", entry["source"])

    def test_the_global_discount_stays_off(self):
        """This change must not be read as licence to switch the other one on."""
        self.assertEqual(PARAM_REGISTRY[RETENTION]["value"], 1.0)


class IsFitNowTests(unittest.TestCase):
    def test_available_with_no_chance_or_a_hundred_is_fit(self):
        self.assertTrue(is_fit_now(FIT))
        self.assertTrue(is_fit_now(FIT_100))

    def test_any_flag_is_not_fit(self):
        for state in (KNOCK, STILL_OUT, availability_state("a", 75),
                      availability_state("s", 0), availability_state("u", None)):
            with self.subTest(state=state):
                self.assertFalse(is_fit_now(state))

    def test_a_stale_note_cleared_to_one_is_not_fit(self):
        """news_stale returns 1.0 but is not FPL saying he is fine."""
        stale = availability_state("d", None, news_age_days=60)
        self.assertEqual(stale.now, 1.0)
        self.assertFalse(is_fit_now(stale))


class ReturningPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.on = _fit(RETURNING, credit=1.0)
        cls.off = _fit(RETURNING, credit=0.0)
        cls.healthy = _fit(HEALTHY, credit=0.0)

    def test_fit_now_his_role_evidence_is_as_if_the_missed_matches_never_happened(self):
        """
        Hard (0%) flags: the posterior attributes the whole zero to the flag.

        Compared on his own evidence, not on p_start: the position prior is
        computed over every row, flagged zeros included, by design (it is also
        the horizon reversion target, measured unconditionally).
        """
        fit_now = self.on.by_player["back"]["fit_now"]
        healthy = self.healthy.by_player["back"]
        for field in ("n_fixtures", "n_starts", "n_not_started"):
            with self.subTest(field=field):
                self.assertAlmostEqual(fit_now[field], healthy[field], places=12)
        self.assertAlmostEqual(
            _roles(self.on, "back", FIT).p_start,
            _roles(self.healthy, "back", FIT).p_start, delta=0.01,
        )

    def test_without_the_credit_the_missed_matches_were_benchings(self):
        self.assertLess(
            _roles(self.off, "back", FIT).p_start,
            0.6 * _roles(self.on, "back", FIT).p_start,
        )

    def test_while_still_flagged_nothing_changes(self):
        """The gate: a flagged player keeps the published fit, credit or not."""
        for state in (STILL_OUT, KNOCK):
            for horizon in (0, 3):
                with self.subTest(state=state.persistence, horizon=horizon):
                    self.assertEqual(
                        _roles(self.on, "back", state, horizon).as_dict(),
                        _roles(self.off, "back", state, horizon).as_dict(),
                    )

    def test_the_published_fit_is_unchanged(self):
        published = {k: v for k, v in self.on.by_player["back"].items() if k != "fit_now"}
        self.assertEqual(published, self.off.by_player["back"])
        self.assertNotIn("fit_now", self.off.by_player["back"])

    def test_only_the_role_split_moves(self):
        """Conditional-on-playing quantities come from appearances, never discounted."""
        fit_now = self.on.by_player["back"]["fit_now"]
        published = self.on.by_player["back"]
        for field in ("sum_minutes_if_start", "n_started_rows", "n_60_starts",
                      "sum_minutes_if_bench", "n_bench_appearances"):
            with self.subTest(field=field):
                self.assertEqual(fit_now[field], published[field])

    def test_the_horizon_uses_the_fit_now_role_and_stays_a_distribution(self):
        for horizon in range(7):
            with self.subTest(horizon=horizon):
                on = _roles(self.on, "back", FIT, horizon)
                off = _roles(self.off, "back", FIT, horizon)
                self.assertGreater(on.p_start, off.p_start)
                total = on.p_start + on.p_bench_appear + on.p_unused + on.p_unavailable
                self.assertAlmostEqual(total, 1.0, places=9)


class InertElsewhereTests(unittest.TestCase):
    def test_a_player_dropped_while_fit_is_untouched(self):
        """The identification: zeros without a flag are selection, and stay so."""
        on, off = _fit(DROPPED, credit=1.0), _fit(DROPPED, credit=0.0)
        self.assertNotIn("fit_now", on.by_player["dropped"])
        self.assertEqual(
            _roles(on, "dropped", FIT).as_dict(), _roles(off, "dropped", FIT).as_dict()
        )

    def test_a_flagged_player_who_played_has_nothing_to_credit(self):
        played = _rows("played", [(90, True, 1.0)] * 4 + [(30, False, 0.75)] * 2)
        on = _fit(played, credit=1.0)
        self.assertNotIn("fit_now", on.by_player["played"])

    def test_zero_credit_attaches_nothing(self):
        model = _fit(RETURNING + DROPPED, credit=0.0)
        self.assertFalse(any("fit_now" in s for s in model.by_player.values()))
        self.assertNotIn("players_with_fit_now_fit", model.availability_diagnostics)

    def test_rows_without_flags_attach_nothing(self):
        """The archive carries no flags; it must be exactly as before."""
        frame = pd.DataFrame(POOL + RETURNING).drop(columns=[AVAILABILITY_AT_DEADLINE])
        with _credit(1.0):
            model = MinutesModel().fit(frame, key="name_key", position_column="position_norm")
        self.assertFalse(any("fit_now" in s for s in model.by_player.values()))

    def test_a_graded_flag_on_a_fringe_player_is_only_partly_credited(self):
        """The posterior keeps most of a fringe player's zero as selection."""
        fringe = _rows(
            "fringe", [(0, False, 1.0)] * 3 + [(90, True, 1.0)] + [(0, False, 0.75)]
        )
        on, off = _fit(fringe, credit=1.0), _fit(fringe, credit=0.0)
        removed = (
            off.by_player["fringe"]["n_fixtures"]
            - on.by_player["fringe"]["fit_now"]["n_fixtures"]
        )
        last_weight = 1.0  # the flagged row is the latest fixture
        self.assertGreater(removed, 0.0)
        self.assertLess(removed, 0.6 * last_weight)


class LiveWiringTests(unittest.TestCase):
    """Both producers of the xp artifact join the flags; neither can be failed by it."""

    ROWS = pd.DataFrame({"element": [1], "GW": [1], "minutes": [0], "starts": [0]})

    def test_in_use_at_the_registry_default(self):
        self.assertTrue(fpl_inputs.deadline_availability_in_use())

    def test_off_means_the_ledger_is_never_read(self):
        with _credit(0.0), mock.patch.object(
            fpl_inputs, "with_deadline_availability"
        ) as join:
            out = fpl_inputs.with_deadline_availability_if_used(
                self.ROWS, {}, Path("/nonexistent")
            )
        join.assert_not_called()
        self.assertIs(out, self.ROWS)

    def test_a_failure_returns_the_rows_rather_than_raising(self):
        with mock.patch.object(
            fpl_inputs, "with_deadline_availability", side_effect=RuntimeError("boom")
        ), self.assertLogs("pipeline.models.fpl_inputs", level="WARNING"):
            out = fpl_inputs.with_deadline_availability_if_used(
                self.ROWS, {}, Path("/nonexistent")
            )
        self.assertIs(out, self.ROWS)

    def _calls_in(self, path: Path, function: str):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == function:
                return {
                    n.func.id for n in ast.walk(node)
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                }
        self.fail(f"{function} not found in {path}")

    def test_both_live_callers_attach_the_flags(self):
        """
        Two producers write the same xp artifact. If only one joined the flags
        they would disagree on every player back from injury.
        """
        for path, function in (
            (PIPELINE / "learning" / "run_agent.py", "refresh_expected_points"),
            (PIPELINE / "run_pipeline.py", "run_pipeline"),
        ):
            with self.subTest(caller=function):
                calls = self._calls_in(path, function)
                self.assertIn("with_deadline_availability_if_used", calls)
                self.assertIn("build_fpl_inputs", calls)


class SealProvenanceTests(unittest.TestCase):
    """
    The header records the parameter value; this records whether it took effect.
    The join is non-fatal, so without it a degraded run seals a header claiming
    the credit was on for a forecast made as if it were off.
    """

    def _provenance(self, rows, diagnostics):
        from pipeline.learning.run_agent import _deadline_availability_provenance

        return _deadline_availability_provenance(rows, diagnostics)

    def test_records_which_sealed_gameweeks_fed_the_fit_as_plain_json(self):
        import json

        import numpy as np

        rows = pd.DataFrame({
            "GW": np.array([1, 2, 3], dtype="int64"),
            "availability_at_deadline": [1.0, float("nan"), 0.75],
        })
        record = self._provenance(
            rows, {"deadline_availability": {"players_with_fit_now_fit": np.int64(4)}},
        )
        self.assertTrue(record["attached"])
        self.assertEqual(record["gameweeks_with_sealed_flags"], [1, 3])
        self.assertEqual(json.loads(json.dumps(record)), record)

    def test_a_degraded_join_is_recorded_as_not_attached(self):
        rows = pd.DataFrame({"GW": [1], "minutes": [0]})
        record = self._provenance(rows, {})
        self.assertFalse(record["attached"])
        self.assertEqual(record["gameweeks_with_sealed_flags"], [])

    def test_never_raises(self):
        self.assertIsNone(self._provenance(object(), object()))

    def test_the_seal_header_carries_it(self):
        source = (PIPELINE / "learning" / "run_agent.py").read_text()
        seal = source[source.index("def _seal("):source.index("def _announce(")]
        self.assertIn('"deadline_availability": outcome.get("deadline_availability")', seal)


if __name__ == "__main__":
    unittest.main()
