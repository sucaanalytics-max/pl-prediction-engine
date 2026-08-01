"""
Tests for per-fixture goal rates.

These exist because a flat rate makes every opponent identical, which is
obviously wrong for the horizon even though — see the commit that added this —
it was NOT the cause of the clean-sheet discrepancy it was first blamed for.
"""
import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipeline.learning.backfill import load_archive_season
from pipeline.models.fixture_rates import (
    FixtureRates,
    TeamStrengths,
    export_fixture_xg,
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


class _FakeDC:
    """
    Stands in for the fitted PyMC model.

    Rates depend on the pair, so a test can tell "queried the posterior per
    fixture" apart from "returned a constant" — which is the entire point of
    the export and exactly the bug it replaces.
    """

    def __init__(self, known=("Arsenal", "Chelsea", "Everton")):
        self.trace = object()
        self.team_index = {name: i for i, name in enumerate(known)}

    def get_lambda_mu_samples(self, home, away, n_samples=10000):
        import numpy as np

        h = self.team_index.get(home, 0) + 1
        a = self.team_index.get(away, 0) + 1
        return np.full(8, 1.0 + 0.1 * h), np.full(8, 0.8 + 0.1 * a)


def _bootstrap_for_export():
    return {
        "events": [
            {"id": 1, "finished": True},
            {"id": 2, "finished": False},
            {"id": 3, "finished": False},
            {"id": 4, "finished": False},
        ],
        "teams": [
            {"id": 1, "name": "Arsenal"},
            {"id": 2, "name": "Chelsea"},
            {"id": 3, "name": "Everton"},
        ],
    }


def _fixtures_for_export():
    return [
        {"id": 10, "event": 1, "team_h": 1, "team_a": 2, "finished": True},
        {"id": 11, "event": 2, "team_h": 1, "team_a": 2, "finished": False},
        {"id": 12, "event": 3, "team_h": 2, "team_a": 3, "finished": False},
        {"id": 13, "event": 9, "team_h": 3, "team_a": 1, "finished": False},
    ]


class TestExportFixtureXg(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    # Sentinel, so a test can pass dc=None explicitly and still reach the code
    # path for "no model at all" rather than silently getting the default.
    _DEFAULT = object()

    def _export(self, horizon=2, dc=_DEFAULT, bootstrap=None):
        return export_fixture_xg(
            _FakeDC() if dc is self._DEFAULT else dc,
            bootstrap if bootstrap is not None else _bootstrap_for_export(),
            _fixtures_for_export(),
            self.dir,
            horizon=horizon,
        )

    def test_exports_only_unfinished_fixtures_inside_the_horizon(self):
        path = self._export(horizon=2)
        payload = json.loads(path.read_text())
        self.assertEqual({f["match_id"] for f in payload["fixtures"]}, {"11", "12"})
        self.assertEqual(payload["first_gameweek"], 2)

    def test_finished_fixtures_are_excluded(self):
        payload = json.loads(self._export(horizon=6).read_text())
        self.assertNotIn("10", {f["match_id"] for f in payload["fixtures"]})

    def test_rates_differ_per_fixture(self):
        """
        The bug being replaced was one constant for every fixture, so a constant
        export would be a silent no-op that still looked like a fix.
        """
        payload = json.loads(self._export(horizon=6).read_text())
        pairs = {(f["lambda_home"], f["mu_away"]) for f in payload["fixtures"]}
        self.assertGreater(len(pairs), 1, "every fixture got identical rates")

    def test_round_trips_through_the_loader(self):
        """Producer and consumer must agree on the format; they live together."""
        path = self._export(horizon=6)
        loaded = load_exported_rates(path)
        payload = json.loads(path.read_text())
        self.assertEqual(set(loaded), {f["match_id"] for f in payload["fixtures"]})
        for match_id, rates in loaded.items():
            self.assertEqual(rates.source, "dixon_coles_posterior")
            self.assertGreater(rates.lambda_home, 0)

    def test_resolve_prefers_the_export_over_the_fallback(self):
        loaded = load_exported_rates(self._export(horizon=6))
        resolved = resolve_rates("11", "Arsenal", "Chelsea", loaded, TeamStrengths())
        self.assertEqual(resolved.source, "dixon_coles_posterior")

    def test_prior_only_clubs_are_flagged(self):
        """
        A promoted club has no posterior strength. Its fixtures must be
        identifiable downstream rather than passing as evidence-backed.
        """
        dc = _FakeDC(known=("Arsenal",))
        payload = json.loads(self._export(horizon=6, dc=dc).read_text())
        self.assertTrue(any(f["prior_only"] for f in payload["fixtures"]))
        self.assertIn("Chelsea", payload["prior_only_clubs"])

    def test_unfitted_model_returns_none_rather_than_raising(self):
        """
        A missing export must degrade the FPL layer, not fail the daily run that
        produces the match predictions and the staking artifacts.
        """
        class Unfitted:
            trace = None

        self.assertIsNone(self._export(dc=Unfitted()))
        self.assertIsNone(self._export(dc=None))
        self.assertFalse((self.dir / "fixture_xg.json").exists())

    def test_no_unfinished_gameweeks_returns_none(self):
        bootstrap = _bootstrap_for_export()
        for event in bootstrap["events"]:
            event["finished"] = True
        self.assertIsNone(self._export(bootstrap=bootstrap))

    def test_export_writes_only_its_own_file(self):
        """
        The plan requires latest.json to be bit-identical across this change.
        The export is additive; this asserts it writes nothing else.
        """
        (self.dir / "latest.json").write_text('{"untouched": true}')
        before = (self.dir / "latest.json").read_bytes()
        self._export(horizon=6)
        self.assertEqual((self.dir / "latest.json").read_bytes(), before)
        self.assertEqual(
            sorted(p.name for p in self.dir.iterdir()),
            ["fixture_xg.json", "latest.json"],
        )
