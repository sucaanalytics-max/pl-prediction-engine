import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd

from pipeline.data.fpl_api import build_league_table, get_upcoming_fixtures
from pipeline.data.odds_api import OddsAPIClient
from pipeline.features.engineer import (
    add_h2h_features,
    engineer_training_and_upcoming_features,
)
from pipeline.risk.kelly import find_value_bets
from pipeline.validation.artifacts import validate_prediction_output
from pipeline.validation.ledger import update_forecast_ledger, evaluate_ledger


def _historical_matches():
    rows = [
        ("2026-01-01", "Alpha", "Beta", 2, 0, "H"),
        ("2026-01-08", "Beta", "Alpha", 1, 1, "D"),
    ]
    records = []
    for index, (date, home, away, hg, ag, result) in enumerate(rows):
        records.append({
            "Date": pd.Timestamp(date),
            "HomeTeam": home,
            "AwayTeam": away,
            "FTHG": hg,
            "FTAG": ag,
            "FTR": result,
            "HTHG": 0,
            "HTAG": 0,
            "HTR": "D",
            "Referee": None,
            "HS": 10,
            "AS": 8,
            "HF": 11,
            "AF": 12,
            "HC": 5,
            "AC": 4,
            "HY": 2,
            "AY": 2,
            "HR": 0,
            "AR": 0,
            "season": "2526",
            "match_id": f"history_{index}",
        })
    return pd.DataFrame(records)


class FeatureContractTests(unittest.TestCase):
    def test_h2h_rates_follow_fixture_team_orientation(self):
        matches = _historical_matches()
        result = add_h2h_features(matches)
        self.assertEqual(result.iloc[1]["h2h_home_win_rate"], 0.0)
        self.assertEqual(result.iloc[1]["h2h_away_win_rate"], 1.0)

    def test_upcoming_fixture_gets_its_own_feature_row(self):
        upcoming = pd.DataFrame([{
            "home_team": "Beta",
            "away_team": "Alpha",
            "kickoff": "2026-08-21T19:00:00Z",
            "gameweek": 1,
        }])
        training, fixture_features = engineer_training_and_upcoming_features(
            _historical_matches(), upcoming
        )

        self.assertEqual(len(training), 2)
        self.assertEqual(len(fixture_features), 1)
        row = fixture_features.iloc[0]
        self.assertEqual(row["HomeTeam"], "Beta")
        self.assertEqual(row["AwayTeam"], "Alpha")
        self.assertEqual(row["match_id"], "20260821_Beta_Alpha")
        self.assertIn("home_elo", fixture_features.columns)
        self.assertIn("home_ewm_goals_for_5", fixture_features.columns)


class OddsContractTests(unittest.TestCase):
    def setUp(self):
        self.predictions = {
            "probabilities": {
                "1x2": {"home": 0.6, "draw": 0.25, "away": 0.15},
                "over_under": {
                    "2.5": {"over": 0.8, "under": 0.2},
                    "3.5": {"over": 0.6, "under": 0.4},
                },
                "btts": {"yes": 0.6, "no": 0.4},
                "corners": {"10.5": {"over": 0.8, "under": 0.2}},
                "cards": {"3.5": {"over": 0.8, "under": 0.2}},
            }
        }

    def test_nested_market_probabilities_are_scanned(self):
        bets = find_value_bets(
            self.predictions,
            odds_benchmark={
                "totals": {
                    "2.5": {
                        "over": 2.0,
                        "under": 2.0,
                        "bookmaker_over": "testbook",
                    }
                }
            },
            corners_odds={
                "10.5": {
                    "over": 2.0,
                    "under": 2.0,
                    "bookmaker_over": "testbook",
                }
            },
            cards_odds={
                "3.5": {
                    "over": 2.0,
                    "under": 2.0,
                    "bookmaker_over": "testbook",
                }
            },
        )
        market_types = {bet["market_type"] for bet in bets}
        self.assertTrue({"over_under", "corners", "cards"} <= market_types)
        self.assertTrue(all("confidence_tier" in bet for bet in bets))

    def test_no_current_odds_means_no_value_bets(self):
        self.assertEqual(find_value_bets(self.predictions, {}), [])

    def test_stale_cache_is_not_used_without_api_access(self):
        with TemporaryDirectory() as directory:
            cache_path = Path(directory) / "stale.json"
            cache_path.write_text("[]")
            client = OddsAPIClient.__new__(OddsAPIClient)
            client.api_key = ""
            client.cache_dir = Path(directory)
            client._is_cache_valid = lambda _: False

            self.assertIsNone(client._get("/unused", {}, "stale"))

    def test_btts_bookmaker_metadata_is_not_treated_as_odds(self):
        bets = find_value_bets(
            self.predictions,
            odds_benchmark={
                "btts": {
                    "yes": 2.0,
                    "no": 2.0,
                    "bookmaker_yes": "testbook",
                    "bookmaker_no": "testbook",
                }
            },
        )
        btts_bets = [bet for bet in bets if bet["market_type"] == "btts"]
        self.assertEqual(len(btts_bets), 1)
        self.assertEqual(btts_bets[0]["market"], "BTTS Yes")
        self.assertEqual(btts_bets[0]["bookmaker"], "testbook")

    def test_bulk_endpoint_only_requests_featured_markets(self):
        client = OddsAPIClient.__new__(OddsAPIClient)
        client.sport = "soccer_epl"
        captured = {}

        def fake_get(endpoint, params, cache_key):
            captured.update({
                "endpoint": endpoint,
                "params": params,
                "cache_key": cache_key,
            })
            return []

        client._get = fake_get
        client.fetch_match_odds()
        self.assertEqual(captured["endpoint"], "/sports/soccer_epl/odds")
        self.assertEqual(captured["params"]["markets"], "h2h,totals")
        self.assertNotIn("btts", captured["params"]["markets"])

    def test_additional_markets_use_per_event_endpoint(self):
        client = OddsAPIClient.__new__(OddsAPIClient)
        client.sport = "soccer_epl"
        captured = {}

        def fake_get(endpoint, params, cache_key):
            captured.update({"endpoint": endpoint, "params": params})
            return {}

        client._get = fake_get
        client.fetch_event_additional_odds("event-123")
        self.assertEqual(
            captured["endpoint"],
            "/sports/soccer_epl/events/event-123/odds",
        )
        self.assertIn("alternate_totals_corners", captured["params"]["markets"])


class FPLTableTests(unittest.TestCase):
    def test_started_fixture_is_not_treated_as_upcoming(self):
        now = pd.Timestamp.now(tz="UTC")
        bootstrap = {
            "events": [{"id": 1, "is_current": True, "finished": False}],
            "teams": [
                {"id": 1, "name": "Arsenal", "short_name": "ARS"},
                {"id": 2, "name": "Chelsea", "short_name": "CHE"},
            ],
        }
        fixtures = [
            {
                "event": 1,
                "team_h": 1,
                "team_a": 2,
                "finished": False,
                "kickoff_time": (now - pd.Timedelta(minutes=30)).isoformat(),
            },
            {
                "event": 1,
                "team_h": 2,
                "team_a": 1,
                "finished": False,
                "kickoff_time": (now + pd.Timedelta(hours=1)).isoformat(),
            },
        ]

        upcoming = get_upcoming_fixtures(bootstrap, fixtures)
        self.assertEqual(len(upcoming), 1)
        self.assertEqual(upcoming.iloc[0]["home_team"], "Chelsea")

    def test_table_is_derived_from_finished_fixtures(self):
        bootstrap = {
            "teams": [
                {"id": 1, "name": "Arsenal"},
                {"id": 2, "name": "Chelsea"},
            ]
        }
        fixtures = [{
            "team_h": 1,
            "team_a": 2,
            "team_h_score": 2,
            "team_a_score": 1,
            "finished": True,
            "kickoff_time": "2026-08-01T12:00:00Z",
        }]
        table = build_league_table(bootstrap, fixtures)
        self.assertEqual(table[0]["team"], "Arsenal")
        self.assertEqual(table[0]["points"], 3)
        self.assertEqual(table[0]["gd"], 1)
        self.assertEqual(table[0]["position"], 1)
        self.assertEqual(table[1]["form"], ["L"])


class ArtifactContractTests(unittest.TestCase):
    def _output(self):
        return {
            "metadata": {
                "season": "2026-27",
                "n_simulations": 2,
                "odds_source": "unavailable",
            },
            "predictions": [{
                "match_id": "20260801_Alpha_Beta",
                "n_simulations": 2,
                "probabilities": {
                    "1x2": {"home": 0.5, "draw": 0.3, "away": 0.2},
                    "btts": {"yes": 0.55, "no": 0.45},
                    "over_under": {"2.5": {"over": 0.6, "under": 0.4}},
                    "corners": {"10.5": {"over": 0.5, "under": 0.5}},
                    "cards": {"3.5": {"over": 0.5, "under": 0.5}},
                    "asian_handicap": {
                        "home_-2.5": 0.1,
                        "home_-0.5": 0.5,
                        "home_2.5": 0.9,
                    },
                },
                "player_bookings": {
                    "top_bookings": [{"is_card_magnet": False}]
                },
                "value_bets": [],
            }],
        }

    def test_valid_output_passes(self):
        self.assertEqual(validate_prediction_output(self._output()), [])

    def test_mixed_simulation_counts_are_rejected(self):
        output = self._output()
        output["predictions"][0]["n_simulations"] = 1
        errors = validate_prediction_output(output)
        self.assertTrue(any("n_simulations" in error for error in errors))

    def test_bets_without_live_odds_are_rejected(self):
        output = self._output()
        output["predictions"][0]["value_bets"] = [{"market": "Home Win"}]
        errors = validate_prediction_output(output)
        self.assertTrue(any("current odds" in error for error in errors))


class ForwardValidationTests(unittest.TestCase):
    def test_ledger_scores_completed_fpl_fixture(self):
        output = {
            "metadata": {
                "season": "2026-27",
                "generated_at": "2026-07-31T10:00:00Z",
            },
            "predictions": [{
                "match_id": "20260801_Arsenal_Chelsea",
                "fixture": {
                    "home_team": "Arsenal",
                    "away_team": "Chelsea",
                    "date": "2026-08-01T12:00:00Z",
                },
                "probabilities": {
                    "1x2": {"home": 0.6, "draw": 0.25, "away": 0.15},
                    "over_under": {"2.5": {"over": 0.55, "under": 0.45}},
                    "btts": {"yes": 0.5, "no": 0.5},
                },
                "expected_goals": {"home": 1.6, "away": 1.0},
                "odds_comparison": None,
            }],
        }
        bootstrap = {
            "teams": [
                {"id": 1, "name": "Arsenal"},
                {"id": 2, "name": "Chelsea"},
            ]
        }
        fixtures = [{
            "team_h": 1,
            "team_a": 2,
            "team_h_score": 2,
            "team_a_score": 1,
            "finished": True,
            "kickoff_time": "2026-08-01T12:00:00Z",
        }]

        with TemporaryDirectory() as directory:
            ledger = update_forecast_ledger(
                output, Path(directory) / "forecast_ledger.json"
            )
            metrics, calibration = evaluate_ledger(
                ledger, bootstrap, fixtures
            )

        self.assertEqual(metrics["n_evaluated_matches"], 1)
        self.assertIn("brier_1x2_home", metrics)
        self.assertEqual(calibration["bins"][0]["count"], 1)


class SimulationContractTests(unittest.TestCase):
    def test_half_time_goals_never_exceed_full_time(self):
        from pipeline.simulation.montecarlo import MonteCarloSimulator

        np.random.seed(7)
        sims = MonteCarloSimulator(500).simulate_match(1.5, 1.1)
        self.assertTrue(np.all(sims["ht_home"] <= sims["home_goals"]))
        self.assertTrue(np.all(sims["ht_away"] <= sims["away_goals"]))

    def test_home_handicap_sign_is_applied_to_home_score(self):
        from pipeline.simulation.montecarlo import MonteCarloSimulator

        sims = {
            "home_goals": np.array([3, 0]),
            "away_goals": np.array([0, 1]),
            "total_goals": np.array([3, 1]),
            "ht_home": np.array([1, 0]),
            "ht_away": np.array([0, 0]),
            "total_corners": np.array([10, 10]),
            "total_cards": np.array([3, 3]),
        }
        handicap = MonteCarloSimulator(2).derive_all_markets(sims)[
            "probabilities"
        ]["asian_handicap"]
        self.assertEqual(handicap["home_-2.5"], 0.5)
        self.assertEqual(handicap["home_2.5"], 1.0)


if __name__ == "__main__":
    unittest.main()
