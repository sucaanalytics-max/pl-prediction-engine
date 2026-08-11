"""
The Grok/X feed validator.

## What it is defending

A language model's reading of a post, entering a store whose claims can lower a
real player's projected minutes through R4.

Every rule mirrors a gate in `file_claim.py`. The value of validating here is
that failure is loud and carries an item index, where a claim that slips through
is dropped silently at resolution — recorded successfully, then gone.

## The two it cannot fix, and does not pretend to

**A fluent invention passes.** Nothing here distinguishes a real quote from a
convincing one. What the design does instead is cap what an unverifiable claim
can affect: tier 2 requires a quote at all, and the contract tells Grok to drop
to tier 3 without one. That is containment, not verification, and the schema doc
says so.

**A plausible-but-wrong timestamp passes** if it is in the past. Only the future
is checkable.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.data.grok_feed import (
    CLAIM_TYPES, COMPARATOR_METRICS, SCHEMA_VERSION, TIERS,
    check_value, validate,
)

NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)
EARLIER = (NOW - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
LATER = (NOW + timedelta(hours=3)).isoformat().replace("+00:00", "Z")


def availability(**over):
    item = {
        "lane": "availability",
        "claim_type": "chance_of_playing",
        "value": 25,
        "player_surname": "Rogers",
        "club": "Aston Villa",
        "tier": 2,
        "source": "robtFPL",
        "quote": "Rogers is a doubt for the weekend, Emery confirmed",
        "url": "https://x.com/robtFPL/status/1234567890",
        "claimed_at": EARLIER,
    }
    item.update(over)
    return {k: v for k, v in item.items() if v is not None}


def comparator(**over):
    item = {
        "lane": "comparator",
        "metric": "projected_points",
        "value": 6.4,
        "player_surname": "Rogers",
        "club": "Aston Villa",
        "source": "robtFPL",
        "claimed_at": EARLIER,
    }
    item.update(over)
    return {k: v for k, v in item.items() if v is not None}


def feed(*items, version=SCHEMA_VERSION):
    return {"schema_version": version, "generated_at": EARLIER, "items": list(items)}


class HappyPathTests(unittest.TestCase):
    def test_a_well_formed_availability_item_survives(self):
        result = validate(feed(availability()), NOW)
        self.assertTrue(result.ok, [str(r) for r in result.rejections])
        self.assertEqual(len(result.availability), 1)

    def test_a_well_formed_comparator_item_survives(self):
        result = validate(feed(comparator()), NOW)
        self.assertTrue(result.ok, [str(r) for r in result.rejections])
        self.assertEqual(len(result.comparator), 1)

    def test_the_two_lanes_stay_separate(self):
        result = validate(feed(availability(), comparator()), NOW)
        self.assertEqual(len(result.availability), 1)
        self.assertEqual(len(result.comparator), 1)

    def test_an_empty_feed_is_valid(self):
        # "I found nothing" is a correct answer and better than a guess.
        result = validate(feed(), NOW)
        self.assertTrue(result.ok)


class ProvenanceTests(unittest.TestCase):
    """R0 drops a tier-2+ claim with no digest, so it must never be filed."""

    def test_neither_quote_nor_url_is_rejected(self):
        result = validate(feed(availability(quote=None, url=None)), NOW)
        self.assertFalse(result.ok)
        self.assertIn("R0", str(result.rejections[0]))

    def test_a_url_alone_is_enough(self):
        self.assertTrue(validate(feed(availability(quote=None)), NOW).ok)

    def test_a_quote_alone_is_enough(self):
        self.assertTrue(validate(feed(availability(url=None)), NOW).ok)

    def test_a_one_word_quote_is_not_a_quote(self):
        # MIN_QUOTE exists to reject "out" and "yes" — fragments that carry
        # nothing auditable — while accepting a genuinely terse one. An earlier
        # version of this test asserted that "he's out" should fail, which
        # contradicts that stated purpose: eight characters of a manager saying
        # a player is out IS the claim.
        for fragment in ("out", "yes", "doubt"):
            self.assertFalse(
                validate(feed(availability(quote=fragment, url=None)), NOW).ok,
                f"{fragment!r} is not a quote",
            )

    def test_a_terse_but_real_quote_is_accepted(self):
        self.assertTrue(validate(feed(availability(quote="he's out", url=None)), NOW).ok)

    def test_a_non_http_url_is_rejected(self):
        result = validate(feed(availability(quote=None, url="x.com/robtFPL")), NOW)
        self.assertFalse(result.ok)


class TimestampTests(unittest.TestCase):
    def test_a_future_claim_is_rejected(self):
        # Recency decides R2's tie-break.
        result = validate(feed(availability(claimed_at=LATER)), NOW)
        self.assertFalse(result.ok)
        self.assertIn("future", str(result.rejections[0]))

    def test_an_unparseable_timestamp_is_rejected(self):
        result = validate(feed(availability(claimed_at="last Tuesday")), NOW)
        self.assertFalse(result.ok)

    def test_a_naive_timestamp_is_read_as_utc(self):
        result = validate(feed(availability(claimed_at="2026-08-11T09:00:00")), NOW)
        self.assertTrue(result.ok, [str(r) for r in result.rejections])


class ValueShapeTests(unittest.TestCase):
    """Mirrors coerce_value. A wrong shape resolves wrongly rather than erroring."""

    def test_a_percentage_string_is_rejected(self):
        self.assertIsNotNone(check_value("chance_of_playing", "25%"))
        self.assertIsNotNone(check_value("chance_of_playing", "25"))

    def test_a_percentage_out_of_range_is_rejected(self):
        self.assertIsNotNone(check_value("chance_of_playing", 150))

    def test_true_is_not_a_percentage(self):
        # bool is an int in Python; True would compare as 1 against FPL's field.
        self.assertIsNotNone(check_value("chance_of_playing", True))

    def test_permanent_exit_must_be_a_mapping(self):
        # R0 checks for a Mapping with "kind" and silently drops anything else,
        # so a bare string would be recorded and then vanish.
        self.assertIsNotNone(check_value("permanent_exit", "transfer"))
        self.assertIsNone(check_value("permanent_exit", {"kind": "transfer"}))

    def test_permanent_exit_kind_is_closed(self):
        self.assertIsNotNone(check_value("permanent_exit", {"kind": "retired"}))

    def test_dates_must_be_iso_days(self):
        self.assertIsNone(check_value("return_date", "2026-09-14"))
        self.assertIsNotNone(check_value("return_date", "14/09/2026"))
        self.assertIsNotNone(check_value("return_date", "2026-09-14T00:00:00Z"))

    def test_an_impossible_date_is_rejected(self):
        self.assertIsNotNone(check_value("return_date", "2026-02-30"))

    def test_expected_minutes_is_bounded_by_the_match(self):
        self.assertIsNone(check_value("expected_minutes", 62.5))
        self.assertIsNotNone(check_value("expected_minutes", 120))

    def test_free_text_must_still_be_text(self):
        self.assertIsNone(check_value("severity", "hamstring, 4-6 weeks"))
        self.assertIsNotNone(check_value("severity", ""))
        self.assertIsNotNone(check_value("unparsed_news", None))


class TierTests(unittest.TestCase):
    def test_tier_one_is_refused(self):
        # It would outrank FPL under R3 while carrying less authority.
        result = validate(feed(availability(tier=1)), NOW)
        self.assertFalse(result.ok)
        self.assertIn("Tier 1", str(result.rejections[0]))

    def test_only_two_and_three_are_available(self):
        self.assertEqual(TIERS, (2, 3))
        for tier in (0, 1, 4):
            self.assertFalse(validate(feed(availability(tier=tier)), NOW).ok)

    def test_a_comparator_may_not_carry_a_tier(self):
        # A tier implies it can win a resolution. It cannot.
        result = validate(feed(comparator(tier=2)), NOW)
        self.assertFalse(result.ok)
        self.assertIn("cannot beat a claim", str(result.rejections[0]))


class ClaimTypeTests(unittest.TestCase):
    def test_the_fileable_set_is_closed(self):
        result = validate(feed(availability(claim_type="status")), NOW)
        self.assertFalse(result.ok)
        self.assertIn("FPL's own field", str(result.rejections[0]))

    def test_predicted_start_is_not_fileable(self):
        result = validate(feed(availability(claim_type="predicted_start")), NOW)
        self.assertFalse(result.ok)

    def test_it_matches_the_manual_lane(self):
        from pipeline.learning.file_claim import FILEABLE, MANUAL_TIERS
        # Drift here would let the feed accept what the filer then refuses.
        self.assertEqual(set(CLAIM_TYPES), set(FILEABLE))
        self.assertEqual(set(TIERS), set(MANUAL_TIERS))


class LaneTests(unittest.TestCase):
    def test_a_missing_lane_is_rejected_not_inferred(self):
        item = availability()
        del item["lane"]
        result = validate(feed(item), NOW)
        self.assertFalse(result.ok)
        self.assertIn("lane", str(result.rejections[0]))

    def test_an_unknown_lane_is_rejected(self):
        self.assertFalse(validate(feed(availability(lane="gossip")), NOW).ok)


class RobustnessTests(unittest.TestCase):
    def test_one_bad_item_does_not_take_the_good_ones(self):
        result = validate(feed(availability(), availability(tier=1), comparator()), NOW)
        self.assertEqual(len(result.availability), 1)
        self.assertEqual(len(result.comparator), 1)
        self.assertEqual(len(result.rejections), 1)

    def test_every_rejection_carries_its_index(self):
        # A 60-item file has to be correctable without guesswork.
        result = validate(feed(availability(), availability(tier=1)), NOW)
        self.assertEqual(result.rejections[0].index, 1)
        self.assertIn("items[1]", str(result.rejections[0]))

    def test_a_wrong_schema_version_stops_everything(self):
        result = validate(feed(availability(), version=99), NOW)
        self.assertFalse(result.ok)
        self.assertEqual(result.availability, [])

    def test_junk_never_raises(self):
        for junk in (None, [], "a string", 42, {"items": "not a list"}):
            result = validate(junk, NOW)
            self.assertFalse(result.ok)


class SchemaFileTests(unittest.TestCase):
    """The published schema and the runtime must not drift."""

    SCHEMA = (
        Path(__file__).resolve().parents[1]
        / "data" / "schemas" / "grok_x_feed.schema.json"
    )

    def test_it_parses(self):
        self.assertTrue(json.loads(self.SCHEMA.read_text(encoding="utf-8")))

    def test_the_claim_types_agree(self):
        schema = json.loads(self.SCHEMA.read_text(encoding="utf-8"))
        published = schema["$defs"]["availability"]["properties"]["claim_type"]["enum"]
        self.assertEqual(set(published), set(CLAIM_TYPES))

    def test_the_tiers_agree(self):
        schema = json.loads(self.SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(
            set(schema["$defs"]["availability"]["properties"]["tier"]["enum"]),
            set(TIERS),
        )

    def test_the_metrics_agree(self):
        schema = json.loads(self.SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(
            set(schema["$defs"]["comparator"]["properties"]["metric"]["enum"]),
            set(COMPARATOR_METRICS),
        )

    def test_the_doc_exists_and_carries_the_prompt(self):
        doc = self.SCHEMA.parents[3] / "docs" / "grok-x-feed-schema.md"
        self.assertTrue(doc.exists(), "the schema doc is the contract")
        text = doc.read_text(encoding="utf-8")
        # The prompt is the part that actually reaches Grok; without it the
        # document describes a format nobody is asked to produce.
        self.assertIn("word-for-word", text)
        self.assertIn("comparator", text)


if __name__ == "__main__":
    unittest.main()


class SheetTests(unittest.TestCase):
    """
    A published Google Sheet, which is the recommended shape.

    A spreadsheet is flat and everything in it is a string, so the adapter has
    to restore the types the validator checks. The one that matters is
    `permanent_exit`: R0 needs a Mapping with `kind`, and asking anyone to type
    `{"kind": "transfer"}` into a cell produces a broken JSON string far more
    often than a correct one — so the cell holds a word and the nesting is built
    here.
    """

    HEADER = ("lane,claim_type,value,player_surname,club,tier,source,quote,url,"
              "claimed_at,metric,horizon_gameweeks")

    def sheet(self, *rows):
        from pipeline.data.grok_feed import parse_sheet
        return parse_sheet("\n".join((self.HEADER, *rows)))

    def test_a_doubt_row_becomes_a_claim(self):
        payload = self.sheet(
            f"availability,chance_of_playing,25,Rogers,Aston Villa,2,robtFPL,"
            f"Rogers is a doubt for the weekend,https://x.com/a,{EARLIER},,"
        )
        result = validate(payload, NOW)
        self.assertTrue(result.ok, [str(r) for r in result.rejections])
        self.assertEqual(result.availability[0]["value"], 25)

    def test_a_percentage_cell_is_read_as_an_integer(self):
        # A spreadsheet will happily hold "25%"; the store must not.
        payload = self.sheet(
            f"availability,chance_of_playing,25%,Rogers,Aston Villa,2,robtFPL,"
            f"a doubt for the weekend,https://x.com/a,{EARLIER},,"
        )
        self.assertEqual(payload["items"][0]["value"], 25)

    def test_permanent_exit_is_nested_from_a_bare_word(self):
        payload = self.sheet(
            f"availability,permanent_exit,transfer,Solomon,Tottenham,3,BBC,,"
            f"https://bbc.co.uk/a,{EARLIER},,"
        )
        self.assertEqual(payload["items"][0]["value"], {"kind": "transfer"})
        self.assertTrue(validate(payload, NOW).ok)

    def test_a_comparator_row_carries_no_tier_or_claim_type(self):
        payload = self.sheet(
            f"comparator,,6.4,Salah,Liverpool,,robtFPL,,https://x.com/b,"
            f"{EARLIER},projected_points,1"
        )
        result = validate(payload, NOW)
        self.assertTrue(result.ok, [str(r) for r in result.rejections])
        self.assertEqual(result.comparator[0]["value"], 6.4)
        self.assertEqual(result.comparator[0]["horizon_gameweeks"], 1)

    def test_empty_cells_are_absent_rather_than_empty_strings(self):
        # A missing required field must read as missing, not as "".
        payload = self.sheet(
            f"availability,chance_of_playing,25,Rogers,Aston Villa,2,robtFPL,,"
            f"https://x.com/a,{EARLIER},,"
        )
        self.assertNotIn("quote", payload["items"][0])
        self.assertNotIn("metric", payload["items"][0])

    def test_a_quote_containing_a_comma_survives(self):
        payload = self.sheet(
            f'availability,severity,hamstring,Rogers,Aston Villa,2,robtFPL,'
            f'"He is out, probably four weeks",https://x.com/a,{EARLIER},,'
        )
        self.assertEqual(
            payload["items"][0]["quote"], "He is out, probably four weeks",
        )

    def test_an_unknown_column_is_ignored(self):
        from pipeline.data.grok_feed import parse_sheet
        payload = parse_sheet(
            self.HEADER + ",my_notes\n"
            f"availability,chance_of_playing,25,Rogers,Aston Villa,2,robtFPL,"
            f"a doubt for the weekend,https://x.com/a,{EARLIER},,,check this"
        )
        self.assertTrue(validate(payload, NOW).ok)

    def test_an_uncoercible_cell_is_left_for_the_validator_to_reject(self):
        # Not coerced to None and not dropped: a claim that looks filed and is
        # missing is worse than one rejected with a reason naming its row.
        payload = self.sheet(
            f"availability,chance_of_playing,probably,Rogers,Aston Villa,2,"
            f"robtFPL,a doubt for the weekend,https://x.com/a,{EARLIER},,"
        )
        result = validate(payload, NOW)
        self.assertFalse(result.ok)
        self.assertIn("integer", str(result.rejections[0]))

    def test_a_header_only_sheet_is_valid_and_empty(self):
        # "I found nothing" is a correct answer.
        result = validate(self.sheet(), NOW)
        self.assertTrue(result.ok)
        self.assertEqual(result.availability, [])


class FormatSniffingTests(unittest.TestCase):
    """
    The format is decided by the body, not the URL.

    A Google Sheets publish link carries no `.csv` extension and a gist raw URL
    may carry one, so an extension check would be wrong for both.
    """

    def test_the_documented_columns_match_the_adapter(self):
        from pipeline.data.grok_feed import SHEET_COLUMNS
        doc = (Path(__file__).resolve().parents[2]
               / "docs" / "grok-x-feed-schema.md").read_text(encoding="utf-8")
        header = ",".join(SHEET_COLUMNS)
        # The header the doc tells you to paste must be the one we parse.
        self.assertIn(header, doc, f"the doc must publish this header: {header}")
