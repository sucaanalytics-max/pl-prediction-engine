"""
Tests for the timestamped availability-evidence store.

Three properties beyond the plumbing.

**Deduplication is against everything ever recorded**, not just the last line.
A claim is an assertion made at a moment, so re-reading an unchanged flag three
hours later is the *same* assertion. This is deliberately the opposite of the
market-snapshot store, where an unchanged price genuinely is a new observation of
the market at a new time.

**A corrupt line raises rather than being skipped.** Silently shortening the
record would produce a resolution computed from partial evidence, which is the
confidently-wrong output the store exists to prevent.

**The workflow must commit the file.** This is asserted structurally, because the
identical omission previously left the message feed written to the CI runner and
discarded, leaving the agent with no channel at all.
"""
import gzip
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.data.availability_news import PARSER_VERSION
from pipeline.learning.availability_evidence import (
    EVIDENCE_FILENAME,
    AvailabilityClaim,
    EvidenceError,
    claims_for_gameweek,
    claims_from_bootstrap,
    history,
    parse_coverage,
    record,
    should_escalate_parse_failures,
)

REPO = Path(__file__).resolve().parents[2]
SNAPSHOT = REPO / "pipeline" / "data" / "priors" / "bootstrap_preseason_2627.json.gz"

OBSERVED = "2026-08-04T15:00:00Z"
NEWS_ADDED = "2026-08-04T12:00:00Z"


def _claim(**overrides):
    payload = {
        "element_id": 123,
        "source": "fpl_bootstrap",
        "source_tier": 1,
        "claim_type": "chance_of_playing",
        "value": 75,
        "claimed_at": NEWS_ADDED,
        "observed_at": OBSERVED,
        "gameweek": 1,
    }
    payload.update(overrides)
    return AvailabilityClaim(**payload)


def _element(**overrides):
    payload = {
        "id": 123,
        "code": 98765,
        "status": "d",
        "chance_of_playing_next_round": 75,
        "news": "Calf injury - 75% chance of playing",
        "news_added": NEWS_ADDED,
    }
    payload.update(overrides)
    return payload


class ClaimTests(unittest.TestCase):
    def test_an_unknown_claim_type_raises_on_construction(self):
        """A programming error, so it fails immediately and loudly."""
        with self.assertRaises(ValueError):
            _claim(claim_type="vibes")

    def test_an_unknown_tier_raises_on_construction(self):
        with self.assertRaises(ValueError):
            _claim(source_tier=9)

    def test_an_impossible_timestamp_does_not_raise_on_construction(self):
        """
        A DATA error, not a programming error. Raising here would make one bad
        stored line unreadable and take the entire history down with it, so the
        check belongs at resolution.
        """
        claim = _claim(claimed_at="2026-09-01T00:00:00Z", observed_at=OBSERVED)
        self.assertGreater(claim.claimed_at, claim.observed_at)

    def test_the_id_ignores_when_we_read_it(self):
        """Re-reading an unchanged flag must collide so the repeat is dropped."""
        self.assertEqual(
            _claim(observed_at="2026-08-04T15:00:00Z").claim_id,
            _claim(observed_at="2026-08-04T18:00:00Z").claim_id,
        )

    def test_the_id_distinguishes_a_genuinely_new_assertion(self):
        """A later claimed_at is a new claim even with the same value."""
        self.assertNotEqual(
            _claim(claimed_at="2026-08-04T12:00:00Z").claim_id,
            _claim(claimed_at="2026-08-05T12:00:00Z").claim_id,
        )

    def test_the_id_distinguishes_sources_and_values(self):
        base = _claim().claim_id
        self.assertNotEqual(base, _claim(source="fpl_news_parse").claim_id)
        self.assertNotEqual(base, _claim(value=50).claim_id)
        self.assertNotEqual(base, _claim(claim_type="expected_minutes").claim_id)

    def test_a_dict_value_hashes_deterministically(self):
        one = _claim(claim_type="permanent_exit", value={"kind": "loan", "club": "X"})
        other = _claim(claim_type="permanent_exit", value={"club": "X", "kind": "loan"})
        self.assertEqual(one.claim_id, other.claim_id)


class BootstrapIngestionTests(unittest.TestCase):
    def test_an_unflagged_player_produces_no_claim(self):
        """
        Recording 500 "status a" rows every three hours would bury the ones that
        matter and grow the file ~50x for no information. An absent claim already
        means nothing was flagged.
        """
        bootstrap = {"elements": [
            _element(id=1, status="a", chance_of_playing_next_round=None, news="")
        ]}
        self.assertEqual(claims_from_bootstrap(bootstrap, 1, OBSERVED), [])

    def test_the_structured_field_and_the_prose_are_separate_sources(self):
        """
        Both tier 1, but distinct: FPL's own number versus our interpretation of
        its text. Keeping them apart is what makes a parser disagreement
        detectable instead of silently resolved.
        """
        claims = claims_from_bootstrap({"elements": [_element()]}, 1, OBSERVED)
        chance = [c for c in claims if c.claim_type == "chance_of_playing"]
        self.assertEqual(len(chance), 2)
        self.assertEqual(
            {c.source for c in chance}, {"fpl_bootstrap", "fpl_news_parse"}
        )
        self.assertEqual({c.value for c in chance}, {75})

    def test_the_news_claim_carries_provenance(self):
        claims = claims_from_bootstrap({"elements": [_element()]}, 1, OBSERVED)
        parsed = next(c for c in claims if c.source == "fpl_news_parse")
        self.assertEqual(parsed.source_text, "Calf injury - 75% chance of playing")
        self.assertEqual(parsed.parser_version, PARSER_VERSION)
        self.assertTrue(parsed.provenance_digest)

    def test_a_suspension_yields_an_eligibility_date(self):
        claims = claims_from_bootstrap(
            {"elements": [_element(
                status="s", chance_of_playing_next_round=0,
                news="Suspended until 29 Aug",
            )]},
            1, OBSERVED,
        )
        dated = next(c for c in claims if c.claim_type == "unavailable_until")
        self.assertEqual(dated.value, "2026-08-29")

    def test_a_departure_yields_a_permanent_exit(self):
        claims = claims_from_bootstrap(
            {"elements": [_element(
                status="u", chance_of_playing_next_round=0,
                news="Has joined Grimsby Town on loan for the rest of the season",
            )]},
            1, OBSERVED,
        )
        exit_claim = next(c for c in claims if c.claim_type == "permanent_exit")
        self.assertEqual(exit_claim.value["kind"], "loan")
        self.assertEqual(exit_claim.value["club"], "Grimsby Town")

    def test_unrecognised_news_is_preserved_but_derives_nothing(self):
        """The fail-safe: the parser can only ever add information."""
        claims = claims_from_bootstrap(
            {"elements": [_element(
                chance_of_playing_next_round=None,
                news="he tweaked something in training, we think",
            )]},
            1, OBSERVED,
        )
        types = {c.claim_type for c in claims}
        self.assertIn("unparsed_news", types)
        self.assertEqual(
            types & {"return_date", "unavailable_until", "permanent_exit"}, set()
        )

    def test_the_claim_time_is_the_news_timestamp_not_our_read_time(self):
        """
        Recency is judged on when the claim was MADE. Using our read time would
        make every re-read look like fresh news and let a stale flag outrank a
        genuinely newer source.
        """
        claims = claims_from_bootstrap({"elements": [_element()]}, 1, OBSERVED)
        self.assertTrue(all(c.claimed_at == NEWS_ADDED for c in claims))
        self.assertTrue(all(c.observed_at == OBSERVED for c in claims))

    def test_a_source_with_no_publication_time_records_none_not_our_read_time(self):
        """
        The regression. Falling back to ``observed_at`` looked harmless and broke
        dedupe completely: the claim id is content-addressed and includes
        ``claimed_at``, so every three-hourly tick minted a new id for a byte-
        identical flag. It also redefined ``claimed_at`` as "when we last read
        it", destroying the recency semantics the two timestamps exist to
        separate. None is the honest value — we do not know when FPL made the
        assertion — and resolution falls back to ``observed_at`` explicitly.
        """
        claims = claims_from_bootstrap(
            {"elements": [_element(news_added=None)]}, 1, OBSERVED
        )
        self.assertTrue(claims)
        self.assertTrue(all(c.claimed_at is None for c in claims))
        self.assertTrue(all(c.observed_at == OBSERVED for c in claims))

        from pipeline.learning.availability_evidence import effective_claim_time

        self.assertTrue(all(effective_claim_time(c) == OBSERVED for c in claims))

    def test_a_flagged_player_without_news_deduplicates_across_ticks(self):
        """
        The consequence, asserted directly. Four ingestions of a byte-identical
        bootstrap previously stored eight lines and would have grown without bound
        all season.
        """
        bootstrap = {"elements": [_element(news="", news_added=None)]}
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for hour in ("06", "09", "12", "15"):
                record(
                    claims_from_bootstrap(
                        bootstrap, 1, f"2026-08-04T{hour}:00:00Z"
                    ),
                    directory,
                )
            self.assertEqual(len(history(directory)), 2)

    @unittest.skipUnless(SNAPSHOT.exists(), "committed snapshot is required")
    def test_the_whole_committed_snapshot_ingests_and_parses(self):
        """
        End to end over 564 real elements. Coverage is asserted at 100% because
        the parser was built against this corpus — the value of the assertion is
        that it fails the first time the snapshot is refreshed with new wording.
        """
        bootstrap = json.load(gzip.open(SNAPSHOT, "rt"))
        claims = claims_from_bootstrap(bootstrap, 1, OBSERVED)
        coverage = parse_coverage(claims)

        # 55 players carry news; two more carry only a published chance of 100,
        # which is a recovery signal worth storing but has nothing to parse.
        self.assertEqual(coverage["n_flagged"], 55)
        self.assertEqual(coverage["n_claimed"], 57)
        self.assertEqual(coverage["n_unparsed"], 0)
        self.assertEqual(coverage["n_dated"], 10)
        self.assertFalse(should_escalate_parse_failures(coverage))

    @unittest.skipUnless(SNAPSHOT.exists(), "committed snapshot is required")
    def test_the_parsed_chance_matches_fpls_own_field_on_every_player(self):
        """
        A free labelled validation set. FPL publishes the percentage twice — once
        as a field, once inside the prose — so any disagreement means our parser
        is wrong, and in production it is a genuine tier-1-internal conflict
        rather than something to quietly resolve.
        """
        bootstrap = json.load(gzip.open(SNAPSHOT, "rt"))
        official = {
            int(e["id"]): e.get("chance_of_playing_next_round")
            for e in bootstrap["elements"]
        }
        claims = claims_from_bootstrap(bootstrap, 1, OBSERVED)
        checked = 0
        for claim in claims:
            if claim.claim_type == "chance_of_playing" and claim.source == "fpl_news_parse":
                self.assertEqual(claim.value, official[claim.element_id])
                checked += 1
        self.assertEqual(checked, 18)


class EscalationTests(unittest.TestCase):
    def test_a_single_oddity_does_not_escalate(self):
        self.assertFalse(should_escalate_parse_failures(
            {"n_flagged": 4, "n_unparsed": 1, "unparsed_share": 0.25}
        ))

    def test_a_high_share_with_a_real_count_escalates(self):
        self.assertTrue(should_escalate_parse_failures(
            {"n_flagged": 10, "n_unparsed": 4, "unparsed_share": 0.40}
        ))

    def test_a_big_count_at_a_low_share_does_not_escalate(self):
        """An injury crisis is not a parser failure."""
        self.assertFalse(should_escalate_parse_failures(
            {"n_flagged": 100, "n_unparsed": 10, "unparsed_share": 0.10}
        ))

    def test_no_claims_does_not_escalate(self):
        self.assertFalse(should_escalate_parse_failures(parse_coverage([])))


class StoreTests(unittest.TestCase):
    def test_recording_then_reading_round_trips_every_field(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            original = _claim(
                player_code=98765, confidence=0.8,
                provenance_url="https://example.invalid/presser",
                provenance_digest="abc123", source_text="text",
                parser_version=1, notes="a note",
            )
            record([original], directory)
            (restored,) = history(directory)
            self.assertEqual(restored.as_dict(), original.as_dict())

    def test_an_unchanged_claim_is_not_recorded_twice(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertIsNotNone(record([_claim()], directory))
            self.assertIsNone(record([_claim(observed_at="2026-08-04T18:00:00Z")], directory))
            self.assertEqual(len(history(directory)), 1)

    def test_dedupe_is_against_everything_ever_recorded(self):
        """
        Not merely against the previous line. A flag that changes and changes back
        is the SAME assertion returning, because the claim's timestamp is part of
        its identity — unlike a market price, where an unchanged quote at a new
        time is a new observation.
        """
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_claim(value=75)], directory)
            record([_claim(value=50, claimed_at="2026-08-05T12:00:00Z")], directory)
            record([_claim(value=75)], directory)  # identical to the first
            self.assertEqual(len(history(directory)), 2)

    def test_appending_never_rewrites_an_earlier_line(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_claim()], directory)
            first = (directory / "fpl" / EVIDENCE_FILENAME).read_bytes()
            record([_claim(value=50, claimed_at="2026-08-05T12:00:00Z")], directory)
            self.assertTrue(
                (directory / "fpl" / EVIDENCE_FILENAME).read_bytes().startswith(first)
            )

    def test_dry_run_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertIsNone(record([_claim()], directory, dry_run=True))
            self.assertFalse((directory / "fpl" / EVIDENCE_FILENAME).exists())

    def test_a_missing_file_is_empty_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(history(Path(tmp)), [])

    def test_a_corrupt_line_raises_rather_than_shortening_the_record(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_claim()], directory)
            with (directory / "fpl" / EVIDENCE_FILENAME).open("a") as handle:
                handle.write("{not json\n")
            with self.assertRaises(EvidenceError):
                history(directory)

    def test_a_line_with_an_invalid_claim_type_raises(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([_claim()], directory)
            with (directory / "fpl" / EVIDENCE_FILENAME).open("a") as handle:
                handle.write(json.dumps({
                    "element_id": 1, "source": "x", "source_tier": 1,
                    "claim_type": "nonsense", "value": 1,
                    "claimed_at": OBSERVED, "observed_at": OBSERVED, "gameweek": 1,
                }) + "\n")
            with self.assertRaises(EvidenceError):
                history(directory)

    def test_a_corrupt_history_still_allows_todays_claims_to_be_recorded(self):
        """
        The corruption is already permanent; today's news is perishable. Losing
        dedupe costs a duplicate line, which is recoverable.
        """
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "fpl").mkdir(parents=True)
            (directory / "fpl" / EVIDENCE_FILENAME).write_text("{not json\n")
            self.assertIsNotNone(record([_claim()], directory))

    def test_the_stored_id_is_derived_not_trusted(self):
        """A tampered id on disk must not survive a read."""
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "fpl" / EVIDENCE_FILENAME
            path.parent.mkdir(parents=True)
            payload = _claim().as_dict()
            payload["claim_id"] = "deadbeefdeadbeef"
            path.write_text(json.dumps(payload) + "\n")
            (restored,) = history(directory)
            self.assertEqual(restored.claim_id, _claim().claim_id)

    def test_claims_are_grouped_by_player_for_a_gameweek(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            record([
                _claim(element_id=1, gameweek=1),
                _claim(element_id=2, gameweek=1),
                _claim(element_id=3, gameweek=2),
            ], directory)
            grouped = claims_for_gameweek(directory, 1)
            self.assertEqual(sorted(grouped), [1, 2])

    def test_recording_nothing_is_not_an_error(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(record([], Path(tmp)))


class WorkflowTests(unittest.TestCase):
    def test_the_agent_workflow_commits_the_evidence_file(self):
        """
        Structural guard. The identical omission previously left the message feed
        written to the CI runner and discarded, so the agent had no channel at
        all — a bug no unit test could see, because every module worked.
        """
        workflow = (REPO / ".github" / "workflows" / "fpl_agent.yml").read_text()
        self.assertIn(f"predictions/fpl/{EVIDENCE_FILENAME}", workflow)

    def test_the_evidence_path_is_not_forbidden_by_the_path_guard(self):
        """
        FORBID_PATHS enumerates the DAILY pipeline's territory to keep two writers
        to main on disjoint paths. A new agent-owned file must not fall inside it.
        """
        import re

        workflow = (REPO / ".github" / "workflows" / "fpl_agent.yml").read_text()
        match = re.search(r"FORBID_PATHS:\s*'([^']+)'", workflow)
        self.assertIsNotNone(match, "FORBID_PATHS is no longer where expected")
        self.assertIsNone(
            re.search(match.group(1), f"predictions/fpl/{EVIDENCE_FILENAME}")
        )


if __name__ == "__main__":
    unittest.main()
