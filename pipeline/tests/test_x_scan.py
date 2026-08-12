"""
The X profile scan, tested against what the live page actually returned.

Every fixture below is a verbatim capture from `x.com/robtFPL` on 2026-08-11,
read logged-out through the Chrome MCP. That matters more than usual here: the
first attempt at this used `<time>` and `[data-testid="tweetText"]`, both of
which are absent from the logged-out view, and returned five posts with null
text and null timestamps while reporting success. A scraper tested against
invented markup passes forever and collects nothing.

The load-bearing assertions are the ones about timestamps and text boundaries,
because those are the two ways this can file a wrong claim rather than no claim.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from pipeline.data import x_scan
from pipeline.data.grok_feed import SHEET_COLUMNS, parse_sheet, validate

#: Verbatim `article.innerText.split('\n')` from the live page.
REAL_LINES = [
    "Rob T",
    "@robtFPL",
    "9 Aug",
    "Final one of the weekend - Liverpool summary from the Monaco friendly 👇",
    "",
    "First pre-season starts for Van Dijk, Gakpo & Alisson. Isak got an hour "
    "after 45' vs Leeds, same for Wirtz and Grav. Szobo and Frimpong both ~250 "
    "mins of pre-season minutes now.",
    "4", "5", "82", "18k",
]

#: The real status id for that post, and the time the page displayed for it.
REAL_ID = "2086478896937963659"
NOW = datetime(2026, 8, 11, 8, 0, tzinfo=timezone.utc)


def real_scan(**over):
    post = {"status_id": REAL_ID,
            "url": f"https://x.com/robtFPL/status/{REAL_ID}",
            "lines": REAL_LINES}
    post.update(over)
    return {"handle": "robtFPL", "posts": [post]}


class TimestampTests(unittest.TestCase):
    """
    The id is the clock.

    The page shows "9 Aug" — no year, no time. Rule 4 of the feed contract
    forbids inventing a timestamp, and a year-less date silently resolves to the
    wrong year every January.
    """

    def test_the_real_id_decodes_to_the_date_the_page_showed(self):
        stamp = x_scan.claimed_at(REAL_ID)
        self.assertIsNotNone(stamp)
        self.assertTrue(stamp.startswith("2026-08-09"), stamp)

    def test_it_decodes_to_the_exact_second_not_just_the_day(self):
        # Measured live: 2026-08-09T15:45:08.590Z. Truncated to whole seconds so
        # two reads of one post hash identically in the store.
        self.assertEqual(x_scan.claimed_at(REAL_ID), "2026-08-09T15:45:08Z")

    def test_a_later_id_is_a_later_time(self):
        # Monotonicity is the property that makes ordering by id meaningful.
        earlier = x_scan.claimed_at("2086121456807575553")
        later = x_scan.claimed_at(REAL_ID)
        self.assertLess(earlier, later)

    def test_the_output_is_utc_and_z_suffixed(self):
        stamp = x_scan.claimed_at(REAL_ID)
        self.assertTrue(stamp.endswith("Z"), stamp)
        self.assertNotIn("+00:00", stamp)

    def test_junk_returns_none_rather_than_a_guess(self):
        for bad in (None, "", "abc", "-1", "0", "12.5", [], {}):
            self.assertIsNone(x_scan.claimed_at(bad), repr(bad))

    def test_an_implausibly_small_id_is_refused(self):
        """
        The guard that had to be a floor date rather than an epoch comparison.

        Shifting a positive integer right yields a non-negative offset, so id
        `1` decodes to the epoch itself, not to something before it. The obvious
        `millis < EPOCH` check can therefore never fire, and this test is what
        caught that: it filed a claim dated 2010-11-04 and called it valid.
        """
        for tiny in ("1", "1000", "999999999999"):
            self.assertIsNone(x_scan.claimed_at(tiny), tiny)


class BodyTests(unittest.TestCase):
    """
    Where the post starts and stops.

    Both boundaries are found by shape. Indexing from the top breaks on a
    quote-tweet; indexing from the bottom breaks on a post with no replies.
    """

    def test_the_real_post_body_is_recovered_whole(self):
        body = x_scan.body_from_lines(REAL_LINES)
        self.assertTrue(body.startswith("Final one of the weekend"), body[:40])
        self.assertTrue(body.endswith("minutes now."), body[-30:])

    def test_the_authors_name_and_handle_are_not_part_of_the_claim(self):
        body = x_scan.body_from_lines(REAL_LINES)
        self.assertNotIn("@robtFPL", body)
        self.assertNotIn("Rob T", body)

    def test_the_date_line_is_not_part_of_the_claim(self):
        self.assertNotIn("9 Aug", x_scan.body_from_lines(REAL_LINES))

    def test_engagement_counters_are_not_part_of_the_claim(self):
        body = x_scan.body_from_lines(REAL_LINES)
        self.assertFalse(body.rstrip().endswith("18k"), body[-20:])
        for counter in ("18k", "82"):
            self.assertNotIn(f"\n{counter}", body)

    def test_a_post_with_no_engagement_still_keeps_its_last_line(self):
        # The failure mode of trimming a fixed number of trailing lines.
        lines = ["Rob T", "@robtFPL", "1h", "Salah is fit and starts tomorrow."]
        self.assertEqual(
            x_scan.body_from_lines(lines), "Salah is fit and starts tomorrow.",
        )

    def test_a_number_inside_the_body_is_not_mistaken_for_a_counter(self):
        # "90" as the final word of a real sentence must survive.
        lines = ["Rob T", "@robtFPL", "2h", "Gvardiol played the full 90", "3", "12"]
        self.assertEqual(
            x_scan.body_from_lines(lines), "Gvardiol played the full 90",
        )

    def test_internal_blank_lines_are_preserved(self):
        # robtFPL's posts are two paragraphs; collapsing them changes the quote.
        self.assertIn("\n\n", x_scan.body_from_lines(REAL_LINES))


class ItemTests(unittest.TestCase):
    def test_a_real_post_becomes_one_tier_three_unparsed_item(self):
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["tier"], 3)
        self.assertEqual(items[0]["claim_type"], "unparsed_news")

    def test_nothing_is_ever_filed_as_a_parsed_availability_value(self):
        """
        The whole safety argument.

        Regex-guessing "a knock for Shaw" into a chance_of_playing would be a
        fabricated number wearing a citation, and R4 lets a tier-2 claim push
        availability down. If this ever emits a structured claim type it needs a
        hand-labelled corpus first, like the RSS path has.
        """
        lines = ["Rob T", "@robtFPL", "1h",
                 "Early injury for Mount and a knock for Shaw. Mount is out for "
                 "six weeks, chance of playing 0%."]
        items = x_scan.to_items(
            real_scan(lines=lines), source="x:robtFPL", now=NOW,
        )
        self.assertEqual([i["claim_type"] for i in items], ["unparsed_news"])
        self.assertEqual(items[0]["player_surname"], "")

    def test_tier_is_never_two(self):
        # robtFPL is an aggregator, not a press conference. Tier 3 cannot raise
        # availability above FPL's own field.
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        self.assertTrue(all(i["tier"] == 3 for i in items))

    def test_a_stale_post_is_dropped(self):
        items = x_scan.to_items(
            real_scan(), source="x:robtFPL",
            now=datetime(2026, 9, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(items, [])

    def test_a_post_dated_in_the_future_is_dropped(self):
        # A clock skew or a decode error, either way not something to file.
        items = x_scan.to_items(
            real_scan(), source="x:robtFPL",
            now=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(items, [])

    def test_a_stub_post_is_dropped(self):
        items = x_scan.to_items(
            real_scan(lines=["Rob T", "@robtFPL", "1h", "👇"]),
            source="x:robtFPL", now=NOW,
        )
        self.assertEqual(items, [])

    def test_a_post_with_an_unusable_id_is_skipped_not_guessed(self):
        items = x_scan.to_items(
            real_scan(status_id="not-an-id"), source="x:robtFPL", now=NOW,
        )
        self.assertEqual(items, [])

    def test_a_non_https_url_is_refused(self):
        items = x_scan.to_items(
            real_scan(url="javascript:alert(1)"), source="x:robtFPL", now=NOW,
        )
        self.assertEqual(items, [])


class CsvTests(unittest.TestCase):
    """
    Commas, quotes and newlines in the body.

    A hand-rolled join produced a one-line file with zero parsable rows the
    first time this was done by hand, which is why `csv.writer` is used.
    """

    def test_a_body_with_commas_survives_a_round_trip(self):
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        text = x_scan.to_csv(items, SHEET_COLUMNS)
        parsed = parse_sheet(text)
        self.assertEqual(len(parsed["items"]), 1)
        self.assertEqual(parsed["items"][0]["value"], items[0]["value"])

    def test_a_body_with_a_double_quote_survives_a_round_trip(self):
        lines = ["Rob T", "@robtFPL", "1h",
                 'Arteta: "Saka is ready, he trains fully" - big news, per club.']
        items = x_scan.to_items(real_scan(lines=lines), source="x:robtFPL", now=NOW)
        parsed = parse_sheet(x_scan.to_csv(items, SHEET_COLUMNS))
        self.assertEqual(parsed["items"][0]["value"], items[0]["value"])

    def test_the_header_matches_the_feed_contract(self):
        text = x_scan.to_csv([], SHEET_COLUMNS)
        self.assertEqual(text.splitlines()[0], ",".join(SHEET_COLUMNS))


class ValidatorTests(unittest.TestCase):
    """
    The scan feeds the existing validator, not a parallel path.

    This is the assertion that keeps the three routes honest: sheet, API and
    browser scan all go through one set of gates, so the route with the least
    human review does not get the fewest checks.
    """

    def test_a_real_scanned_post_is_accepted(self):
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        result = validate(parse_sheet(x_scan.to_csv(items, SHEET_COLUMNS)), NOW)
        self.assertEqual(len(result.availability), 1, result.rejections)
        self.assertEqual(result.rejections, [])

    def test_a_club_level_post_needs_no_player(self):
        # The relaxation this required: a per-club minutes summary names six
        # players, so it has no single surname. It is `unparsed_news`, which
        # carries no machine-usable value and cannot move a projection.
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        self.assertEqual(items[0]["player_surname"], "")
        result = validate(parse_sheet(x_scan.to_csv(items, SHEET_COLUMNS)), NOW)
        self.assertEqual(len(result.availability), 1, result.rejections)

    def test_the_relaxation_did_not_open_the_structured_claim_types(self):
        """
        The relaxation must be narrow.

        A `chance_of_playing` with no player named is a number attached to
        nobody, and it CAN move a projection. It must still be rejected.
        """
        header = ",".join(SHEET_COLUMNS)
        row = ("availability,chance_of_playing,25,,Liverpool,3,x:robtFPL,"
               "he is a doubt for the weekend,,2026-08-09T15:45:08Z,,")
        result = validate(parse_sheet("\n".join([header, row])), NOW)
        self.assertEqual(len(result.availability), 0)
        self.assertEqual(len(result.rejections), 1)
        self.assertIn("player_surname", str(result.rejections[0]))


class FeedAttributionTests(unittest.TestCase):
    """
    A logged-in home timeline is many authors, and who said it is the whole claim.

    The profile scan needed no such thing: one page, one author, so the `source`
    argument described every row. Reading the user's own feed breaks that
    assumption, and breaking it quietly is the failure that matters here — the
    rows are `unparsed_news`, so their ONLY value is provenance. A feed of forty
    accounts all stamped `x:home-feed` is forty untraceable assertions, which is
    exactly what the manual claim lane exists to prevent.
    """

    def test_each_post_is_attributed_to_its_own_author(self):
        # `trusted` names both authors, because this test is about ATTRIBUTION and
        # nothing else. The relevance gate refuses an uncurated author on a
        # home-timeline surface, so without the injection this fixture would test
        # admissibility by accident and stop testing what it is named for. The
        # refusal itself is asserted below, and per-post in test_x_relevance.py.
        scan = {"handle": "home", "posts": [
            {"status_id": REAL_ID, "author": "robtFPL",
             "url": f"https://x.com/robtFPL/status/{REAL_ID}", "lines": REAL_LINES},
            {"status_id": "2086121456807575553", "author": "FPLHarry",
             "url": "https://x.com/FPLHarry/status/2086121456807575553",
             "lines": ["Harry", "@FPLHarry", "8 Aug",
                       "Arsenal have no fresh injury concerns ahead of the weekend.",
                       "3", "9"]},
        ]}
        items = x_scan.to_items(scan, source="x:home-feed", now=NOW,
                                trusted=("robtFPL", "FPLHarry"))
        self.assertEqual([i["source"] for i in items], ["x:robtFPL", "x:FPLHarry"])

    def test_an_uncurated_author_on_the_home_feed_is_dropped_not_filed(self):
        """
        The same fixture without the injection, which is the shipped behaviour.

        A home timeline is the whole non-football internet with two football posts
        in it (measured: 2 of 21, zero carrying team news). Trust is a property of
        the page we chose to open, so an author we never curated is refused even
        when the post reads like team news — a tier-3 claim can push availability
        DOWN under R4, and there is no cheap way to tell a real report from a
        rumour on a surface nobody vetted.
        """
        scan = {"handle": "home", "posts": [
            {"status_id": REAL_ID, "author": "robtFPL",
             "url": f"https://x.com/robtFPL/status/{REAL_ID}", "lines": REAL_LINES},
            {"status_id": "2086121456807575553", "author": "FPLHarry",
             "url": "https://x.com/FPLHarry/status/2086121456807575553",
             "lines": ["Harry", "@FPLHarry", "8 Aug",
                       "Arsenal have no fresh injury concerns ahead of the weekend.",
                       "3", "9"]},
        ]}
        items = x_scan.to_items(scan, source="x:home-feed", now=NOW)
        self.assertEqual([i["source"] for i in items], ["x:robtFPL"])

    def test_a_missing_author_falls_back_and_does_not_drop_the_post(self):
        # The extractor can only read an author from a status href. If the markup
        # changes, the post is still worth filing under the page it came from —
        # losing it entirely would be worse than a coarse attribution.
        items = x_scan.to_items(real_scan(), source="x:robtFPL", now=NOW)
        self.assertEqual(items[0]["source"], "x:robtFPL")

    def test_a_junk_author_is_not_written_into_the_source(self):
        """
        The author is interpolated into a provenance field, so its shape is checked.

        An X handle is 1-15 of `[A-Za-z0-9_]`. Anything else means the href did
        not have the shape assumed, and writing it through would put arbitrary
        page text into the field a human reads to decide whether to trust a row.
        """
        for bad in ("", "not a handle", "a/b", "x" * 16, "робт", "'; DROP"):
            items = x_scan.to_items(
                real_scan(author=bad), source="x:home-feed", now=NOW,
            )
            self.assertEqual(items[0]["source"], "x:home-feed", bad)

    def test_the_extractor_never_builds_a_url_from_the_pathname(self):
        """
        The defect this replaced, pinned so it cannot return.

        The first version built each URL as
        `'https://x.com/' + location.pathname.split('/')[1] + '/status/' + id`.
        On a profile that is right by coincidence. On `/home` it yields
        `https://x.com/home/status/<id>` for every row in the feed — a URL naming
        an author who does not exist, in the field that is supposed to be the
        citation.
        """
        source = x_scan.EXTRACT_JS
        self.assertNotIn("pathname.split('/')[1] + '/status/'", source)
        # And the replacement must take the author from the post's own link.
        self.assertIn("status", source)
        self.assertIn("author", source)

    def test_both_callers_still_read_the_one_extractor_file(self):
        # The reason the JS lives in a file at all: two copies of a scraper's
        # selectors drift, and the stale one returns zero posts and reports
        # success.
        from pathlib import Path
        mjs = Path(__file__).resolve().parents[2] / "scripts" / "x_scan.mjs"
        self.assertIn("x_extract.js", mjs.read_text(encoding="utf-8"))


class ClubPinTests(unittest.TestCase):
    """
    A `--club` pin describes the ACCOUNT, so it may only label that account's posts.

    `X_SCAN_ACCOUNTS` invites a pin for a club-specific account and `to_items` used
    to stamp it on every row. That was harmless while a scan was one author; once a
    page's trust extends to the reposts it amplifies, it writes a club that appears
    nowhere in the text. Measured: a `--club Arsenal` scan of robtFPL filed
    @SolioAnalytics, @OptaAnalyst and @FPL_Spaceman posts as Arsenal, none of which
    mention Arsenal.

    That is not cosmetic. The string lands in `AvailabilityClaim.notes` in the
    append-only evidence store, so it is a fabricated attribution that cannot be
    edited out afterwards. Latent under today's config — the one configured account
    has `club=None` — and fixed before a club-specific account makes it routine.
    """

    def _scan(self):
        return {"handle": "robtFPL", "profileRoot": True, "posts": [
            {"status_id": REAL_ID, "author": "robtFPL",
             "url": f"https://x.com/robtFPL/status/{REAL_ID}",
             "lines": ["Rob T", "@robtFPL", "9 Aug",
                       "Liverpool summary: first pre-season starts for Van Dijk."]},
            {"status_id": "2086471531001962819", "author": "SolioAnalytics",
             "url": "https://x.com/SolioAnalytics/status/2086471531001962819",
             "lines": ["Solio", "@SolioAnalytics", "9 Aug",
                       "Shot maps and set pieces: comparing chip strategy for GW1."]},
        ]}

    def _items(self, **over):
        return x_scan.to_items(
            self._scan(), source="x:robtFPL", now=NOW,
            trusted=("robtFPL", "SolioAnalytics"), **over,
        )

    def test_the_pin_labels_the_accounts_own_post(self):
        items = self._items(club="Arsenal")
        own = [i for i in items if i["source"] == "x:robtFPL"]
        self.assertEqual([i["club"] for i in own], ["Arsenal"])

    def test_the_pin_never_labels_another_authors_repost(self):
        items = self._items(club="Arsenal")
        others = [i for i in items if i["source"] != "x:robtFPL"]
        self.assertTrue(others, "the repost was dropped; this test proves nothing")
        for item in others:
            self.assertNotEqual(
                item["club"], "Arsenal",
                f"{item['source']} was branded Arsenal; its text does not "
                f"mention Arsenal: {item['value'][:60]!r}",
            )

    def test_a_repost_still_gets_its_own_detected_club(self):
        # Refusing to pin must not also refuse the honest label. `club_in` reads a
        # club only when the text literally names exactly one.
        scan = self._scan()
        scan["posts"][1]["lines"][3] = (
            "Chelsea shot maps and set pieces: comparing chip strategy for GW1."
        )
        items = x_scan.to_items(scan, source="x:robtFPL", now=NOW, club="Arsenal",
                                trusted=("robtFPL", "SolioAnalytics"))
        repost = [i for i in items if i["source"] == "x:SolioAnalytics"]
        self.assertEqual([i["club"] for i in repost], ["Chelsea"])

    def test_no_pin_means_detection_for_everyone(self):
        for item in self._items():
            self.assertNotEqual(item["club"], "Arsenal")


class InboxTests(unittest.TestCase):
    def _text(self, **over):
        return x_scan.to_csv(
            x_scan.to_items(real_scan(**over), source="x:robtFPL", now=NOW),
            SHEET_COLUMNS,
        )

    def test_rescanning_the_same_post_adds_no_row(self):
        # The reason this matters: the logged-out page shows the same five posts
        # all day, and the inbox is committed. Twice-daily scans would otherwise
        # grow it without bound.
        #
        # Counted as parsed rows, not as lines. A post body contains newlines, so
        # a correctly quoted CSV row spans several lines — counting lines made
        # this assert 4 != 2 against a file that was in fact correct.
        first = self._text()
        merged = x_scan.merge_inbox(first, first, SHEET_COLUMNS)
        self.assertEqual(len(parse_sheet(merged)["items"]), 1)

    def test_a_new_post_is_added(self):
        second = self._text(
            status_id="2086471531001962819",
            url="https://x.com/robtFPL/status/2086471531001962819",
        )
        merged = x_scan.merge_inbox(self._text(), second, SHEET_COLUMNS)
        self.assertEqual(len(parse_sheet(merged)["items"]), 2)

    def test_the_merged_inbox_still_parses(self):
        merged = x_scan.merge_inbox("", self._text(), SHEET_COLUMNS)
        self.assertEqual(len(parse_sheet(merged)["items"]), 1)

    def test_merging_into_an_empty_inbox_keeps_the_header(self):
        merged = x_scan.merge_inbox("", self._text(), SHEET_COLUMNS)
        self.assertEqual(merged.splitlines()[0], ",".join(SHEET_COLUMNS))

    def test_newest_first(self):
        # Both ids are real and both predate NOW. An earlier version used a
        # larger made-up id, which decoded to 2026-08-19 — the future relative to
        # NOW — so `to_items` correctly dropped it and the test indexed an empty
        # list. A fabricated id is not a safe stand-in when the id IS the clock.
        old = self._text(
            status_id="2086121456807575553",
            url="https://x.com/robtFPL/status/2086121456807575553",
        )
        new = self._text()
        merged = x_scan.merge_inbox(old, new, SHEET_COLUMNS)
        rows = parse_sheet(merged)["items"]
        self.assertGreater(rows[0]["claimed_at"], rows[1]["claimed_at"])

    def test_the_write_is_atomic(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "x_inbox.csv"
            x_scan.write_inbox(target, self._text())
            self.assertTrue(target.is_file())
            # No scratch file left behind for the poller to trip over.
            self.assertEqual(list(target.parent.glob("*.tmp")), [])


class ExtractorTests(unittest.TestCase):
    """
    The DOM read is a constant so it is reviewable; these pin what it must not do.
    """

    def test_it_does_not_use_selectors_the_logged_out_page_lacks(self):
        # Measured: `<time>` is absent and no `data-testid` attribute is emitted
        # in the logged-out view. Using either returns five null rows while
        # reporting success, which is the worst possible failure mode.
        self.assertNotIn("data-testid", x_scan.EXTRACT_JS)
        self.assertNotIn("querySelector('time'", x_scan.EXTRACT_JS)

    def test_it_reads_the_dom_and_derives_nothing(self):
        # Timestamps, tier and text boundaries are decided in Python, where they
        # are tested. The browser half must stay dumb.
        for derived in ("tier", "claim_type", "unparsed_news", "Date("):
            self.assertNotIn(derived, x_scan.EXTRACT_JS)

    def test_it_keys_on_the_status_permalink(self):
        self.assertIn("/status/", x_scan.EXTRACT_JS)
        self.assertIn("article", x_scan.EXTRACT_JS)


if __name__ == "__main__":
    unittest.main()


class SharedExtractorTests(unittest.TestCase):
    """
    One copy of the DOM read, two callers.

    `x_scan.py` uses it through the Chrome MCP in a Claude Code session;
    `scripts/x_scan.mjs` uses it under headless Playwright on the launchd
    schedule. If they ever hold separate copies, one goes stale and returns zero
    posts while reporting success — the exact failure this route is built to
    avoid, and the reason the JavaScript lives in its own file.
    """

    def _repo(self):
        from pathlib import Path
        return Path(__file__).resolve().parents[2]

    def test_the_javascript_lives_in_its_own_file(self):
        self.assertTrue(x_scan.EXTRACT_JS_PATH.is_file(), x_scan.EXTRACT_JS_PATH)

    def test_python_loads_it_rather_than_inlining_it(self):
        source = (self._repo() / "pipeline" / "data" / "x_scan.py").read_text(
            encoding="utf-8",
        )
        # The literal would be a second copy.
        self.assertNotIn('EXTRACT_JS = """', source)
        self.assertIn("EXTRACT_JS_PATH", source)

    def test_the_node_script_loads_the_same_file(self):
        script = (self._repo() / "scripts" / "x_scan.mjs").read_text(encoding="utf-8")
        self.assertIn("x_extract.js", script)
        # Reading it, not restating it.
        self.assertNotIn("querySelectorAll('article')", script)
        # And it must actually READ the path, not merely name it. Mutation testing
        # caught this: replacing the readFileSync call with an inline copy left the
        # unused EXTRACT_PATH constant in place, so a test that only looked for the
        # filename passed against a script that had its own second copy.
        self.assertIn('readFileSync(EXTRACT_PATH, "utf8")', script)
        self.assertIn("source.indexOf", script)

    def test_the_loaded_value_is_a_bare_function_expression(self):
        # `evaluate` needs an expression. A leaked comment line makes the whole
        # thing parse as a comment and return undefined.
        self.assertTrue(x_scan.EXTRACT_JS.startswith("() =>"), x_scan.EXTRACT_JS[:40])

    def test_the_node_script_invokes_the_function(self):
        """
        Measured: passing the bare arrow-function source to Playwright's
        `evaluate` returns the FUNCTION, not its result, so the run wrote
        `undefined` and crashed. The MCP path takes a callable directly, so this
        only bites the headless caller.
        """
        script = (self._repo() / "scripts" / "x_scan.mjs").read_text(encoding="utf-8")
        # The IIFE wrapper, stated plainly. An earlier version of this assertion
        # ran three chained `.replace` calls over the source before checking, which
        # was hard to read and easy to make pass by accident.
        self.assertIn("`(${extractSource})()`", script)
        self.assertNotIn("page.evaluate(extractSource)", script)

    def test_the_node_script_fails_loudly_on_zero_posts(self):
        # A scraper that returns nothing while exiting 0 is indistinguishable from
        # a quiet news day, and the whole route would rot unnoticed.
        script = (self._repo() / "scripts" / "x_scan.mjs").read_text(encoding="utf-8")
        self.assertIn("posts.length === 0", script)
        self.assertIn("process.exit(4)", script)

    def test_the_shell_wrapper_only_stages_paths_it_owns(self):
        # Three writers push to main on disjoint paths; staging everything would
        # turn a scan into a surprise commit of whatever else was dirty.
        wrapper = (self._repo() / "scripts" / "x_scan.sh").read_text(encoding="utf-8")
        self.assertIn('git add -- "${PATHS[@]}"', wrapper)
        self.assertNotIn("git add -A", wrapper)
        self.assertNotIn("git add .", wrapper)

    def test_the_shell_wrapper_autostashes_before_rebasing(self):
        # Measured on the first real run: the scan, merge, poll and commit all
        # succeeded and the push failed with "cannot pull with rebase: You have
        # unstaged changes", stranding the claims locally.
        wrapper = (self._repo() / "scripts" / "x_scan.sh").read_text(encoding="utf-8")
        self.assertIn("--autostash", wrapper)

    def test_both_callers_get_their_accounts_from_config(self):
        """
        One source of accounts, reached the same way by both callers.

        The local wrapper and the CI workflow each need the list. The wrapper used
        to embed a heredoc and the workflow another, which is two places to add an
        account and two places to get the quoting wrong — the workflow's version
        silently produced nothing. Both now call `scripts/list_accounts.py`.
        """
        helper = self._repo() / "scripts" / "list_accounts.py"
        self.assertTrue(helper.is_file())
        self.assertIn("X_SCAN_ACCOUNTS", helper.read_text(encoding="utf-8"))

        for caller in ("scripts/x_scan.sh", ".github/workflows/x_scan.yml"):
            text = (self._repo() / caller).read_text(encoding="utf-8")
            self.assertIn("list_accounts.py", text, caller)

    def test_no_handle_is_hardcoded_in_either_caller(self):
        # Adding an account must be a reviewable change to config, not an edit to a
        # script that runs unattended or to a workflow triggered from a web page.
        for caller in ("scripts/x_scan.sh", ".github/workflows/x_scan.yml"):
            text = (self._repo() / caller).read_text(encoding="utf-8")
            # The handle appears in prose/comments; what must not appear is a
            # command invoking the scanner against a literal account.
            self.assertNotIn("x_scan.mjs robtFPL", text, caller)

    def test_the_workflow_takes_no_injectable_input(self):
        """
        The workflow is meant to be triggered from a web page.

        Its first draft accepted a `handle` input and interpolated it into a `run:`
        block — shell injection with the value arriving from an HTTP request, and a
        way to point the runners at any X profile.
        """
        workflow = (self._repo() / ".github" / "workflows" / "x_scan.yml").read_text(
            encoding="utf-8",
        )
        self.assertNotIn("inputs.handle", workflow)
        self.assertNotIn("${{ inputs.", workflow)

    def test_the_workflow_has_no_schedule(self):
        # Deliberate: a cron would spend runner minutes re-reading the same five
        # posts. The owner triggers it.
        workflow = (self._repo() / ".github" / "workflows" / "x_scan.yml").read_text(
            encoding="utf-8",
        )
        self.assertNotIn("schedule:", workflow)
        self.assertIn("workflow_dispatch:", workflow)
