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


class CadenceTests(unittest.TestCase):
    """
    Why the prompt asks for a 3-hour window and byte-identical carry-overs.

    The Grok task runs every 3 hours and the poller reads the sheet every 15
    minutes, so the same row is read a dozen times between Grok runs and any
    carried-over row is written again. Both are safe only because `claim_id` is
    a content hash that excludes `observed_at`.

    These tests exist so the prompt's rules 10 and 11 stay justified: if the
    hash ever started including `observed_at`, every re-read would become a new
    claim and the prompt would be giving advice that no longer helps.
    """

    def _claim(self, value, observed, claimed="2026-08-11T08:42:00Z"):
        import inspect

        from pipeline.learning.availability_evidence import AvailabilityClaim

        kwargs = dict(
            source="manual:robtFPL", element_id=503, claim_type="severity",
            value=value, claimed_at=claimed, observed_at=observed,
        )
        for name, param in inspect.signature(AvailabilityClaim).parameters.items():
            if name not in kwargs and param.default is inspect.Parameter.empty:
                kwargs[name] = 1 if name in ("gameweek", "source_tier") else None
        return AvailabilityClaim(**kwargs)

    def test_an_identical_carry_over_deduplicates(self):
        first = self._claim("hamstring, 4-6 weeks", "2026-08-11T09:00:00Z")
        again = self._claim("hamstring, 4-6 weeks", "2026-08-11T12:00:00Z")
        self.assertEqual(first.claim_id, again.claim_id)

    def test_a_reworded_carry_over_does_not(self):
        # Which is why the prompt asks for the row to be reproduced exactly,
        # and why it prefers structured claim types over free text.
        first = self._claim("hamstring, 4-6 weeks", "2026-08-11T09:00:00Z")
        reworded = self._claim("hamstring - four to six weeks", "2026-08-11T12:00:00Z")
        self.assertNotEqual(first.claim_id, reworded.claim_id)

    def test_a_structured_value_is_canonical_across_runs(self):
        # `chance_of_playing=25` cannot be phrased two ways, so it survives the
        # overlap that free text does not.
        from pipeline.data.grok_feed import parse_sheet

        header = ("lane,claim_type,value,player_surname,club,tier,source,quote,"
                  "url,claimed_at,metric,horizon_gameweeks")
        row = (f"availability,chance_of_playing,{{}},Rogers,Aston Villa,2,robtFPL,"
               f"a doubt for the weekend,https://x.com/a,{EARLIER},,")
        first = parse_sheet("\n".join((header, row.format("25"))))
        again = parse_sheet("\n".join((header, row.format("25%"))))
        # Written two ways in the sheet, identical once parsed.
        self.assertEqual(first["items"][0]["value"], again["items"][0]["value"])

    def test_the_doc_states_the_cadence_and_the_window(self):
        doc = (Path(__file__).resolve().parents[2]
               / "docs" / "grok-x-feed-schema.md").read_text(encoding="utf-8")
        self.assertIn("every 3 hours", doc)
        self.assertIn("last 3 hours", doc)
        # The rule that makes the overlap safe has to be in the prompt itself,
        # not only in the prose above it.
        self.assertIn("exactly as you wrote it", doc)

    def test_the_age_filter_outlives_the_cadence(self):
        # A row must survive long enough to be read: a 3-day window against a
        # 3-hour cadence leaves ample margin if a Grok run is missed.
        from pipeline.config import GROK_FEED

        self.assertGreaterEqual(GROK_FEED["max_age_days"], 1)


class ApiRouteTests(unittest.TestCase):
    """
    Route A: the poller asks xAI directly, so there is no sheet to maintain.

    Everything here is offline. The one live call that was made against a real
    key returned 403 `permission-denied` — "your newly created team doesn't have
    any credits" — which is what `test_a_403_names_billing_rather_than_the_key`
    exists to keep legible, because the bare `403 Client Error` that surfaced
    first reads as a code fault and sends you debugging the wrong thing.
    """

    def _config(self, **over):
        from pipeline.config import GROK_FEED

        return {**GROK_FEED, **over}

    def test_the_request_carries_the_gameweek_and_the_deadline(self):
        from pipeline.data.grok_feed import build_request

        body = build_request(self._config(), 7, "2026-10-03T10:00:00Z")
        user = body["messages"][1]["content"]
        self.assertIn("Gameweek 7", user)
        self.assertIn("2026-10-03T10:00:00Z", user)

    def test_a_missing_deadline_is_omitted_rather_than_invented(self):
        # An FPL event with no published deadline is normal in pre-season. A
        # fabricated date would be reported back to us as fact by the model.
        from pipeline.data.grok_feed import build_request

        user = build_request(self._config(), 1, None)["messages"][1]["content"]
        self.assertIn("Gameweek 1", user)
        self.assertNotIn("whose deadline is", user)

    def test_temperature_is_zero(self):
        # Extraction, not composition. A creative sampler here invents quotes,
        # and rule 1 of the prompt is that quotes are never reconstructed.
        from pipeline.data.grok_feed import build_request

        self.assertEqual(build_request(self._config(), 1, None)["temperature"], 0.0)

    def test_the_search_window_follows_the_configured_cadence(self):
        from pipeline.data.grok_feed import build_request

        user = build_request(self._config(window_hours=6), 1, None)["messages"][1]["content"]
        self.assertIn("last 6 hours", user)

    def test_robtfpl_is_named_in_the_request(self):
        # The account the user asked for by name. If a refactor drops it the
        # comparator lane silently goes empty and nothing else complains.
        from pipeline.data.grok_feed import build_request

        body = build_request(self._config(), 1, None)
        self.assertIn("robtFPL", body["messages"][1]["content"])

    def test_the_system_prompt_and_the_doc_carry_the_same_load_bearing_rules(self):
        """
        Two prompts, one contract.

        The doc's prompt is what a human pastes into Grok; SYSTEM_PROMPT is what
        the poller sends. They must not drift, because a rule present in only
        one means the two routes accept different data into the same store.
        """
        from pipeline.data.grok_feed import SYSTEM_PROMPT

        doc = (Path(__file__).resolve().parents[2]
               / "docs" / "grok-x-feed-schema.md").read_text(encoding="utf-8")
        for rule in (
            "word-for-word",        # never reconstruct a quote
            "comparator",           # projections are never availability claims
            "unparsed_news",        # the refusal path
        ):
            self.assertIn(rule, SYSTEM_PROMPT, f"{rule} missing from SYSTEM_PROMPT")
            self.assertIn(rule, doc, f"{rule} missing from the doc prompt")

    def test_the_header_in_the_prompt_matches_the_parser(self):
        # The single highest-value assertion here: if the prompt asks for
        # columns the parser does not read, every row is silently rejected.
        from pipeline.data.grok_feed import SHEET_COLUMNS, SYSTEM_PROMPT

        self.assertIn(",".join(SHEET_COLUMNS), SYSTEM_PROMPT)

    # ---- error surfaces -------------------------------------------------

    class _Response:
        def __init__(self, status, body=None, text=""):
            self.status_code, self._body, self.text = status, body, text

        def json(self):
            if self._body is None:
                raise ValueError("not json")
            return self._body

        def raise_for_status(self):
            raise AssertionError("raise_for_status must not be reached")

    def _ask_against(self, response):
        """Call `ask` with requests.post stubbed to return `response`."""
        import sys, types
        from pipeline.data import grok_feed

        stub = types.ModuleType("requests")
        stub.post = lambda *a, **k: response
        real = sys.modules.get("requests")
        sys.modules["requests"] = stub
        try:
            with self.assertRaises(ValueError) as caught:
                grok_feed.ask("xai-test", self._config(), 1, None)
        finally:
            if real is not None:
                sys.modules["requests"] = real
            else:
                del sys.modules["requests"]
        return str(caught.exception)

    def test_a_403_names_billing_rather_than_the_key(self):
        message = self._ask_against(self._Response(403, {
            "code": "permission-denied",
            "error": "Your newly created team doesn't have any credits or "
                     "licenses yet. You can purchase those on https://console.x.ai/",
        }))
        self.assertIn("billing", message)
        # The provider's own sentence, which is the part that names the fix.
        self.assertIn("credits", message)
        self.assertIn("console.x.ai", message)

    def test_a_403_with_an_unparseable_body_still_says_something(self):
        message = self._ask_against(self._Response(403, None, text="<html>nope</html>"))
        self.assertIn("403", message)
        self.assertIn("nope", message)

    def test_401_is_reported_as_a_key_problem_not_a_billing_one(self):
        # The distinction is the whole point: 401 means change the key, 403
        # means buy credits. Conflating them wastes the debugging session.
        message = self._ask_against(self._Response(401, {"error": "invalid key"}))
        self.assertIn("401", message)
        self.assertNotIn("billing", message)
