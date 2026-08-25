"""
Tests for scoring the manager rather than the model.

Three of these exist because the naive implementation was written first and was
wrong. They are named for the mistake, not the method, so a future rewrite that
reintroduces it fails on a test whose name says why.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from pipeline.learning import decision_review as dr

REPO_ROOT = Path(__file__).resolve().parents[2]
GW1_LEDGER = REPO_ROOT / "predictions" / "fpl" / "ledger" / "gw01" / "forecast.jsonl"


def sealed(element_id: int, xp: float, mc_se: float = 0.02) -> dr.Sealed:
    return dr.Sealed(element_id=element_id, xp=xp, mc_se=mc_se)


def picks_payload(
    eleven,
    bench,
    *,
    captain=None,
    subs=(),
    entry_history=None,
):
    """A picks response shaped like FPL's, with multipliers already auto-subbed."""
    rows = []
    for position, element in enumerate(eleven, start=1):
        rows.append(
            {
                "element": element,
                "position": position,
                "multiplier": 2 if element == captain else 1,
                "is_captain": element == captain,
                "is_vice_captain": False,
            }
        )
    for offset, element in enumerate(bench, start=12):
        rows.append(
            {
                "element": element,
                "position": offset,
                "multiplier": 0,
                "is_captain": False,
                "is_vice_captain": False,
            }
        )
    return {
        "picks": rows,
        "automatic_subs": list(subs),
        "entry_history": entry_history or {},
    }


class SubmittedElevenTest(unittest.TestCase):
    """FPL returns the team it corrected, not the team that was picked."""

    def test_reverses_an_automatic_substitution(self):
        # As served: 173 sits in an XI slot and 152 on the bench. The sub log says
        # 173 came on for 152, so the submitted eleven contained 152, not 173.
        payload = picks_payload(
            [1, 173, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            [12, 13, 14, 152],
            subs=({"element_in": 173, "element_out": 152},),
        )
        eleven, bench = dr.submitted_eleven(payload)
        self.assertIn(152, eleven, "the starter the manager actually chose")
        self.assertNotIn(173, eleven, "the substitute FPL brought on")
        self.assertIn(173, bench)
        self.assertEqual(len(eleven), 11)
        self.assertEqual(len(bench), 4)

    def test_no_substitutions_leaves_the_eleven_alone(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        eleven, bench = dr.submitted_eleven(payload)
        self.assertEqual(eleven, set(range(1, 12)))
        self.assertEqual(bench, [12, 13, 14, 15])

    def test_bench_keeps_its_submitted_order(self):
        # Ids must not overlap the eleven; an element in both is correctly excluded
        # from the bench, which is what an earlier version of this test tripped on.
        payload = picks_payload(list(range(1, 12)), [40, 30, 20, 15])
        _, bench = dr.submitted_eleven(payload)
        self.assertEqual(bench, [40, 30, 20, 15], "bench order is itself a decision")

    def test_half_recorded_substitution_is_not_reversed(self):
        payload = picks_payload(
            list(range(1, 12)), [12, 13, 14, 15], subs=({"element_in": 5},)
        )
        eleven, _ = dr.submitted_eleven(payload)
        self.assertEqual(len(eleven), 11, "under-report rather than invent a decision")


class SeparationTest(unittest.TestCase):
    """A tie must never become a lesson."""

    def test_a_gap_inside_combined_error_is_not_separated(self):
        # Real GW1 values: two midfielders 0.0008 apart with a combined 2-sigma
        # of about 0.100. `>` would have called this a managerial error.
        left = sealed(368, 4.4736, 0.0348)
        right = sealed(418, 4.4744, 0.0362)
        self.assertFalse(dr.separated(left, right))

    def test_a_gap_beyond_combined_error_is_separated(self):
        # Real GW1 values: Thomas over Palestra, gap 0.074, combined 2-sigma 0.053.
        thomas = sealed(173, 0.8726, 0.0175)
        palestra = sealed(152, 0.7983, 0.0198)
        self.assertTrue(dr.separated(thomas, palestra))

    def test_separation_is_symmetric(self):
        a, b = sealed(1, 5.0, 0.01), sealed(2, 4.0, 0.01)
        self.assertEqual(dr.separated(a, b), dr.separated(b, a))

    def test_a_tie_verdicts_as_indistinguishable_not_foreseeable(self):
        verdict = dr._verdict(sealed(1, 4.4744, 0.0362), sealed(2, 4.4736, 0.0348))
        self.assertEqual(verdict, dr.INDISTINGUISHABLE)

    def test_an_absent_forecast_gives_no_verdict(self):
        self.assertIsNone(dr._verdict(None, sealed(2, 4.0)))
        self.assertIsNone(dr._verdict(sealed(1, 4.0), None))


class BenchReviewTest(unittest.TestCase):
    def test_one_substitution_produces_exactly_one_rescue(self):
        """The first implementation credited every bench player who played."""
        payload = picks_payload(
            [1, 173, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            [12, 13, 14, 152],
            subs=({"element_in": 173, "element_out": 152},),
        )
        points = {173: 3, 13: 2, 152: 0, 3: 5, 1: 6}
        minutes = {e: 90 for e in [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 173, 13]}
        minutes[152] = 0
        minutes[12] = 0
        minutes[14] = 0
        calls = dr.review_bench(payload, points, minutes, {})
        rescued = [c for c in calls if c.kind == dr.RESCUED]
        self.assertEqual(len(rescued), 1)
        self.assertEqual(rescued[0].bench_element, 173)
        self.assertEqual(rescued[0].starter_element, 152)

    def test_a_rescue_forgoes_no_points(self):
        payload = picks_payload(
            [1, 173, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            [12, 13, 14, 152],
            subs=({"element_in": 173, "element_out": 152},),
        )
        calls = dr.review_bench(payload, {173: 9}, {173: 90, 152: 0}, {})
        rescued = next(c for c in calls if c.kind == dr.RESCUED)
        self.assertEqual(
            rescued.points_forgone, 0, "the substitution already collected them"
        )

    def test_a_bench_player_who_did_not_play_has_no_claim(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        minutes = {e: 90 for e in range(1, 12)}
        calls = dr.review_bench(payload, {}, minutes, {})
        for call in calls:
            self.assertEqual(call.kind, dr.NO_CLAIM)
            self.assertEqual(call.points_forgone, 0)
            self.assertIsNone(call.verdict)

    def test_a_bench_player_who_beat_nobody_is_correct_not_a_cost(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        points = {e: 10 for e in range(1, 12)}
        points[12] = 2
        minutes = {e: 90 for e in list(range(1, 12)) + [12]}
        calls = dr.review_bench(payload, points, minutes, {})
        call = next(c for c in calls if c.bench_element == 12)
        self.assertEqual(call.kind, dr.CORRECT)
        self.assertEqual(call.points_forgone, 0)

    def test_a_real_cost_is_measured_against_the_worst_starter_who_played(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        points = {e: 5 for e in range(1, 12)}
        points[7] = 1          # worst starter who played
        points[8] = 0          # did not play, so not a candidate
        points[12] = 6
        minutes = {e: 90 for e in list(range(1, 12)) + [12]}
        minutes[8] = 0
        calls = dr.review_bench(payload, points, minutes, {})
        call = next(c for c in calls if c.bench_element == 12)
        self.assertEqual(call.kind, dr.COST)
        self.assertEqual(call.starter_element, 7)
        self.assertEqual(call.points_forgone, 5)

    def test_only_a_foreseeable_cost_is_a_lesson(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        points = {**{e: 5 for e in range(1, 12)}, 7: 1, 12: 6}
        minutes = {e: 90 for e in list(range(1, 12)) + [12]}

        forecast = {12: sealed(12, 5.0, 0.02), 7: sealed(7, 3.0, 0.02)}
        call = next(
            c for c in dr.review_bench(payload, points, minutes, forecast)
            if c.bench_element == 12
        )
        self.assertEqual(call.verdict, dr.FORESEEABLE)
        self.assertTrue(call.is_lesson())

        tied = {12: sealed(12, 4.0, 0.05), 7: sealed(7, 3.99, 0.05)}
        call = next(
            c for c in dr.review_bench(payload, points, minutes, tied)
            if c.bench_element == 12
        )
        self.assertEqual(call.verdict, dr.INDISTINGUISHABLE)
        self.assertFalse(call.is_lesson(), "a tie is not a lesson")

        defensible = {12: sealed(12, 2.0, 0.02), 7: sealed(7, 6.0, 0.02)}
        call = next(
            c for c in dr.review_bench(payload, points, minutes, defensible)
            if c.bench_element == 12
        )
        self.assertEqual(call.verdict, dr.DEFENSIBLE)
        self.assertFalse(call.is_lesson(), "right call, bad luck")


class ElevenCheckTest(unittest.TestCase):
    """The selection question, decided before kickoff and not by auto-subs."""

    def test_flags_every_bench_player_rated_above_the_weakest_starter(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        forecast = {
            **{e: sealed(e, 4.0, 0.02) for e in range(1, 12)},
            7: sealed(7, 0.80, 0.02),          # the weak starter
            12: sealed(12, 4.41, 0.03),
            13: sealed(13, 3.50, 0.03),
            14: sealed(14, 0.87, 0.02),
            15: sealed(15, 0.10, 0.02),        # rated below him, correctly benched
        }
        check = dr.review_eleven(payload, forecast)
        self.assertEqual(check.worst_starter, 7)
        self.assertEqual(check.best_bench, 12)
        self.assertEqual(set(check.bench_rated_higher), {12, 13, 14})
        self.assertTrue(check.misordered)
        self.assertAlmostEqual(check.gap, 3.61, places=2)

    def test_a_correctly_ordered_eleven_is_not_misordered(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        forecast = {
            **{e: sealed(e, 5.0, 0.02) for e in range(1, 12)},
            **{e: sealed(e, 1.0, 0.02) for e in (12, 13, 14, 15)},
        }
        check = dr.review_eleven(payload, forecast)
        self.assertFalse(check.misordered)
        self.assertEqual(check.bench_rated_higher, ())

    def test_a_tie_does_not_count_as_misordered(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        forecast = {
            **{e: sealed(e, 4.0, 0.05) for e in range(1, 12)},
            12: sealed(12, 4.01, 0.05),   # inside the combined error
        }
        check = dr.review_eleven(payload, forecast)
        self.assertFalse(check.misordered, "noise is not a selection error")
        self.assertIsNone(check.gap)

    def test_uncovered_forecast_yields_no_check(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        check = dr.review_eleven(payload, {})
        self.assertIsNone(check.worst_starter)
        self.assertFalse(check.misordered)

    def test_it_uses_the_submitted_eleven_not_the_corrected_one(self):
        payload = picks_payload(
            [1, 173, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            [12, 13, 14, 152],
            subs=({"element_in": 173, "element_out": 152},),
        )
        forecast = {
            **{e: sealed(e, 4.0, 0.02) for e in [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]},
            152: sealed(152, 0.798, 0.0198),
            173: sealed(173, 0.873, 0.0175),
            13: sealed(13, 4.41, 0.03),
        }
        check = dr.review_eleven(payload, forecast)
        self.assertEqual(
            check.worst_starter, 152, "the man the manager actually started"
        )
        self.assertIn(173, check.bench_rated_higher)
        self.assertIn(13, check.bench_rated_higher)


class LessonTest(unittest.TestCase):
    def test_a_rescued_foreseeable_error_is_still_a_lesson(self):
        """
        GW1 2026-27: an auto-sub covered a foreseeably wrong start. Gating the
        lesson on points_forgone would teach the manager to notice a bad call only
        when it was also unlucky.
        """
        call = dr.BenchCall(
            bench_element=173,
            starter_element=152,
            kind=dr.RESCUED,
            points_forgone=0,
            verdict=dr.FORESEEABLE,
        )
        self.assertTrue(call.is_lesson())

    def test_an_indistinguishable_cost_is_not_a_lesson(self):
        call = dr.BenchCall(1, 2, dr.COST, 2, dr.INDISTINGUISHABLE)
        self.assertFalse(call.is_lesson())

    def test_a_defensible_cost_is_not_a_lesson(self):
        call = dr.BenchCall(1, 2, dr.COST, 6, dr.DEFENSIBLE)
        self.assertFalse(call.is_lesson())

    def test_no_verdict_is_not_a_lesson(self):
        self.assertFalse(dr.BenchCall(1, None, dr.NO_CLAIM, 0, None).is_lesson())


class CaptainReviewTest(unittest.TestCase):
    def test_argmax_is_restricted_to_the_submitted_eleven(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15], captain=5)
        forecast = {
            **{e: sealed(e, 3.0) for e in range(1, 12)},
            5: sealed(5, 6.0),
            13: sealed(13, 99.0),   # a monster on the bench must not be the target
        }
        call = dr.review_captain(payload, {}, forecast)
        self.assertEqual(call.sealed_best, 5)
        self.assertTrue(call.agreed)

    def test_divergence_is_doubled_because_the_armband_doubles(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15], captain=1)
        forecast = {1: sealed(1, 3.0), 2: sealed(2, 9.0)}
        call = dr.review_captain(payload, {1: 2, 2: 8}, forecast)
        self.assertEqual(call.sealed_best, 2)
        self.assertFalse(call.agreed)
        self.assertEqual(call.points_delta, 12)

    def test_no_captain_returns_none(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15])
        self.assertIsNone(dr.review_captain(payload, {}, {}))

    def test_an_uncovered_eleven_yields_no_comparison(self):
        payload = picks_payload(list(range(1, 12)), [12, 13, 14, 15], captain=3)
        call = dr.review_captain(payload, {3: 7}, {})
        self.assertEqual(call.chosen, 3)
        self.assertIsNone(call.sealed_best)
        self.assertIsNone(call.agreed)


class WithholdingTest(unittest.TestCase):
    """One gameweek of self-assessment is noise and must not read as a finding."""

    def test_aggregate_is_withheld_below_the_threshold(self):
        payload = dr.build([{"gameweek": 1, "bench": [], "captain": None}],
                           generated_at="2026-08-25T00:00:00Z")
        self.assertIsNone(payload["aggregate"])
        self.assertIn("6 are needed", payload["aggregate_reason"])
        self.assertEqual(payload["observations"], 1)
        self.assertEqual(len(payload["gameweeks"]), 1, "per-gameweek calls still ship")

    def test_aggregate_appears_once_earned(self):
        weeks = [
            {
                "gameweek": n,
                "bench": [
                    {"kind": dr.COST, "points_forgone": 2, "verdict": dr.FORESEEABLE}
                ],
                "captain": {"agreed": n % 2 == 0, "points_delta": 2},
            }
            for n in range(1, 7)
        ]
        payload = dr.build(weeks, generated_at="2026-08-25T00:00:00Z")
        agg = payload["aggregate"]
        self.assertIsNotNone(agg)
        self.assertIsNone(payload["aggregate_reason"])
        self.assertEqual(agg["gameweeks"], 6)
        self.assertEqual(agg["points_forgone_on_bench"], 12)
        self.assertEqual(agg["foreseeable_bench_errors"], 6)
        self.assertEqual(agg["captain_agreement_rate"], 0.5)


class SealedLedgerTest(unittest.TestCase):
    """Against the committed GW1 seal, not a fixture of it."""

    @classmethod
    def setUpClass(cls):
        if not GW1_LEDGER.exists():
            raise unittest.SkipTest(f"no sealed ledger at {GW1_LEDGER}")
        cls.lines = GW1_LEDGER.read_text().splitlines()

    def test_loads_the_sealed_universe(self):
        forecast = dr.load_sealed(self.lines)
        self.assertGreater(len(forecast), 400)
        for row in forecast.values():
            self.assertGreaterEqual(row.mc_se, 0.0)

    def test_a_zero_variance_forecast_is_exact_not_missing(self):
        """
        One GW1 row carries mc_se 0.0: element 298, with xp, xp_sd, q90 and
        p_appears all exactly 0 — a player who does not appear in any of the
        10,000 draws. That is a precise forecast, not an absent one, so it must
        load. Two such players compare as indistinguishable (a zero gap), while
        one against a real projection separates, which is correct: both means are
        exact.
        """
        forecast = dr.load_sealed(self.lines)
        exact = [r for r in forecast.values() if r.mc_se == 0.0]
        self.assertTrue(exact, "the zero-variance row must survive loading")
        for row in exact:
            self.assertEqual(row.xp, 0.0)
        self.assertFalse(dr.separated(exact[0], exact[0]))
        self.assertTrue(dr.separated(exact[0], sealed(999, 4.0, 0.03)))

    def test_header_carries_the_proof_of_precedence(self):
        header = dr.sealed_header(self.lines)
        self.assertIsNotNone(header)
        self.assertIn("sealed_at", header)
        self.assertGreater(
            header["seconds_before_deadline"], 0, "sealed before the deadline"
        )
        self.assertFalse(header.get("dry_run"), "a dry run proves nothing")

    def test_header_rows_are_not_loaded_as_players(self):
        forecast = dr.load_sealed(self.lines)
        header = dr.sealed_header(self.lines)
        self.assertNotIn(header.get("element_id"), forecast)

    def test_rows_without_mc_se_are_dropped_not_defaulted(self):
        doctored = json.dumps({"record": "forecast", "element_id": 999, "xp": 5.0})
        forecast = dr.load_sealed([doctored])
        self.assertNotIn(999, forecast)


if __name__ == "__main__":
    unittest.main()
