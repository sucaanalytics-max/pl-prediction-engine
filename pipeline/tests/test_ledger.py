"""
Tests for the sealed ledger, settlement and scoring.

These protect the only thing that makes an accuracy claim falsifiable. Most of
them assert that something is REFUSED: sealing twice, sealing late, scoring from
provisional data, scoring a late seal, re-projecting from the network. Each of
those would produce a number that looks fine and means nothing, and a number that
looks fine will be quoted.
"""
import gzip
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning.ledger import (
    AlreadySealedError,
    IN_PROGRESS_MARKER,
    LedgerError,
    TooLateToSealError,
    freeze_inputs,
    gameweek_dir,
    load_frozen_bootstrap,
    read_forecast,
    resolve_universe,
    seal_forecast,
)
from pipeline.learning.outcomes import (
    SettlementError,
    parse_event_live,
    read_outcomes,
    settle_gameweek,
)
from pipeline.learning.scoring import UnscoreableError, score_gameweek

DEADLINE = "2026-09-12T10:30:00Z"
BEFORE = datetime(2026, 9, 12, 6, 30, tzinfo=timezone.utc)
AFTER = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)


def _bootstrap():
    return {
        "elements": [
            {"id": 1, "status": "a", "chance_of_playing_next_round": None,
             "selected_by_percent": "40.0"},
            {"id": 2, "status": "a", "chance_of_playing_next_round": 75,
             "selected_by_percent": "5.0"},
            {"id": 3, "status": "i", "chance_of_playing_next_round": 0,
             "selected_by_percent": "12.0"},   # in via ownership
            {"id": 4, "status": "u", "chance_of_playing_next_round": None,
             "selected_by_percent": "0.1"},    # out
        ]
    }


def _projections():
    return [
        {"element_id": 1, "xp": 5.2, "p_appears": 0.97, "p_60": 0.92,
         "p_goal": 0.30, "p_multi_goal": 0.05, "p_clean_sheet": 0.30,
         "p_ge_2": 0.90, "p_ge_5": 0.42, "p_ge_10": 0.12, "p_ge_15": 0.03},
        {"element_id": 2, "xp": 2.1, "p_appears": 0.55, "p_60": 0.35,
         "p_goal": 0.05, "p_multi_goal": 0.00, "p_clean_sheet": 0.12,
         "p_ge_2": 0.45, "p_ge_5": 0.08, "p_ge_10": 0.01, "p_ge_15": 0.00},
        {"element_id": 3, "xp": 0.4, "p_appears": 0.10, "p_60": 0.05,
         "p_goal": 0.01, "p_multi_goal": 0.00, "p_clean_sheet": 0.02,
         "p_ge_2": 0.08, "p_ge_5": 0.01, "p_ge_10": 0.00, "p_ge_15": 0.00},
        # Not in the universe; must not be sealed.
        {"element_id": 4, "xp": 9.9, "p_appears": 1.0, "p_60": 1.0,
         "p_goal": 0.9, "p_multi_goal": 0.5, "p_clean_sheet": 0.5,
         "p_ge_2": 1.0, "p_ge_5": 0.9, "p_ge_10": 0.7, "p_ge_15": 0.4},
    ]


def _live(**overrides):
    """An event/{gw}/live-shaped payload."""
    def element(element_id, minutes, points, goals=0, cs=0):
        return {
            "id": element_id,
            "stats": {
                "minutes": minutes, "goals_scored": goals, "assists": 0,
                "clean_sheets": cs, "goals_conceded": 0, "own_goals": 0,
                "penalties_saved": 0, "penalties_missed": 0, "yellow_cards": 0,
                "red_cards": 0, "saves": 0, "bonus": 0, "bps": 20,
                "clearances_blocks_interceptions": 3, "recoveries": 4,
                "tackles": 1, "defensive_contribution": 0, "starts": 1,
                "total_points": points,
            },
            "explain": [{"fixture": 100 + element_id, "stats": []}],
        }
    payload = {"elements": [
        element(1, 90, 8, goals=1, cs=1),
        element(2, 20, 1),
        element(3, 0, 0),
    ]}
    payload.update(overrides)
    return payload


def _seal(tmp, now=BEFORE, dry_run=False):
    return seal_forecast(
        gameweek=5, deadline=DEADLINE, projections=_projections(),
        universe=resolve_universe(_bootstrap()), bootstrap=_bootstrap(),
        predictions_dir=Path(tmp), now=now, dry_run=dry_run,
    )


class UniverseTests(unittest.TestCase):
    def test_universe_is_resolved_from_model_independent_inputs(self):
        """
        Availability and ownership only. Deriving it from the model's own output
        would let a candidate win a paired comparison by projecting fewer players.
        """
        universe = resolve_universe(_bootstrap())
        self.assertEqual(sorted(universe.element_ids), [1, 2, 3])
        self.assertNotIn(4, universe.element_ids)

    def test_an_injured_but_widely_owned_player_is_still_scored(self):
        self.assertIn(3, resolve_universe(_bootstrap()).element_ids)

    def test_the_digest_is_order_independent(self):
        from pipeline.learning.ledger import SealedUniverse

        self.assertEqual(
            SealedUniverse([3, 1, 2], "x").digest,
            SealedUniverse([1, 2, 3], "x").digest,
        )


class SealTests(unittest.TestCase):
    def test_sealing_writes_a_header_and_only_universe_rows(self):
        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            data = read_forecast(path)
            self.assertEqual(data["header"]["gameweek"], 5)
            self.assertEqual(len(data["rows"]), 3)
            self.assertNotIn(4, [r["element_id"] for r in data["rows"]])

    def test_sealing_twice_raises(self):
        """A sealed gameweek is never rewritten; that is what makes it evidence."""
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            with self.assertRaises(AlreadySealedError):
                _seal(tmp)

    def test_sealing_after_the_deadline_raises(self):
        with TemporaryDirectory() as tmp:
            with self.assertRaises(TooLateToSealError):
                _seal(tmp, now=AFTER)

    def test_sealing_exactly_at_the_deadline_raises(self):
        with TemporaryDirectory() as tmp:
            with self.assertRaises(TooLateToSealError):
                _seal(tmp, now=datetime(2026, 9, 12, 10, 30, tzinfo=timezone.utc))

    def test_header_records_how_early_the_seal_was(self):
        with TemporaryDirectory() as tmp:
            header = read_forecast(_seal(tmp))["header"]
            self.assertAlmostEqual(header["seconds_before_deadline"], 4 * 3600)

    def test_the_in_progress_marker_is_removed_on_success(self):
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            marker = gameweek_dir(Path(tmp), 5) / IN_PROGRESS_MARKER
            self.assertFalse(marker.exists())

    def test_a_truncated_forecast_is_detected_on_read(self):
        """Header row count vs actual, so silent truncation cannot pass."""
        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            lines = path.read_text().splitlines()
            path.write_text("\n".join(lines[:-1]) + "\n")
            with self.assertRaises(LedgerError):
                read_forecast(path)

    def test_a_dry_run_is_quarantined_from_real_ledger_state(self):
        with TemporaryDirectory() as tmp:
            _seal(tmp, dry_run=True)
            self.assertFalse((gameweek_dir(Path(tmp), 5) / "forecast.jsonl").exists())
            self.assertTrue(
                (gameweek_dir(Path(tmp), 5, dry_run=True) / "forecast.jsonl").exists()
            )


class FrozenInputTests(unittest.TestCase):
    def test_frozen_inputs_round_trip(self):
        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            directory = path.parent
            header = read_forecast(path)["header"]
            restored = load_frozen_bootstrap(directory, header)
            self.assertEqual(len(restored["elements"]), 4)

    def test_a_tampered_bundle_is_refused(self):
        """
        A digest mismatch makes the gameweek unscoreable rather than silently
        re-projected against different data.
        """
        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            directory = path.parent
            header = read_forecast(path)["header"]
            bundle = directory / "inputs" / "bootstrap.json.gz"
            bundle.write_bytes(gzip.compress(b'{"elements": []}'))
            with self.assertRaises(LedgerError):
                load_frozen_bootstrap(directory, header)

    def test_a_missing_bundle_is_refused_not_refetched(self):
        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            directory = path.parent
            header = read_forecast(path)["header"]
            (directory / "inputs" / "bootstrap.json.gz").unlink()
            with self.assertRaises(LedgerError):
                load_frozen_bootstrap(directory, header)

    def test_reading_frozen_inputs_touches_no_network(self):
        """
        A re-projection that quietly refetches is comparing today's data against
        yesterday's forecast. Enforced by making any HTTP call raise.
        """
        import urllib.request

        with TemporaryDirectory() as tmp:
            path = _seal(tmp)
            header = read_forecast(path)["header"]
            original = urllib.request.urlopen

            def forbidden(*args, **kwargs):
                raise AssertionError("network access during re-projection")

            urllib.request.urlopen = forbidden
            self.addCleanup(setattr, urllib.request, "urlopen", original)
            restored = load_frozen_bootstrap(path.parent, header)
            self.assertEqual(len(restored["elements"]), 4)


class SettlementTests(unittest.TestCase):
    def test_parsing_extracts_every_scoring_stat(self):
        parsed = parse_event_live(_live())
        self.assertEqual(parsed[1]["minutes"], 90)
        self.assertEqual(parsed[1]["total_points"], 8)
        self.assertEqual(parsed[1]["goals_scored"], 1)

    def test_parsing_retains_fixture_attribution_for_doubles(self):
        """`explain` is the only thing that says which fixture a return came from."""
        parsed = parse_event_live(_live())
        self.assertEqual(parsed[1]["n_fixtures_played"], 1)
        self.assertEqual(parsed[1]["fixture_ids"], [101])

    def test_parsing_rejects_a_payload_that_is_not_event_live(self):
        with self.assertRaises(SettlementError):
            parse_event_live({"nope": []})

    def test_settling_without_a_seal_raises(self):
        """Outcomes with no prediction to score them against are not settlement."""
        with TemporaryDirectory() as tmp:
            with self.assertRaises(SettlementError):
                settle_gameweek(5, Path(tmp), _live(), provisional=False)

    def test_an_empty_live_payload_is_not_a_settlement(self):
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            with self.assertRaises(SettlementError):
                settle_gameweek(5, Path(tmp), {"elements": []}, provisional=True)

    def test_provisional_can_be_superseded_by_final(self):
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            settle_gameweek(5, Path(tmp), _live(), provisional=True)
            path = settle_gameweek(5, Path(tmp), _live(), provisional=False)
            header = read_outcomes(path)["header"]
            self.assertFalse(header["provisional"])
            self.assertEqual(header["revision"], 2)

    def test_a_final_settlement_is_not_re_settled(self):
        """Re-reading a finished match can only lose information."""
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            settle_gameweek(5, Path(tmp), _live(), provisional=False)
            with self.assertRaises(SettlementError):
                settle_gameweek(5, Path(tmp), _live(), provisional=False)


class ScoringTests(unittest.TestCase):
    def _prepare(self, tmp, provisional=False, now=BEFORE):
        _seal(tmp, now=now)
        settle_gameweek(5, Path(tmp), _live(), provisional=provisional)

    def test_scoring_produces_a_report_over_the_sealed_universe(self):
        with TemporaryDirectory() as tmp:
            self._prepare(tmp)
            report = score_gameweek(5, Path(tmp))
            self.assertEqual(report.n_scored, 3)
            self.assertTrue((gameweek_dir(Path(tmp), 5) / "score.json").exists())

    def test_provisional_data_will_not_produce_an_accuracy_claim(self):
        with TemporaryDirectory() as tmp:
            self._prepare(tmp, provisional=True)
            with self.assertRaises(UnscoreableError):
                score_gameweek(5, Path(tmp))

    def test_provisional_data_may_be_scored_as_an_explicit_diagnostic(self):
        with TemporaryDirectory() as tmp:
            self._prepare(tmp, provisional=True)
            report = score_gameweek(5, Path(tmp), allow_provisional=True)
            self.assertTrue(report.provisional)

    def test_every_binary_component_is_measured_separately(self):
        """An aggregate hides direction; a component curve does not."""
        with TemporaryDirectory() as tmp:
            self._prepare(tmp)
            report = score_gameweek(5, Path(tmp))
            for component in ("p_appears", "p_60", "p_goal", "p_clean_sheet",
                              "p_ge_10"):
                self.assertIn(component, report.metrics["components"])
                self.assertIn("brier", report.metrics["components"][component])

    def test_points_error_is_stratified_by_whether_the_player_returned(self):
        with TemporaryDirectory() as tmp:
            self._prepare(tmp)
            points = score_gameweek(5, Path(tmp)).metrics["points"]
            self.assertIn("mae_zeros", points)
            self.assertIn("mae_returners", points)
            self.assertEqual(points["n_zeros"], 1)

    def test_the_score_records_how_early_the_forecast_was_sealed(self):
        with TemporaryDirectory() as tmp:
            self._prepare(tmp)
            self.assertAlmostEqual(
                score_gameweek(5, Path(tmp)).metrics["hours_before_deadline"], 4.0
            )

    def test_a_sealed_player_absent_from_the_outcome_is_counted_not_dropped(self):
        with TemporaryDirectory() as tmp:
            _seal(tmp)
            payload = _live()
            payload["elements"] = payload["elements"][:2]
            settle_gameweek(5, Path(tmp), payload, provisional=False)
            report = score_gameweek(5, Path(tmp))
            self.assertEqual(report.metrics["n_missing_outcome"], 1)
            self.assertEqual(report.n_scored, 2)

    def test_scoring_never_reads_the_dry_run_directory(self):
        """A dry run must not be able to masquerade as a measurement."""
        with TemporaryDirectory() as tmp:
            _seal(tmp, dry_run=True)
            settle_gameweek(5, Path(tmp), _live(), provisional=False, dry_run=True)
            with self.assertRaises(FileNotFoundError):
                score_gameweek(5, Path(tmp))


if __name__ == "__main__":
    unittest.main()
