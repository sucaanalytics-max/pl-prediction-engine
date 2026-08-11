"""
The manual claim lane.

This is the primary path for tier-2 availability, not a fallback: the connectors
surface evidence and derive no availability from prose, so a human filing a claim
here is how evidence becomes something that moves a projection.

Two integration bugs were found by writing these tests, and both were of the
"records successfully, then silently does nothing" kind:

1. **R0 requires ``provenance_digest`` for any tier-2-or-lower claim**, and
   nothing in the repo had ever populated that field — every claim to date was
   tier 1 from FPL's own bootstrap, so the rule was unsatisfiable rather than
   merely unused. Without a digest every manual claim was dropped at resolution.
2. **``permanent_exit`` must be a Mapping with a ``"kind"`` key.** A bare string
   passes construction and is discarded by R0.

Both are asserted below, because both looked like working code.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning.availability_conflicts import availability_view, resolve_claims
from pipeline.learning.availability_evidence import (
    digest_matches, history, record,
)
from pipeline.learning.file_claim import (
    FILEABLE, MANUAL_TIERS, SOURCE_PREFIX, ClaimInputError, build_claim,
    coerce_value, main, parse_stamp, resolve_element,
)

FIXTURES = Path(__file__).parent / "fixtures" / "news_corpus"
NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)
SAID = datetime(2026, 8, 5, 13, 30, 0, tzinfo=timezone.utc)


def _bootstrap():
    return json.loads((FIXTURES / "bootstrap_slim.json").read_text(encoding="utf-8"))


def _claim(**over):
    params = dict(
        element_id=521, source="De Zerbi presser", tier=2,
        claim_type="chance_of_playing", value="25",
        claimed_at=SAID, gameweek=1, observed_at=NOW,
        quote="He is a couple of weeks away",
        url="https://hayters.com/kulusevski",
    )
    params.update(over)
    return build_claim(**params)


class TimestampTests(unittest.TestCase):
    def test_requires_a_timezone(self):
        """
        Assuming local time would make the same claim resolve differently on a
        laptop and on a runner, breaking the reproducibility the seal depends on.
        """
        with self.assertRaises(ClaimInputError):
            parse_stamp("2026-08-05T13:30:00", "--claimed-at")

    def test_accepts_z_and_offset_forms(self):
        self.assertEqual(
            parse_stamp("2026-08-05T13:30:00Z", "x"),
            parse_stamp("2026-08-05T15:30:00+02:00", "x"),
        )

    def test_rejects_nonsense(self):
        with self.assertRaises(ClaimInputError):
            parse_stamp("last tuesday", "--claimed-at")

    def test_a_claim_from_the_future_is_refused(self):
        """
        The check that stops a back-dated claim outranking a fresher source, since
        R2 judges recency on claimed_at.
        """
        with self.assertRaises(ClaimInputError) as caught:
            _claim(claimed_at=NOW + timedelta(hours=1))
        self.assertIn("future", str(caught.exception))

    def test_claimed_at_and_observed_at_stay_distinct(self):
        claim = _claim()
        self.assertEqual(claim.claimed_at, "2026-08-05T13:30:00Z")
        self.assertEqual(claim.observed_at, "2026-08-06T12:00:00Z")
        self.assertNotEqual(claim.claimed_at, claim.observed_at)


class ValueCoercionTests(unittest.TestCase):
    def test_chance_of_playing_becomes_an_int(self):
        self.assertEqual(coerce_value("chance_of_playing", "25"), 25)

    def test_chance_of_playing_tolerates_a_percent_sign(self):
        self.assertEqual(coerce_value("chance_of_playing", "75%"), 75)

    def test_chance_of_playing_rejects_out_of_range(self):
        for bad in ("-1", "101", "250"):
            with self.subTest(value=bad), self.assertRaises(ClaimInputError):
                coerce_value("chance_of_playing", bad)

    def test_chance_of_playing_rejects_a_string(self):
        """
        Stored as a string it would compare wrongly against FPL's integer and
        resolution would pick the wrong winner without erroring.
        """
        with self.assertRaises(ClaimInputError):
            coerce_value("chance_of_playing", "doubtful")

    def test_dates_must_be_iso_calendar_dates(self):
        self.assertEqual(coerce_value("return_date", "2026-08-21"), "2026-08-21")
        with self.assertRaises(ClaimInputError):
            coerce_value("return_date", "21 Aug")

    def test_permanent_exit_is_a_mapping_with_a_kind(self):
        """
        R0 validates `isinstance(value, Mapping) and "kind" in value`. A bare
        string is recorded successfully and then silently discarded.
        """
        value = coerce_value("permanent_exit", "loan")
        self.assertIsInstance(value, dict)
        self.assertEqual(value["kind"], "loan")

    def test_permanent_exit_rejects_an_unknown_kind(self):
        with self.assertRaises(ClaimInputError):
            coerce_value("permanent_exit", "retired")

    def test_expected_minutes_is_bounded_by_a_match(self):
        self.assertEqual(coerce_value("expected_minutes", "60"), 60.0)
        with self.assertRaises(ClaimInputError):
            coerce_value("expected_minutes", "120")


class AuthorityTests(unittest.TestCase):
    def test_tier_one_is_refused(self):
        """
        Tier 1 is 'official or owned'. A manual claim taking it would outrank FPL's
        own status under R3 while carrying less authority than the presser it came
        from.
        """
        with self.assertRaises(ClaimInputError) as caught:
            _claim(tier=1)
        self.assertIn("reserved", str(caught.exception))

    def test_only_tiers_two_and_three_are_available(self):
        self.assertEqual(MANUAL_TIERS, (2, 3))

    def test_status_cannot_be_filed_by_hand(self):
        """FPL's own letter. Filing one would impersonate a tier-1 source."""
        self.assertNotIn("status", FILEABLE)
        with self.assertRaises(ClaimInputError):
            _claim(claim_type="status", value="i")

    def test_predicted_start_cannot_be_filed_by_hand(self):
        """
        R5 keeps it out of the availability view entirely — it belongs to the
        minutes model, and offering it here would imply it affects availability.
        """
        self.assertNotIn("predicted_start", FILEABLE)

    def test_the_source_is_tagged_so_manual_claims_are_identifiable(self):
        self.assertTrue(_claim().source.startswith(SOURCE_PREFIX))

    def test_the_tag_is_not_doubled_if_already_present(self):
        claim = _claim(source="manual:already tagged")
        self.assertEqual(claim.source.count(SOURCE_PREFIX), 1)

    def test_an_unattributed_claim_is_refused(self):
        with self.assertRaises(ClaimInputError):
            _claim(source="   ")

    def test_a_claim_about_nobody_is_refused(self):
        with self.assertRaises(ClaimInputError) as caught:
            _claim(element_id=0)
        self.assertIn("element id", str(caught.exception))


class AuditabilityTests(unittest.TestCase):
    """R0's digest requirement, which nothing in the repo had ever satisfied."""

    def test_a_claim_with_neither_quote_nor_url_is_refused(self):
        with self.assertRaises(ClaimInputError) as caught:
            _claim(quote=None, url=None)
        self.assertIn("audited", str(caught.exception))

    def test_a_quote_alone_is_enough(self):
        self.assertTrue(_claim(url=None).provenance_digest)

    def test_a_url_alone_is_enough(self):
        self.assertTrue(_claim(quote=None).provenance_digest)

    def test_the_digest_verifies_against_the_stored_text(self):
        self.assertTrue(digest_matches(_claim()))

    def test_an_altered_quote_fails_the_audit(self):
        """
        The point of the digest: an append-only store cannot otherwise detect that
        a quote was edited after the claim was filed.
        """
        claim = _claim()
        self.assertFalse(digest_matches(claim, source_text="something else"))

    def test_the_claim_survives_r0_and_reaches_the_availability_view(self):
        """
        The end-to-end assertion. Before the digest existed this claim was
        recorded, reported as recorded, and then dropped at resolution.
        """
        claim = _claim()
        resolutions, _ = resolve_claims([claim])
        for resolution in resolutions.values():
            self.assertEqual(resolution.dropped, (),
                             f"R0 dropped the claim: {resolution.dropped}")
        view = availability_view(resolutions)
        self.assertIn(521, view)
        self.assertEqual(view[521]["chance_of_playing"].value, 25)

    def test_a_permanent_exit_claim_also_survives_r0(self):
        claim = _claim(claim_type="permanent_exit", value="loan")
        resolutions, _ = resolve_claims([claim])
        for resolution in resolutions.values():
            self.assertEqual(resolution.dropped, ())


class ElementResolutionTests(unittest.TestCase):
    def setUp(self):
        self.boot = _bootstrap()

    def test_resolves_a_unique_web_name(self):
        element = resolve_element(self.boot, "Kulusevski")
        self.assertEqual(int(element["id"]), 521)

    def test_resolves_an_element_id_directly(self):
        self.assertEqual(int(resolve_element(self.boot, "521")["id"]), 521)

    def test_an_unknown_id_is_refused(self):
        with self.assertRaises(ClaimInputError):
            resolve_element(self.boot, "999999")

    def test_an_unknown_name_is_refused(self):
        with self.assertRaises(ClaimInputError):
            resolve_element(self.boot, "Nobody At All")

    def test_an_ambiguous_name_is_refused_and_lists_the_candidates(self):
        """
        "two Silvas at one club must escalate, not pick". The listing is what makes
        the refusal actionable rather than a dead end.
        """
        with self.assertRaises(ClaimInputError) as caught:
            resolve_element(self.boot, "Wilson")
        message = str(caught.exception)
        self.assertIn("matches", message)
        self.assertRegex(message, r"\d+=")

    def test_ambiguity_is_never_silently_resolved(self):
        with self.assertRaises(ClaimInputError):
            resolve_element(self.boot, "Phillips")


class DedupeAndStoreTests(unittest.TestCase):
    def test_re_filing_the_same_claim_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            claim = _claim()
            self.assertIsNotNone(record([claim], root))
            self.assertIsNone(record([claim], root))
            lines = (root / "fpl" / "availability_evidence.jsonl").read_text().strip()
            self.assertEqual(len(lines.splitlines()), 1)

    def test_a_genuinely_newer_assertion_is_a_new_claim(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            record([_claim()], root)
            # Later than the first claim but still before `NOW` — a claim from the
            # future is refused, which this test tripped over twice.
            later = _claim(value="75", claimed_at=SAID + timedelta(hours=6))
            self.assertIsNotNone(record([later], root))
            self.assertEqual(len(history(root)), 2)

    def test_observed_at_moving_does_not_mint_a_new_claim(self):
        """
        This has bitten before: `claimed_at = news_added or observed_at` minted a
        new content hash on every three-hourly tick.
        """
        first = _claim()
        second = _claim(observed_at=NOW + timedelta(hours=3))
        self.assertEqual(first.claim_id, second.claim_id)


class CliTests(unittest.TestCase):
    def _run(self, *args):
        return main([*args, "--bootstrap", str(FIXTURES / "bootstrap_slim.json")])

    def test_a_valid_dry_run_exits_zero(self):
        code = self._run(
            "--player", "Kulusevski", "--type", "chance_of_playing", "--value", "25",
            "--source", "presser", "--tier", "2", "--claimed-at", "2026-08-05T13:30:00Z",
            "--gameweek", "1", "--quote", "a couple of weeks", "--dry-run",
        )
        self.assertEqual(code, 0)

    def test_a_bad_claim_exits_two_rather_than_traceback(self):
        code = self._run(
            "--player", "Kulusevski", "--type", "chance_of_playing", "--value", "250",
            "--source", "presser", "--tier", "2", "--now", "--gameweek", "1",
            "--quote", "x", "--dry-run",
        )
        self.assertEqual(code, 2)

    def test_an_ambiguous_player_exits_two(self):
        code = self._run(
            "--player", "Wilson", "--type", "chance_of_playing", "--value", "25",
            "--source", "presser", "--tier", "2", "--now", "--gameweek", "1",
            "--quote", "x", "--dry-run",
        )
        self.assertEqual(code, 2)

    def test_writing_then_re_running_is_idempotent(self):
        with TemporaryDirectory() as tmp:
            args = [
                "--player", "Kulusevski", "--type", "chance_of_playing",
                "--value", "25", "--source", "presser", "--tier", "2",
                "--claimed-at", "2026-08-05T13:30:00Z", "--gameweek", "1",
                "--quote", "a couple of weeks", "--predictions-dir", tmp,
            ]
            self.assertEqual(self._run(*args), 0)
            self.assertEqual(self._run(*args), 0)
            self.assertEqual(len(history(Path(tmp))), 1)


if __name__ == "__main__":
    unittest.main()
