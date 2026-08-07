"""
Robustness scoring, and its refusal to run on a guessed sigma.

## What these tests are for

Two properties carry the whole module, and both are about honesty rather than
arithmetic.

**It must not produce a number today.** No gameweek has sealed, so there is no
measured projection-error distribution. A survival percentage computed from an
invented sigma looks exactly like one computed from evidence, which makes it
worse than no number at all. `test_refuses_without_measurement` is the gate.

**Correlated noise must actually penalise concentration.** The entire reason for
sampling shocks at the team level is that three Liverpool defenders share one
clean-sheet outcome. If the correlation had no effect on the spread of a
concentrated squad's total, the model would be decoration.
`ConcentrationTests` measures that directly: the same fifteen points spread
across fifteen teams must have a *narrower* total distribution than fifteen
points from three teams, under the same sigma.

That second one is the test a plausible-looking implementation passes only if it
is right. An implementation that drew one shock per *player* and multiplied it
by rho would look correlated, satisfy a "rho is used" assertion, and fail this.
"""

from __future__ import annotations

import math
import random
import unittest
from dataclasses import dataclass

from pipeline.learning.sensitivity import (
    MIN_OBSERVATIONS_PER_POSITION,
    NoiseModel,
    assess,
    describe_move,
    interpret,
    measure_noise,
    perturb,
)


@dataclass
class FakeCandidate:
    element_id: int
    position: str
    team: str
    xp: float


@dataclass
class FakePlan:
    transfers_out: list
    transfers_in: list


class _Rng:
    """Deterministic standard normals, so a failure is reproducible."""

    def __init__(self, seed: int = 7) -> None:
        self._rand = random.Random(seed)

    def normal(self) -> float:
        return self._rand.gauss(0.0, 1.0)


def settled(n_per_position: int, spread: float = 2.0, seed: int = 3):
    """Synthetic settled outcomes with a known residual spread."""
    rand = random.Random(seed)
    rows = []
    for position in ("GKP", "DEF", "MID", "FWD"):
        for i in range(n_per_position):
            predicted = 4.0
            rows.append({
                "gameweek": 1 + (i % 4),
                "element_id": i,
                "position": position,
                "team": f"T{i % 5}",
                "predicted": predicted,
                "actual": predicted + rand.gauss(0.0, spread),
            })
    return rows


class MeasurementGateTests(unittest.TestCase):
    """Nothing is measurable until enough gameweeks have settled."""

    def test_no_history_measures_nothing(self):
        self.assertIsNone(measure_noise([]))

    def test_too_few_observations_measures_nothing(self):
        thin = settled(MIN_OBSERVATIONS_PER_POSITION - 1)
        self.assertIsNone(measure_noise(thin))

    def test_enough_observations_measures_something(self):
        model = measure_noise(settled(MIN_OBSERVATIONS_PER_POSITION + 10))
        self.assertIsNotNone(model)
        assert model is not None
        self.assertGreater(model.sd_for("MID"), 0.0)

    def test_it_recovers_the_spread_it_was_given(self):
        model = measure_noise(settled(400, spread=2.5))
        assert model is not None
        # Generous tolerance: this asserts the estimator is not wrong by a
        # factor, not that it is precise on a finite sample.
        self.assertAlmostEqual(model.sd_for("MID"), 2.5, delta=0.4)

    def test_a_position_with_no_history_gets_no_borrowed_sigma(self):
        rows = [r for r in settled(200) if r["position"] != "GKP"]
        model = measure_noise(rows)
        assert model is not None
        # Not a forward's sigma, and not a pooled one. Zero means unmeasured.
        self.assertEqual(model.sd_for("GKP"), 0.0)
        self.assertGreater(model.sd_for("FWD"), 0.0)

    def test_bias_does_not_inflate_the_spread(self):
        """
        A systematically optimistic model is biased, not noisy.

        Measuring residuals about zero instead of about their mean would fold a
        constant bias into sigma, widen every perturbation, and report every
        recommendation as more fragile than the evidence supports.
        """
        rows = settled(400, spread=1.0)
        for row in rows:
            row["actual"] += 3.0  # a whole-sample shift, no extra spread
        model = measure_noise(rows)
        assert model is not None
        self.assertAlmostEqual(model.sd_for("MID"), 1.0, delta=0.3)

    def test_non_numeric_rows_are_skipped_not_coerced(self):
        rows = settled(MIN_OBSERVATIONS_PER_POSITION + 5)
        rows.append({
            "gameweek": 1, "element_id": 999, "position": "MID",
            "team": "LIV", "predicted": None, "actual": "6",
        })
        model = measure_noise(rows)
        assert model is not None
        self.assertEqual(model.observations["MID"], MIN_OBSERVATIONS_PER_POSITION + 5)

    def test_an_unknown_position_is_dropped_rather_than_pooled(self):
        rows = settled(MIN_OBSERVATIONS_PER_POSITION + 5)
        rows += [{
            "gameweek": 1, "element_id": 1, "position": "MANAGER",
            "team": "LIV", "predicted": 1.0, "actual": 50.0,
        }] * 50
        model = measure_noise(rows)
        assert model is not None
        # A 49-point residual pooled into any real bucket would dominate it.
        self.assertLess(model.sd_for("MID"), 5.0)


class CorrelationTests(unittest.TestCase):
    def test_rho_is_between_zero_and_one(self):
        model = measure_noise(settled(200))
        assert model is not None
        self.assertGreaterEqual(model.intra_team_rho, 0.0)
        self.assertLessEqual(model.intra_team_rho, 1.0)

    def test_a_team_wide_shock_is_detected_as_correlation(self):
        rand = random.Random(11)
        rows = []
        for gw in range(1, 9):
            for team in range(6):
                shared = rand.gauss(0.0, 3.0)  # the clean sheet, or not
                for i in range(8):
                    rows.append({
                        "gameweek": gw, "element_id": team * 100 + i,
                        "position": "DEF", "team": f"T{team}",
                        "predicted": 4.0,
                        "actual": 4.0 + shared + rand.gauss(0.0, 0.5),
                    })
        model = measure_noise(rows)
        assert model is not None
        # Almost all variance is shared here, so rho must be high.
        self.assertGreater(model.intra_team_rho, 0.6)

    def test_independent_residuals_show_little_correlation(self):
        rand = random.Random(12)
        rows = [{
            "gameweek": gw, "element_id": i, "position": "MID",
            "team": f"T{i % 6}", "predicted": 4.0,
            "actual": 4.0 + rand.gauss(0.0, 2.0),
        } for gw in range(1, 9) for i in range(48)]
        model = measure_noise(rows)
        assert model is not None
        self.assertLess(model.intra_team_rho, 0.35)


class PerturbationTests(unittest.TestCase):
    NOISE = NoiseModel(
        sd_by_position={"DEF": 2.0, "MID": 2.0, "FWD": 2.0, "GKP": 2.0},
        intra_team_rho=0.5,
        observations={"DEF": 100, "MID": 100, "FWD": 100, "GKP": 100},
        gameweeks=8,
    )

    def test_it_does_not_mutate_the_input(self):
        original = [FakeCandidate(1, "MID", "LIV", 5.0)]
        perturb(original, self.NOISE, _Rng())
        self.assertEqual(original[0].xp, 5.0)

    def test_perturbed_values_move(self):
        candidates = [FakeCandidate(i, "MID", f"T{i}", 5.0) for i in range(20)]
        out = perturb(candidates, self.NOISE, _Rng())
        self.assertTrue(any(c.xp != 5.0 for c in out))

    def test_expected_points_never_go_negative(self):
        # A negative xP is not a forecast the optimiser can interpret.
        candidates = [FakeCandidate(i, "MID", f"T{i}", 0.1) for i in range(200)]
        out = perturb(candidates, self.NOISE, _Rng(99))
        self.assertTrue(all(c.xp >= 0.0 for c in out))

    def test_an_unmeasured_position_is_left_alone(self):
        noise = NoiseModel(
            sd_by_position={"MID": 2.0},
            intra_team_rho=0.0,
            observations={"MID": 100},
            gameweeks=8,
        )
        out = perturb([FakeCandidate(1, "GKP", "LIV", 4.0)], noise, _Rng())
        self.assertEqual(out[0].xp, 4.0)

    def test_teammates_move_together_under_high_rho(self):
        noise = NoiseModel(
            sd_by_position={"DEF": 2.0}, intra_team_rho=1.0,
            observations={"DEF": 100}, gameweeks=8,
        )
        squad = [FakeCandidate(i, "DEF", "LIV", 5.0) for i in range(4)]
        out = perturb(squad, noise, _Rng(5))
        # rho = 1 means one shock for the whole team, so every delta is equal.
        deltas = {round(c.xp - 5.0, 9) for c in out}
        self.assertEqual(len(deltas), 1)

    def test_rivals_move_independently_under_high_rho(self):
        noise = NoiseModel(
            sd_by_position={"DEF": 2.0}, intra_team_rho=1.0,
            observations={"DEF": 100}, gameweeks=8,
        )
        squad = [FakeCandidate(i, "DEF", f"T{i}", 5.0) for i in range(6)]
        out = perturb(squad, noise, _Rng(5))
        self.assertGreater(len({round(c.xp, 9) for c in out}), 1)


class ConcentrationTests(unittest.TestCase):
    """
    The property the whole correlation model exists for.

    Fifteen points from three teams must be riskier than fifteen points from
    fifteen teams. An implementation that drew a per-player shock and merely
    scaled it by rho would pass every test above and fail this one.
    """

    NOISE = NoiseModel(
        sd_by_position={"DEF": 2.0}, intra_team_rho=0.7,
        observations={"DEF": 300}, gameweeks=10,
    )

    @staticmethod
    def _total_spread(squad, seed_base: int, draws: int = 400) -> float:
        totals = []
        for draw in range(draws):
            out = perturb(squad, ConcentrationTests.NOISE, _Rng(seed_base + draw))
            totals.append(sum(c.xp for c in out))
        mean = sum(totals) / len(totals)
        var = sum((t - mean) ** 2 for t in totals) / (len(totals) - 1)
        return math.sqrt(var)

    def test_a_concentrated_squad_has_a_wider_total_distribution(self):
        concentrated = [
            FakeCandidate(i, "DEF", f"T{i % 3}", 5.0) for i in range(15)
        ]
        diversified = [
            FakeCandidate(i, "DEF", f"T{i}", 5.0) for i in range(15)
        ]
        self.assertGreater(
            self._total_spread(concentrated, 1000),
            self._total_spread(diversified, 1000) * 1.3,
        )

    def test_with_no_correlation_the_two_are_alike(self):
        """The control. Without rho the concentration penalty must vanish."""
        noise = NoiseModel(
            sd_by_position={"DEF": 2.0}, intra_team_rho=0.0,
            observations={"DEF": 300}, gameweeks=10,
        )
        concentrated = [FakeCandidate(i, "DEF", f"T{i % 3}", 5.0) for i in range(15)]
        diversified = [FakeCandidate(i, "DEF", f"T{i}", 5.0) for i in range(15)]

        def spread(squad, base):
            totals = []
            for draw in range(400):
                out = perturb(squad, noise, _Rng(base + draw))
                totals.append(sum(c.xp for c in out))
            mean = sum(totals) / len(totals)
            return math.sqrt(sum((t - mean) ** 2 for t in totals) / (len(totals) - 1))

        ratio = spread(concentrated, 2000) / spread(diversified, 2000)
        self.assertLess(abs(ratio - 1.0), 0.25)


class AssessTests(unittest.TestCase):
    NOISE = NoiseModel(
        sd_by_position={"MID": 1.0}, intra_team_rho=0.2,
        observations={"MID": 100}, gameweeks=8,
    )
    SQUAD = [FakeCandidate(i, "MID", f"T{i}", 5.0 + i * 0.1) for i in range(6)]

    def test_refuses_without_measurement(self):
        """Today's state, and the one that matters most."""
        report = assess(self.SQUAD, None, lambda c: FakePlan([], []))
        self.assertFalse(report.measurable)
        self.assertIsNone(report.survival)
        assert report.reason is not None
        self.assertIn("never been measured", report.reason)

    def test_the_unmeasurable_report_carries_no_fabricated_numbers(self):
        payload = assess(self.SQUAD, None, lambda c: FakePlan([], [])).as_dict()
        self.assertIsNone(payload["survival"])
        self.assertIsNone(payload["baseline_move"])
        self.assertEqual(payload["alternatives"], [])
        self.assertIsNone(payload["noise"])

    def test_a_stable_recommendation_survives(self):
        report = assess(
            self.SQUAD, self.NOISE, lambda c: FakePlan([1], [2]), draws=20,
            rng=_Rng(),
        )
        self.assertTrue(report.measurable)
        self.assertEqual(report.baseline_move, "1->2")
        self.assertEqual(report.survival, 1.0)

    def test_alternatives_are_counted_and_ranked(self):
        calls = {"n": 0}

        def solver(candidates):
            calls["n"] += 1
            # First call is the baseline, then alternate.
            return FakePlan([1], [2]) if calls["n"] % 3 else FakePlan([3], [4])

        report = assess(self.SQUAD, self.NOISE, solver, draws=30, rng=_Rng())
        self.assertGreater(len(report.outcomes), 1)
        self.assertGreaterEqual(report.outcomes[0].wins, report.outcomes[1].wins)

    def test_a_failed_draw_is_reported_not_counted_against_the_baseline(self):
        calls = {"n": 0}

        def solver(candidates):
            calls["n"] += 1
            if calls["n"] % 2 == 0:
                raise RuntimeError("solver limit")
            return FakePlan([1], [2])

        report = assess(self.SQUAD, self.NOISE, solver, draws=10, rng=_Rng())
        self.assertGreater(report.failed_draws, 0)
        # Counting solver failures as losses would report our own limits as
        # evidence against the recommendation.
        self.assertEqual(report.survival, 1.0)
        self.assertEqual(report.draws + report.failed_draws, 10)


class MoveLabelTests(unittest.TestCase):
    def test_a_hold_is_named(self):
        self.assertEqual(describe_move(FakePlan([], [])), "hold")

    def test_order_does_not_create_a_second_move(self):
        # The optimiser has no reason to return transfers in a stable order, and
        # an unsorted label would split one move across two counters.
        self.assertEqual(
            describe_move(FakePlan([2, 1], [4, 3])),
            describe_move(FakePlan([1, 2], [3, 4])),
        )


class BandTests(unittest.TestCase):
    """The vocabulary that ships with the number."""

    def test_unmeasured_says_so(self):
        self.assertEqual(interpret(None), "not measured")

    def test_the_bands_are_ordered_and_total(self):
        seen = [interpret(v / 100) for v in range(0, 101)]
        self.assertEqual(len(set(seen)), 4)
        self.assertIn("robust", seen[95])
        self.assertIn("fragile", seen[10])


if __name__ == "__main__":
    unittest.main()
