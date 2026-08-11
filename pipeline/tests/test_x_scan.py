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
