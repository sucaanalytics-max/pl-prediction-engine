"""
The news extractor, against a committed corpus of real feed entries.

## Why a corpus rather than unit tests

The 102 entries in ``fixtures/news_corpus/entries.json`` are a real pull of all six
feeds on 2026-08-06. Hand-written fixtures only ever contain what their author
already imagined, and every failure this extractor is designed around was found by
running it against real text:

* a naive surname index made ``esse`` match inside "as*sesse*d";
* "Olid named new Man Utd Women boss" resolved a men's player named Scott;
* 441 of 663 surname keys in the 570-player bootstrap are ambiguous, with Wilson
  and Phillips appearing six times each.

## The bar

**Zero false positives on availability.** Rule R4 permits a tier-2 or tier-3
source to push availability *down* but never up, so a wrong claim does not add
noise — it benches a fit player. Recall is sacrificed for that without apology:
the extractor emits only ``unparsed_news``, which by construction derives no
availability at all, and a human turns evidence into an availability claim through
``file_claim.py``.

So these tests assert two things above all: that every claim is
``unparsed_news``, and that nothing is ever attributed to a player whose club is
not named in the same entry.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, Dict, List

from pipeline.data import news_extract
from pipeline.data.news_extract import (
    EXTRACTOR_VERSION, MIN_SURNAME_LENGTH, build_club_index, build_player_index,
    extract_all, extract_entry, fold, is_out_of_scope,
)
from pipeline.data.news_feeds import FeedEntry

FIXTURES = Path(__file__).parent / "fixtures" / "news_corpus"
OBSERVED = "2026-08-06T12:00:00Z"


def _load_corpus() -> List[FeedEntry]:
    rows = json.loads((FIXTURES / "entries.json").read_text(encoding="utf-8"))
    return [
        FeedEntry(
            feed=row["feed"], tier=row["tier"], title=row["title"],
            summary=row["summary"], link=row["link"],
            published_at=row["published_at"],
            entry_id=row["link"] or row["title"],
        )
        for row in rows
    ]


def _load_bootstrap() -> Dict[str, Any]:
    return json.loads((FIXTURES / "bootstrap_slim.json").read_text(encoding="utf-8"))


class CorpusFixtureTests(unittest.TestCase):
    """The fixture itself, before anything is asserted about the extractor."""

    def test_the_corpus_is_present_and_real(self):
        entries = _load_corpus()
        self.assertEqual(len(entries), 102)
        # All six configured feeds contributed, so every tier is exercised.
        self.assertEqual(
            {e.feed for e in entries},
            {"hayters", "allaboutfpl", "premierfantasytools",
             "fantasyfootballscout", "bbc_football", "sky_football"},
        )

    def test_the_corpus_covers_every_configured_feed(self):
        """
        A feed silently contributing nothing is how a dormant source hides. The
        first capture of this corpus was missing allaboutfpl entirely, because the
        configured endpoint was a category feed that had stopped being used while
        the site kept posting daily — and nothing in the tests said so.
        """
        from pipeline.config import NEWS_FEEDS
        configured = {f["name"] for f in NEWS_FEEDS}
        present = {e.feed for e in _load_corpus()}
        self.assertEqual(
            configured - present, set(),
            "these configured feeds contributed no entry to the corpus",
        )

    def test_the_bootstrap_fixture_is_the_real_roster(self):
        boot = _load_bootstrap()
        self.assertEqual(len(boot["teams"]), 20)
        self.assertEqual(len(boot["elements"]), 570)


class FoldTests(unittest.TestCase):
    def test_strips_accents_so_a_headline_matches_the_roster(self):
        # The bootstrap spells him with a caron; feeds usually do not.
        self.assertEqual(fold("Kulusevski"), fold("Kuluševski"))

    def test_lowercases(self):
        self.assertEqual(fold("Arsenal"), "arsenal")


class OutOfScopeTests(unittest.TestCase):
    """
    Entries that mention a club but are not about its senior squad.

    Each of these is a measured false positive, not a hypothetical.
    """

    def test_a_womens_team_article_is_out_of_scope(self):
        self.assertIsNotNone(is_out_of_scope("Olid named new Man Utd Women boss"))

    def test_an_academy_article_is_out_of_scope(self):
        self.assertIsNotNone(is_out_of_scope("Arsenal academy graduate signs deal"))

    def test_an_under_age_article_is_out_of_scope(self):
        self.assertIsNotNone(is_out_of_scope("England Under-21 squad named"))
        self.assertIsNotNone(is_out_of_scope("Chelsea U18s win"))

    def test_ordinary_team_news_is_in_scope(self):
        self.assertIsNone(
            is_out_of_scope("Spurs boss De Zerbi gives optimistic update on Kulusevski")
        )


class PlayerIndexTests(unittest.TestCase):
    def setUp(self):
        self.index = build_player_index(_load_bootstrap())

    def test_ambiguous_surnames_are_excluded_from_the_unique_index(self):
        """
        The core safety property. Six players share the surname Wilson; resolving
        one of them is a coin flip presented as a fact.
        """
        for shared in ("wilson", "phillips", "henderson", "james"):
            with self.subTest(surname=shared):
                self.assertNotIn(shared, self.index.unique)
                self.assertIn(shared, self.index.ambiguous)
                self.assertGreater(len(self.index.ambiguous[shared]), 1)

    def test_short_surnames_are_excluded_entirely(self):
        """
        Measured: at four characters, "king", "sarr" and "esse" fire on ordinary
        prose. `esse` matched inside "assessed".
        """
        for surname in self.index.unique:
            self.assertGreaterEqual(len(surname), MIN_SURNAME_LENGTH)

    def test_a_substring_cannot_match(self):
        """
        Word-boundary matching, not `in`. This is the "assessed" bug.

        Note this one passes for two reasons at once — `esse` is also below
        MIN_SURNAME_LENGTH — which is why the test below exists separately.
        """
        found = self.index.find("All 89 midfielders assessed for the new season")
        names = {self.index.name_of[i] for i in found}
        self.assertNotIn("Esse", names)
        # And nothing else spuriously either.
        self.assertEqual(found, set(), f"spurious matches: {names}")

    def test_a_long_surname_hidden_inside_a_word_does_not_match(self):
        """
        The test that actually pins word-boundary matching.

        Swapping the boundary regex for a plain `in` check survived every other
        assertion in this file, because the obvious example (`esse` in "assessed")
        is ALSO caught by the five-character minimum — so the length filter was
        doing all the work and the boundary guard was untested.

        **Mason Mount** is the real counterexample: "mount" is five characters and
        unique in the roster, and it hides inside "mountain", "paramount" and
        "surmounted". A scan of the live bootstrap found exactly three such traps
        among 486 unique surnames, all of them his.
        """
        mount = self.index.unique.get("mount")
        self.assertIsNotNone(mount, "expected Mount in the unique surname index")

        for sentence in (
            "Man Utd face a mountain to climb this season",
            "Staying up is of paramount importance",
            "They surmounted a two-goal deficit",
        ):
            with self.subTest(sentence=sentence):
                self.assertNotIn(
                    mount, self.index.find(sentence),
                    f"matched Mount inside a longer word: {sentence!r}",
                )

    def test_the_surname_still_matches_when_it_stands_alone(self):
        """The boundary guard must not cost a real match."""
        self.assertIn(
            self.index.unique["mount"],
            self.index.find("Mount returns to training"),
        )

    def test_punctuation_does_not_defeat_a_real_match(self):
        for sentence in ("update on Mount.", "(Mount) is fit", "Mount, who trained,"):
            with self.subTest(sentence=sentence):
                self.assertIn(self.index.unique["mount"], self.index.find(sentence))

    def test_a_real_surname_does_match(self):
        found = self.index.find("optimistic update on Kulusevski")
        self.assertTrue(found)

    def test_ambiguity_is_surfaced_rather_than_resolved(self):
        seen = self.index.ambiguous_in("Wilson and Phillips both featured")
        self.assertIn("wilson", seen)
        self.assertIn("phillips", seen)
        # Every candidate is reported; none is chosen.
        self.assertGreater(len(seen["wilson"]), 1)


class ClubIndexTests(unittest.TestCase):
    def setUp(self):
        self.index = build_club_index(_load_bootstrap())

    def test_resolves_colloquial_names(self):
        for text, expected in (
            ("Spurs boss De Zerbi", "Spurs"),
            ("the Gunners prepare an approach", "Arsenal"),
            ("Man Utd latest", "Man Utd"),
            ("Villa injuries mount", "Aston Villa"),
        ):
            with self.subTest(text=text):
                self.assertIn(expected, self.index.find(text))

    def test_does_not_resolve_a_bare_ambiguous_word(self):
        """
        "United" alone cannot identify a club — Man Utd, Newcastle United, Leeds
        United and West Ham United are all "United" to somebody.
        """
        self.assertEqual(self.index.find("United are in talks"), set())

    def test_a_three_letter_code_is_not_an_alias(self):
        # "ARS" style codes collide with ordinary words and abbreviations.
        self.assertEqual(self.index.find("the ARS of the deal"), set())

    def test_a_club_alias_hidden_inside_a_word_does_not_match(self):
        """
        The club index needs the same word-boundary guard as the player index, and
        for the same reason: dropping it survived every other assertion here.

        A scan of the live alias table found the traps — "villa" inside
        "village"/"villagers", "forest" inside "forests"/"forestry", "palace"
        inside "palaces". A story about villagers objecting to a stadium would
        otherwise be filed as Aston Villa team news.
        """
        for sentence, club in (
            ("Villagers protest against the new stadium", "Aston Villa"),
            ("The village club were promoted", "Aston Villa"),
            ("Forestry work near the training ground", "Nott'm Forest"),
            ("Two royal palaces were opened", "Crystal Palace"),
        ):
            with self.subTest(sentence=sentence):
                self.assertNotIn(
                    club, self.index.find(sentence),
                    f"matched {club} inside a longer word: {sentence!r}",
                )

    def test_those_aliases_still_match_when_they_stand_alone(self):
        """The guard must not cost the real matches it is protecting."""
        self.assertIn("Aston Villa", self.index.find("Villa injuries mount"))
        self.assertIn("Nott'm Forest", self.index.find("Forest sign a striker"))
        self.assertIn("Crystal Palace", self.index.find("Palace are in talks"))


class ExtractionSafetyTests(unittest.TestCase):
    """The properties that make a wrong claim impossible, on the real corpus."""

    @classmethod
    def setUpClass(cls):
        cls.boot = _load_bootstrap()
        cls.entries = _load_corpus()
        cls.claims, cls.report = extract_all(
            cls.entries, cls.boot, gameweek=1, observed_at=OBSERVED,
        )
        cls.players = build_player_index(cls.boot)
        cls.clubs = build_club_index(cls.boot)

    def test_every_claim_is_unparsed_news(self):
        """
        The single most important assertion in this file.

        `unparsed_news` carries no availability by definition, so no claim from a
        prose feed can move a projection or bench a player. Any other claim type
        appearing here means the extractor started deriving availability from
        headlines, which it must not do.
        """
        kinds = {c.claim_type for c in self.claims}
        self.assertEqual(kinds, {"unparsed_news"}, f"unexpected claim types: {kinds}")

    def test_no_claim_carries_a_chance_of_playing(self):
        """
        A headline saying "out for three weeks" does not license inventing a
        percentage, and under R4 an invented percentage would bench the player.
        """
        for claim in self.claims:
            self.assertNotEqual(claim.claim_type, "chance_of_playing")
            self.assertIsInstance(claim.value, str)

    def test_every_player_linked_claim_names_that_players_club(self):
        """
        The check that stops "Man City boss on Forest and Spurs linked duo" from
        attaching City players to a Spurs story.
        """
        by_id = {int(e["id"]): e for e in self.boot["elements"]}
        teams = {t["id"]: t["name"] for t in self.boot["teams"]}
        for claim in self.claims:
            if claim.element_id <= 0:
                continue
            club = teams[by_id[claim.element_id]["team"]]
            named = self.clubs.find(str(claim.source_text))
            with self.subTest(element=claim.element_id):
                self.assertIn(
                    club, named,
                    f"linked {by_id[claim.element_id]['web_name']} ({club}) to an "
                    f"entry naming {sorted(named)}",
                )

    def test_no_claim_is_attributed_to_an_ambiguous_surname(self):
        linked = {c.element_id for c in self.claims if c.element_id > 0}
        ambiguous_ids = {i for ids in self.players.ambiguous.values() for i in ids}
        self.assertEqual(
            linked & ambiguous_ids, set(),
            "a player with a shared surname was resolved from prose",
        )

    def test_out_of_scope_entries_produce_nothing(self):
        for entry in self.entries:
            if is_out_of_scope(entry.text) is None:
                continue
            result = extract_entry(entry, self.clubs, self.players, 1, OBSERVED)
            with self.subTest(title=entry.title[:40]):
                self.assertEqual(result.claims, ())

    def test_tiers_are_carried_from_the_feed_untouched(self):
        by_feed = {e.feed: e.tier for e in self.entries}
        for claim in self.claims:
            self.assertEqual(claim.source_tier, by_feed[claim.source])

    def test_no_claim_claims_tier_one(self):
        """
        Tier 1 is 'official or owned' — FPL's own fields and our parse of its own
        text. A press feed is never tier 1, and a tier-1 claim from prose would
        outrank FPL's own status under R3.
        """
        for claim in self.claims:
            self.assertGreater(claim.source_tier, 1)

    def test_claimed_at_is_the_feeds_own_time_and_never_invented(self):
        by_link = {(e.link or e.title): e for e in self.entries}
        for claim in self.claims:
            entry = by_link.get(str(claim.provenance_url or ""))
            if entry is None:
                continue
            self.assertEqual(claim.claimed_at, entry.published_at)

    def test_observed_at_is_injected_not_read_from_the_clock(self):
        for claim in self.claims:
            self.assertEqual(claim.observed_at, OBSERVED)

    def test_every_claim_records_its_extractor_version(self):
        for claim in self.claims:
            self.assertEqual(claim.parser_version, EXTRACTOR_VERSION)

    def test_source_text_is_a_short_quote_not_the_article(self):
        """
        These feeds permit consumption, not redistribution. A capped quote is
        citation; storing the full text would not be.
        """
        for claim in self.claims:
            self.assertLessEqual(len(str(claim.value)), news_extract.MAX_SOURCE_TEXT)

    def test_claims_deduplicate_across_two_identical_runs(self):
        """
        The poller runs every 15 minutes. Identical content must be one claim.

        This has bitten before: an earlier `claimed_at = news_added or observed_at`
        minted a new content hash on every tick.
        """
        again, _ = extract_all(self.entries, self.boot, gameweek=1,
                               observed_at="2026-08-06T15:00:00Z")
        self.assertEqual(
            {c.claim_id for c in self.claims}, {c.claim_id for c in again},
            "claim ids changed when only observed_at moved",
        )


class CoverageReportTests(unittest.TestCase):
    """The report is what distinguishes 'quiet news' from 'broken matcher'."""

    @classmethod
    def setUpClass(cls):
        cls.claims, cls.report = extract_all(
            _load_corpus(), _load_bootstrap(), gameweek=1, observed_at=OBSERVED,
        )

    def test_yield_is_recorded_honestly(self):
        report = self.report
        self.assertEqual(report["n_entries"], 102)
        # Measured on this corpus. Pinned so a change in the matcher is visible
        # as a number rather than as a vague feeling that it still works.
        self.assertEqual(report["n_claims"], 44)
        self.assertEqual(report["n_player_linked"], 10)
        self.assertEqual(report["n_club_only"], 32)
        self.assertEqual(report["n_skipped"], 60)

    def test_skips_are_explained_rather_than_silent(self):
        reasons = self.report["skipped_by_reason"]
        self.assertEqual(reasons["no club resolved"], 48)
        self.assertEqual(reasons["out of scope"], 12)
        self.assertEqual(sum(reasons.values()), self.report["n_skipped"])

    def test_ambiguous_surnames_are_reported(self):
        seen = self.report["ambiguous_surnames"]
        # Real ambiguities in this corpus: a Garcia, a James and a Phillips are
        # mentioned and none can be resolved.
        self.assertIn("garcia", seen)
        for surname, ids in seen.items():
            self.assertGreater(len(ids), 1, f"{surname} is not actually ambiguous")

    def test_a_healthy_run_is_not_flagged_suspicious(self):
        self.assertIsNone(news_extract.coverage_is_suspicious(self.report))

    def test_a_matcher_that_resolves_nothing_IS_flagged(self):
        """
        Half a broad feed resolving no club is correct in the pre-season. EVERY
        entry resolving nothing means the bootstrap changed shape or the alias
        table went stale, and that must not look like a quiet news day.
        """
        broken = {"n_entries": 102, "n_claims": 0, "n_unique_surnames": 486}
        self.assertIsNotNone(news_extract.coverage_is_suspicious(broken))

    def test_an_empty_player_index_is_flagged(self):
        stale = {"n_entries": 102, "n_claims": 40, "n_unique_surnames": 0}
        self.assertIsNotNone(news_extract.coverage_is_suspicious(stale))

    def test_an_empty_run_is_not_flagged(self):
        # Nothing fetched is not a failure; it is a 304 on every feed.
        self.assertIsNone(news_extract.coverage_is_suspicious({"n_entries": 0}))


class KnownEntryTests(unittest.TestCase):
    """
    Named entries from the corpus, asserted individually.

    Aggregate counts can stay green while individual behaviour rots, so the
    interesting entries are pinned by name.
    """

    @classmethod
    def setUpClass(cls):
        cls.boot = _load_bootstrap()
        cls.clubs = build_club_index(cls.boot)
        cls.players = build_player_index(cls.boot)
        cls.by_title = {e.title: e for e in _load_corpus()}

    def _extract(self, title_fragment: str):
        matches = [e for t, e in self.by_title.items() if title_fragment in t]
        self.assertEqual(len(matches), 1, f"{title_fragment!r} matched {len(matches)}")
        return extract_entry(matches[0], self.clubs, self.players, 1, OBSERVED)

    def test_a_genuine_availability_headline_becomes_player_evidence(self):
        result = self._extract("optimistic update on Kulusevski")
        self.assertEqual(len(result.claims), 1)
        claim = result.claims[0]
        self.assertGreater(claim.element_id, 0)
        self.assertEqual(claim.claim_type, "unparsed_news")
        # Evidence, not a conclusion: nothing here says he is or is not available.
        self.assertIsInstance(claim.value, str)

    def test_the_womens_team_headline_yields_nothing(self):
        result = self._extract("Man Utd Women boss")
        self.assertEqual(result.claims, ())
        self.assertTrue(result.skipped)

    def test_an_editorial_listicle_yields_no_player(self):
        """
        "Best £5.0m midfielders for FPL 2026/27: All 89 assessed" is where `esse`
        used to match. It resolves no club either, so it yields nothing at all.
        """
        result = self._extract("All 89 assessed")
        self.assertEqual(
            [c.element_id for c in result.claims if c.element_id > 0], [],
        )

    def test_a_club_story_with_no_resolvable_player_is_still_evidence(self):
        result = self._extract("Newcastle United comes your way")
        self.assertEqual(len(result.claims), 1)
        self.assertEqual(result.claims[0].element_id, 0)
        self.assertIn("club-level", result.claims[0].notes)


if __name__ == "__main__":
    unittest.main()
