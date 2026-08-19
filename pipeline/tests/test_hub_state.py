"""
Tests for the hub capture read.

This module sits in the pre-deadline decision path, so the tests are weighted
toward the ways it must REFUSE: a gate that could switch itself on, a partial
squad reaching the optimiser as free slots, and any failure escaping as an
exception instead of a None.
"""
from __future__ import annotations

import json
import os
import unittest
import urllib.error
from datetime import datetime, timezone
from unittest import mock

from pipeline.fpl.hub_state import (
    OWNER_CAPTURED,
    Capture,
    capture_enabled,
    read_capture,
)
from pipeline.learning.run_agent import _entry_state_from_capture

CREDENTIALS = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
}

SQUAD = list(range(1, 16))


def _row(**overrides):
    row = {
        "captured_at": "2026-08-25T09:00:00+00:00",
        "payload": {
            "squad": SQUAD,
            "bank": 35,
            "free_transfers": 2,
            "purchase_prices": {str(i): 50 for i in SQUAD},
        },
    }
    row.update(overrides)
    return row


def _response(rows):
    handle = mock.MagicMock()
    handle.read.return_value = json.dumps(rows).encode("utf-8")
    handle.__enter__ = lambda self_: self_
    handle.__exit__ = lambda *a: False
    return handle


class GateTests(unittest.TestCase):
    def test_the_gate_is_off_when_unset(self):
        """
        The property that makes this safe to ship into the decision path before an
        irrecoverable seal: landing the code changes nothing until someone sets the
        variable. If this test ever fails, the change is no longer inert.
        """
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(capture_enabled())

    def test_an_empty_or_junk_value_does_not_enable_it(self):
        for value in ("", " ", "0", "false", "no", "maybe", "off"):
            with mock.patch.dict(os.environ, {"FPL_HUB_CAPTURE": value}, clear=True):
                self.assertFalse(capture_enabled(), f"{value!r} must not enable")

    def test_explicit_affirmatives_enable_it(self):
        for value in ("1", "true", "TRUE", "yes", " true "):
            with mock.patch.dict(os.environ, {"FPL_HUB_CAPTURE": value}, clear=True):
                self.assertTrue(capture_enabled(), f"{value!r} should enable")

    def test_no_network_call_happens_while_the_gate_is_off(self):
        with mock.patch.dict(os.environ, CREDENTIALS, clear=True), \
                mock.patch("urllib.request.urlopen") as urlopen:
            self.assertIsNone(read_capture(2561567, 2))
        urlopen.assert_not_called()


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(CREDENTIALS, FPL_HUB_CAPTURE="1")

    def test_a_valid_capture_is_returned(self):
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_response([_row()])):
            capture = read_capture(2561567, 2)

        self.assertIsNotNone(capture)
        self.assertEqual(capture.entry_id, 2561567)
        self.assertEqual(capture.gameweek, 2)
        self.assertEqual(capture.squad, SQUAD)
        self.assertEqual(capture.bank, 35, "bank stays integer tenths, not millions")
        self.assertEqual(capture.free_transfers, 2)
        self.assertEqual(capture.purchase_prices[1], 50)

    def test_the_query_is_scoped_to_the_entry_gameweek_and_provenance(self):
        """
        Serving GW3's squad into a GW4 decision would be a wrong answer delivered
        confidently, so the scoping is in the query rather than in a later filter.
        """
        seen = {}

        def capture_request(request, timeout=None):
            seen["url"] = request.full_url
            return _response([_row()])

        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", capture_request):
            read_capture(2561567, 4)

        self.assertIn("entry_id=eq.2561567", seen["url"])
        self.assertIn("event_id=eq.4", seen["url"])
        self.assertIn(f"source=eq.{OWNER_CAPTURED}", seen["url"])
        self.assertIn("limit=1", seen["url"])

    def test_missing_credentials_return_none_rather_than_raising(self):
        with mock.patch.dict(os.environ, {"FPL_HUB_CAPTURE": "1"}, clear=True):
            self.assertIsNone(read_capture(2561567, 2))

    def test_a_network_failure_returns_none_rather_than_raising(self):
        """
        A hub outage must cost nothing: the FPL API read below this rung already
        works, so an exception here would turn a recoverable proposal into a red run.
        """
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen",
                           side_effect=urllib.error.URLError("hub down")):
            self.assertIsNone(read_capture(2561567, 2))

    def test_no_capture_yet_returns_none(self):
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_response([])):
            self.assertIsNone(read_capture(2561567, 2))

    def test_a_short_squad_is_refused(self):
        """
        Fourteen players would read to the optimiser as a free slot to fill, and it
        would spend the bank on it. A partial capture is worse than none.
        """
        row = _row(payload={"squad": SQUAD[:14], "bank": 0,
                            "free_transfers": 1, "purchase_prices": {}})
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_response([row])):
            self.assertIsNone(read_capture(2561567, 2))

    def test_a_squad_with_duplicates_is_refused(self):
        row = _row(payload={"squad": SQUAD[:14] + [SQUAD[0]], "bank": 0,
                            "free_transfers": 1, "purchase_prices": {}})
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_response([row])):
            self.assertIsNone(read_capture(2561567, 2))

    def test_an_unreadable_timestamp_is_refused(self):
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen",
                           return_value=_response([_row(captured_at="not a date")])):
            self.assertIsNone(read_capture(2561567, 2))

    def test_a_non_numeric_payload_is_refused(self):
        row = _row(payload={"squad": ["not-an-id"] * 15, "bank": 0,
                            "free_transfers": 1, "purchase_prices": {}})
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_response([row])):
            self.assertIsNone(read_capture(2561567, 2))


class PriceStalenessTests(unittest.TestCase):
    """
    Prices age against FPL's own ~01:30 UTC price change, not against a round
    number of hours. A capture taken at 23:00 is stale by 02:00 the next morning
    after only three hours; one taken at 02:00 survives twenty-three.
    """

    def _capture(self, captured_at):
        return Capture(entry_id=1, gameweek=2, captured_at=captured_at, squad=SQUAD)

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
    def _capture(self, captured_at):
        return Capture(
            entry_id=2561567, gameweek=2, captured_at=captured_at,
            squad=SQUAD, bank=35, free_transfers=2,
            purchase_prices={i: 50 for i in SQUAD},
        )

    def test_a_fresh_capture_keeps_its_prices(self):
        fresh = self._capture(datetime.now(timezone.utc))
        state = _entry_state_from_capture(fresh, 2)
        self.assertEqual(state.squad, SQUAD)
        self.assertEqual(state.bank, 35)
        self.assertEqual(state.free_transfers, 2)
        self.assertEqual(state.purchase_prices, {i: 50 for i in SQUAD})
        self.assertEqual(state.untraced, [])
        self.assertFalse(state.price_uncertain)

    def test_a_price_stale_capture_keeps_the_squad_but_flags_every_price(self):
        """
        The squad is still right — it changes only when the owner transfers. The
        prices are not, so they route through the SAME `untraced` mechanism the
        FPL read already uses, rather than a second kind of uncertainty nobody
        downstream would know to check.
        """
        stale = self._capture(datetime(2026, 1, 1, 2, 0, tzinfo=timezone.utc))
        state = _entry_state_from_capture(stale, 2)
        self.assertEqual(state.squad, SQUAD)
        self.assertEqual(state.purchase_prices, {})
        self.assertEqual(state.untraced, SQUAD)
        self.assertTrue(state.price_uncertain)


    def test_a_capture_with_no_prices_reports_them_as_uncertain(self):
        """
        The hole this closes: keying `untraced` on staleness alone meant a FRESH
        capture carrying no purchase prices reported them as certain, and the
        decision path would have priced every sale at now_cost without a flag.
        """
        fresh = Capture(
            entry_id=2561567, gameweek=2, captured_at=datetime.now(timezone.utc),
            squad=SQUAD, bank=35, free_transfers=1, purchase_prices={},
        )
        state = _entry_state_from_capture(fresh, 2)
        self.assertEqual(state.squad, SQUAD)
        self.assertEqual(state.untraced, SQUAD)
        self.assertTrue(state.price_uncertain)

    def test_a_partially_priced_capture_flags_only_the_unpriced(self):
        partial = Capture(
            entry_id=2561567, gameweek=2, captured_at=datetime.now(timezone.utc),
            squad=SQUAD, bank=35, free_transfers=1,
            purchase_prices={i: 50 for i in SQUAD[:10]},
        )
        state = _entry_state_from_capture(partial, 2)
        self.assertEqual(state.untraced, SQUAD[10:])
        self.assertTrue(state.price_uncertain)


if __name__ == "__main__":
    unittest.main()
