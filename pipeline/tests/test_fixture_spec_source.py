"""The FPL layer must rank on the market-anchored rates, not the raw ensemble.

fixture_xg.json is validated by seven blocking checks and then discarded. It is
also the only artifact in the repo carrying rates beyond the next gameweek:
80 fixtures across GW1-8 against latest.json's single gameweek.
"""
import unittest

from pipeline.models.fpl_inputs import fixture_specs_from_fixture_xg


def _artifact():
    return {
        "schema_version": 1,
        "horizon": 8,
        "first_gameweek": 1,
        "fixtures": [
            {"match_id": "1", "gameweek": 1,
             "home_team": "Arsenal", "away_team": "Coventry City",
             "kickoff": "2026-08-21T19:00:00Z",
             "lambda_home": 2.471716, "mu_away": 0.661262,
             # The pre-anchor posterior, carried so a switch to the _dc keys
             # fails on a value mismatch rather than on a StopIteration from
             # the `next(...)` lookup below — which reads like a broken test
             # rather than a regression in the code under test.
             "lambda_home_dc": 1.819, "mu_away_dc": 0.995,
             "rate_source": "market_blend", "prior_only": True},
            {"match_id": "2", "gameweek": 1,
             "home_team": "Hull City", "away_team": "Man United",
             "kickoff": "2026-08-21T19:00:00Z",
             "lambda_home": 0.917505, "mu_away": 2.028719,
             "rate_source": "market_blend", "prior_only": True},
            {"match_id": "11", "gameweek": 2,
             "home_team": "Arsenal", "away_team": "Everton",
             "kickoff": "2026-08-28T19:00:00Z",
             "lambda_home": 2.1, "mu_away": 0.8,
             "rate_source": "dixon_coles_posterior", "prior_only": False},
        ],
    }


class FixtureSpecsFromFixtureXg(unittest.TestCase):
    def test_uses_the_anchored_rate_not_the_dixon_coles_one(self):
        specs = fixture_specs_from_fixture_xg(_artifact(), gameweeks=[1])
        arsenal = next(s for s in specs if s.home_team == "Arsenal")
        self.assertAlmostEqual(arsenal.lambda_home, 2.471716, places=6)
        self.assertAlmostEqual(arsenal.mu_away, 0.661262, places=6)

    def test_spans_multiple_gameweeks(self):
        """The horizon the Planner needs; latest.json is one gameweek wide."""
        specs = fixture_specs_from_fixture_xg(_artifact())
        self.assertEqual(sorted({s.gameweek for s in specs}), [1, 2])

    def test_filters_to_requested_gameweeks(self):
        specs = fixture_specs_from_fixture_xg(_artifact(), gameweeks=[2])
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].away_team, "Everton")

    def test_canonicalises_team_names(self):
        artifact = _artifact()
        artifact["fixtures"][0]["home_team"] = "Arsenal FC"
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        self.assertIn("Arsenal", [s.home_team for s in specs])
        self.assertNotIn("Arsenal FC", [s.home_team for s in specs])

    def test_skips_a_fixture_with_no_usable_rate(self):
        """A missing rate must drop the fixture loudly, never default to zero:
        a 0.0 goal rate silently makes every clean sheet a certainty."""
        artifact = _artifact()
        artifact["fixtures"][0]["lambda_home"] = None
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        self.assertEqual([s.home_team for s in specs], ["Hull City"])

    def test_returns_empty_for_an_empty_artifact(self):
        self.assertEqual(fixture_specs_from_fixture_xg({"fixtures": []}), [])

    def test_each_spec_carries_its_own_rate_source(self):
        """Provenance travels on the spec, so the artifact writer needs no
        parallel lookup keyed on team names."""
        specs = fixture_specs_from_fixture_xg(_artifact())
        by_gw = {s.gameweek: s.rate_source for s in specs}
        self.assertEqual(by_gw[1], "market_blend")
        self.assertEqual(by_gw[2], "dixon_coles_posterior")

    def test_labels_an_unsourced_row_rather_than_leaving_it_null(self):
        artifact = _artifact()
        del artifact["fixtures"][0]["rate_source"]
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        arsenal = next(s for s in specs if s.home_team == "Arsenal")
        self.assertEqual(arsenal.rate_source, "unknown")

    def test_returns_nothing_for_an_empty_gameweek_list(self):
        """gameweeks=[] must mean "simulate nothing", not "no filter"."""
        specs = fixture_specs_from_fixture_xg(_artifact(), gameweeks=[])
        self.assertEqual(specs, [])

    def test_a_malformed_row_does_not_discard_the_rest_of_the_batch(self):
        """One bad value must drop only its own fixture, per the docstring's
        promise, not raise and take the whole batch down with it."""
        artifact = {
            "fixtures": [
                {"match_id": "1", "gameweek": "GW1",
                 "home_team": "Arsenal", "away_team": "Coventry City",
                 "lambda_home": 2.471716, "mu_away": 0.661262,
                 "rate_source": "market_blend"},
                {"match_id": "2", "gameweek": 1,
                 "home_team": "Hull City", "away_team": "Man United",
                 "lambda_home": 0.917505, "mu_away": 2.028719,
                 "rate_source": "market_blend"},
            ],
        }
        specs = fixture_specs_from_fixture_xg(artifact)
        self.assertEqual([s.home_team for s in specs], ["Hull City"])
