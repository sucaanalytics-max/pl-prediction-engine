"""
Tests for bookmaker odds parsing.

This module had no tests at all, and it contained a silent side-resolution bug
for as long as it has existed: the home side was guessed from ``outcomes[0]``, so
any bookmaker listing the away team first returned a book with **no away leg**.
Downstream that is indistinguishable from "this book did not quote the away
side", so the book was quietly dropped from every away-side comparison and
nothing anywhere reported it.

The other property asserted here is the one the market-implied goal rate depends
on: the best-price-across-bookmakers view is a *max over books*, not any single
book's coherent view, so it is not a legitimate probability source. Per-bookmaker
prices must be available separately, and the two-sided totals leg must be paired
within one book.
"""
import unittest

from pipeline.data.odds_api import _parse_h2h, parse_match_odds
from pipeline.data.team_mapping import normalize_team_name

HOME_RAW = "Arsenal"
AWAY_RAW = "Chelsea"
HOME = normalize_team_name(HOME_RAW)
AWAY = normalize_team_name(AWAY_RAW)

HOME_PRICE = 1.80
DRAW_PRICE = 3.50
AWAY_PRICE = 4.20


def _outcome(name, price, point=None):
    outcome = {"name": name, "price": price}
    if point is not None:
        outcome["point"] = point
    return outcome


def _h2h_market(order):
    """A bookmaker h2h market whose outcomes are listed in the given order."""
    prices = {
        "home": _outcome(HOME_RAW, HOME_PRICE),
        "draw": _outcome("Draw", DRAW_PRICE),
        "away": _outcome(AWAY_RAW, AWAY_PRICE),
    }
    return {"key": "h2h", "outcomes": [prices[side] for side in order]}


def _totals_market(line, over, under):
    return {
        "key": "totals",
        "outcomes": [
            _outcome("Over", over, point=line),
            _outcome("Under", under, point=line),
        ],
    }


def _event(bookmakers):
    return {
        "home_team": HOME_RAW,
        "away_team": AWAY_RAW,
        "commence_time": "2026-08-21T19:00:00Z",
        "bookmakers": bookmakers,
    }


class SideResolutionTests(unittest.TestCase):
    """Which price belongs to which team, resolved by name and never by order."""

    def _parse(self, outcomes):
        return _parse_h2h(outcomes, HOME, AWAY, HOME_RAW, AWAY_RAW)

    def test_home_listed_first_resolves(self):
        parsed = self._parse(_h2h_market(["home", "draw", "away"])["outcomes"])
        self.assertEqual(
            parsed, {"home": HOME_PRICE, "draw": DRAW_PRICE, "away": AWAY_PRICE}
        )

    def test_away_listed_first_still_resolves_both_sides(self):
        """
        The regression. Previously this returned ``{"home": 1.80, "draw": 3.50}``
        — correct home price, away leg missing entirely — because the first
        outcome matched a positional guess at the home side and the real home
        outcome then overwrote it.
        """
        parsed = self._parse(_h2h_market(["away", "home", "draw"])["outcomes"])
        self.assertEqual(
            parsed, {"home": HOME_PRICE, "draw": DRAW_PRICE, "away": AWAY_PRICE}
        )

    def test_every_ordering_gives_the_same_result(self):
        """Order is not information. Assert that over all six permutations."""
        from itertools import permutations

        expected = {"home": HOME_PRICE, "draw": DRAW_PRICE, "away": AWAY_PRICE}
        for order in permutations(["home", "draw", "away"]):
            with self.subTest(order=order):
                self.assertEqual(
                    self._parse(_h2h_market(list(order))["outcomes"]), expected
                )

    def test_a_club_spelt_its_own_way_resolves_by_normalisation(self):
        outcomes = [
            _outcome("Draw", DRAW_PRICE),
            _outcome("Arsenal FC", HOME_PRICE),
            _outcome("Chelsea FC", AWAY_PRICE),
        ]
        self.assertEqual(
            self._parse(outcomes),
            {"home": HOME_PRICE, "draw": DRAW_PRICE, "away": AWAY_PRICE},
        )

    def test_an_unresolvable_outcome_rejects_the_whole_book(self):
        """
        A partial book must never be returned. Returning two of three legs reads
        downstream as "this book chose not to quote the third", which would let a
        parse failure masquerade as market data.
        """
        outcomes = [
            _outcome(HOME_RAW, HOME_PRICE),
            _outcome("Draw", DRAW_PRICE),
            _outcome("Some Other Club", AWAY_PRICE),
        ]
        self.assertEqual(self._parse(outcomes), {})

    def test_a_missing_draw_rejects_the_book(self):
        outcomes = [_outcome(HOME_RAW, HOME_PRICE), _outcome(AWAY_RAW, AWAY_PRICE)]
        self.assertEqual(self._parse(outcomes), {})

    def test_a_null_price_rejects_the_book(self):
        outcomes = [
            _outcome(HOME_RAW, None),
            _outcome("Draw", DRAW_PRICE),
            _outcome(AWAY_RAW, AWAY_PRICE),
        ]
        self.assertEqual(self._parse(outcomes), {})

    def test_no_outcomes_is_empty_not_an_error(self):
        self.assertEqual(self._parse([]), {})


class PerBookmakerTests(unittest.TestCase):
    """The inputs a market-implied goal rate is allowed to use."""

    def test_a_book_listing_away_first_is_kept_in_h2h_all(self):
        parsed = parse_match_odds([
            _event([
                {"key": "bet365", "markets": [_h2h_market(["home", "draw", "away"])]},
                {"key": "williamhill", "markets": [_h2h_market(["away", "home", "draw"])]},
            ])
        ])
        book = parsed[f"{HOME}_vs_{AWAY}"]["h2h_all"]["williamhill"]
        self.assertEqual(set(book), {"home", "draw", "away"})
        self.assertEqual(book["away"], AWAY_PRICE)

    def test_an_unresolvable_book_is_absent_from_h2h_all(self):
        broken = {
            "key": "brokenbook",
            "markets": [{
                "key": "h2h",
                "outcomes": [
                    _outcome("Mystery FC", 2.0),
                    _outcome("Draw", 3.0),
                    _outcome("Other FC", 4.0),
                ],
            }],
        }
        parsed = parse_match_odds([
            _event([
                {"key": "bet365", "markets": [_h2h_market(["home", "draw", "away"])]},
                broken,
            ])
        ])
        self.assertEqual(
            list(parsed[f"{HOME}_vs_{AWAY}"]["h2h_all"]), ["bet365"]
        )

    # Two books, each carrying a genuine ~2.8% margin, leaning opposite ways on
    # the same line. Realistic, and enough for the best-of-both pair to imply
    # probabilities summing to LESS than one.
    _TWO_BOOKS = [
        {"key": "bet365", "markets": [_totals_market(2.5, 1.85, 2.05)]},
        {"key": "williamhill", "markets": [_totals_market(2.5, 2.02, 1.88)]},
    ]

    def test_totals_are_paired_within_a_single_bookmaker(self):
        """
        The best-price view keeps the best over from one book and the best under
        from another. That pair does not belong to any book, so a two-way de-vig
        on it is meaningless. ``totals_all`` preserves the within-book pairing.
        """
        parsed = parse_match_odds([_event(self._TWO_BOOKS)])
        match = parsed[f"{HOME}_vs_{AWAY}"]

        # The best-price view mixes books, as it is meant to.
        self.assertEqual(match["totals"]["2.5"]["over"], 2.02)
        self.assertEqual(match["totals"]["2.5"]["under"], 2.05)
        self.assertEqual(match["totals"]["2.5"]["bookmaker_over"], "williamhill")
        self.assertEqual(match["totals"]["2.5"]["bookmaker_under"], "bet365")

        # Each book's own pair survives intact.
        self.assertEqual(
            match["totals_all"]["bet365"]["2.5"], {"over": 1.85, "under": 2.05}
        )
        self.assertEqual(
            match["totals_all"]["williamhill"]["2.5"], {"over": 2.02, "under": 1.88}
        )

    def test_the_best_price_totals_book_sums_to_below_one(self):
        """
        Demonstrates *why* the pairing matters, rather than asserting it in prose.
        Every real book's prices sum to more than 1 — that surplus IS the margin,
        and removing it is what de-vigging means. The mixed best-price pair sums
        to LESS than 1, so normalising it inflates both probabilities instead of
        deflating them. There is no margin there to remove.
        """
        parsed = parse_match_odds([_event(self._TWO_BOOKS)])
        match = parsed[f"{HOME}_vs_{AWAY}"]

        mixed = match["totals"]["2.5"]
        mixed_sum = 1.0 / mixed["over"] + 1.0 / mixed["under"]
        self.assertLess(mixed_sum, 1.0)

        for book, lines in match["totals_all"].items():
            with self.subTest(book=book):
                prices = lines["2.5"]
                book_sum = 1.0 / prices["over"] + 1.0 / prices["under"]
                self.assertGreater(book_sum, 1.0, "a real book carries a margin")

    def test_a_one_sided_line_is_excluded_from_totals_all(self):
        """Half a two-way market cannot be de-vigged; keeping it invites the error."""
        one_sided = {
            "key": "totals",
            "outcomes": [_outcome("Over", 1.90, point=3.5)],
        }
        parsed = parse_match_odds([
            _event([{
                "key": "bet365",
                "markets": [_totals_market(2.5, 1.90, 1.95), one_sided],
            }])
        ])
        book = parsed[f"{HOME}_vs_{AWAY}"]["totals_all"]["bet365"]
        self.assertEqual(list(book), ["2.5"])
        # Still visible in the best-price view, which has no such requirement.
        self.assertIn("3.5", parsed[f"{HOME}_vs_{AWAY}"]["totals"])


class QuotaTests(unittest.TestCase):
    def test_the_featured_market_string_is_unchanged(self):
        """
        The Odds API bills one credit per market per region, the free tier is 500
        a month, and the daily pipeline spends it. Adding a market here — even to
        the same HTTP request — raises the monthly cost, so the string is pinned.
        """
        from pipeline.data.odds_api import MARKETS

        self.assertEqual(MARKETS["featured"], "h2h,totals")


if __name__ == "__main__":
    unittest.main()
