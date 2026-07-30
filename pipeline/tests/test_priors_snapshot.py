"""
Contract tests for the perishable prior-season capture (Increment 0).

The snapshot is irreplaceable: the FPL API zeroes prior-season per-player
aggregates at rollover. These tests guard both the capture logic and the
committed artifact itself, so deleting the artifact fails CI rather than
silently degrading every model fitted afterwards.
"""
import gzip
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.data.priors.snapshot import (
    SeasonAlreadyStartedError,
    build_player_priors,
    load_player_priors,
    prior_season_label,
    season_has_started,
    snapshot_priors,
)


def _bootstrap(started: bool = False, **element_overrides) -> dict:
    """A minimal but structurally faithful bootstrap payload."""
    element = {
        "id": 7,
        "code": 123456,
        "first_name": "Kai",
        "second_name": "Havertz",
        "web_name": "Havertz",
        "team": 1,
        "element_type": 3,
        "now_cost": 78,
        "status": "a",
        "chance_of_playing_next_round": None,
        "news": "",
        # Prior-season counting stats, some delivered as strings by the API.
        "minutes": "2410",
        "starts": 27,
        "total_points": 142,
        "goals_scored": 11,
        "assists": 6,
        "clean_sheets": 8,
        "goals_conceded": 30,
        "own_goals": 0,
        "penalties_saved": 0,
        "penalties_missed": 1,
        "yellow_cards": 4,
        "red_cards": 0,
        "saves": 0,
        "bonus": 17,
        "bps": 480,
        "clearances_blocks_interceptions": 41,
        "recoveries": 88,
        "tackles": 22,
        "defensive_contribution": 151,
        # Rates, delivered as strings.
        "influence": "780.4",
        "creativity": "410.2",
        "threat": "1102.0",
        "ict_index": "229.6",
        "expected_goals": "10.42",
        "expected_assists": "4.81",
        "expected_goal_involvements": "15.23",
        "expected_goals_conceded": "31.10",
        "starts_per_90": "1.01",
        "saves_per_90": "0.00",
        "expected_goals_per_90": "0.39",
        "expected_assists_per_90": "0.18",
        "expected_goal_involvements_per_90": "0.57",
        "expected_goals_conceded_per_90": "1.16",
        "goals_conceded_per_90": "1.12",
        "clean_sheets_per_90": "0.30",
        "defensive_contribution_per_90": "5.64",
        "penalties_order": 2,
        "direct_freekicks_order": None,
        "corners_and_indirect_freekicks_order": None,
        "selected_by_percent": "12.4",
        "ep_next": "4.6",
        "form": "3.2",
        "points_per_game": "3.9",
        "value_season": "18.2",
    }
    element.update(element_overrides)
    return {
        # "Spurs" exercises canonicalisation; FPL's own label is not canonical.
        "teams": [{"id": 1, "name": "Spurs", "short_name": "TOT"}],
        "element_types": [
            {"id": 1, "singular_name_short": "GKP"},
            {"id": 2, "singular_name_short": "DEF"},
            {"id": 3, "singular_name_short": "MID"},
            {"id": 4, "singular_name_short": "FWD"},
        ],
        "elements": [element],
        "events": [
            {
                "id": 1,
                "deadline_time": "2026-08-21T17:30:00Z",
                "finished": started,
                "is_current": started,
                "data_checked": started,
            },
            {
                "id": 2,
                "deadline_time": "2026-08-28T17:30:00Z",
                "finished": False,
                "is_current": False,
                "data_checked": False,
            },
        ],
    }


class PriorSeasonLabelTests(unittest.TestCase):
    def test_label_is_derived_arithmetically(self):
        """A new season must not require a config edit."""
        self.assertEqual(prior_season_label("2627"), "2526")
        self.assertEqual(prior_season_label("2526"), "2425")
        self.assertEqual(prior_season_label("2324"), "2223")


class SeasonStartDetectionTests(unittest.TestCase):
    def test_preseason_bootstrap_has_not_started(self):
        self.assertFalse(season_has_started(_bootstrap(started=False)))

    def test_any_settled_event_counts_as_started(self):
        """Checked across all events, not just events[0]."""
        bootstrap = _bootstrap(started=False)
        bootstrap["events"][1]["finished"] = True
        self.assertTrue(season_has_started(bootstrap))

    def test_data_checked_alone_counts_as_started(self):
        bootstrap = _bootstrap(started=False)
        bootstrap["events"][0]["data_checked"] = True
        self.assertTrue(season_has_started(bootstrap))


class BuildPlayerPriorsTests(unittest.TestCase):
    def test_refuses_to_build_from_a_started_season(self):
        """Aggregates are current-season once the season starts."""
        with self.assertRaises(SeasonAlreadyStartedError):
            build_player_priors(_bootstrap(started=True))

    def test_team_name_is_canonicalised(self):
        priors = build_player_priors(_bootstrap())
        player = priors["players"][0]
        self.assertEqual(player["team_raw"], "Spurs")
        self.assertEqual(player["team"], "Tottenham")

    def test_string_numerics_are_coerced(self):
        priors = build_player_priors(_bootstrap())
        player = priors["players"][0]
        self.assertEqual(player["minutes"], 2410)
        self.assertIsInstance(player["minutes"], int)
        self.assertAlmostEqual(player["expected_goals"], 10.42)
        self.assertIsInstance(player["expected_goals"], float)

    def test_absent_set_piece_duty_stays_none_not_zero(self):
        """Order 1 and "no duty" must remain distinguishable."""
        priors = build_player_priors(_bootstrap())
        player = priors["players"][0]
        self.assertEqual(player["penalties_order"], 2)
        self.assertIsNone(player["direct_freekicks_order"])

    def test_permanent_code_and_season_scoped_id_both_captured(self):
        """`element_id` is season-scoped and must never be a cross-season key."""
        player = build_player_priors(_bootstrap())["players"][0]
        self.assertEqual(player["code"], 123456)
        self.assertEqual(player["element_id"], 7)

    def test_metadata_records_deadline_and_counts(self):
        meta = build_player_priors(_bootstrap())["metadata"]
        self.assertEqual(meta["season"], "2627")
        self.assertEqual(meta["prior_season"], "2526")
        self.assertEqual(meta["gw1_deadline"], "2026-08-21T17:30:00Z")
        self.assertEqual(meta["n_players"], 1)
        self.assertEqual(meta["n_with_prior_minutes"], 1)

    def test_zero_minute_players_are_kept_not_filtered(self):
        """Models shrink toward priors; they do not exclude."""
        priors = build_player_priors(_bootstrap(minutes=0, total_points=0))
        self.assertEqual(priors["metadata"]["n_players"], 1)
        self.assertEqual(priors["metadata"]["n_with_prior_minutes"], 0)

    def test_empty_elements_raises(self):
        bootstrap = _bootstrap()
        bootstrap["elements"] = []
        with self.assertRaises(ValueError):
            build_player_priors(bootstrap)


class SnapshotPriorsTests(unittest.TestCase):
    def test_writes_both_artifacts_in_preseason(self):
        with TemporaryDirectory() as tmp:
            snapshot_priors(bootstrap=_bootstrap(), priors_dir=Path(tmp))
            priors_path = Path(tmp) / "fpl_player_priors_2526.json"
            bootstrap_path = Path(tmp) / "bootstrap_preseason_2627.json.gz"
            self.assertTrue(priors_path.exists())
            self.assertTrue(bootstrap_path.exists())
            # The verbatim copy must be a faithful, re-readable bootstrap.
            restored = json.loads(gzip.decompress(bootstrap_path.read_bytes()))
            self.assertEqual(restored["elements"][0]["code"], 123456)

    def test_preseason_reinvocation_refreshes_price(self):
        """Pre-season prices move; the capture must track them to the deadline."""
        with TemporaryDirectory() as tmp:
            snapshot_priors(bootstrap=_bootstrap(now_cost=78), priors_dir=Path(tmp))
            result = snapshot_priors(
                bootstrap=_bootstrap(now_cost=81), priors_dir=Path(tmp)
            )
            self.assertEqual(result["players"][0]["now_cost"], 81)

    def test_raises_when_season_started_and_nothing_was_captured(self):
        """The irrecoverable case must never pass silently."""
        with TemporaryDirectory() as tmp:
            with self.assertRaises(SeasonAlreadyStartedError):
                snapshot_priors(
                    bootstrap=_bootstrap(started=True), priors_dir=Path(tmp)
                )

    def test_is_a_noop_when_season_started_but_snapshot_exists(self):
        """Safe to leave on a daily schedule across the season boundary."""
        with TemporaryDirectory() as tmp:
            snapshot_priors(bootstrap=_bootstrap(now_cost=78), priors_dir=Path(tmp))
            result = snapshot_priors(
                bootstrap=_bootstrap(started=True, now_cost=999),
                priors_dir=Path(tmp),
            )
            # Pre-season value retained; the started-season payload is ignored.
            self.assertEqual(result["players"][0]["now_cost"], 78)


class CommittedSnapshotTests(unittest.TestCase):
    """Guards the irreplaceable committed artifact."""

    def test_committed_snapshot_exists_and_is_populated(self):
        priors = load_player_priors()
        meta = priors["metadata"]
        self.assertEqual(meta["prior_season"], prior_season_label())
        # 20 Premier League squads; a truncated capture must fail loudly.
        self.assertGreater(meta["n_players"], 400)
        self.assertGreater(meta["n_with_prior_minutes"], 300)

    def test_committed_snapshot_covers_twenty_canonical_teams(self):
        priors = load_player_priors()
        teams = {player["team"] for player in priors["players"]}
        self.assertEqual(len(teams), 20)

    def test_defensive_contribution_is_present_for_the_prior_season(self):
        """DefCon rates are the newest and least recoverable component."""
        priors = load_player_priors()
        with_defcon = [
            p for p in priors["players"] if p["defensive_contribution"] > 0
        ]
        self.assertGreater(len(with_defcon), 200)

    def test_penalty_duty_is_captured_for_some_players(self):
        priors = load_player_priors()
        takers = [p for p in priors["players"] if p["penalties_order"] == 1]
        self.assertGreaterEqual(len(takers), 10)


if __name__ == "__main__":
    unittest.main()
