"""
Tests for the per-book CLOSING odds corpus.

These run against the REAL Football-Data.co.uk CSVs rather than fixtures, because
the whole point of the loader is which columns it reads, and a fixture would be
written from the same misunderstanding as the code. The properties that matter
are properties of the actual prices:

* every book's margin lands inside ``devig``'s plausible SINGLE-BOOK band, and
  Pinnacle's is the tighter of the two. That is the falsifiable signature of a
  single book's closing view. A cross-book average (``AvgH``) or a best-price
  vector would not have it, so this test is what stops the ``*C*`` columns being
  swapped back for the ``Avg*`` ones that ``extract_odds_benchmark`` reads;
* ``closing_market``'s output is accepted by ``invert_fixture`` as-is. The two
  modules have no shared type, so nothing but a test holds the shapes together —
  and ``invert_fixture`` deliberately raises on a flat ``{outcome: price}``
  mapping, which is the mistake a hand-written reshaper makes;
* the median inverted total goals matches the realised scoring rate over the same
  matches. The one end-to-end check that the corpus is on the right SCALE, which
  a per-row assertion cannot see.

Skipped, loudly, when the corpus cannot be fetched — an offline run must not
silently report these as passing.
"""
import math
import unittest
from typing import Optional

import numpy as np
import pandas as pd

from pipeline.data.football_data import (
    CLOSING_BOOKS,
    CLOSING_META_COLS,
    closing_market,
    closing_price_columns,
    load_closing_odds,
    parse_match_dates,
    shape_closing_odds,
)
from pipeline.data.team_mapping import TEAM_ALIASES
from pipeline.models.devig import (
    MAX_PLAUSIBLE_MARGIN,
    MIN_PLAUSIBLE_MARGIN,
    book_margin,
)
from pipeline.models.market_rates import STATUS_CONVERGED, invert_fixture

# The three completed seasons the column audit was done against.
CORPUS_SEASONS = ["2324", "2425", "2526"]
MATCHES_PER_SEASON = 380

# Dixon-Coles low-score correlation. Any plausible value inverts; 0.05 is what
# test_market_rates uses, so a failure here is not a rho disagreement.
RHO = 0.05

# Columns that must never enter this corpus.
#
# Avg*/Max* are computed ACROSS bookmakers, so they carry no single margin to
# remove and de-vigging them is meaningless. PSH/PSD/PSA and B365H/B365D/B365A
# ARE single books, but they are PRE-match: mixing them in would put two
# different timestamps in one corpus, and the "closing prices are an upper bound
# on how much to trust our pre-deadline line" argument depends entirely on
# knowing which timestamp each row is.
NON_CLOSING_COLS = {
    "AvgH", "AvgD", "AvgA", "Avg>2.5", "Avg<2.5",
    "MaxH", "MaxD", "MaxA", "Max>2.5", "Max<2.5",
    "PSH", "PSD", "PSA",
    "B365H", "B365D", "B365A", "B365>2.5", "B365<2.5",
}

_CORPUS: Optional[pd.DataFrame] = None
_CORPUS_ERROR = ""


def _corpus() -> Optional[pd.DataFrame]:
    """The real corpus, fetched at most once per run (and cached on disk)."""
    global _CORPUS, _CORPUS_ERROR
    if _CORPUS is None and not _CORPUS_ERROR:
        try:
            _CORPUS = load_closing_odds(CORPUS_SEASONS)
        except Exception as exc:  # noqa: BLE001 - offline is a skip, not a failure
            _CORPUS_ERROR = f"{type(exc).__name__}: {exc}"
    return _CORPUS


def _raw_row(
    date: str = "15/08/2025",
    home: str = "Man United",
    away: str = "Wolves",
    home_goals=2,
    away_goals=1,
    **overrides,
):
    """One raw CSV row, two books quoting, with any price overridable."""
    row = {
        "Date": date,
        "HomeTeam": home,
        "AwayTeam": away,
        "FTHG": home_goals,
        "FTAG": away_goals,
        "PSCH": 1.90, "PSCD": 3.60, "PSCA": 4.20,
        "PC>2.5": 1.95, "PC<2.5": 1.95,
        "AHCh": -0.5, "PCAHH": 1.93, "PCAHA": 1.97,
        "B365CH": 1.85, "B365CD": 3.50, "B365CA": 4.00,
        "B365C>2.5": 1.90, "B365C<2.5": 1.90,
    }
    row.update(overrides)
    return row


def _raw_frame(*rows) -> pd.DataFrame:
    return pd.DataFrame(list(rows) or [_raw_row()])


def _shaped(*rows, season="2526") -> pd.DataFrame:
    return shape_closing_odds(_raw_frame(*rows), season)


class RealCorpusTestCase(unittest.TestCase):
    """Base for the tests that need the actual CSVs."""

    @classmethod
    def setUpClass(cls):
        if _corpus() is None:
            raise unittest.SkipTest(
                f"Football-Data.co.uk corpus unavailable ({_CORPUS_ERROR}). "
                "These assertions are about real closing prices and there is no "
                "honest way to fake them."
            )
        cls.corpus = _corpus()
        # Reshaped once. ``iterrows`` and not ``itertuples``: the latter renames
        # 'PC>2.5' to a positional '_7' and every book then reads as unquoted.
        cls.markets = [
            (row["season"], row["match_id"]) + closing_market(row)
            for _, row in cls.corpus.iterrows()
        ]


class MarginBandTests(RealCorpusTestCase):
    def test_every_books_every_market_is_a_plausible_single_book(self):
        """
        The load-bearing assertion of the whole module.

        Measured across 1140 matches: Pinnacle 1X2 margins run 0.63%-4.23% and
        Bet365 1X2 3.13%-12.07%, both wholly inside devig's [0.5%, 15%] band —
        so ``strict=True`` de-vigging never has to be relaxed for this corpus. A
        single out-of-band row means a non-closing or cross-book column crept in.
        """
        out_of_band = []
        for _, match_id, h2h, totals in self.markets:
            markets = [(book, "h2h", prices) for book, prices in h2h.items()]
            markets += [
                (book, f"over_{line}", sides)
                for book, lines in totals.items()
                for line, sides in lines.items()
            ]
            for book, market, prices in markets:
                margin = book_margin(prices)
                if not MIN_PLAUSIBLE_MARGIN <= margin <= MAX_PLAUSIBLE_MARGIN:
                    out_of_band.append((match_id, book, market, margin))

        self.assertEqual(out_of_band[:5], [], f"{len(out_of_band)} out-of-band books")

    def test_pinnacle_is_the_sharper_book_in_every_season(self):
        """
        Pinnacle's median 1X2 margin measures 2.87-2.94% per season against
        Bet365's 5.49-5.57% — Pinnacle is the low-margin book, by roughly 2x.

        Asserted per season rather than pooled because the ordering is the
        signature that the two column families are the books they are labelled
        as. Swap ``PSCH`` for ``AvgH`` and the gap collapses; swap the two books'
        columns and the ordering inverts. Either mistake is invisible to a
        band check that only asks "is it between 0.5% and 15%".
        """
        for season in CORPUS_SEASONS:
            medians = {}
            for book in CLOSING_BOOKS:
                margins = [
                    book_margin(h2h[book])
                    for row_season, _, h2h, _ in self.markets
                    if row_season == season and book in h2h
                ]
                self.assertGreater(len(margins), 100, f"{season} {book} coverage")
                medians[book] = float(np.median(margins))
            self.assertLess(
                medians["pinnacle"], medians["bet365"],
                f"{season}: {medians}",
            )
            self.assertTrue(
                0.020 <= medians["pinnacle"] <= 0.040, f"{season}: {medians}"
            )
            self.assertTrue(
                0.045 <= medians["bet365"] <= 0.070, f"{season}: {medians}"
            )


class CorpusShapeTests(RealCorpusTestCase):
    def test_every_season_carries_its_full_380_match_programme(self):
        """
        A short season means rows were dropped, and a corpus that quietly loses
        the fixtures one book failed to price would bias the fitted weight toward
        exactly the matches that book finds easy.
        """
        counts = self.corpus["season"].value_counts().to_dict()
        self.assertEqual(
            counts, {season: MATCHES_PER_SEASON for season in CORPUS_SEASONS}
        )

    def test_no_non_closing_or_cross_book_column_is_ever_read(self):
        """Pins the docstring's claim in code rather than in prose."""
        self.assertEqual(NON_CLOSING_COLS & set(closing_price_columns()), set())
        self.assertEqual(NON_CLOSING_COLS & set(self.corpus.columns), set())

    def test_team_names_are_canonical_on_both_sides(self):
        """
        Football-Data spells clubs "Man United"/"Wolves"; joining on those raw
        strings against any other provider drops the rows that disagree, silently.
        """
        canonical = set(TEAM_ALIASES)
        for column in ("home_team", "away_team"):
            names = set(self.corpus[column])
            self.assertEqual(names - canonical, set(), f"{column} not canonical")
        # 20 clubs a season, 38 matches each, home and away.
        for season, frame in self.corpus.groupby("season"):
            self.assertEqual(len(set(frame["home_team"])), 20, season)

    def test_every_match_yields_at_least_one_book_and_most_yield_two(self):
        """
        Measured: 970 of 1140 matches carry a two-book h2h, and 960 carry two
        books on BOTH h2h and over/under 2.5. The 170 single-book matches are all
        2526, where Pinnacle's closing prices are published for 210 of 380 rows.

        Asserted as a floor rather than an equality because Football-Data
        backfills; a floor still fails if a column rename silently halves the
        coverage, which is the failure worth catching.
        """
        two_book_h2h = 0
        no_book = []
        for _, match_id, h2h, totals in self.markets:
            if not h2h or not totals:
                no_book.append(match_id)
            if len(h2h) == 2:
                two_book_h2h += 1

        self.assertEqual(no_book[:5], [])
        self.assertGreaterEqual(two_book_h2h, 900)


class InversionTests(RealCorpusTestCase):
    def test_the_whole_corpus_inverts_to_converged_market_rates(self):
        """
        ``closing_market`` output goes into ``invert_fixture`` untouched. It has
        to, or the corpus is unusable for the thing it exists for — and
        ``invert_fixture`` raises ``DevigError`` on the flat ``{outcome: price}``
        shape a hand-written reshaper produces, so this also pins the nesting.

        All 1140 matches converge, with an unweighted logit RMS residual whose
        median is 0.053 against the module's 0.35 rejection threshold. Nothing is
        allowed to fail here: a Dixon-Coles grid that cannot fit a two-book
        closing market would mean the forward model, not the prices, is wrong.
        """
        statuses, residuals, totals_implied, supremacies = [], [], [], []
        for _, _, h2h, totals in self.markets:
            rates = invert_fixture(h2h, totals, rho=RHO)
            statuses.append(rates.status)
            if rates.usable:
                residuals.append(rates.residual)
                totals_implied.append(rates.total_goals)
                supremacies.append(rates.supremacy)

        self.assertEqual(set(statuses), {STATUS_CONVERGED})
        self.assertEqual(len(residuals), len(self.corpus))
        self.assertLess(max(residuals), 0.35)
        self.assertLess(float(np.median(residuals)), 0.10)
        self.assertGreater(float(np.median(totals_implied)), 2.0)

        # HOME ADVANTAGE MUST SURVIVE THE INVERSION WITH THE RIGHT SIGN.
        #
        # This assertion used to be on `totals_implied`, which is INVARIANT under
        # a home/away swap — the comment claimed a sign property the assertion
        # could not see. Measured: inverting the h2h column order flipped median
        # supremacy from +0.27 to −0.27 across all 1140 matches and the entire
        # 25-test module still passed. That would have fitted market.blend_weight
        # against a mirrored market and inverted every clean-sheet projection
        # derived from it.
        median_supremacy = float(np.median(supremacies))
        self.assertGreater(
            median_supremacy, 0.10,
            f"median market supremacy is {median_supremacy:+.4f}; home advantage "
            f"has been lost or inverted",
        )
        # And it agrees in sign with what actually happened, so the check is
        # anchored on the outcomes rather than on a threshold I chose.
        realised = float(
            (self.corpus["home_goals"] - self.corpus["away_goals"]).mean()
        )
        self.assertGreater(realised, 0.0, "the corpus itself must show home advantage")
        self.assertGreater(
            median_supremacy * realised, 0.0,
            f"market supremacy {median_supremacy:+.4f} disagrees in SIGN with the "
            f"realised goal difference {realised:+.4f}",
        )

    def test_the_inverted_total_matches_the_realised_scoring_rate(self):
        """
        The end-to-end scale check, and the only one that touches the scorelines.

        Median inverted total goals measures 2.965 against a realised mean of
        2.988 over the same 1140 matches — a market that closed 0.02 goals below
        what happened, which is the order of sampling noise on 1140 matches. Any
        systematic error in the de-vig direction, the over/under leg orientation
        or the goal grid would show up here as a gap of several tenths, and
        nowhere else: per-row assertions cannot see a uniform bias.

        Median against mean is deliberate. The inverted totals are the market's
        conditional means, so their MEAN is the comparable statistic in principle
        — but one stale line drags a mean and cannot drag a median, and the two
        agree to 0.01 goals here anyway.
        """
        implied = []
        for _, _, h2h, totals in self.markets:
            rates = invert_fixture(h2h, totals, rho=RHO)
            if rates.usable:
                implied.append(rates.total_goals)

        realised = float(
            (self.corpus["home_goals"] + self.corpus["away_goals"]).mean()
        )
        self.assertAlmostEqual(float(np.median(implied)), realised, delta=0.25)
        self.assertAlmostEqual(float(np.mean(implied)), realised, delta=0.25)

    def test_a_single_book_fixture_still_inverts_but_earns_less_weight(self):
        """
        The 170 Pinnacle-less 2526 rows must not be discarded — one real closing
        book is information — and must not be trusted like two. ``aggregate_books``
        marks a sub-``min_books`` consensus thin at n/(n+2), so one book on each
        market gives 1/3 x 1/3 = 0.111 against two books' 0.5 x 0.5 = 0.25.
        """
        both = _shaped(_raw_row()).iloc[0]
        one = _shaped(
            _raw_row(PSCH=None, PSCD=None, PSCA=None, **{"PC>2.5": None, "PC<2.5": None})
        ).iloc[0]

        two_book = invert_fixture(*closing_market(both), rho=RHO)
        one_book = invert_fixture(*closing_market(one), rho=RHO)

        self.assertEqual(two_book.status, STATUS_CONVERGED)
        self.assertEqual(one_book.status, STATUS_CONVERGED)
        self.assertAlmostEqual(two_book.weight, 0.25, places=3)
        self.assertAlmostEqual(one_book.weight, 1.0 / 9.0, places=3)


class NullPriceTests(unittest.TestCase):
    def test_a_book_with_null_prices_is_omitted_not_emitted_as_nan(self):
        """
        NaN must never leave ``closing_market``. ``devig._check`` does reject a
        NaN price, so an emitted NaN would be swallowed as a DROPPED book inside
        ``aggregate_books`` — the consensus would come back one book thinner with
        the reason buried in a diagnostics map, and the fitted weight would move
        for a reason no caller could see. Pinnacle is absent on 170 of 380 2526
        rows, so this is the ordinary path.
        """
        row = _shaped(
            _raw_row(PSCH=None, PSCD=None, PSCA=None, **{"PC>2.5": None, "PC<2.5": None})
        ).iloc[0]
        h2h, totals = closing_market(row)

        self.assertEqual(set(h2h), {"bet365"})
        self.assertEqual(set(totals), {"bet365"})
        emitted = [
            price
            for prices in h2h.values() for price in prices.values()
        ] + [
            price
            for lines in totals.values() for sides in lines.values()
            for price in sides.values()
        ]
        self.assertTrue(emitted)
        self.assertTrue(all(math.isfinite(price) for price in emitted))

    def test_one_missing_leg_drops_only_that_books_market(self):
        """
        Markets are independent. A book with a null draw price still has a usable
        over/under, and dropping its totals as well would throw away a real price.
        """
        row = _shaped(_raw_row(PSCD=None)).iloc[0]
        h2h, totals = closing_market(row)

        self.assertEqual(set(h2h), {"bet365"})
        self.assertEqual(set(totals), {"pinnacle", "bet365"})

    def test_a_price_at_or_below_evens_is_treated_as_missing(self):
        """
        A decimal price of 1.0 pays nothing and 0.0 is a placeholder, not a quote.
        ``devig._check`` raises on both, so they are nulled at load rather than
        left to surface as a dropped book later.
        """
        row = _shaped(_raw_row(PSCH=1.0, B365CH=0.0)).iloc[0]
        self.assertTrue(pd.isna(row["PSCH"]))
        self.assertTrue(pd.isna(row["B365CH"]))
        self.assertEqual(closing_market(row)[0], {})

    def test_a_season_missing_a_books_columns_entirely_still_shapes(self):
        """
        The pre-2019 CSVs have no ``PC>2.5`` at all. A missing COLUMN must behave
        exactly like a missing price, or the seasons cannot be concatenated.
        """
        raw = _raw_frame(_raw_row()).drop(columns=["PC>2.5", "PC<2.5"])
        shaped = shape_closing_odds(raw, "1718")

        self.assertEqual(
            list(shaped.columns), CLOSING_META_COLS + closing_price_columns()
        )
        self.assertTrue(pd.isna(shaped.iloc[0]["PC>2.5"]))
        self.assertEqual(set(closing_market(shaped.iloc[0])[1]), {"bet365"})


class MangledRowTests(unittest.TestCase):
    def test_a_mangled_row_raises_instead_of_reading_as_unquoted(self):
        """
        The failure this guard exists for was real, and silent: iterating the
        corpus with ``DataFrame.itertuples`` renames 'PC>2.5' and 'B365C>2.5' to
        positional '_7'-style names because they are not valid Python identifiers,
        while leaving 'PSCH' alone. Every totals market was then skipped,
        ``invert_fixture`` returned ``absent`` for all 1140 matches, and the corpus
        read as "the market never quoted" rather than as a caller bug.

        Note what a "none of the columns are present" guard would have missed: the
        mangling is PARTIAL, so half the columns still resolve.
        """
        frame = _shaped(_raw_row())
        mangled = next(iter(frame.itertuples(index=False)))._asdict()
        self.assertIn("PSCH", mangled)  # the half that survives

        with self.assertRaises(KeyError) as caught:
            closing_market(mangled)
        self.assertIn("iterrows", str(caught.exception))

    def test_a_row_with_the_columns_but_no_prices_is_data_not_an_error(self):
        """The guard must fire on a mangled row and never on an unquoted one."""
        row = _shaped(
            _raw_row(
                PSCH=None, PSCD=None, PSCA=None, PCAHH=None, PCAHA=None,
                B365CH=None, B365CD=None, B365CA=None,
                **{
                    "PC>2.5": None, "PC<2.5": None,
                    "B365C>2.5": None, "B365C<2.5": None,
                },
            )
        ).iloc[0]
        self.assertEqual(closing_market(row), ({}, {}))


class DateParsingTests(unittest.TestCase):
    def test_two_and_four_digit_years_parse_to_the_same_day(self):
        """Football-Data switched from dd/mm/yy to dd/mm/yyyy mid-corpus."""
        parsed = parse_match_dates(pd.Series(["15/08/2025", "15/08/25"]))
        self.assertEqual(parsed.iloc[0], parsed.iloc[1])
        self.assertEqual(parsed.iloc[0], pd.Timestamp("2025-08-15"))

    def test_an_ambiguous_date_is_read_day_first_in_both_formats(self):
        """
        05/08 is 5 August in this corpus, not 8 May. The failure mode is silent —
        a month-first read produces a valid date on the wrong day, which reorders
        the season and would leak later matches into an earlier fit.
        """
        parsed = parse_match_dates(pd.Series(["05/08/2025", "05/08/25"]))
        for value in parsed:
            self.assertEqual(value.month, 8)
            self.assertEqual(value.day, 5)

    def test_a_mixed_column_parses_every_row(self):
        """Both formats in one column, which is what a concatenated corpus is."""
        raw = pd.Series(["11/08/2023", "13/05/24", "24/05/2026", "01/01/99"])
        parsed = parse_match_dates(raw)
        self.assertEqual(parsed.isna().sum(), 0)
        self.assertEqual(list(parsed.dt.year), [2023, 2024, 2026, 1999])

    def test_an_unparseable_date_becomes_nat_and_the_row_is_dropped(self):
        """
        A row whose date cannot be read cannot be ordered against the others, and
        an out-of-order row in a corpus fitted chronologically is a leak.
        """
        self.assertTrue(pd.isna(parse_match_dates(pd.Series(["not a date"])).iloc[0]))
        self.assertEqual(len(_shaped(_raw_row(date="not a date"))), 0)


class ShapingTests(unittest.TestCase):
    def test_an_unplayed_match_is_dropped(self):
        """
        No scoreline, nothing to fit a trust weight against. Keeping the row would
        put NaN goals into the realised side of the comparison.
        """
        self.assertEqual(len(_shaped(_raw_row(home_goals=None, away_goals=None))), 0)
        self.assertEqual(len(_shaped(_raw_row(away_goals=None))), 0)

    def test_provider_spellings_are_canonicalised(self):
        row = _shaped(
            _raw_row(home="Manchester United", away="Wolverhampton Wanderers")
        ).iloc[0]
        self.assertEqual(row["home_team"], "Man United")
        self.assertEqual(row["away_team"], "Wolves")

    def test_match_id_uses_the_canonical_names_and_the_parsed_date(self):
        """
        Same convention as ``clean_football_data``, so the closing corpus can be
        joined to the feature frame on ``match_id`` without a second mapping.
        """
        row = _shaped(_raw_row(date="15/08/25", home="Man Utd")).iloc[0]
        self.assertEqual(row["match_id"], "20250815_Man United_Wolves")

    def test_goals_are_integers_and_rows_are_date_ordered(self):
        frame = _shaped(
            _raw_row(date="20/08/2025", home_goals=1, away_goals=0),
            _raw_row(date="15/08/2025", home_goals=3, away_goals=2),
        )
        self.assertEqual(list(frame["date"].dt.day), [15, 20])
        self.assertEqual(list(frame["home_goals"]), [3, 1])
        self.assertEqual(frame["home_goals"].dtype.kind, "i")

    def test_the_handicap_line_is_carried_but_never_priced_as_a_total(self):
        """
        ``AHCh`` is a goal line, not a price, so it is exempt from the ">1.0 or
        null" rule — a -0.5 handicap is ordinary. It is deliberately absent from
        ``closing_market`` because ``invert_fixture`` has no handicap constraint,
        and folding a handicap price into a totals line would fabricate a market
        that was never posted.
        """
        row = _shaped(_raw_row(AHCh=-0.5)).iloc[0]
        self.assertEqual(row["AHCh"], -0.5)

        _, totals = closing_market(row)
        self.assertEqual(set(totals["pinnacle"]), {"2.5"})
        self.assertNotIn("PCAHH", str(totals))

    def test_totals_lines_are_keyed_by_the_string_of_the_line(self):
        """
        ``invert_fixture`` regroups on this key and calls ``float`` on it. A float
        key survives that but not a JSON round trip, so the string form is what
        keeps the in-memory and serialised shapes interchangeable.
        """
        _, totals = closing_market(_shaped(_raw_row()).iloc[0])
        for lines in totals.values():
            for key in lines:
                self.assertIsInstance(key, str)
                self.assertEqual(float(key), 2.5)


if __name__ == "__main__":
    unittest.main()
