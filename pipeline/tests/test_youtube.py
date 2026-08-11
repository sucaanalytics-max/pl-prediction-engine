"""
The YouTube metadata connector: quota, storage cap, and graceful absence.

## What these tests defend

**`search.list` is never called.** It costs 100 units against a 10,000/day
budget and has its own separate 100/day cap. Fifteen channels polled hourly
through it would exhaust everything before lunch. The cheap path —
`channels.list` once, then `playlistItems.list` — is a hundred times cheaper,
and `test_never_calls_search` pins it so a future edit cannot quietly reach for
the obvious API.

**The 30-day cap is enforced, not intended.** YouTube's terms require deleting
API-derived data within 30 days. A comment saying so is worth nothing; `prune`
runs on every poll and these tests check it actually removes things, including
records whose timestamp is missing or unparseable — where the safe reading of
"delete within 30 days" is to delete.

**No API key is not an error.** That is today's state. The connector is
additive, and a missing key must leave every other news source untouched rather
than failing the run.

**A burst counts channels, not videos.** One channel posting four times about
Arsenal is a content schedule. Four channels posting once each inside one poll
is evidence that something happened. An implementation counting videos would
pass a naive test and report a publishing habit as news.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest import mock

from pipeline.data.news_feeds import FeedEntry
from pipeline.data.youtube import (
    COST_PLAYLIST_ITEMS,
    COST_SEARCH_LIST,
    MAX_STORAGE_DAYS,
    Ledger,
    QuotaExhausted,
    club_burst,
    fetch_channel,
    load_ledger,
    poll,
    prune,
)

NOW = datetime(2026, 8, 8, 12, 0, tzinfo=timezone.utc)

CHANNEL = {"name": "letstalkfpl", "channel_id": "UCabc", "tier": 3}


def channels_payload(playlist: str = "UUabc") -> Dict[str, Any]:
    return {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": playlist}}}]}


def items_payload(*titles: str) -> Dict[str, Any]:
    return {
        "items": [
            {
                "snippet": {
                    "title": title,
                    "description": "Some description.",
                    "publishedAt": "2026-08-08T09:00:00Z",
                    "resourceId": {"videoId": f"vid{index}"},
                }
            }
            for index, title in enumerate(titles)
        ]
    }


class FakeApi:
    """Records every path requested, so the expensive one can be asserted absent."""

    def __init__(self, *responses: Dict[str, Any]) -> None:
        self.responses = list(responses)
        self.paths: List[str] = []

    def __call__(self, path: str, params, timeout):  # noqa: ANN001
        self.paths.append(path)
        if not self.responses:
            raise AssertionError(f"unexpected extra call to {path}")
        return self.responses.pop(0)


class LedgerTests(unittest.TestCase):
    def test_it_refuses_to_exceed_the_ceiling(self):
        ledger = Ledger(date="2026-08-08", spent=4_999, ceiling=5_000)
        ledger.charge(1)
        with self.assertRaises(QuotaExhausted):
            ledger.charge(1)

    def test_it_resets_on_the_utc_date_roll(self):
        state = {"youtube": {"ledger": {"date": "2026-08-07", "spent": 4_000}}}
        ledger = load_ledger(state, NOW, ceiling=5_000)
        self.assertEqual(ledger.spent, 0)

    def test_it_carries_the_spend_within_a_day(self):
        state = {"youtube": {"ledger": {"date": "2026-08-08", "spent": 4_000}}}
        self.assertEqual(load_ledger(state, NOW, ceiling=5_000).spent, 4_000)

    def test_a_lowered_ceiling_takes_effect_immediately(self):
        # Not on the next date roll: a limit that waits a day is not a limit.
        state = {"youtube": {"ledger": {"date": "2026-08-08", "spent": 10, "ceiling": 9_000}}}
        self.assertEqual(load_ledger(state, NOW, ceiling=100).ceiling, 100)


class QuotaPathTests(unittest.TestCase):
    def test_never_calls_search(self):
        """
        The expensive API, pinned absent.

        `search.list` is a hundred times the cost and has its own 100/day cap.
        """
        api = FakeApi(channels_payload(), items_payload("Arsenal team news"))
        state: Dict[str, Any] = {}
        with mock.patch("pipeline.data.youtube._get", api):
            fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", ceiling=100))
        self.assertNotIn("search", api.paths)
        self.assertEqual(api.paths, ["channels", "playlistItems"])
        self.assertEqual(COST_SEARCH_LIST, 100)

    def test_the_uploads_playlist_is_resolved_once_and_cached(self):
        state: Dict[str, Any] = {}
        ledger = Ledger("2026-08-08", ceiling=100)
        api = FakeApi(
            channels_payload(), items_payload("one"), items_payload("two"),
        )
        with mock.patch("pipeline.data.youtube._get", api):
            fetch_channel(CHANNEL, "key", state, ledger)
            fetch_channel(CHANNEL, "key", state, ledger)
        # channels.list once, playlistItems twice — not channels.list twice.
        self.assertEqual(api.paths, ["channels", "playlistItems", "playlistItems"])
        self.assertEqual(ledger.spent, 1 + 2 * COST_PLAYLIST_ITEMS)

    def test_exhaustion_is_a_skip_not_a_failure(self):
        state: Dict[str, Any] = {"youtube": {"uploads": {"UCabc": "UUabc"}}}
        outcome = fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", spent=100, ceiling=100))
        # Nothing is wrong; there is simply no budget left.
        self.assertEqual(outcome.status, "skipped_interval")
        self.assertIn("units", outcome.reason)

    def test_one_bad_channel_does_not_sink_the_others(self):
        def boom(path, params, timeout):  # noqa: ANN001
            raise RuntimeError("channel is private")

        state: Dict[str, Any] = {}
        with mock.patch("pipeline.data.youtube._get", boom):
            outcome = fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", ceiling=100))
        self.assertEqual(outcome.status, "failed")
        self.assertIn("private", outcome.reason)


class EntryShapeTests(unittest.TestCase):
    def test_uploads_become_FeedEntry(self):
        """
        The same type the RSS connector emits.

        One entry shape means one extractor. A second shape would mean a second
        set of rules, and two sets of rules drift apart.
        """
        state: Dict[str, Any] = {}
        api = FakeApi(channels_payload(), items_payload("Salah OUT - confirmed"))
        with mock.patch("pipeline.data.youtube._get", api):
            outcome = fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", ceiling=100))
        entry = outcome.entries[0]
        self.assertIsInstance(entry, FeedEntry)
        self.assertEqual(entry.tier, 3)
        self.assertEqual(entry.feed, "letstalkfpl")
        self.assertTrue(entry.link.startswith("https://www.youtube.com/watch?v="))
        self.assertIn("Salah OUT", entry.text)

    def test_an_item_with_no_title_is_dropped(self):
        state: Dict[str, Any] = {}
        payload = {"items": [{"snippet": {"resourceId": {"videoId": "v1"}}}]}
        api = FakeApi(channels_payload(), payload)
        with mock.patch("pipeline.data.youtube._get", api):
            outcome = fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", ceiling=100))
        self.assertEqual(outcome.entries, [])

    def test_a_long_description_is_truncated(self):
        state: Dict[str, Any] = {}
        payload = {
            "items": [{
                "snippet": {
                    "title": "Team news",
                    "description": "x" * 5000,
                    "resourceId": {"videoId": "v1"},
                }
            }]
        }
        api = FakeApi(channels_payload(), payload)
        with mock.patch("pipeline.data.youtube._get", api):
            outcome = fetch_channel(CHANNEL, "key", state, Ledger("2026-08-08", ceiling=100))
        # Sponsor blurbs and chapter lists would otherwise swamp the extractor.
        self.assertLessEqual(len(outcome.entries[0].summary), 600)


class StorageCapTests(unittest.TestCase):
    """The terms require deletion within 30 days. Enforced, not intended."""

    def _state(self, **seen):
        return {"youtube": {"seen": dict(seen)}}

    def test_it_removes_records_past_the_cap(self):
        old = (NOW - timedelta(days=MAX_STORAGE_DAYS + 1)).isoformat().replace("+00:00", "Z")
        state = self._state(**{"youtube:old": old})
        self.assertEqual(prune(state, NOW), 1)
        self.assertEqual(state["youtube"]["seen"], {})

    def test_it_keeps_records_inside_the_cap(self):
        recent = (NOW - timedelta(days=2)).isoformat().replace("+00:00", "Z")
        state = self._state(**{"youtube:new": recent})
        self.assertEqual(prune(state, NOW), 0)
        self.assertIn("youtube:new", state["youtube"]["seen"])

    def test_a_record_with_no_timestamp_is_deleted(self):
        # We cannot prove it is inside the window, and the safe reading of
        # "delete within 30 days" is to delete.
        state = self._state(**{"youtube:mystery": None})
        self.assertEqual(prune(state, NOW), 1)

    def test_an_unparseable_timestamp_is_deleted(self):
        state = self._state(**{"youtube:junk": "not a date"})
        self.assertEqual(prune(state, NOW), 1)

    def test_the_cap_is_thirty_days(self):
        # A tuning knob would be a terms violation waiting to happen.
        self.assertEqual(MAX_STORAGE_DAYS, 30)


class PollTests(unittest.TestCase):
    def test_no_api_key_is_not_an_error(self):
        """Today's state. Every other news source must be unaffected."""
        result = poll([CHANNEL], {}, {}, NOW, api_key=None)
        self.assertIsNotNone(result.skipped)
        assert result.skipped is not None
        self.assertIn("YOUTUBE_API_KEY", result.skipped)
        self.assertEqual(result.entries, [])

    def test_no_channels_is_not_an_error(self):
        result = poll([], {}, {}, NOW, api_key="key")
        self.assertIsNotNone(result.skipped)

    def test_it_deduplicates_across_polls(self):
        state: Dict[str, Any] = {}
        config = {"daily_unit_ceiling": 100}

        api = FakeApi(channels_payload(), items_payload("Team news"))
        with mock.patch("pipeline.data.youtube._get", api):
            first = poll([CHANNEL], state, config, NOW, api_key="key")
        self.assertEqual(len(first.entries), 1)

        api = FakeApi(items_payload("Team news"))
        with mock.patch("pipeline.data.youtube._get", api):
            second = poll([CHANNEL], state, config, NOW, api_key="key")
        # The same upload seen twice is not news twice.
        self.assertEqual(second.entries, [])

    def test_it_prunes_on_every_poll(self):
        old = (NOW - timedelta(days=60)).isoformat().replace("+00:00", "Z")
        state: Dict[str, Any] = {"youtube": {"seen": {"youtube:ancient": old}}}
        api = FakeApi(channels_payload(), items_payload("Team news"))
        with mock.patch("pipeline.data.youtube._get", api):
            result = poll([CHANNEL], state, {"daily_unit_ceiling": 100}, NOW, api_key="key")
        # Not on a schedule: a policy enforced by a cron that has not run is
        # not enforced.
        self.assertEqual(result.pruned, 1)

    def test_it_reports_what_it_spent(self):
        state: Dict[str, Any] = {}
        api = FakeApi(channels_payload(), items_payload("Team news"))
        with mock.patch("pipeline.data.youtube._get", api):
            result = poll([CHANNEL], state, {"daily_unit_ceiling": 100}, NOW, api_key="key")
        self.assertEqual(result.units_spent, 2)
        self.assertEqual(state["youtube"]["ledger"]["spent"], 2)


class BurstTests(unittest.TestCase):
    ALIASES = {"Arsenal": ["Arsenal"], "Liverpool": ["Liverpool"]}

    @staticmethod
    def entry(feed: str, title: str) -> FeedEntry:
        return FeedEntry(
            feed=feed, tier=3, title=title, summary="", link="l",
            published_at=None, entry_id=f"{feed}:{title}",
        )

    def test_several_channels_on_one_club_is_a_burst(self):
        entries = [
            self.entry("a", "Arsenal team news"),
            self.entry("b", "Arsenal injury latest"),
            self.entry("c", "Arsenal press conference"),
        ]
        self.assertEqual(club_burst(entries, self.ALIASES), {"Arsenal": 3})

    def test_one_channel_posting_repeatedly_is_not(self):
        """
        The property that makes this a signal rather than a publishing habit.

        An implementation counting videos rather than distinct channels would
        report a content schedule as news.
        """
        entries = [self.entry("a", f"Arsenal video {i}") for i in range(6)]
        self.assertEqual(club_burst(entries, self.ALIASES), {})

    def test_the_threshold_is_honoured(self):
        entries = [
            self.entry("a", "Liverpool news"),
            self.entry("b", "Liverpool news"),
        ]
        self.assertEqual(club_burst(entries, self.ALIASES), {})
        self.assertEqual(
            club_burst(entries, self.ALIASES, threshold=2), {"Liverpool": 2},
        )

    def test_a_club_nobody_mentions_is_absent(self):
        entries = [self.entry("a", "Arsenal news")]
        self.assertNotIn("Liverpool", club_burst(entries, self.ALIASES, threshold=1))


if __name__ == "__main__":
    unittest.main()
