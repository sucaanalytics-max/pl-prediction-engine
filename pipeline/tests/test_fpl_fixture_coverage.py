"""Two ways the daily FPL lane can publish a projection that looks complete.

**Partial coverage.** `export_fixture_xg` drops individual fixtures — an
unmapped team id, or a posterior query that raised inside its
`except Exception: continue`. At 9 of 10 fixtures `if not fpl_specs` is False,
no fallback fires, and every player in the missing fixture is marked
`blank: True` with xp ~ 0: an entire club at zero for captaincy and transfers,
visible only in `diagnostics`.

**Staleness.** `export_fixture_xg`'s call site only warns on failure, so the
previous run's `fixture_xg.json` survives. It still covers the current
gameweek, so no coverage check can see it, and it still publishes
`rate_source: "market_blend"` off odds that may be days old — indistinguishable
from fresh. The SEAL path's reader (`fixture_rates.load_exported_rates`) has
had a staleness gate all along; this lane had none.

Neither can be exercised through a real pipeline run here (pymc/xgboost/
sklearn are absent), so these test the helpers the FPL block calls plus the
structure of the call site itself.
"""
import ast
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.run_pipeline import (
    FIXTURE_XG_MAX_AGE_HOURS,
    _expected_gameweek_fixtures,
    _fixture_xg_staleness,
    _uncovered_fixtures,
)
from pipeline.simulation.gameweek_sim import FixtureSpec

REPO = Path(__file__).resolve().parents[2]


def _stamp(hours_ago):
    moment = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return moment.isoformat().replace("+00:00", "Z")


BOOTSTRAP = {
    "teams": [
        {"id": 1, "name": "Arsenal"},
        {"id": 2, "name": "Chelsea"},
        {"id": 3, "name": "Everton"},
        {"id": 4, "name": "Liverpool"},
    ]
}

FIXTURES_RAW = [
    {"id": 11, "event": 1, "finished": False, "team_h": 1, "team_a": 2},
    {"id": 12, "event": 1, "finished": False, "team_h": 3, "team_a": 4},
    # Already played — not part of what still needs projecting.
    {"id": 13, "event": 1, "finished": True, "team_h": 2, "team_a": 3},
    # A different gameweek.
    {"id": 21, "event": 2, "finished": False, "team_h": 4, "team_a": 1},
]


def _spec(home, away, gameweek=1):
    return FixtureSpec(
        match_id=f"{home}_{away}", gameweek=gameweek, home_team=home,
        away_team=away, lambda_home=1.5, mu_away=1.1,
        rate_source="market_blend",
    )


class ExpectedFixtures(unittest.TestCase):
    def test_counts_only_unfinished_fixtures_in_this_gameweek(self):
        expected = _expected_gameweek_fixtures(FIXTURES_RAW, BOOTSTRAP, 1)
        self.assertEqual(
            sorted(expected.values()), ["Arsenal v Chelsea", "Everton v Liverpool"]
        )

    def test_a_genuine_blank_gameweek_expects_nothing(self):
        """Compared against the real fixture list, never a hardcoded 10."""
        self.assertEqual(_expected_gameweek_fixtures(FIXTURES_RAW, BOOTSTRAP, 9), {})

    def test_a_malformed_bootstrap_degrades_instead_of_raising(self):
        self.assertEqual(_expected_gameweek_fixtures(FIXTURES_RAW, None, 1), {})
        self.assertEqual(_expected_gameweek_fixtures(None, BOOTSTRAP, 1), {})


class UncoveredFixtures(unittest.TestCase):
    def test_full_coverage_reports_nothing_missing(self):
        specs = [_spec("Arsenal", "Chelsea"), _spec("Everton", "Liverpool")]
        expected = _expected_gameweek_fixtures(FIXTURES_RAW, BOOTSTRAP, 1)
        self.assertEqual(_uncovered_fixtures(expected, specs), [])

    def test_a_dropped_fixture_is_named_not_merely_counted(self):
        """"9 of 10" says something is wrong; the name says which club's
        players are sitting at xp 0 in today's recommendations."""
        specs = [_spec("Arsenal", "Chelsea")]
        expected = _expected_gameweek_fixtures(FIXTURES_RAW, BOOTSTRAP, 1)
        self.assertEqual(
            _uncovered_fixtures(expected, specs), ["Everton v Liverpool"]
        )

    def test_no_expectation_means_no_shortfall(self):
        self.assertEqual(_uncovered_fixtures({}, []), [])

    def test_specs_from_the_ensemble_path_still_match_on_club_pair(self):
        """The two spec builders use different id schemes — fixture_xg.json
        carries the FPL fixture id, fixture_specs_from_predictions carries
        "YYYYMMDD_Home_Away". Keying coverage on match_id would report a total
        shortfall on the fallback path every single day."""
        from pipeline.models.fpl_inputs import fixture_specs_from_predictions

        specs = fixture_specs_from_predictions([
            {"match_id": "20260821_Arsenal_Chelsea",
             "fixture": {"home_team": "Arsenal", "away_team": "Chelsea",
                         "gameweek": 1, "date": "2026-08-21T19:00:00Z"},
             "expected_goals": {"home": 1.8, "away": 1.2}},
            {"match_id": "20260821_Everton_Liverpool",
             "fixture": {"home_team": "Everton", "away_team": "Liverpool",
                         "gameweek": 1, "date": "2026-08-21T19:00:00Z"},
             "expected_goals": {"home": 1.1, "away": 1.6}},
        ], gameweek=1)
        expected = _expected_gameweek_fixtures(FIXTURES_RAW, BOOTSTRAP, 1)
        self.assertEqual(_uncovered_fixtures(expected, specs), [])


class FixtureXgFreshness(unittest.TestCase):
    def test_a_file_written_this_morning_is_fresh(self):
        self.assertIsNone(_fixture_xg_staleness({"generated_at": _stamp(3)}))

    def test_a_file_from_the_previous_run_is_still_fresh(self):
        """The limit sits just over a day so a run starting slightly later
        than the previous one does not reject its immediate predecessor."""
        self.assertIsNone(_fixture_xg_staleness({"generated_at": _stamp(25)}))

    def test_a_file_older_than_the_limit_is_stale(self):
        reason = _fixture_xg_staleness(
            {"generated_at": _stamp(FIXTURE_XG_MAX_AGE_HOURS + 2)})
        self.assertIsNotNone(reason)
        self.assertIn("freshness limit", reason)

    def test_an_unparseable_timestamp_degrades_to_stale_not_to_fresh(self):
        """Trusting an undatable file costs the ability to ever detect the
        failure; falling back costs the market anchor for one day."""
        self.assertIsNotNone(_fixture_xg_staleness({"generated_at": "yesterday"}))

    def test_an_absent_timestamp_is_stale(self):
        self.assertIsNotNone(_fixture_xg_staleness({"fixtures": []}))

    def test_a_non_object_payload_is_stale_and_does_not_raise(self):
        for payload in (None, [], "text", 7):
            with self.subTest(payload=payload):
                self.assertIsNotNone(_fixture_xg_staleness(payload))

    def test_a_naive_timestamp_is_read_as_utc_rather_than_raising(self):
        naive = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(
            tzinfo=None).isoformat()
        self.assertIsNone(_fixture_xg_staleness({"generated_at": naive}))


class TheCallSiteUsesBothGates(unittest.TestCase):
    """The FPL block sits inside a try/except that swallows ImportError for
    the heavy dependencies, so it cannot be executed here — only inspected.
    Without this, both helpers above could be perfectly correct and never
    called."""

    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(
            (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8"))

    def _called_names(self):
        return {
            node.func.id for node in ast.walk(self.tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }

    def test_the_freshness_gate_is_called(self):
        self.assertIn("_fixture_xg_staleness", self._called_names())

    def test_the_coverage_check_is_called(self):
        names = self._called_names()
        self.assertIn("_expected_gameweek_fixtures", names)
        self.assertIn("_uncovered_fixtures", names)

    def test_a_shortfall_reaches_the_published_status(self):
        """A shortfall that only ever reached `diagnostics` is the defect."""
        source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        self.assertIn('"fixtures_missing": fpl_missing', source)
        self.assertIn("fpl_rules.degraded or fpl_missing", source)


if __name__ == "__main__":
    unittest.main()
