"""
Tests for the promotion gates.

The gate that matters is ``gate_out_of_sample``, and the test that matters is
``test_pure_noise_is_rejected_over_a_whole_season``: the refit is re-run every
gameweek and ships the first time it passes, so a gate that is merely correct at
a fixed sample size will eventually pass a candidate that is pure noise. That is
simulated directly rather than argued about.

Every other gate is tested for the thing it forbids, not the thing it allows —
a gate that never fires is indistinguishable from no gate at all.
"""
from __future__ import annotations

import unittest

import numpy as np

from pipeline.config import PARAM_REGISTRY, RISK
from pipeline.learning.gates import (
    DEFAULT_ALPHA,
    MAX_BLOCK_PARAMETERS,
    MIN_EFFECTIVE_SAMPLE,
    MIN_OBSERVATIONS,
    anytime_valid_bound,
    evaluate,
    gate_block_size,
    gate_bounds,
    gate_effective_sample,
    gate_is_registered,
    gate_move_size,
    gate_not_risk,
    gate_out_of_sample,
    gate_tier,
)

# A real fittable parameter, so the tests exercise the actual registry rather
# than a fixture that might drift away from it.
FITTABLE = next(
    name for name, entry in PARAM_REGISTRY.items() if entry.get("tier") == "F"
)


class TestRegistryDisjointFromRisk(unittest.TestCase):
    def test_no_parameter_is_both_fittable_and_a_staking_control(self):
        """
        The plan states this as an invariant, so it is asserted rather than
        assumed. A learning loop that could widen a stake cap is a categorically
        more dangerous system than one that fits expected points.
        """
        self.assertEqual(set(PARAM_REGISTRY) & set(RISK), set())

    def test_every_registry_entry_declares_bounds_a_tier_and_a_source(self):
        for name, entry in PARAM_REGISTRY.items():
            self.assertIn("bounds", entry, name)
            self.assertIn("tier", entry, name)
            self.assertIn("source", entry, name)
            self.assertTrue(str(entry["source"]).strip(), f"{name} has an empty source")

    def test_every_value_lies_inside_its_own_bounds(self):
        for name, entry in PARAM_REGISTRY.items():
            low, high = entry["bounds"]
            self.assertGreaterEqual(entry["value"], low, name)
            self.assertLessEqual(entry["value"], high, name)


class TestAnytimeValidBound(unittest.TestCase):
    def test_too_few_observations_bound_nothing(self):
        """
        A run of lucky weeks must not promote anything. Below the minimum the
        sample standard deviation cannot be trusted in a boundary derived for
        known variance, so the radius is infinite by construction.
        """
        for n in (1, 2, MIN_OBSERVATIONS - 1):
            _, radius = anytime_valid_bound([1.0] * n)
            self.assertEqual(radius, float("inf"), f"n={n}")
        _, radius = anytime_valid_bound([1.0, 2.0] * MIN_OBSERVATIONS)
        self.assertLess(radius, float("inf"))

    def test_radius_shrinks_as_evidence_accumulates(self):
        rng = np.random.default_rng(0)
        draws = rng.normal(0.5, 1.0, 400)
        _, small = anytime_valid_bound(draws[:20])
        _, large = anytime_valid_bound(draws)
        self.assertLess(large, small)

    def test_it_is_wider_than_a_fixed_n_interval(self):
        """
        The price of being allowed to stop whenever the answer looks good. If it
        were not wider, it would not be valid under optional stopping.
        """
        rng = np.random.default_rng(1)
        draws = rng.normal(0.0, 1.0, 100)
        _, radius = anytime_valid_bound(draws)
        fixed = 1.96 * draws.std(ddof=1) / np.sqrt(len(draws))
        self.assertGreater(radius, fixed)

    def test_identical_differences_have_zero_radius(self):
        mean, radius = anytime_valid_bound([2.0] * MIN_OBSERVATIONS)
        self.assertEqual(mean, 2.0)
        self.assertEqual(radius, 0.0)


class TestOutOfSampleGate(unittest.TestCase):
    def test_pure_noise_is_rejected_over_a_whole_season(self):
        """
        The gate this module exists for.

        A refit is re-tested every gameweek and ships the first time it passes.
        Simulate that honestly: 200 independent seasons of 38 zero-mean weeks,
        checking the gate after every week and promoting on the first pass. The
        false-promotion rate must stay near alpha, not approach one.
        """
        rng = np.random.default_rng(20260801)
        promoted = 0
        seasons = 200
        for _ in range(seasons):
            weeks = rng.normal(0.0, 1.0, 38)
            for n in range(2, len(weeks) + 1):
                if gate_out_of_sample(weeks[:n]).passed:
                    promoted += 1
                    break
        rate = promoted / seasons
        self.assertLess(
            rate, 0.05,
            f"{promoted}/{seasons} noise-only candidates promoted under weekly "
            f"looks; the sequence is not controlling optional stopping",
        )

    def test_a_fixed_alpha_test_would_have_failed_that(self):
        """
        The counterfactual, so the anytime-valid machinery is justified by
        evidence rather than by assertion. A naive per-week t-test on the same
        streams promotes far more often.
        """
        rng = np.random.default_rng(20260801)
        promoted = 0
        seasons = 200
        for _ in range(seasons):
            weeks = rng.normal(0.0, 1.0, 38)
            for n in range(2, len(weeks) + 1):
                sample = weeks[:n]
                se = sample.std(ddof=1) / np.sqrt(n)
                if se > 0 and sample.mean() - 1.96 * se > 0:
                    promoted += 1
                    break
        self.assertGreater(
            promoted / seasons, 0.15,
            "the naive test was expected to over-promote; if it does not, this "
            "test no longer demonstrates why the confidence sequence is needed",
        )

    def test_a_real_improvement_is_eventually_accepted(self):
        """
        A gate that rejects everything is not a gate. A genuine effect, large
        relative to its noise, must clear.
        """
        rng = np.random.default_rng(7)
        weeks = rng.normal(1.0, 0.5, 60)
        self.assertTrue(gate_out_of_sample(weeks).passed)

    def test_a_regression_is_rejected(self):
        rng = np.random.default_rng(8)
        self.assertFalse(gate_out_of_sample(rng.normal(-1.0, 0.5, 60)).passed)


class TestIndividualGates(unittest.TestCase):
    def test_unregistered_parameter_is_refused(self):
        self.assertFalse(gate_is_registered("minutes.not_a_real_parameter").passed)
        self.assertTrue(gate_is_registered(FITTABLE).passed)

    def test_staking_parameters_are_refused(self):
        for name in list(RISK)[:3]:
            self.assertFalse(gate_not_risk(name).passed, name)
        self.assertFalse(gate_not_risk("risk.anything").passed)
        self.assertTrue(gate_not_risk(FITTABLE).passed)

    def test_constants_are_never_refit(self):
        constants = [n for n, e in PARAM_REGISTRY.items() if e.get("tier") == "C"]
        for name in constants:
            self.assertFalse(gate_tier(name).passed, name)

    def test_out_of_bounds_is_refused_not_clipped(self):
        low, high = PARAM_REGISTRY[FITTABLE]["bounds"]
        result = gate_bounds(FITTABLE, high * 10)
        self.assertFalse(result.passed)
        # The proposal is reported unchanged: clipping would ship a value the
        # fit never chose.
        self.assertEqual(result.detail["proposed"], high * 10)

    def test_a_large_jump_is_refused(self):
        low, high = PARAM_REGISTRY[FITTABLE]["bounds"]
        self.assertFalse(gate_move_size(FITTABLE, low, high).passed)
        span = high - low
        self.assertTrue(gate_move_size(FITTABLE, low, low + 0.05 * span).passed)

    def test_thin_evidence_is_refused(self):
        self.assertFalse(gate_effective_sample(MIN_EFFECTIVE_SAMPLE - 1).passed)
        self.assertTrue(gate_effective_sample(MIN_EFFECTIVE_SAMPLE).passed)

    def test_effective_sample_scales_with_block_size(self):
        """Four parameters need four times the evidence, not the same."""
        ess = MIN_EFFECTIVE_SAMPLE * 2
        self.assertTrue(gate_effective_sample(ess, n_parameters=1).passed)
        self.assertFalse(gate_effective_sample(ess, n_parameters=4).passed)

    def test_oversized_blocks_are_refused(self):
        self.assertFalse(gate_block_size(MAX_BLOCK_PARAMETERS + 1).passed)
        self.assertFalse(gate_block_size(0).passed)
        self.assertTrue(gate_block_size(MAX_BLOCK_PARAMETERS).passed)


class TestEvaluate(unittest.TestCase):
    def _good(self, **overrides):
        low, high = PARAM_REGISTRY[FITTABLE]["bounds"]
        current = PARAM_REGISTRY[FITTABLE]["value"]
        rng = np.random.default_rng(3)
        params = dict(
            name=FITTABLE, current=current,
            proposed=min(high, current + 0.01 * (high - low)),
            differences=rng.normal(1.0, 0.4, 60),
            ess=MIN_EFFECTIVE_SAMPLE * 2, n_parameters=1,
        )
        params.update(overrides)
        return params

    def test_a_sound_proposal_passes(self):
        passed, results = evaluate(**self._good())
        self.assertTrue(passed, [r.reason for r in results if not r.passed])

    def test_every_gate_runs_even_after_one_fails(self):
        """
        A rejection listing one reason invites fixing that reason and
        re-submitting, which is optional stopping wearing a different hat.
        """
        passed, results = evaluate(**self._good(name="not.registered"))
        self.assertFalse(passed)
        self.assertEqual(len(results), 8)

    def test_noise_alone_cannot_promote_however_good_the_rest_looks(self):
        rng = np.random.default_rng(11)
        passed, results = evaluate(**self._good(differences=rng.normal(0.0, 1.0, 38)))
        self.assertFalse(passed)
        failed = {r.name for r in results if not r.passed}
        self.assertIn("out_of_sample", failed)

    def test_every_failure_carries_a_reason(self):
        _, results = evaluate(**self._good(name="not.registered", ess=1.0))
        for result in results:
            if not result.passed:
                self.assertTrue(result.reason.strip(), f"{result.name} gave no reason")


if __name__ == "__main__":
    unittest.main()
