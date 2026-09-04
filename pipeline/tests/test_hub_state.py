"""
Tests for the hub capture read.

This sits in the pre-deadline decision path, so the tests are weighted toward the
ways it must REFUSE: a squad that would read as free slots, a capture belonging to
a different gameweek, and prices that a price change has since invalidated.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.fpl.hub_state import (
    OWNER_CAPTURED,
    Capture,
    capture_path,
    read_capture,
)
from pipeline.learning.run_agent import _entry_state_from_capture

ENTRY = 2561567
SQUAD = list(range(1, 16))


def _write(directory: Path, **overrides) -> Path:
    payload = {
        "source": OWNER_CAPTURED,
        "entry_id": ENTRY,
        "gameweek": 2,
        "captured_at": "2026-08-25T09:00:00+00:00",
        "squad": SQUAD,
        "bank": 35,
        "free_transfers": 2,
        "purchase_prices": {str(i): 50 for i in SQUAD},
    }
    payload.update(overrides)
    path = capture_path(directory, ENTRY)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class PathTests(unittest.TestCase):
    def test_the_capture_lives_on_a_path_no_other_writer_owns(self):
        path = capture_path(Path("/tmp/predictions"), ENTRY)
        self.assertEqual(
            path, Path("/tmp/predictions/fpl/hub/capture/2561567.json"),
            "the path is declared in the other workflows' FORBID_PATHS, so it is "
            "not free to move without updating them",
        )


class ReadTests(unittest.TestCase):
    def test_no_file_is_no_capture(self):
        """Absence is the gate. There is no flag, because there needs to be none."""
        with TemporaryDirectory() as tmp:
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_a_valid_capture_is_returned_in_tenths(self):
        with TemporaryDirectory() as tmp:
            _write(Path(tmp))
            capture = read_capture(Path(tmp), ENTRY, 2)

        self.assertIsNotNone(capture)
        self.assertEqual(capture.entry_id, ENTRY)
        self.assertEqual(capture.gameweek, 2)
        self.assertEqual(capture.squad, SQUAD)
        self.assertEqual(capture.bank, 35, "tenths, not millions")
        self.assertEqual(capture.free_transfers, 2)
        self.assertEqual(capture.purchase_prices[1], 50)

    def test_another_gameweeks_capture_is_refused(self):
        """
        Serving GW3's squad into a GW4 decision would be a wrong answer delivered
        confidently, and the file outlives the gameweek it describes.
        """
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), gameweek=3)
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 4))

    def test_a_file_that_does_not_claim_owner_provenance_is_refused(self):
        """
        `captured_authenticated_draft` means "official picks were unavailable", not
        "the owner typed this in". Accepting it here would let a fallback label
        drive a decision as though a human had asserted it.
        """
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), source="captured_authenticated_draft")
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_unreadable_json_returns_none_rather_than_raising(self):
        with TemporaryDirectory() as tmp:
            path = capture_path(Path(tmp), ENTRY)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_a_short_squad_is_refused(self):
        """
        Fourteen players read to the optimiser as a free slot, and it would spend
        the bank filling it. A partial capture is worse than none.
        """
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), squad=SQUAD[:14])
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_a_duplicated_player_is_refused(self):
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), squad=SQUAD[:14] + [SQUAD[0]])
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_an_unreadable_timestamp_is_refused(self):
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), captured_at="not a date")
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))

    def test_a_non_numeric_squad_is_refused(self):
        with TemporaryDirectory() as tmp:
            _write(Path(tmp), squad=["not-an-id"] * 15)
            self.assertIsNone(read_capture(Path(tmp), ENTRY, 2))


class PriceStalenessTests(unittest.TestCase):
    """
    Prices age against FPL's own ~01:30 UTC price change, not a round number of
    hours. A capture taken at 23:00 is stale by 02:00 after three hours; one taken
    at 02:00 survives twenty-three.
    """

    def _capture(self, captured_at):
        return Capture(entry_id=ENTRY, gameweek=2, captured_at=captured_at, squad=SQUAD)

    def test_prices_survive_until_the_next_price_change(self):
        capture = self._capture(datetime(2026, 8, 25, 2, 0, tzinfo=timezone.utc))
        self.assertFalse(
            capture.prices_are_stale(datetime(2026, 8, 26, 1, 0, tzinfo=timezone.utc))
        )

    def test_prices_are_stale_once_the_price_change_has_passed(self):
        capture = self._capture(datetime(2026, 8, 25, 2, 0, tzinfo=timezone.utc))
        self.assertTrue(
            capture.prices_are_stale(datetime(2026, 8, 26, 2, 0, tzinfo=timezone.utc))
        )

    def test_a_late_evening_capture_goes_stale_the_same_night(self):
        capture = self._capture(datetime(2026, 8, 25, 23, 0, tzinfo=timezone.utc))
        self.assertTrue(
            capture.prices_are_stale(datetime(2026, 8, 26, 2, 0, tzinfo=timezone.utc))
        )

    def test_a_naive_timestamp_is_treated_as_utc_rather_than_raising(self):
        capture = self._capture(datetime(2026, 8, 25, 2, 0))
        self.assertFalse(
            capture.prices_are_stale(datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc))
        )


class EntryStateFromCaptureTests(unittest.TestCase):
    def _capture(self, captured_at, prices=None):
        return Capture(
            entry_id=ENTRY, gameweek=2, captured_at=captured_at,
            squad=SQUAD, bank=35, free_transfers=2,
            purchase_prices={i: 50 for i in SQUAD} if prices is None else prices,
        )

    def test_a_fresh_capture_keeps_its_prices(self):
        state = _entry_state_from_capture(self._capture(datetime.now(timezone.utc)), 2)
        self.assertEqual(state.squad, SQUAD)
        self.assertEqual(state.bank, 35)
        self.assertEqual(state.purchase_prices, {i: 50 for i in SQUAD})
        self.assertEqual(state.untraced, [])
        self.assertFalse(state.price_uncertain)

    def test_a_price_stale_capture_keeps_the_squad_but_flags_every_price(self):
        """
        The squad is still right — it changes only when the owner transfers. The
        prices are not, so they route through the SAME `untraced` field the FPL
        read already uses, rather than a second kind of uncertainty nothing
        downstream knows to check.
        """
        stale = self._capture(datetime(2026, 1, 1, 2, 0, tzinfo=timezone.utc))
        state = _entry_state_from_capture(stale, 2)
        self.assertEqual(state.squad, SQUAD)
        self.assertEqual(state.purchase_prices, {})
        self.assertEqual(state.untraced, SQUAD)
        self.assertTrue(state.price_uncertain)

    def test_a_capture_with_no_prices_reports_them_as_uncertain(self):
        """
        Keying `untraced` on staleness alone meant a FRESH capture carrying no
        prices reported them as certain, and every sale would have been priced at
        now_cost without a flag.
        """
        state = _entry_state_from_capture(
            self._capture(datetime.now(timezone.utc), prices={}), 2
        )
        self.assertEqual(state.untraced, SQUAD)
        self.assertTrue(state.price_uncertain)

    def test_a_partially_priced_capture_flags_only_the_unpriced(self):
        state = _entry_state_from_capture(
            self._capture(datetime.now(timezone.utc),
                          prices={i: 50 for i in SQUAD[:10]}), 2
        )
        self.assertEqual(state.untraced, SQUAD[10:])
        self.assertTrue(state.price_uncertain)


if __name__ == "__main__":
    unittest.main()


class ReadEntryFplRungTests(unittest.TestCase):
    """
    Rung 2 of `_read_entry`: no capture on disk, so FPL's own endpoint answers.

    This rung had no test, which is how a hardcoded free-transfer count survived
    in it. `read_entry_state` needs the banked-transfer cap, and the cap is a
    rule — `rules.max_banked_free_transfers`, one definition, in rules.py. A
    caller that invents its own number would be a second answer to a question
    that already has one.
    """

    HISTORY = {
        "current": [
            {"event": 1, "event_transfers": 0},
            {"event": 2, "event_transfers": 0},
            {"event": 3, "event_transfers": 1},
        ],
        "chips": [],
    }
    PICKS = {"picks": [{"element": 1}], "entry_history": {"bank": 0}}

    def test_the_banked_count_comes_from_history_not_a_constant(self):
        from unittest import mock

        from pipeline.learning.run_agent import _read_entry

        with (
            TemporaryDirectory() as tmp,
            mock.patch("pipeline.fpl.entry_api.fetch_picks", return_value=self.PICKS),
            mock.patch("pipeline.fpl.entry_api.fetch_transfers", return_value=[]),
            mock.patch(
                "pipeline.fpl.entry_api.fetch_history", return_value=self.HISTORY
            ),
        ):
            state = _read_entry(
                Path(tmp),
                {"entry_id": ENTRY},
                4,
                {"elements": [{"id": 1, "now_cost": 60}]},
                max_banked_free_transfers=5,
            )

        self.assertEqual(state.free_transfers, 2)
