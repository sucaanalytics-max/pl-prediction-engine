"""
Tests for per-fixture goal rates.

These exist because a flat rate makes every opponent identical, which is
obviously wrong for the horizon even though — see the commit that added this —
it was NOT the cause of the clean-sheet discrepancy it was first blamed for.
"""
import unittest

import pandas as pd

from pipeline.learning.backfill import load_archive_season
from pipeline.models.fixture_rates import (
    FixtureRates,
    TeamStrengths,
    load_exported_rates,
    resolve_rates,
)


class TeamStrengthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strengths = TeamStrengths().fit(load_archive_season("2526"))

    def test_strengths_are_centred_on_one(self):
        values = list(self.strengths.attack.values())
        self.assertAlmostEqual(sum(values) / len(values), 1.0, delta=0.15)

    def test_home_advantage_is_derived_not_assumed(self):
        self.assertGreater(self.strengths.home_share, 0.5)
        self.assertLess(self.strengths.home_share, 0.65)

    def test_a_strong_attack_outrates_a_weak_one_against_the_same_opponent(self):
        teams = sorted(self.strengths.attack, key=self.strengths.attack.get)
        weakest, strongest = teams[0], teams[-1]
        opponent = teams[len(teams) // 2]
        self.assertGreater(
            self.strengths.rates(strongest, opponent).lambda_home,
            self.strengths.rates(weakest, opponent).lambda_home,
        )

    def test_rates_stay_inside_a_plausible_band(self):
        for home in list(self.strengths.attack)[:6]:
            for away in list(self.strengths.attack)[:6]:
                if home == away:
                    continue
                rates = self.strengths.rates(home, away)
                self.assertGreater(rates.lambda_home, 0.2)
                self.assertLess(rates.lambda_home, 4.0)

    def test_an_unknown_club_falls_back_to_average_rather_than_zero(self):
        rates = self.strengths.rates("Nowhere United", "Also Nowhere")
        self.assertGreater(rates.lambda_home, 0.5)

    def test_fitting_without_the_required_columns_raises(self):
        with self.assertRaises(ValueError):
            TeamStrengths().fit(pd.DataFrame({"fixture": [1]}))


class ResolutionTests(unittest.TestCase):
    def test_exported_posterior_beats_the_fallback(self):
        exported = {
            "m1": FixtureRates("A", "B", 2.5, 0.8, "dixon_coles_posterior")
        }
        resolved = resolve_rates("m1", "A", "B", exported, TeamStrengths())
        self.assertEqual(resolved.source, "dixon_coles_posterior")
        self.assertEqual(resolved.lambda_home, 2.5)

    def test_provenance_is_carried_so_sources_cannot_be_mixed_silently(self):
        """A horizon mixing posterior and fallback rates could not be calibrated."""
        resolved = resolve_rates("missing", "A", "B", {}, None)
        self.assertEqual(resolved.source, "flat_default")

    def test_a_missing_export_is_not_an_error(self):
        from pathlib import Path

        self.assertEqual(load_exported_rates(Path("/nonexistent/x.json")), {})


if __name__ == "__main__":
    unittest.main()
