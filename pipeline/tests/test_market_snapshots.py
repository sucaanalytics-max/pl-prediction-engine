"""
Tests for the pre-deadline market price store.

Two properties carry the weight.

**It records raw per-bookmaker prices, never a de-vigged consensus.** A consensus
bakes today's de-vig method into a permanent record, so changing the method makes
the whole history incomparable with no way to re-derive it. The point of the store
is to let every de-vig variant be measured against one history.

**Dedupe must preserve movement.** Bookmakers do not move every line every day,
so repeats are noise — but a price that moved and moved back is three real
observations, not one. Collapsing that would erase the line movement the store
exists to capture.
"""
import json
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.data.market_snapshots import (
    MarketSnapshot,
    SNAPSHOTS_FILENAME,
    extract,
    history,
    last_before_kickoff,
    record,
)

KICKOFF = "2026-08-21T19:00:00Z"


def _parsed(h2h=None, totals=None, match_key="Arsenal_vs_Chelsea"):
    """One fixture in parse_match_odds' output shape."""
    return {
        match_key: {
            "home_team": "Arsenal",
            "away_team": "Chelsea",
            "commence_time": KICKOFF,
            # Best-price keys are present in real output and must be ignored.
            "h2h": {"home": 1.99, "draw": 3.60, "away": 4.40, "bookmaker": "mixed"},
            "totals": {"2.5": {"over": 2.02, "under": 2.05}},
            "h2h_all": h2h if h2h is not None else {
                "bet365": {"home": 1.85, "draw": 3.50, "away": 4.20},
                "williamhill": {"home": 1.90, "draw": 3.40, "away": 4.10},
            },
            "totals_all": totals if totals is not None else {
                "bet365": {"2.5": {"over": 1.85, "under": 2.05}},
            },
        }
    }


def _snapshot(captured_at, h2h=None, commence_time=KICKOFF):
    return MarketSnapshot(
        match_key="Arsenal_vs_Chelsea",
        home_team="Arsenal",
        away_team="Chelsea",
        commence_time=commence_time,
        captured_at=captured_at,
        h2h=h2h if h2h is not None else {"bet365": {"home": 1.85, "draw": 3.5, "away": 4.2}},
    )


class ExtractionTests(unittest.TestCase):
    def test_per_bookmaker_prices_are_kept_verbatim(self):
        snapshots = extract(_parsed(), "2026-08-19T06:00:00Z")
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(
            snapshots[0].h2h["bet365"], {"home": 1.85, "draw": 3.50, "away": 4.20}
        )
        self.assertEqual(
            snapshots[0].totals["bet365"]["2.5"], {"over": 1.85, "under": 2.05}
        )

    def test_the_mixed_best_price_view_is_not_recorded(self):
        """
        The best-price keys take the best over from one book and the best under
        from another; that pair belongs to no bookmaker. Recording it as though
        it were a market view is the error this store must not make.
        """
        snapshots = extract(_parsed(), "2026-08-19T06:00:00Z")
        recorded = json.dumps(snapshots[0].as_dict())
        self.assertNotIn("1.99", recorded)  # best-price h2h home
        self.assertNotIn("2.02", recorded)  # best-price totals over
        self.assertNotIn("bookmaker", recorded)

    def test_a_fixture_with_no_per_book_prices_is_skipped(self):
        """
        Recording it empty would be indistinguishable from "the market had gone",
        and would inflate any later count of how many fixtures we had prices for.
        """
        self.assertEqual(extract(_parsed(h2h={}, totals={}), "2026-08-19T06:00:00Z"), [])

    def test_hours_to_kickoff_is_computed_and_signed(self):
        before = _snapshot("2026-08-21T07:00:00Z")
        self.assertAlmostEqual(before.hours_to_kickoff, 12.0, places=6)
        after = _snapshot("2026-08-21T21:00:00Z")
        self.assertAlmostEqual(after.hours_to_kickoff, -2.0, places=6)

    def test_an_unparseable_kickoff_gives_no_lead_time_rather_than_zero(self):
        self.assertIsNone(_snapshot("2026-08-19T06:00:00Z", commence_time=None).hours_to_kickoff)
        self.assertIsNone(_snapshot("2026-08-19T06:00:00Z", commence_time="soon").hours_to_kickoff)

    def test_a_naive_timestamp_is_treated_as_utc(self):
        naive = _snapshot("2026-08-21T07:00:00", commence_time="2026-08-21T19:00:00")
        self.assertAlmostEqual(naive.hours_to_kickoff, 12.0, places=6)


class DigestTests(unittest.TestCase):
    def test_the_digest_ignores_when_it_was_captured(self):
        """Two captures of identical prices must collide, or dedupe cannot work."""
        self.assertEqual(
            _snapshot("2026-08-19T06:00:00Z").digest,
            _snapshot("2026-08-20T06:00:00Z").digest,
        )

    def test_the_digest_ignores_bookmaker_ordering(self):
        one = _snapshot("2026-08-19T06:00:00Z", h2h={
            "bet365": {"home": 1.85, "draw": 3.5, "away": 4.2},
            "williamhill": {"home": 1.90, "draw": 3.4, "away": 4.1},
        })
        other = _snapshot("2026-08-19T06:00:00Z", h2h={
            "williamhill": {"home": 1.90, "draw": 3.4, "away": 4.1},
            "bet365": {"home": 1.85, "draw": 3.5, "away": 4.2},
        })
        self.assertEqual(one.digest, other.digest)

    def test_a_single_moved_price_changes_the_digest(self):
        moved = _snapshot(
            "2026-08-19T06:00:00Z",
            h2h={"bet365": {"home": 1.86, "draw": 3.5, "away": 4.2}},
        )
        self.assertNotEqual(_snapshot("2026-08-19T06:00:00Z").digest, moved.digest)


class RecordingTests(unittest.TestCase):
    def test_unchanged_prices_write_nothing(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertIsNotNone(record([_snapshot("2026-08-19T06:00:00Z")], directory))
            self.assertIsNone(record([_snapshot("2026-08-20T06:00:00Z")], directory))
            self.assertEqual(len(history(directory)), 1)

    def test_a_price_that_moves_back_records_all_three_observations(self):
        """
        Dedupe is against the PREVIOUS line, not against everything ever seen.
        The record is of what was published when — a reversal is real movement,
        and collapsing it would erase exactly the signal being collected.
        """
        opening = {"bet365": {"home": 1.85, "draw": 3.5, "away": 4.2}}
        drifted = {"bet365": {"home": 1.95, "draw": 3.5, "away": 4.2}}
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_snapshot("2026-08-19T06:00:00Z", h2h=opening)], directory)
            record([_snapshot("2026-08-20T06:00:00Z", h2h=drifted)], directory)
            record([_snapshot("2026-08-21T06:00:00Z", h2h=opening)], directory)

            rows = history(directory)
            self.assertEqual(len(rows), 3)
            self.assertEqual(
                [row.h2h["bet365"]["home"] for row in rows], [1.85, 1.95, 1.85]
            )

    def test_appending_never_rewrites_an_earlier_line(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_snapshot("2026-08-19T06:00:00Z")], directory)
            first = (directory / SNAPSHOTS_FILENAME).read_bytes()
            record([
                _snapshot(
                    "2026-08-20T06:00:00Z",
                    h2h={"bet365": {"home": 1.95, "draw": 3.5, "away": 4.2}},
                )
            ], directory)
            self.assertTrue((directory / SNAPSHOTS_FILENAME).read_bytes().startswith(first))

    def test_dry_run_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertIsNone(
                record([_snapshot("2026-08-19T06:00:00Z")], directory, dry_run=True)
            )
            self.assertFalse((directory / SNAPSHOTS_FILENAME).exists())

    def test_recording_nothing_is_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(record([], Path(tmp)))

    def test_two_fixtures_dedupe_independently(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            arsenal = _snapshot("2026-08-19T06:00:00Z")
            spurs = MarketSnapshot(
                match_key="Tottenham_vs_Everton",
                home_team="Tottenham", away_team="Everton",
                commence_time=KICKOFF, captured_at="2026-08-19T06:00:00Z",
                h2h={"bet365": {"home": 1.60, "draw": 4.0, "away": 5.5}},
            )
            record([arsenal, spurs], directory)
            # Only Arsenal moves.
            moved = _snapshot(
                "2026-08-20T06:00:00Z",
                h2h={"bet365": {"home": 1.95, "draw": 3.5, "away": 4.2}},
            )
            still = replace(spurs, captured_at="2026-08-20T06:00:00Z")
            record([moved, still], directory)

            keys = [row.match_key for row in history(directory)]
            self.assertEqual(keys.count("Arsenal_vs_Chelsea"), 2)
            self.assertEqual(keys.count("Tottenham_vs_Everton"), 1)


class HistoryTests(unittest.TestCase):
    def test_a_missing_file_is_empty_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(history(Path(tmp)), [])

    def test_a_corrupt_line_raises_rather_than_shortening_the_history(self):
        """
        Skipping a bad line silently shortens the record, and a blend weight
        fitted on a silently shortened history is the confidently wrong number
        this store exists to prevent.
        """
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_snapshot("2026-08-19T06:00:00Z")], directory)
            with (directory / SNAPSHOTS_FILENAME).open("a") as handle:
                handle.write("{not json\n")
            with self.assertRaises(ValueError) as caught:
                history(directory)
            self.assertIn(SNAPSHOTS_FILENAME, str(caught.exception))

    def test_a_corrupt_history_still_allows_todays_prices_to_be_captured(self):
        """
        The corruption is already permanent; today's prices are perishable. So a
        bad history disables dedupe rather than blocking the write — the worst
        case is a duplicate line, against permanently losing an observation.
        """
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / SNAPSHOTS_FILENAME).write_text("{not json\n")
            self.assertIsNotNone(record([_snapshot("2026-08-19T06:00:00Z")], directory))


class LastBeforeKickoffTests(unittest.TestCase):
    def _populate(self, directory):
        for captured, home in (
            ("2026-08-19T06:00:00Z", 1.85),
            ("2026-08-21T15:00:00Z", 1.90),   # 4h before kickoff
            ("2026-08-21T20:00:00Z", 1.95),   # 1h AFTER kickoff
        ):
            record([
                _snapshot(captured, h2h={"bet365": {"home": home, "draw": 3.5, "away": 4.2}})
            ], directory)

    def test_picks_the_latest_snapshot_before_kickoff(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self._populate(directory)
            best = last_before_kickoff(directory)
            self.assertEqual(best["Arsenal_vs_Chelsea"].h2h["bet365"]["home"], 1.90)

    def test_a_post_kickoff_snapshot_is_never_selected(self):
        """A price published after the deadline is not a forecast input."""
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self._populate(directory)
            for snapshot in last_before_kickoff(directory).values():
                self.assertGreaterEqual(snapshot.hours_to_kickoff, 0.0)

    def test_a_minimum_lead_time_excludes_closer_snapshots(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self._populate(directory)
            best = last_before_kickoff(directory, min_hours=12.0)
            self.assertEqual(best["Arsenal_vs_Chelsea"].h2h["bet365"]["home"], 1.85)

    def test_a_snapshot_with_no_kickoff_is_excluded_not_assumed_in_time(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_snapshot("2026-08-19T06:00:00Z", commence_time=None)], directory)
            self.assertEqual(last_before_kickoff(directory), {})


if __name__ == "__main__":
    unittest.main()
