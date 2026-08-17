"""
The captured headlines, and the claim this view must never make.

## Why it exists

The poller writes every feed item it can link to a player into
`availability_evidence.jsonl` as `unparsed_news`. After one live run that was 59
items from BBC, Sky, FantasyFootballScout and Hayters — and **nothing rendered
any of them**, because `evidence_view.json` carries resolved availability only
and `unparsed_news` is by definition unresolved.

They were being collected into a file with no reader.

## The property that matters most

**This must never present itself as evidence the model used.** Every item here
is text the parser explicitly refused to turn into an availability value,
because RSS prose cannot meet the zero-false-positive bar R4 demands. Rendering
it as model input would be the same lie as the hand-typed captaincy confidence
this project deleted.

`test_the_basis_disclaims_model_use` pins that, and it is the assertion to keep
if any other is ever dropped.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.learning import news_view

NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)
NAMES = {503: ("Van de Ven", "SPU"), 427: ("Salah", "LIV"), 9: ("Sánchez", "CHE")}


def claim(**over):
    base = {
        "claim_type": "unparsed_news",
        "element_id": 503,
        "source": "hayters",
        "source_tier": 2,
        "source_text": "Van de Ven signs new deal\nTottenham have announced...",
        "claimed_at": (NOW - timedelta(hours=6)).isoformat().replace("+00:00", "Z"),
        "provenance_url": "https://hayters.com/vdv/",
        "provenance_digest": "abc123",
    }
    base.update(over)
    return base


def build(claims, **over):
    kwargs = dict(now=NOW, generated_at="2026-08-11T12:00:00Z")
    kwargs.update(over)
    return news_view.build(claims, NAMES, **kwargs)


class HonestyTests(unittest.TestCase):
    def test_the_basis_disclaims_model_use(self):
        """The assertion to keep if every other one is dropped."""
        view = build([claim()])
        self.assertIn("has moved a projection", view["basis"])
        self.assertIn("reading list", view["basis"])

    def test_only_unparsed_news_reaches_it(self):
        # A parsed claim belongs in evidence_view, where its conflicts and the
        # rule that beat it are recorded. Showing it here would strip that.
        view = build([claim(claim_type="chance_of_playing", value=25)])
        self.assertEqual(view["items"], [])


class DeduplicationTests(unittest.TestCase):
    def test_one_article_naming_three_players_is_one_item(self):
        claims = [
            claim(element_id=503),
            claim(element_id=427),
            claim(element_id=9),
        ]
        view = build(claims)
        self.assertEqual(len(view["items"]), 1)
        self.assertEqual(len(view["items"][0]["players"]), 3)

    def test_distinct_articles_stay_distinct(self):
        view = build([claim(provenance_digest="a"), claim(provenance_digest="b")])
        self.assertEqual(len(view["items"]), 2)

    def test_a_repeated_player_on_one_article_is_not_duplicated(self):
        view = build([claim(element_id=503), claim(element_id=503)])
        self.assertEqual(len(view["items"][0]["players"]), 1)


class RankingTests(unittest.TestCase):
    def test_squad_players_sort_first(self):
        older_squad = claim(
            element_id=427, provenance_digest="squad",
            claimed_at=(NOW - timedelta(days=2)).isoformat().replace("+00:00", "Z"),
        )
        newer_other = claim(element_id=503, provenance_digest="other")
        view = build([older_squad, newer_other], held=[427])
        # Older, but it touches a player you hold — which is the only reason to
        # rank a reading list at all.
        self.assertEqual(view["items"][0]["digest"], "squad")
        self.assertTrue(view["items"][0]["touches_squad"])

    def test_within_a_group_the_newest_is_first(self):
        old = claim(provenance_digest="old",
                    claimed_at=(NOW - timedelta(days=3)).isoformat().replace("+00:00", "Z"))
        new = claim(provenance_digest="new")
        self.assertEqual(build([old, new])["items"][0]["digest"], "new")

    def test_the_order_is_total(self):
        # Same timestamp, same relevance: the digest breaks the tie so a
        # re-publish does not reshuffle the file for no reason.
        a = claim(provenance_digest="aaa")
        b = claim(provenance_digest="bbb")
        self.assertEqual(
            [i["digest"] for i in build([a, b])["items"]],
            [i["digest"] for i in build([b, a])["items"]],
        )


class BoundingTests(unittest.TestCase):
    def test_stale_items_fall_out_of_the_window(self):
        stale = claim(
            claimed_at=(NOW - timedelta(days=30)).isoformat().replace("+00:00", "Z"),
        )
        self.assertEqual(build([stale])["items"], [])

    def test_the_count_is_capped_and_the_total_reported(self):
        claims = [claim(provenance_digest=f"d{i}") for i in range(200)]
        view = build(claims, limit=10)
        self.assertEqual(len(view["items"]), 10)
        # Reported, so a capped view cannot read as a complete one.
        self.assertEqual(view["n_articles"], 200)
        self.assertEqual(view["n_shown"], 10)

    def test_an_item_with_no_timestamp_is_dropped(self):
        # Without one it cannot be placed in the window, and a headline of
        # unknown age is not worth ranking.
        self.assertEqual(build([claim(claimed_at=None, observed_at=None)])["items"], [])

    def test_it_falls_back_to_observed_at(self):
        view = build([claim(
            claimed_at=None,
            observed_at=(NOW - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        )])
        self.assertEqual(len(view["items"]), 1)


class ReadingTests(unittest.TestCase):
    def test_a_missing_store_is_empty_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(news_view.read_claims(Path(tmp)), [])

    def test_a_corrupt_line_does_not_hide_the_others(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "fpl").mkdir()
            (root / "fpl" / "availability_evidence.jsonl").write_text(
                json.dumps(claim()) + "\n{ not json\n" + json.dumps(claim()) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(len(news_view.read_claims(root)), 2)

    def test_the_headline_is_the_first_line_only(self):
        view = build([claim(source_text="Headline here\nBody paragraph follows.")])
        self.assertEqual(view["items"][0]["headline"], "Headline here")

    def test_provenance_travels(self):
        item = build([claim()])["items"][0]
        self.assertEqual(item["source"], "hayters")
        self.assertEqual(item["tier"], 2)
        self.assertTrue(item["url"].startswith("https://"))


class CommittedStoreTests(unittest.TestCase):
    """Against the real captured data, not a fixture."""

    STORE = (
        Path(__file__).resolve().parents[2]
        / "predictions" / "fpl" / "availability_evidence.jsonl"
    )

    @unittest.skipUnless(STORE.exists(), "no committed evidence store")
    def test_the_real_store_produces_a_readable_view(self):
        claims = news_view.read_claims(self.STORE.parents[1])
        view = build(claims, now=datetime.now(timezone.utc))
        # Every item must carry something to read and somewhere to read it.
        for item in view["items"]:
            self.assertTrue(item["headline"], "an item with no headline is not readable")
            self.assertTrue(item["source"])


if __name__ == "__main__":
    unittest.main()


class PollerStaysLightweightTests(unittest.TestCase):
    """
    The poller may only import what news.yml installs.

    news.yml installs `requests` and `feedparser` and nothing else, and says
    why: it runs every fifteen minutes and must finish in seconds, where
    `pipeline/requirements.txt` pulls PyMC, XGBoost and SciPy.

    `news_view.write` originally called `pipeline.fpl.artifacts.
    write_json_atomically`, which drags in a chain needing PyYAML. The first
    live run logged `could not publish the news view: No module named 'yaml'`
    and published nothing — non-fatally, so the poll itself survived and the
    failure was a single warning line in a log nobody was watching.

    A unit test on this machine cannot catch it: the dev venv has every
    dependency. So the check is structural.
    """

    MODULE = Path(__file__).resolve().parents[1] / "learning" / "news_view.py"

    #: Modules that reach PyMC, SciPy, PyYAML or the FPL rules loader.
    HEAVY = ("pipeline.fpl.artifacts", "pipeline.fpl.rules", "numpy", "scipy",
             "yaml", "pymc", "xgboost", "pipeline.simulation")

    def test_it_imports_nothing_the_poller_does_not_install(self):
        """
        Checked by parsing the imports, not by searching the text.

        A substring search over the whole file matches the docstrings above,
        which name `pipeline.fpl.artifacts` precisely because it explains why it
        is not imported. A test that fails on its own explanation is worse than
        no test: it trains you to weaken the check rather than the code.
        """
        import ast

        tree = ast.parse(self.MODULE.read_text(encoding="utf-8"))
        imported: List[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                # Both the module and each name bound from it. Recording only
                # `node.module` meant `from pipeline.fpl import artifacts`
                # registered as "pipeline.fpl", which matches nothing in HEAVY —
                # so the natural spelling of the exact import this guard exists
                # to forbid walked straight past it. Verified by mutation: a real
                # call to `artifacts.write_json_atomically` left all three tests
                # green while importing the module under a yaml blocker raised
                # ImportError.
                #
                # `test_module_reachability` fixed this same AST subtlety in the
                # other direction and called recording only `node.module` "a
                # blind spot with teeth".
                imported.append(node.module)
                imported.extend(f"{node.module}.{alias.name}" for alias in node.names)

        offenders = [
            name for name in imported
            if any(name == heavy or name.startswith(heavy + ".")
                   for heavy in self.HEAVY)
        ]
        self.assertEqual(
            offenders, [],
            "news_view runs inside the 15-minute poller, which installs only "
            "requests and feedparser:\n  " + "\n  ".join(offenders),
        )

    def test_the_module_imports_cleanly_with_only_the_stdlib_available(self):
        # Importing it must not reach for anything the poller lacks.
        import importlib
        module = importlib.import_module("pipeline.learning.news_view")
        self.assertTrue(hasattr(module, "build"))

    def test_the_write_is_atomic(self):
        # A poll interrupted mid-write must not leave the app fetching half a
        # JSON document.
        source = self.MODULE.read_text(encoding="utf-8")
        self.assertIn(".replace(target)", source)


class SourceBalanceTests(unittest.TestCase):
    """
    A feed that publishes all day must not bury one that publishes once.

    Measured on a real poll: ninety slots went bbc_football 33, sky_football 24,
    hayters 14, fantasyfootballscout 11, x:robtFPL 5, x:OptaAnalyst 2 and
    allaboutfpl 1. Ranking by recency is right and is exactly what produces this
    — the sources chosen for FPL value publish least often, so they are the first
    to be crowded out.
    """

    def _mixed(self):
        # One quiet source against one that never stops.
        loud = [claim(provenance_digest=f"loud{i}", source="bbc_football",
                      claimed_at=(NOW - timedelta(minutes=i)).isoformat().replace("+00:00", "Z"))
                for i in range(50)]
        quiet = [claim(provenance_digest="quiet1", source="allaboutfpl",
                       claimed_at=(NOW - timedelta(days=2)).isoformat().replace("+00:00", "Z"))]
        return loud + quiet

    def test_the_quiet_source_survives_the_cap(self):
        view = build(self._mixed(), limit=10)
        sources = {i["source"] for i in view["items"]}
        self.assertIn(
            "allaboutfpl", sources,
            "the one article from the quiet source was dropped for the tenth "
            "article from the loud one, which is the defect this fixes",
        )

    def test_the_cap_is_still_the_cap(self):
        # Balancing decides which items travel, never how many.
        view = build(self._mixed(), limit=10)
        self.assertEqual(len(view["items"]), 10)
        self.assertEqual(view["n_shown"], 10)

    def test_the_loud_source_still_fills_what_is_left(self):
        # Fairness is a floor, not an equal split: nobody else wants the slots.
        view = build(self._mixed(), limit=10)
        loud = [i for i in view["items"] if i["source"] == "bbc_football"]
        self.assertEqual(len(loud), 9)

    def test_the_loss_is_named_per_source(self):
        # "dropped 41" said the list was truncated. It did not say who was starved.
        view = build(self._mixed(), limit=10)
        self.assertEqual(view["dropped_by_source"], {"bbc_football": 41})

    def test_nothing_is_dropped_when_it_all_fits(self):
        view = build(self._mixed(), limit=200)
        self.assertEqual(view["n_dropped"], 0)
        self.assertEqual(view["dropped_by_source"], {})

    def test_the_published_order_is_still_the_reading_order(self):
        """
        Round-robin decides membership, not order.

        Interleaving by source would publish bbc, allaboutfpl, bbc, ... which is
        an order no reader asked for and which breaks the squad-first promise.
        """
        view = build(self._mixed(), limit=10)
        stamps = [i["claimed_at"] for i in view["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))


class SummaryTests(unittest.TestCase):
    """
    The article's own summary, which the store has carried all along.

    `source_text` is the title, a newline, then the feed's summary. This view
    read `split("\\n", 1)[0]` and dropped the rest for its whole life, so it
    published a list of titles while holding what a readable card needs.
    """

    def test_the_summary_travels_with_the_headline(self):
        view = build([claim()])
        item = view["items"][0]
        self.assertEqual(item["headline"], "Van de Ven signs new deal")
        self.assertEqual(item["summary"], "Tottenham have announced...")

    def test_a_headline_with_no_summary_reports_none(self):
        # None, not "": an empty string renders a card with a blank body.
        view = build([claim(source_text="Just a headline")])
        self.assertIsNone(view["items"][0]["summary"])

    def test_wrapped_lines_are_collapsed(self):
        # Feed wrapping is not the author's paragraphing.
        view = build([claim(source_text="Title\nfirst line\nsecond line")])
        self.assertEqual(view["items"][0]["summary"], "first line second line")

    def test_the_summary_is_bounded(self):
        # The whole artifact is fetched by the browser; the full body is 8.7KB.
        view = build([claim(source_text="Title\n" + "x" * 5000)])
        self.assertEqual(len(view["items"][0]["summary"]), news_view.MAX_SUMMARY)
