"""
The relevance gate, asserted post-by-post against the real captured feed.

`fixtures/x_feed_corpus.json` is a verbatim capture of 39 posts read through a
signed-in Chrome on 2026-08-12: one home timeline (21 posts) and one curated
profile scroll (18 posts, including three reposts). It is the only evidence that
exists for what a signed-in scan actually returns, so the expected verdict for
every single post is written out below rather than summarised. A gate scored only
in aggregate can lose the one post that matters and still report 38 of 39.

Two posts carry the whole argument:

    #13 @PolymarketSport  Arsenal's wedding packages — the canonical false
                          positive. Names a canonical club twice, has zero FPL
                          value, and `x_scan.club_in` returns "Arsenal" for it.
                          MUST be refused, and is refused twice over: no curated
                          surface AND zero football vocabulary.

    #21 @SolioAnalytics   reposts on the curated profile. All high signal, none
    #29 @FPL_Spaceman     naming a club at all, which is why a club-name gate
    #33 @OptaAnalyst      cannot be the mechanism. MUST pass.
"""

from __future__ import annotations

import json
import pathlib
import unittest

from pipeline.data import x_relevance as xr
from pipeline.data import x_scan

CORPUS_PATH = (pathlib.Path(__file__).resolve().parent / "fixtures"
               / "x_feed_corpus.json")

#: The scan's own trusted set for these tests. Injected rather than read from
#: config so a future account addition cannot change what this file asserts —
#: what is being tested is the gate, not today's account list.
TRUSTED = ("robtFPL",)

#: Expected verdict per corpus index, with the reason a refusal must give and a
#: one-line note on what the post actually is. Written by hand against the
#: capture; every entry below was read before it was labelled.
#:
#: `content` is the verdict of the CONTENT half alone (`is_football_text`), which
#: is what `run_news.py` re-runs over the committed inbox where no surface was
#: recorded. Two home posts pass content and are refused only by surface trust:
#: they are the design's two knowing false negatives.
EXPECTED = (
    (0,  False, "untrusted-surface", False, "Tata chairman steps down"),
    (1,  False, "promoted-post", False, "AI21 Labs ad"),
    (2,  False, "untrusted-surface", False, "Indian income-tax surcharges"),
    (3,  False, "untrusted-surface", False, "Tata resignation + Air India"),
    (4,  False, "untrusted-surface", False, "Indian unicorns of 2026"),
    (5,  False, "untrusted-surface", False, "UAE visa offer"),
    (6,  False, "promoted-post", False, "Bull Ai ad"),
    (7,  False, "untrusted-surface", False, "non-veg Tuesday meme"),
    (8,  False, "untrusted-surface", False, "Apple Pay vs UPI"),
    (9,  False, "untrusted-surface", False, "GTM/sales terminology"),
    (10, False, "untrusted-surface", False, "LinkedOut startup joke"),
    (11, False, "promoted-post", False, "tee-shirt ad"),
    (12, False, "untrusted-surface", False, "cockroaches and food licences"),
    (13, False, "untrusted-surface", False,
     "THE FALSE POSITIVE: Arsenal wedding packages"),
    (14, False, "untrusted-surface", False, "Karnataka bans Gutka"),
    (15, False, "untrusted-surface", False, "Lakers sold for $12bn"),
    (16, False, "promoted-post", False, "LevelUp bootcamp ad"),
    (17, False, "untrusted-surface", True,
     "FALSE NEGATIVE: City/Chelsea midfield spending, real football"),
    (18, False, "untrusted-surface", False, "Sam Altman quote thread"),
    (19, False, "untrusted-surface", True,
     "FALSE NEGATIVE: Djed Spence to Inter, a real availability change"),
    (20, False, "untrusted-surface", False, "Nvidia Nemotron"),
    (21, True,  "ok", True, "REPOST @SolioAnalytics: pod, shot maps, GW1 draft"),
    (22, True,  "ok", True, "season-long G+A spreads"),
    (23, True,  "ok", True, "Liverpool pre-season minutes summary"),
    (24, True,  "ok", True, "heat maps, starting full-backs"),
    (25, True,  "ok", True, "Arsenal friendly summary, set pieces"),
    (26, True,  "ok", True, "touch heat maps for main XI"),
    (27, True,  "ok", True, "Man City friendly summary"),
    (28, True,  "ok", True, "heat maps for the outfield starting XI"),
    (29, True,  "ok", True, "REPOST @FPL_Spaceman: PL squad depth charts"),
    (30, True,  "ok", True, "Man Utd friendly: injury for Mount, knock for Shaw"),
    (31, True,  "ok", True, "Brighton friendly: Minteh injury"),
    (32, True,  "ok", True, "Chelsea friendly: wing-backs, corners"),
    (33, True,  "ok", True, "REPOST @OptaAnalyst: FPL set-piece feature"),
    (34, True,  "ok", True, "projected set-piece takers for all 20 clubs"),
    (35, True,  "ok", True, "G+A spreads, FWD season goals"),
    (36, True,  "ok", True, "pod on depth charts and fixture runs"),
    (37, True,  "ok", True, "GW1-19 fixture runs"),
    (38, True,  "ok", True, "clean sheet odds by 5GW stretch"),
)


def load_corpus():
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))


def verdict_for(post, trusted=TRUSTED):
    """The gate's decision for one captured post, via the real body parser."""
    origin = str(post.get("origin") or "")
    handle = "home" if origin == "home" else origin.split(":", 1)[-1]
    body = x_scan.body_from_lines(post["lines"])
    return xr.is_football_relevant(
        body, post.get("author", ""), handle=handle, lines=post["lines"],
        trusted=trusted,
    )


class CorpusIsWhatWeThinkItIs(unittest.TestCase):
    """
    Guard the evidence before guarding the code.

    Every claim this module makes about precision is a claim about this file. If
    the fixture is edited, the expectations below stop meaning what they say, and
    the failure would look like a gate regression.
    """

    def test_the_corpus_has_the_measured_shape(self):
        corpus = load_corpus()
        self.assertEqual(len(corpus), 39)
        self.assertEqual(sum(p["origin"] == "home" for p in corpus), 21)
        self.assertEqual(
            sum(p["origin"] == "profile:robtFPL" for p in corpus), 18,
        )

    def test_the_expectations_cover_every_post_exactly_once(self):
        self.assertEqual([row[0] for row in EXPECTED],
                         list(range(len(load_corpus()))))


class EveryPostIsClassified(unittest.TestCase):
    def test_each_post_gets_the_expected_verdict(self):
        corpus = load_corpus()
        for index, expected_pass, reason, _content, note in EXPECTED:
            post = corpus[index]
            with self.subTest(index=index, author=post["author"], note=note):
                verdict = verdict_for(post)
                self.assertEqual(verdict.passed, expected_pass, verdict)
                self.assertTrue(
                    verdict.reason.startswith(reason),
                    f"#{index} refused as {verdict.reason!r}, expected "
                    f"{reason!r}",
                )

    def test_the_content_half_agrees_where_it_is_expected_to(self):
        """
        `run_news.py` re-runs the content half over the committed inbox.

        It must keep everything the scan filed (or a stored row would vanish on
        the next poll) and still refuse the wedding post, which is the row a
        pre-gate scan could have left behind.
        """
        corpus = load_corpus()
        for index, _passed, _reason, expected_content, note in EXPECTED:
            post = corpus[index]
            with self.subTest(index=index, note=note):
                body = x_scan.body_from_lines(post["lines"])
                self.assertEqual(
                    xr.is_football_text(body, post["lines"]).passed,
                    expected_content,
                )

    def test_totals(self):
        # Stated as numbers because the whole design was chosen on them.
        corpus = load_corpus()
        verdicts = [verdict_for(post) for post in corpus]
        self.assertEqual(sum(v.passed for v in verdicts), 18)
        self.assertEqual(sum(not v.passed for v in verdicts), 21)

    def test_no_home_post_is_ever_filed(self):
        for post in load_corpus():
            if post["origin"] != "home":
                continue
            with self.subTest(author=post["author"]):
                self.assertFalse(verdict_for(post).passed)

    def test_every_curated_profile_post_is_filed(self):
        # The other half of the trade. Refusing the home feed is only defensible
        # if the curated scroll survives intact — otherwise the gate is just a
        # smaller scan.
        for post in load_corpus():
            if post["origin"] == "home":
                continue
            with self.subTest(author=post["author"]):
                self.assertTrue(verdict_for(post).passed, post["author"])


class TheCanonicalFalsePositive(unittest.TestCase):
    """
    @PolymarketSport, corpus #13, and the two independent reasons it dies.
    """

    def _post(self):
        return next(p for p in load_corpus()
                    if p["author"] == "PolymarketSport")

    def test_it_is_refused(self):
        self.assertFalse(verdict_for(self._post()).passed)

    def test_club_in_really_does_resolve_a_club_for_it(self):
        # Not a hypothetical: the club lookup the row would be labelled with says
        # "Arsenal". That is what makes a club-name gate file this post.
        body = x_scan.body_from_lines(self._post()["lines"])
        self.assertEqual(x_scan.club_in(body), "Arsenal")

    def test_it_scores_zero_football_vocabulary(self):
        # The second, independent refusal. Even if it were reposted onto a
        # curated timeline tomorrow, it does not say one football thing.
        body = x_scan.body_from_lines(self._post()["lines"])
        self.assertEqual(xr.football_signals(body), {})
        self.assertFalse(xr.is_football_text(body).passed)

    def test_a_club_name_never_admits_a_post(self):
        # Generalised, because the specific post is only an example. These both
        # name a canonical club and are business news.
        for text in (
            "Arsenal Capital Partners' managing director was named today.",
            "Everton shares suspended after the takeover filing.",
            "Emirates Stadium now hosts wedding receptions for Arsenal fans.",
        ):
            with self.subTest(text=text):
                self.assertTrue(x_scan.club_in(text))
                self.assertFalse(
                    xr.is_football_relevant(
                        text, "robtFPL", handle="robtFPL", trusted=TRUSTED,
                    ).passed,
                )


class TheHighSignalReposts(unittest.TestCase):
    """
    The three posts a trusted-author allowlist would have missed.

    They are reposts by accounts nobody listed, on a page we did open. Trust is a
    property of that page, so they inherit it; the same posts on the home feed do
    not. This is the recall the design buys, and it must not regress.
    """

    def _post(self, author):
        return next(p for p in load_corpus() if p["author"] == author)

    def test_each_repost_passes_on_the_curated_profile(self):
        for author in ("SolioAnalytics", "FPL_Spaceman", "OptaAnalyst"):
            with self.subTest(author=author):
                verdict = verdict_for(self._post(author))
                self.assertTrue(verdict.passed, verdict)
                self.assertTrue(verdict.terms, "admitted with no evidence")

    def test_none_of_them_names_a_club(self):
        # The measurement that rules out a club-name requirement: requiring a
        # club would refuse all three.
        for author in ("SolioAnalytics", "FPL_Spaceman", "OptaAnalyst"):
            body = x_scan.body_from_lines(self._post(author)["lines"])
            with self.subTest(author=author):
                self.assertEqual(x_scan.club_in(body), "")

    def test_the_same_repost_seen_on_the_home_feed_is_refused(self):
        post = self._post("OptaAnalyst")
        body = x_scan.body_from_lines(post["lines"])
        self.assertFalse(
            xr.is_football_relevant(body, "OptaAnalyst", handle="home",
                                    trusted=TRUSTED).passed,
        )

    def test_the_opta_card_line_is_not_treated_as_an_ad_tell(self):
        # A rejected heuristic, pinned. "From <domain>" looks like an ad marker
        # and would cost exactly this post.
        body = x_scan.body_from_lines(self._post("OptaAnalyst")["lines"])
        self.assertIn("From theanalyst.com", body)
        self.assertTrue(xr.is_football_text(body).passed)


class SurfaceTrust(unittest.TestCase):
    def test_a_curated_handle_is_trusted(self):
        self.assertTrue(xr.is_football_relevant(
            "Arsenal have no fresh injury concerns ahead of the weekend.",
            "someone_else", handle="robtFPL", trusted=TRUSTED).passed)

    def test_a_curated_author_is_trusted_wherever_it_is_seen(self):
        self.assertTrue(xr.is_football_relevant(
            "Arsenal have no fresh injury concerns ahead of the weekend.",
            "robtFPL", handle="home", trusted=TRUSTED).passed)

    def test_handles_compare_case_insensitively(self):
        # X handles are case-insensitive, and the page can render either form.
        self.assertTrue(xr.is_football_relevant(
            "Team news: Saka trains fully.", "ROBTFPL", handle="RobtFPL",
            trusted=TRUSTED).passed)

    def test_a_leading_at_sign_on_the_author_is_tolerated(self):
        self.assertTrue(xr.is_football_relevant(
            "Team news: Saka trains fully.", "@robtFPL", handle="home",
            trusted=TRUSTED).passed)

    def test_an_unknown_surface_is_refused_even_for_real_team_news(self):
        """
        The knowing cost, written down as a test rather than as a caveat.

        A genuine injury report from an account we never curated is refused. It
        is accepted because the RSS lane covers reporters and `file_claim.py`
        covers a human who reads one, so the home feed adds volume rather than
        unique coverage — and because a rumoured exit that never happens can push
        availability down under R4.
        """
        verdict = xr.is_football_relevant(
            "Newcastle confirm Isak is ruled out for six weeks with a groin "
            "injury.", "SomeReporter", handle="home", trusted=TRUSTED)
        self.assertFalse(verdict.passed)
        self.assertEqual(verdict.reason, "untrusted-surface")

    def test_a_blank_author_on_a_shared_surface_is_refused(self):
        """
        No author, no filing.

        `to_items` falls back to the CLI `--source` when the extractor cannot read
        an author. On a home timeline that stamps a stranger's post `x:robtFPL`,
        and the author is the only thing that makes these rows admissible.
        """
        verdict = xr.is_football_relevant(
            "Team news: Saka trains fully and starts.", "", handle="home",
            trusted=TRUSTED)
        self.assertFalse(verdict.passed)
        self.assertEqual(verdict.reason, "no-author-on-untrusted-surface")

    def test_a_blank_author_on_a_curated_profile_still_files(self):
        # The one case where the fallback attribution is accurate: one page, one
        # author. Pinned because `test_x_scan` relies on it, with the reasoning
        # that losing the post entirely is worse than a coarse attribution.
        self.assertTrue(xr.is_football_relevant(
            "Team news: Saka trains fully and starts.", "", handle="robtFPL",
            trusted=TRUSTED).passed)

    def test_a_malformed_author_cannot_launder_an_untrusted_surface(self):
        for bad in ("not a handle", "a/b", "x" * 16, "робт", "'; DROP"):
            with self.subTest(bad):
                self.assertFalse(xr.is_football_relevant(
                    "Team news: Saka trains fully and starts.", bad,
                    handle="home", trusted=TRUSTED).passed)

    def test_with_no_trusted_surfaces_nothing_passes(self):
        # Fail-safe direction: an empty or broken account table refuses
        # everything rather than admitting everything.
        self.assertFalse(xr.is_football_relevant(
            "Team news: Saka trains fully and starts.", "robtFPL",
            handle="robtFPL", trusted=()).passed)

    def test_the_default_trusted_set_comes_from_config(self):
        from pipeline.config import X_SCAN_ACCOUNTS
        self.assertEqual(
            xr.trusted_handles(),
            frozenset(str(a["handle"]).lower() for a in X_SCAN_ACCOUNTS),
        )


class Vetoes(unittest.TestCase):
    def test_a_promoted_post_is_refused_from_its_raw_lines(self):
        # Asserted against `lines`, not the assembled body: the body only happens
        # to keep "Ad" as its first line today, and a cleanup of that must not
        # silently disable the veto.
        lines = ["Some Brand", "@somebrand", "Ad",
                 "Arsenal's new kit - injury-free comfort, trains fully"]
        self.assertTrue(xr.is_promoted("", lines))
        self.assertFalse(xr.is_football_relevant(
            x_scan.body_from_lines(lines), "robtFPL", handle="robtFPL",
            lines=lines, trusted=TRUSTED).passed)

    def test_a_football_brand_ad_on_a_curated_timeline_is_still_refused(self):
        # The reason the veto is kept even though the trust check already refuses
        # every ad in the corpus: an advert is never team news, and a curated
        # account can be shown one.
        verdict = xr.is_football_relevant(
            "Ad\nArsenal's new kit - injury-free comfort", "robtFPL",
            handle="robtFPL", trusted=TRUSTED)
        self.assertFalse(verdict.passed)
        self.assertEqual(verdict.reason, "promoted-post")

    def test_every_ad_in_the_corpus_is_caught_by_shape(self):
        ads = [p for p in load_corpus()
               if any(line.strip() == "Ad" for line in p["lines"][:4])]
        self.assertEqual(len(ads), 4)
        for post in ads:
            with self.subTest(author=post["author"]):
                self.assertTrue(xr.is_promoted(
                    x_scan.body_from_lines(post["lines"]), post["lines"]))

    def test_the_womens_and_academy_exclusion_is_reused_not_reinvented(self):
        from pipeline.data import news_extract
        text = "Olid named new Man Utd Women boss; she trains fully with the squad."
        self.assertIsNotNone(news_extract.is_out_of_scope(text))
        verdict = xr.is_football_relevant(text, "robtFPL", handle="robtFPL",
                                         trusted=TRUSTED)
        self.assertFalse(verdict.passed)
        self.assertTrue(verdict.reason.startswith("out-of-scope"))

    def test_gambling_promos_are_refused_behind_a_trusted_handle(self):
        # The hole the trust layer leaves open: organic betting spam is not
        # flagged "Ad" and carries real football vocabulary.
        for text in (
            "Bet on Arsenal vs Chelsea this gameweek - free bet for new customers",
            "Use code FPL50 for a deposit bonus on the Premier League opener. 18+",
        ):
            with self.subTest(text=text):
                verdict = xr.is_football_relevant(
                    text, "robtFPL", handle="robtFPL", trusted=TRUSTED)
                self.assertFalse(verdict.passed)
                self.assertTrue(verdict.reason.startswith("gambling-promo"))


class Vocabulary(unittest.TestCase):
    def test_accented_names_do_not_break_a_match(self):
        # Folding is load-bearing on this corpus, not hypothetically:
        # Šeško/Estêvão (#22), Ødegaard (#26), Groß/Vušković (#31), García (#35).
        for text in ("Ødegaard was a planned 30' sub and played longer at CM",
                     "Groß on all set pieces as expected, 45' for Vušković",
                     "Šeško and Estêvão added to the G+A markets"):
            with self.subTest(text=text):
                self.assertTrue(xr.is_football_text(text).passed, text)

    def test_uppercase_abbreviations_cannot_fire_on_prose(self):
        """
        The collisions that make a naive abbreviation list a liability.

        Each of these is a real string from a news-heavy timeline, and each is
        why the short abbreviations match case-sensitively in uppercase only.
        """
        for text in (
            "Xi Jinping met the delegation in Beijing this morning.",
            "The panel is 30cm wide and ships flat.",
            "India added 5GW of solar capacity last quarter.",
            "The cf command failed on the deploy box.",
        ):
            with self.subTest(text=text):
                self.assertEqual(xr.football_signals(text), {}, text)

    def test_the_uppercase_forms_do_match(self):
        for text in ("Touch heat maps for main XI",
                     "Gvardiol started LB and moved inside",
                     "a punchy total for the #FPL 6.0 FWDs",
                     "GW1-19 fixture runs"):
            with self.subTest(text=text):
                self.assertTrue(xr.is_football_text(text).passed, text)

    def test_generic_availability_words_cannot_admit_a_post_alone(self):
        """
        The residual class a bare `injury` rule leaves open.

        "injury" is ordinary English. The football-specific phrasing is what a
        real team-news post uses, and that is what carries a post on its own.
        """
        verdict = xr.is_football_relevant(
            "A workplace injury claim was filed against the Anderson group.",
            "robtFPL", handle="robtFPL", trusted=TRUSTED)
        self.assertFalse(verdict.passed)
        self.assertEqual(verdict.reason, "generic-availability-only")
        self.assertEqual(verdict.families, ("availability_generic",))

    def test_the_other_generic_availability_words_are_equally_powerless(self):
        # "unavailable" is in the vocabulary because corpus #29 uses it about
        # players, but "the service is unavailable" must not file a claim.
        for text in ("The service is unavailable until Monday.",
                     "She misses out on the promotion round.",
                     "Corporate fitness memberships are half price."):
            with self.subTest(text=text):
                verdict = xr.is_football_relevant(
                    text, "robtFPL", handle="robtFPL", trusted=TRUSTED)
                self.assertFalse(verdict.passed, text)
                self.assertEqual(verdict.reason, "generic-availability-only")

    def test_football_specific_availability_carries_a_post_alone(self):
        for text in ("Isak is ruled out for six weeks with a groin injury",
                     "He limped off in the second half",
                     "Saka trains fully and is match fit",
                     "No fresh injury concerns reported"):
            with self.subTest(text=text):
                verdict = xr.is_football_relevant(
                    text, "robtFPL", handle="robtFPL", trusted=TRUSTED)
                self.assertTrue(verdict.passed, text)

    def test_business_homographs_that_were_deliberately_excluded(self):
        """
        Every term dropped during design, pinned so re-adding one fails here.

        This is the test that makes the exclusion list a decision rather than an
        anecdote in a comment.
        """
        for text in (
            "The agent assists analysts across the entire customer journey.",
            "The wage differential widened again this quarter.",
            "Q3 goals were met and the hiring window closes Friday.",
            "You can add transit cards and tap to pay at a metro station.",
            "Management credibility across 3,000+ NSE/BSE companies.",
            "We cut corners on the rollout and the form is fine.",
            "It only takes 3 minutes and the form is user-friendly.",
            "A wildcard entry in the draft, delivered free.",
            "Our P&L improved and the transfer settled next day.",
            "The training data was relabelled before the trains arrived.",
        ):
            with self.subTest(text=text):
                self.assertEqual(xr.football_signals(text), {}, text)

    def test_no_admitted_corpus_post_rests_on_a_single_term(self):
        """
        Fragility check, not a coverage check.

        A post admitted by exactly one matched term is one rewording away from
        being dropped. Measured before the uppercase-abbreviation and
        corner-verb patterns landed, three profile posts (#22, #26, #32) rested
        on one term each; they now carry at least two.
        """
        for post in load_corpus():
            if post["origin"] == "home":
                continue
            body = x_scan.body_from_lines(post["lines"])
            with self.subTest(author=post["author"], body=body[:40]):
                self.assertGreaterEqual(
                    len(xr.is_football_text(body, post["lines"]).terms), 2,
                )

    def test_the_gate_never_synthesises_anything(self):
        """
        It only ever says no.

        The verdict carries the literal matched substrings and nothing else — no
        availability value, no player, no club, no tier. Anything else would be a
        fabricated number wearing a citation.
        """
        body = x_scan.body_from_lines(
            next(p for p in load_corpus() if p["author"] == "FPL_Spaceman")["lines"]
        )
        verdict = verdict_for(
            next(p for p in load_corpus() if p["author"] == "FPL_Spaceman"))
        self.assertEqual(set(verdict.__dataclass_fields__),
                         {"passed", "reason", "families", "terms"})
        for term in verdict.terms:
            self.assertIn(term.lower(), body.lower())

    def test_the_verdict_is_immutable(self):
        verdict = xr.is_football_text("Saka trains fully")
        with self.assertRaises(Exception):
            verdict.passed = False  # type: ignore[misc]


class VersionAndPurity(unittest.TestCase):
    def test_the_vocabulary_size_is_pinned_to_the_gate_version(self):
        """
        A term added without bumping `GATE_VERSION` fails here.

        The version is what lets a stored row say which gate admitted it. "We
        filed this because it mentioned a hamstring" and "we filed this because
        someone widened the vocabulary" are different claims about the same CSV.
        """
        # v1 was (1, 79). v2 adds the missing body parts, surgery, and the verb
        # inflections an adversarial pass measured as missing.
        self.assertEqual((xr.GATE_VERSION, xr.PATTERN_COUNT), (2, 94))

    def test_every_pattern_compiles_and_is_anchored(self):
        # An unanchored pattern is the measured failure mode from the sibling
        # lane: unbounded "signed" matches "resigned", unbounded "manager"
        # matches "Management".
        for family, patterns in {**xr.FOLDED, **xr.EXACT}.items():
            for pattern in patterns:
                with self.subTest(family=family, pattern=pattern):
                    self.assertIn("\\b", pattern)

    def test_signed_does_not_match_resigned(self):
        self.assertEqual(
            xr.football_signals("The chairman resigned after the board vote."),
            {},
        )

    def test_it_makes_no_network_call_and_needs_no_snapshot(self):
        """
        Pure, offline, deterministic — CLAUDE.md's constraint for anything the
        unattended pipeline depends on.

        Deliberately no bootstrap-derived player index: 441 of 663 surname keys
        are ambiguous, and the gate would then depend on a snapshot whose absence
        silently changes every decision.
        """
        source = (pathlib.Path(xr.__file__)).read_text(encoding="utf-8")
        for forbidden in ("requests", "urllib", "http", "open(", "read_text",
                          "bootstrap"):
            self.assertNotIn(f"{forbidden}.", source, forbidden)
        self.assertNotIn("import requests", source)
        self.assertNotIn("import urllib", source)

    def test_the_club_table_is_still_the_only_club_list(self):
        """
        Constraint 2: club names go through `team_mapping.TEAM_ALIASES`.

        The gate must not hold a second club list, not even a small one — and it
        must not consult the real one either, because a club name is neither
        necessary nor sufficient here. `TEAM_ALIASES` may be *named* in the
        docstring (it is the table this module explains why it does not use); what
        must not exist is an import of it or a club pattern.
        """
        source = (pathlib.Path(xr.__file__)).read_text(encoding="utf-8")
        self.assertNotIn("team_mapping", source)
        self.assertNotIn("TEAM_ALIASES =", source)
        for club in ("Arsenal", "Liverpool", "Man City", "Tottenham",
                     "Brighton", "Wolves"):
            with self.subTest(club=club):
                self.assertNotIn(f"\\b{club}", source)
                self.assertNotIn(f"{club.lower()}|", source)


class ScanIntegration(unittest.TestCase):
    """
    The gate reaches `to_items`, which is where a refused post is dropped.

    Asserted end to end over the corpus, with URLs synthesised from each post's
    author and status id — the capture has no `url` field, and `to_items`
    requires one.
    """

    def _scan(self, origin):
        posts = [
            {"status_id": p["status_id"], "author": p["author"],
             "url": f"https://x.com/{p['author']}/status/{p['status_id']}",
             "lines": p["lines"]}
            for p in load_corpus() if p["origin"] == origin
        ]
        handle = "home" if origin == "home" else origin.split(":", 1)[-1]
        return {"handle": handle, "posts": posts}

    def _now(self):
        # Late enough that every capture is inside the age window, since the
        # corpus was captured on 2026-08-12 and holds posts back to 4 August.
        from datetime import datetime, timezone
        return datetime(2026, 8, 12, 12, tzinfo=timezone.utc)

    def test_the_home_feed_files_nothing(self):
        items = x_scan.to_items(self._scan("home"), source="x:home-feed",
                                now=self._now(), max_age_days=30,
                                trusted=TRUSTED)
        self.assertEqual(items, [])

    def test_the_curated_scroll_files_every_post_it_read(self):
        items = x_scan.to_items(self._scan("profile:robtFPL"),
                                source="x:robtFPL", now=self._now(),
                                max_age_days=30, trusted=TRUSTED)
        self.assertEqual(len(items), 18)
        self.assertTrue(all(i["claim_type"] == "unparsed_news" for i in items))
        self.assertTrue(all(i["tier"] == 3 for i in items))

    def test_the_reposts_keep_their_own_attribution(self):
        items = x_scan.to_items(self._scan("profile:robtFPL"),
                                source="x:robtFPL", now=self._now(),
                                max_age_days=30, trusted=TRUSTED)
        sources = {i["source"] for i in items}
        for author in ("SolioAnalytics", "FPL_Spaceman", "OptaAnalyst"):
            self.assertIn(f"x:{author}", sources)

    def test_refusals_are_logged_by_reason(self):
        # Silent recall loss is an allowlist's only real failure mode, so the
        # counts have to be visible in the run log.
        with self.assertLogs("pipeline.data.x_scan", level="INFO") as logs:
            x_scan.to_items(self._scan("home"), source="x:home-feed",
                            now=self._now(), max_age_days=30, trusted=TRUSTED)
        text = "\n".join(logs.output)
        self.assertIn("untrusted-surface", text)
        self.assertIn("promoted-post", text)

    def test_a_curated_scan_that_files_nothing_warns(self):
        """
        The extractor-drift alarm.

        A curated page filing 0 of N is indistinguishable from a quiet day unless
        it says so — the same failure CLAUDE.md records for the duplicated
        scraper, which "returns zero posts and reports success".
        """
        scan = {"handle": "robtFPL", "posts": [
            {"status_id": "2086478896937963659", "author": "robtFPL",
             "url": "https://x.com/robtFPL/status/2086478896937963659",
             "lines": ["Rob T", "@robtFPL", "9 Aug",
                       "Off topic but this restaurant in Soho is genuinely "
                       "excellent, go before the queues start"]},
        ]}
        with self.assertLogs("pipeline.data.x_scan", level="WARNING") as logs:
            items = x_scan.to_items(scan, source="x:robtFPL", now=self._now(),
                                    max_age_days=30, trusted=TRUSTED)
        self.assertEqual(items, [])
        self.assertIn("filed 0 of 1", "\n".join(logs.output))

    def test_the_truncation_marker_is_not_part_of_the_claim(self):
        # X renders "Show more" as its own line on a long post (corpus
        # #0/#9/#18/#20). It is chrome, and it was sitting inside the verbatim
        # quote a human reads on /evidence.
        lines = ["Rob T", "@robtFPL", "9 Aug",
                 "Arsenal summary from the Dortmund friendly - set pieces and",
                 "Show more", "4", "5"]
        body = x_scan.body_from_lines(lines)
        self.assertNotIn("Show more", body)
        self.assertTrue(body.endswith("set pieces and"), body)

    def test_the_gate_cannot_be_switched_off(self):
        # There is no flag. An opt-in gate has to default somewhere, and the
        # caller most likely to forget it is a signed-in session reading home.
        import inspect
        signature = inspect.signature(x_scan.to_items)
        for forbidden in ("gate", "screen", "relevance", "filter"):
            self.assertNotIn(forbidden, signature.parameters, forbidden)


class IngestRescreen(unittest.TestCase):
    """
    The poller screens the committed inbox again, not just the scan.

    The inbox is a file in git, so it holds whatever an older scanner wrote —
    including, before this gate existed, a signed-in home scroll. A row is not
    trustworthy forever because some earlier version accepted it.
    """

    def _run_news(self):
        return (pathlib.Path(__file__).resolve().parents[1] / "learning"
                / "run_news.py").read_text(encoding="utf-8")

    def test_the_poller_re_runs_the_content_half(self):
        source = self._run_news()
        self.assertIn("x_relevance.is_football_text", source)
        # Only the content half can run there: the CSV records `source` and the
        # verbatim text, never which page the post came from.
        self.assertNotIn("x_relevance.is_football_relevant", source)

    def test_it_only_screens_rows_the_scan_wrote(self):
        # Sheet and Grok rows arrive through the same columns and are a human's
        # or another lane's judgement; screening them with an X vocabulary would
        # silently drop them.
        self.assertIn('startswith("x:")', self._run_news())

    def test_a_legacy_row_from_a_wider_scan_is_refused(self):
        wedding = next(p for p in load_corpus()
                       if p["author"] == "PolymarketSport")
        row = {"source": "x:PolymarketSport",
               "value": x_scan.body_from_lines(wedding["lines"])}
        self.assertFalse(xr.is_football_text(str(row["value"])).passed)

    def test_every_row_the_current_scan_writes_survives_the_rescreen(self):
        # If this were not true, a filed row would vanish on the next poll and the
        # inbox and the store would disagree about what was read.
        scan = {"handle": "robtFPL", "posts": [
            {"status_id": p["status_id"], "author": p["author"],
             "url": f"https://x.com/{p['author']}/status/{p['status_id']}",
             "lines": p["lines"]}
            for p in load_corpus() if p["origin"] == "profile:robtFPL"
        ]}
        from datetime import datetime, timezone
        items = x_scan.to_items(
            scan, source="x:robtFPL",
            now=datetime(2026, 8, 12, 12, tzinfo=timezone.utc),
            max_age_days=30, trusted=TRUSTED,
        )
        self.assertEqual(len(items), 18)
        for item in items:
            with self.subTest(source=item["source"]):
                self.assertTrue(xr.is_football_text(item["value"]).passed)


class AdversarialFindings(unittest.TestCase):
    """
    The defects an adversarial pass found in gate v1, each pinned by the input
    that exposed it.

    Every case below is quoted from a finding that was *executed* against v1, not
    argued. Keeping the original inputs matters more than paraphrasing them: a fix
    verified against a reworded case is a fix I believe in, not one I know about.
    """

    def gate(self, text, author="robtFPL", handle="robtFPL", root=True):
        return xr.is_football_relevant(
            text, author, handle=handle, lines=text.split("\n"),
            trusted=TRUSTED, profile_root=root,
        )

    # ── Trust was keyed to the profile OWNER, not the page's authors ──────────

    def test_a_stranger_off_the_profile_root_is_refused(self):
        """
        The worst of the findings, and it filed 5 of 5.

        `handle` comes from the URL's first path segment, so `/robtFPL`,
        `/robtFPL/with_replies` and `/robtFPL/status/<id>` all report "robtFPL" —
        but the last two render articles by arbitrary strangers, and the extractor
        takes `querySelectorAll('article')` unfiltered. The geopolitics example is
        the one to keep: it was filed with `club='Arsenal'` because "nuclear
        arsenal" contains a club alias.
        """
        for text in (
            "Congrats! Our clean sheets NFT collection mints tonight, link in bio",
            "nothing beats a bed with clean sheets after a 14 hour flight",
            "Great quarter. Q3 was on target and the kick-off call was Monday.",
            "the Chiefs have ruled out their linebacker with a hamstring",
            "Russia has ruled out any reduction of its nuclear arsenal.",
        ):
            verdict = self.gate(text, author="cryptobot99", root=False)
            self.assertFalse(verdict.passed, text)
            self.assertEqual(verdict.reason, "untrusted-surface")

    def test_the_owners_own_post_is_still_trusted_off_the_root(self):
        # Reading robtFPL's own post at `/robtFPL/status/<id>` asserts exactly what
        # reading it on the timeline does, so the fix must not cost that.
        self.assertTrue(self.gate(
            "Arsenal summary: 60 mins for Gabriel, set pieces second half.",
            author="robtFPL", root=False,
        ).passed)

    def test_a_repost_on_the_root_timeline_still_inherits_trust(self):
        # The behaviour the fix must NOT break: @OptaAnalyst, @SolioAnalytics and
        # @FPL_Spaceman are the highest-signal content measured, and they reach us
        # only as reposts on a curated root timeline.
        self.assertTrue(self.gate(
            "Shot maps and set pieces: comparing chip strategy for GW1.",
            author="OptaAnalyst", root=True,
        ).passed)

    # ── The vocabulary saw 4 of 13 body parts and had no word for surgery ─────

    def test_surgery_and_the_missing_body_parts_are_seen(self):
        for text in (
            "Confirmed: Saka has had knee surgery and will be out until October.",
            "Rodri underwent an operation on his ankle yesterday.",
            "Wirtz has a stress fracture in his foot.",
            "Foden has a slight thigh strain.",
            "Gabriel suffered a shoulder injury and did not travel.",
        ):
            self.assertTrue(self.gate(text).passed, text)

    def test_no_body_part_asymmetry_remains(self):
        """
        v1 saw hamstring and not knee, which is not a judgement about evidence —
        it is a gap in a list. The parts now come from `availability_news.py`, so
        the two lanes cannot disagree about what counts as an injury.
        """
        from pipeline.data.availability_news import _LIGAMENT, _MUSCULAR
        for part in sorted(_MUSCULAR | _LIGAMENT):
            text = f"Saka has a {part} problem and is out for three weeks."
            self.assertIn("availability", xr.football_signals(text), part)

    def test_the_inflections_real_posts_use_are_seen(self):
        # v1 carried nouns without verbs: "faces a suspension" passed while "is
        # suspended for three games" did not.
        for text in (
            "Saka is suspended for three games.",
            "Saka is doubtful for the weekend.",
            "Saka is out until October.",
            "Saka has a 25% chance of playing.",
            "Isak has been left out of the travelling squad.",
        ):
            self.assertTrue(self.gate(text).passed, text)

    def test_fpls_own_news_strings_are_all_seen(self):
        """
        The sharpest version of the asymmetry: these are the literal strings
        `availability_news.PATTERNS` parses into availability facts. v1 passed the
        hamstring and groin ones and refused the knee, thigh and shoulder ones.
        """
        for text in (
            "Hamstring injury - Unknown return date",
            "Knee injury - Unknown return date",
            "Thigh injury - Unknown return date",
            "Shoulder injury - 50% chance of playing",
            "Suspended until 29 Aug",
        ):
            self.assertTrue(self.gate(text).passed, text)

    def test_the_new_terms_did_not_admit_business_prose(self):
        """
        Two of these were false positives I introduced while fixing recall, caught
        by the pre-existing corpus and club-name tests rather than by foresight:
        `back` as a body part (ordinary English), and bare `suspended` (which
        admitted "Everton shares suspended after the takeover filing" — a club name
        plus a finance verb, the exact shape this module exists to refuse).
        """
        for text in (
            "Everton shares suspended after the takeover filing.",
            "The team is back on the picket line on Monday.",
            "The fund underwent a review and the operation of the business is fine.",
            "It is doubtful that the merger completes this quarter.",
        ):
            self.assertFalse(xr.is_football_text(text).passed, text)

    # ── A regulatory marker the promo check could never match ────────────────

    def test_the_18_plus_marker_is_matched(self):
        r"""
        `\b18\+\b` can never match a real "18+": a word boundary after "+" needs a
        following word character, so it fired only on "18+only". Its test passed
        because both fixtures also said "free bet" or "deposit bonus", so the one
        pattern meant to catch a bare regulatory marker was never exercised.
        """
        import re
        self.assertIsNone(re.compile(r"\b18\+\b").search("18+ only"))
        for text in (
            "Bet on Arsenal vs Chelsea this gameweek. 18+ only.",
            "Best odds on the Premier League starting XI markets. 18+. Bet now.",
        ):
            verdict = self.gate(text)
            self.assertFalse(verdict.passed, text)
            self.assertTrue(verdict.reason.startswith("gambling-promo"), verdict.reason)

    # ── A headline exclusion list applied to multi-topic bodies ──────────────

    def test_an_incidental_academy_mention_no_longer_discards_team_news(self):
        # v1 refused these for one incidental word while its own `football_signals`
        # had matched senior availability evidence.
        for text in (
            "Arteta confirms Saka is ruled out; academy graduate Nwaneri starts.",
            "Rooney is a legend, but Mount has a hamstring tear and is ruled out.",
            "Team news: Palmer ruled out with a groin issue, U21 keeper on the bench.",
        ):
            self.assertTrue(self.gate(text).passed, text)

    def test_a_womens_story_is_still_refused_however_much_evidence_it_carries(self):
        """
        The scoping is NOT uniform, and my first version got this wrong.

        A women's or WSL story concerns a competition whose players have no
        `element_id`, so availability language in it is still not senior team news.
        "academy"/"U21"/"legend" describe people who appear in senior stories;
        "Women"/"WSL" describe a different competition. The pre-existing reuse test
        is what caught the difference.
        """
        for text in (
            "Olid named new Man Utd Women boss; she trains fully with the squad.",
            "WSL: their striker is ruled out for six weeks with a hamstring.",
        ):
            verdict = self.gate(text)
            self.assertFalse(verdict.passed, text)
            self.assertTrue(verdict.reason.startswith("out-of-scope"), verdict.reason)

    # ── The claim of mine that the audit refuted ─────────────────────────────

    def test_the_content_half_is_not_claimed_to_be_a_football_classifier(self):
        """
        I reported that the wedding post was "refused by both layers
        independently". Executed, that is false: one added clause makes it pass the
        content half. The refusal was a property of the words that tweet used, not
        of the design — so the docstring now says the trust layer is what makes the
        gate sound, and this pins the honest version.
        """
        reworded = (
            "FACT: Emirates Stadium offers wedding ceremonies and receptions. "
            "Arsenal's website says 'Say I Do at Emirates Stadium.' "
            "Kick-off for the first ceremony is in September."
        )
        self.assertTrue(xr.is_football_text(reworded).passed)
        # The trust layer is what actually stops it.
        self.assertFalse(xr.is_football_relevant(
            reworded, "PolymarketSport", handle="home", trusted=TRUSTED,
        ).passed)
        source = pathlib.Path(xr.__file__).read_text(encoding="utf-8")
        self.assertNotIn("either layer alone refuses it", source)


if __name__ == "__main__":
    unittest.main()
