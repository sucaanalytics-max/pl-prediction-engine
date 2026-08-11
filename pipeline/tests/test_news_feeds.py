"""
The feed fetcher: conditional GET, intervals, size caps and failure policy.

No network. A fake session returns canned responses, because the behaviour worth
testing is what we send and how we react — not whether hayters.com is up.

The measured facts these tests encode, from a live pull of all six feeds:

    hayters.com                     ETag + Last-Modified
    allaboutfpl.com                 ETag + Last-Modified
    www.premierfantasytools.com     Last-Modified only
    www.fantasyfootballscout.co.uk  ETag + Last-Modified
    feeds.bbci.co.uk                NEITHER
    www.skysports.com               NEITHER

Two of six cannot be polled conditionally at all, which is why the per-host
minimum interval exists as well as the validators.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional

from pipeline.config import NEWS_FEEDS, NEWS_FETCH
from pipeline.data import news_feeds
from pipeline.data.news_feeds import (
    FAILURE_ESCALATION_THRESHOLD, FeedError, due, feeds_needing_escalation,
    fetch_all, fetch_one, host_of, load_state, min_interval_for, parse, recent,
    save_state,
)

NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test</title>
  <item>
    <title>Spurs boss gives update on Kulusevski</title>
    <description>&lt;p&gt;He is a couple of weeks away.&lt;/p&gt;</description>
    <link>https://example.invalid/a</link>
    <guid>guid-a</guid>
    <pubDate>Wed, 05 Aug 2026 13:30:00 GMT</pubDate>
  </item>
  <item>
    <title>Old news</title>
    <description>Something from last year</description>
    <link>https://example.invalid/b</link>
    <guid>guid-b</guid>
    <pubDate>Tue, 01 Jul 2025 09:00:00 GMT</pubDate>
  </item>
</channel></rss>
"""

ATOM = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom test</title>
  <entry>
    <title>Arteta on the squad</title>
    <summary>Everyone trained.</summary>
    <link href="https://example.invalid/atom-a"/>
    <id>atom-a</id>
    <updated>2026-08-05T10:00:00Z</updated>
  </entry>
</feed>
"""


class FakeResponse:
    def __init__(self, status_code: int, body: bytes = b"",
                 headers: Optional[Dict[str, str]] = None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size: int = 65_536):
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start:start + chunk_size]

    def close(self):
        self.closed = True


class FakeSession:
    """Records every request so the headers we SEND can be asserted."""

    def __init__(self, responses: List[FakeResponse]):
        self.responses = list(responses)
        self.requests: List[Dict[str, Any]] = []

    def get(self, url, headers=None, timeout=None, stream=None,
            allow_redirects=None):
        self.requests.append({
            "url": url, "headers": dict(headers or {}), "timeout": timeout,
            "stream": stream, "allow_redirects": allow_redirects,
        })
        return self.responses.pop(0)


FEED = {"name": "test", "url": "https://example.invalid/feed/", "tier": 2}


class ParseTests(unittest.TestCase):
    def test_parses_rss(self):
        entries = parse(RSS.encode(), "test", 2)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0].title, "Spurs boss gives update on Kulusevski")
        self.assertEqual(entries[0].tier, 2)

    def test_parses_atom(self):
        """
        Both formats, which is the reason feedparser is a dependency: RSS dates are
        RFC 822 and Atom dates are RFC 3339, and a date parsed wrongly misorders
        claims — which R2 breaks ties on.
        """
        entries = parse(ATOM.encode(), "test", 3)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].published_at, "2026-08-05T10:00:00Z")

    def test_normalises_rss_dates_to_iso_utc(self):
        entries = parse(RSS.encode(), "test", 2)
        self.assertEqual(entries[0].published_at, "2026-08-05T13:30:00Z")

    def test_strips_html_from_summaries(self):
        entries = parse(RSS.encode(), "test", 2)
        self.assertNotIn("<p>", entries[0].summary)
        self.assertIn("couple of weeks", entries[0].summary)

    def test_prefers_the_feeds_own_guid_for_identity(self):
        entries = parse(RSS.encode(), "test", 2)
        self.assertEqual(entries[0].entry_id, "guid-a")

    def test_an_unparseable_body_raises(self):
        with self.assertRaises(FeedError):
            parse(b"this is not xml at all, not even close", "test", 2)

    def test_a_partially_broken_feed_keeps_what_it_can(self):
        """One malformed entry must not cost the others."""
        broken = RSS.replace("</channel></rss>", "<item><title>Truncated")
        entries = parse(broken.encode(), "test", 2)
        self.assertGreaterEqual(len(entries), 2)

    def test_an_entry_with_no_title_or_summary_is_dropped(self):
        empty = """<?xml version="1.0"?><rss version="2.0"><channel>
          <item><link>https://example.invalid/x</link></item></channel></rss>"""
        self.assertEqual(parse(empty.encode(), "test", 2), [])


class RecencyTests(unittest.TestCase):
    def test_drops_entries_past_the_window(self):
        entries = parse(RSS.encode(), "test", 2)
        kept = recent(entries, NOW, max_age_days=10)
        titles = [e.title for e in kept]
        self.assertIn("Spurs boss gives update on Kulusevski", titles)
        self.assertNotIn("Old news", titles)

    def test_keeps_an_entry_with_no_timestamp(self):
        """
        It cannot be shown to be old, and the store deduplicates by content — so
        keeping it costs one redundant extraction while dropping it loses every
        claim from a feed that omits dates.
        """
        entries = parse(ATOM.encode().replace(
            b"<updated>2026-08-05T10:00:00Z</updated>", b""), "test", 2)
        self.assertEqual(len(recent(entries, NOW, max_age_days=1)), len(entries))

    def test_a_feed_that_has_gone_quiet_yields_nothing(self):
        """
        The age filter is what makes a stalled source harmless rather than
        misleading. Measured case: allaboutfpl's /category/ endpoints stopped in
        late 2025 while the site itself kept posting daily, so a category feed
        looked like a live source with no news. The config now points at the site
        feed; this pins the behaviour that made the mistake survivable.
        """
        stale = RSS.replace("Wed, 05 Aug 2026 13:30:00 GMT",
                            "Thu, 02 Oct 2025 19:38:31 GMT")
        entries = parse(stale.encode(), "some_feed", 2)
        self.assertEqual(recent(entries, NOW, max_age_days=10), [])


class IntervalTests(unittest.TestCase):
    def test_hosts_without_validators_get_a_longer_interval(self):
        """
        BBC and Sky return no ETag and no Last-Modified, so every poll is a full
        download. The interval is the only brake.
        """
        bbc = min_interval_for("https://feeds.bbci.co.uk/sport/football/rss.xml",
                               NEWS_FETCH)
        default = min_interval_for("https://hayters.com/feed/", NEWS_FETCH)
        self.assertGreater(bbc, default)

    def test_host_is_extracted_for_the_lookup(self):
        self.assertEqual(host_of("https://hayters.com/feed/"), "hayters.com")

    def test_a_feed_never_polled_is_due(self):
        ready, _ = due(FEED, {}, NEWS_FETCH, NOW)
        self.assertTrue(ready)

    def test_a_feed_polled_a_moment_ago_is_not_due(self):
        state = {"last_attempt_at": (NOW - timedelta(seconds=30)).isoformat()}
        ready, why = due(FEED, state, NEWS_FETCH, NOW)
        self.assertFalse(ready)
        self.assertIn("until next poll", why)

    def test_the_interval_is_measured_from_the_ATTEMPT_not_the_success(self):
        """
        Otherwise a failing feed is retried on every one of 96 daily ticks, which
        is exactly the behaviour that gets a client blocked.
        """
        state = {"last_attempt_at": (NOW - timedelta(seconds=30)).isoformat(),
                 "last_success_at": (NOW - timedelta(days=5)).isoformat()}
        ready, _ = due(FEED, state, NEWS_FETCH, NOW)
        self.assertFalse(ready)

    def test_an_unparseable_last_attempt_errs_toward_polling(self):
        ready, _ = due(FEED, {"last_attempt_at": "nonsense"}, NEWS_FETCH, NOW)
        self.assertTrue(ready)


class ConditionalGetTests(unittest.TestCase):
    def test_sends_no_validators_on_a_first_fetch(self):
        session = FakeSession([FakeResponse(200, RSS.encode())])
        state: Dict[str, Any] = {}
        fetch_one(FEED, state, NEWS_FETCH, NOW, session=session)
        sent = session.requests[0]["headers"]
        self.assertNotIn("If-None-Match", sent)
        self.assertNotIn("If-Modified-Since", sent)

    def test_stores_and_then_replays_both_validators(self):
        session = FakeSession([
            FakeResponse(200, RSS.encode(),
                         {"ETag": 'W/"abc"', "Last-Modified": "Wed, 05 Aug 2026 13:30:00 GMT"}),
            FakeResponse(304),
        ])
        state: Dict[str, Any] = {}
        fetch_one(FEED, state, NEWS_FETCH, NOW, session=session)
        later = NOW + timedelta(hours=2)
        outcome = fetch_one(FEED, state, NEWS_FETCH, later, session=session)

        sent = session.requests[1]["headers"]
        self.assertEqual(sent["If-None-Match"], 'W/"abc"')
        self.assertEqual(sent["If-Modified-Since"], "Wed, 05 Aug 2026 13:30:00 GMT")
        self.assertEqual(outcome.status, "not_modified")
        self.assertEqual(outcome.entries, [])

    def test_a_304_parses_nothing(self):
        session = FakeSession([FakeResponse(304)])
        outcome = fetch_one(FEED, {}, NEWS_FETCH, NOW, session=session)
        self.assertEqual(outcome.status, "not_modified")
        self.assertEqual(outcome.entries, [])

    def test_a_304_clears_the_failure_streak(self):
        session = FakeSession([FakeResponse(304)])
        state = {"feeds": {"test": {"failures": 3}}}
        fetch_one(FEED, state, NEWS_FETCH, NOW, session=session)
        self.assertEqual(state["feeds"]["test"]["failures"], 0)

    def test_a_validator_is_not_stored_when_the_body_could_not_be_parsed(self):
        """
        Storing one would make the next poll a 304 and skip the feed forever — a
        single bad response silently retiring a source.
        """
        session = FakeSession([FakeResponse(200, b"not xml", {"ETag": 'W/"bad"'})])
        state: Dict[str, Any] = {}
        outcome = fetch_one(FEED, state, NEWS_FETCH, NOW, session=session)
        self.assertEqual(outcome.status, "failed")
        self.assertNotIn("etag", state["feeds"]["test"])

    def test_does_not_follow_redirects(self):
        session = FakeSession([FakeResponse(200, RSS.encode())])
        fetch_one(FEED, {}, NEWS_FETCH, NOW, session=session)
        self.assertFalse(session.requests[0]["allow_redirects"])

    def test_a_redirect_is_reported_as_a_move_rather_than_absorbed(self):
        """
        NEWS_FEEDS holds post-redirect URLs. A redirect now means the feed MOVED,
        and absorbing it silently would hide that and double every request.
        """
        session = FakeSession([
            FakeResponse(301, headers={"Location": "https://elsewhere.invalid/feed"}),
        ])
        outcome = fetch_one(FEED, {}, NEWS_FETCH, NOW, session=session)
        self.assertEqual(outcome.status, "failed")
        self.assertIn("moved", outcome.reason)
        self.assertIn("elsewhere.invalid", outcome.reason)


class SizeCapTests(unittest.TestCase):
    def test_an_oversized_body_is_refused_before_parsing(self):
        big = b"<rss>" + b"x" * 5_000_000
        session = FakeSession([FakeResponse(200, big)])
        outcome = fetch_one(FEED, {}, {**NEWS_FETCH, "max_bytes": 1000},
                            NOW, session=session)
        self.assertEqual(outcome.status, "failed")
        self.assertIn("exceeded", outcome.reason)

    def test_a_body_within_the_cap_is_parsed(self):
        session = FakeSession([FakeResponse(200, RSS.encode())])
        outcome = fetch_one(FEED, {}, NEWS_FETCH, NOW, session=session)
        self.assertEqual(outcome.status, "fetched")
        self.assertTrue(outcome.entries)

    def test_the_response_is_always_closed(self):
        response = FakeResponse(200, RSS.encode())
        session = FakeSession([response])
        fetch_one(FEED, {}, NEWS_FETCH, NOW, session=session)
        self.assertTrue(response.closed)


class FailurePolicyTests(unittest.TestCase):
    def test_a_transport_error_is_a_failure_not_an_exception(self):
        class Boom:
            def get(self, *a, **k):
                raise OSError("connection reset")
        outcome = fetch_one(FEED, {}, NEWS_FETCH, NOW, session=Boom())
        self.assertEqual(outcome.status, "failed")
        self.assertIn("connection reset", outcome.reason)

    def test_failures_accumulate_and_successes_clear_them(self):
        state: Dict[str, Any] = {}
        class Boom:
            def get(self, *a, **k):
                raise OSError("down")
        for expected in (1, 2, 3):
            outcome = fetch_one(FEED, state, {**NEWS_FETCH, "min_interval_seconds": {}},
                                NOW, session=Boom())
            self.assertEqual(outcome.consecutive_failures, expected)

        session = FakeSession([FakeResponse(200, RSS.encode())])
        fetch_one(FEED, state, {**NEWS_FETCH, "min_interval_seconds": {}},
                  NOW, session=session)
        self.assertEqual(state["feeds"]["test"]["failures"], 0)

    def test_one_failing_feed_does_not_stop_the_others(self):
        class Mixed:
            def __init__(self):
                self.n = 0
            def get(self, url, **k):
                self.n += 1
                if self.n == 1:
                    raise OSError("first one down")
                return FakeResponse(200, RSS.encode())
        feeds = [
            {"name": "a", "url": "https://a.invalid/f", "tier": 2},
            {"name": "b", "url": "https://b.invalid/f", "tier": 3},
        ]
        outcomes = fetch_all(feeds, {}, {**NEWS_FETCH, "min_interval_seconds": {}},
                             NOW, session=Mixed())
        self.assertEqual([o.status for o in outcomes], ["failed", "fetched"])

    def test_a_single_failure_does_not_escalate(self):
        outcomes = [news_feeds.FeedOutcome(feed="a", status="failed",
                                          consecutive_failures=1)]
        self.assertEqual(feeds_needing_escalation(outcomes), [])

    def test_a_persistent_failure_does_escalate(self):
        """
        The distinction that matters: one failure is noise on a small site polled 96
        times a day; a sustained one means the news layer has stopped working while
        the app still shows a healthy agent.
        """
        outcomes = [news_feeds.FeedOutcome(
            feed="a", status="failed",
            consecutive_failures=FAILURE_ESCALATION_THRESHOLD)]
        self.assertEqual(len(feeds_needing_escalation(outcomes)), 1)


class StateTests(unittest.TestCase):
    def test_round_trips(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_state({"feeds": {"a": {"etag": "x"}}}, root)
            self.assertEqual(load_state(root)["feeds"]["a"]["etag"], "x")

    def test_a_missing_state_file_is_empty_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(load_state(Path(tmp))["feeds"], {})

    def test_a_corrupt_state_file_degrades_to_empty(self):
        """
        Losing the validators costs one unconditional fetch per feed. Refusing to
        poll loses perishable team news outright.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / news_feeds.STATE_FILENAME).write_text("{not json")
            self.assertEqual(load_state(root)["feeds"], {})

    def test_a_state_file_with_no_feeds_map_degrades_to_empty(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / news_feeds.STATE_FILENAME).write_text('{"version": 1}')
            self.assertEqual(load_state(root)["feeds"], {})


class ConfiguredFeedsTests(unittest.TestCase):
    """
    The live table. Tier assignment is a safety property, not a preference: under
    R4 a tier-2 claim may push availability DOWN, so a feed at the wrong tier is a
    bug that benches players.
    """

    def test_every_feed_has_the_required_fields(self):
        for feed in NEWS_FEEDS:
            with self.subTest(feed=feed.get("name")):
                self.assertIn("name", feed)
                self.assertIn("url", feed)
                self.assertIn("tier", feed)
                self.assertIn("note", feed)

    def test_no_feed_claims_tier_one(self):
        """Tier 1 is FPL's own fields. A press feed outranking FPL under R3 would
        let a headline overwrite the official status."""
        for feed in NEWS_FEEDS:
            with self.subTest(feed=feed["name"]):
                self.assertGreaterEqual(feed["tier"], 2)
                self.assertLessEqual(feed["tier"], 3)

    def test_only_the_press_agency_is_tier_two(self):
        """
        Tier 2 is "press conference, club statement" — the room itself. Hayters'
        reporters are in it; everyone else in this table is reporting on it, which
        is tier 3's "aggregator, predicted lineup".
        """
        tier2 = {f["name"] for f in NEWS_FEEDS if f["tier"] == 2}
        self.assertEqual(tier2, {"hayters"})

    def test_broad_outlets_are_tier_three(self):
        """
        BBC and Sky are primary outlets but their feeds are league-wide sport news,
        so an item is usually not team news at all and the extractor cannot
        establish that it is.
        """
        by_name = {f["name"]: f["tier"] for f in NEWS_FEEDS}
        self.assertEqual(by_name["bbc_football"], 3)
        self.assertEqual(by_name["sky_football"], 3)

    def test_feed_names_are_unique(self):
        names = [f["name"] for f in NEWS_FEEDS]
        self.assertEqual(len(set(names)), len(names))

    def test_urls_are_unique_and_https(self):
        urls = [f["url"] for f in NEWS_FEEDS]
        self.assertEqual(len(set(urls)), len(urls))
        for url in urls:
            self.assertTrue(url.startswith("https://"), url)

    def test_no_excluded_source_has_crept_in(self):
        """
        premierinjuries is barred by its terms and YouTube transcripts by four
        clauses. Asserted so a future edit has to argue with a test.
        """
        joined = " ".join(f["url"] for f in NEWS_FEEDS)
        for barred in ("premierinjuries", "youtube.com", "youtu.be"):
            self.assertNotIn(barred, joined)

    def test_api_premierleague_is_not_a_news_feed(self):
        joined = " ".join(f["url"] for f in NEWS_FEEDS)
        self.assertNotIn("api.premierleague.com", joined)

    def test_no_feed_points_at_a_category_endpoint(self):
        """
        Category feeds were the obvious choice for allaboutfpl and the wrong one:
        the site posts daily while its /category/fpl-press-conference-updates/ and
        /category/fpl-injury-news/ feeds stopped in late 2025, and
        /category/fpl-team-news/ 404s. A dormant category endpoint reads as a
        working source that simply has no news.
        """
        for feed in NEWS_FEEDS:
            with self.subTest(feed=feed["name"]):
                self.assertNotIn("/category/", feed["url"])


if __name__ == "__main__":
    unittest.main()
