"""
The Odds API client for fetching live bookmaker odds.

Supports EPL markets:
- h2h (1X2 match result)
- totals (over/under goals)
- btts (both teams to score)
- alternate_totals_corners (corners O/U lines)
- alternate_totals_cards (cards O/U lines)
- player props (anytime goalscorer, player cards)

Free tier: 500 requests/month → ~100 calls/month with caching.
"""
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import requests

from pipeline.config import (
    ODDS_API_KEY,
    ODDS_API_BASE,
    ODDS_API_SPORT,
    ODDS_API_CACHE_MINUTES,
    ODDS_FETCH_ADDITIONAL,
    ODDS_ADDITIONAL_REGIONS,
    ODDS_ADDITIONAL_HORIZON_HOURS,
    DATA_PROCESSED,
)
from pipeline.data.team_mapping import normalize_team_name
from pipeline.utils import fetch_with_retry

logger = logging.getLogger(__name__)

# Featured markets are supported by the bulk /odds endpoint. Additional soccer
# markets must be requested one event at a time.
MARKETS = {
    "featured": "h2h,totals",
    "additional": "btts,alternate_totals_corners,alternate_totals_cards",
}

# Bookmaker priority (UK-focused, ordered by reliability)
PREFERRED_BOOKMAKERS = [
    "bet365", "williamhill", "paddypower", "betfair_ex_uk",
    "unibet_uk", "betway", "ladbrokes_uk", "coral",
    "skybet", "betfred", "888sport",
]


class OddsAPIClient:
    """Client for The Odds API with caching and rate limiting."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or ODDS_API_KEY
        self.base_url = ODDS_API_BASE
        self.sport = ODDS_API_SPORT
        self.cache_dir = DATA_PROCESSED / "odds_api"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.remaining_requests = None
        self.used_requests = None

    def _is_cache_valid(self, cache_path: Path) -> bool:
        """Check if cached response is still fresh."""
        if not cache_path.exists():
            return False
        age_minutes = (time.time() - cache_path.stat().st_mtime) / 60
        return age_minutes < ODDS_API_CACHE_MINUTES

    def _get(self, endpoint: str, params: dict, cache_key: str):
        """Make API request with caching."""
        cache_path = self.cache_dir / f"{cache_key}.json"

        if self._is_cache_valid(cache_path):
            logger.info(f"Loading cached odds: {cache_key}")
            return json.loads(cache_path.read_text())

        if not self.api_key:
            logger.warning("No ODDS_API_KEY set. Skipping odds fetch.")
            if cache_path.exists():
                logger.warning("Stale odds cache exists but will not be used for recommendations")
            return None

        url = f"{self.base_url}{endpoint}"
        params["apiKey"] = self.api_key

        try:
            resp = fetch_with_retry(url, max_retries=2, timeout=30, params=params)

            # Track usage
            self.remaining_requests = resp.headers.get("x-requests-remaining")
            self.used_requests = resp.headers.get("x-requests-used")
            if self.remaining_requests:
                logger.info(f"Odds API: {self.remaining_requests} requests remaining")

            data = resp.json()

            # Cache response
            cache_path.write_text(json.dumps(data, indent=2))
            return data

        except Exception as e:
            logger.error(f"Odds API error: {e}")
            if cache_path.exists():
                logger.warning("Stale odds cache exists but will not be used for recommendations")
            return None

    def fetch_match_odds(self, regions: str = "uk") -> Optional[List[Dict]]:
        """
        Fetch featured 1X2 and total-goals odds for upcoming EPL matches.

        Returns list of match dicts with nested bookmaker odds.
        """
        return self._get(
            f"/sports/{self.sport}/odds",
            {
                "regions": regions,
                "markets": MARKETS["featured"],
                "oddsFormat": "decimal",
            },
            cache_key="main_odds",
        )

    def fetch_events(self) -> Optional[List[Dict]]:
        """Fetch upcoming EPL event identifiers (no market quota cost)."""
        return self._get(
            f"/sports/{self.sport}/events",
            {},
            cache_key="events",
        )

    def fetch_event_additional_odds(
        self,
        event_id: str,
        regions: str = ODDS_ADDITIONAL_REGIONS,
    ) -> Optional[Dict]:
        """Fetch opt-in BTTS/corners/cards odds for one event."""
        return self._get(
            f"/sports/{self.sport}/events/{event_id}/odds",
            {
                "regions": regions,
                "markets": MARKETS["additional"],
                "oddsFormat": "decimal",
            },
            cache_key=f"additional_{event_id}_{regions.replace(',', '-')}",
        )

    def fetch_all_odds(self, regions: str = "uk") -> Dict[str, Optional[List[Dict]]]:
        """
        Fetch low-cost featured odds and optional per-event additional markets.

        Additional markets are disabled by default because their per-event quota
        cost is unsuitable for an unconditional daily gameweek-wide fetch.
        """
        main = self.fetch_match_odds(regions)
        additional = []

        if ODDS_FETCH_ADDITIONAL:
            events = self.fetch_events() or []
            now = datetime.now(timezone.utc)
            horizon_seconds = ODDS_ADDITIONAL_HORIZON_HOURS * 3600
            for event in events:
                commence_raw = event.get("commence_time")
                if not commence_raw:
                    continue
                try:
                    commence = datetime.fromisoformat(
                        commence_raw.replace("Z", "+00:00")
                    )
                except ValueError:
                    continue
                seconds_until = (commence - now).total_seconds()
                if seconds_until < 0 or seconds_until > horizon_seconds:
                    continue

                event_odds = self.fetch_event_additional_odds(event["id"])
                if event_odds:
                    additional.append(event_odds)

        return {"main": main, "additional": additional}


def parse_match_odds(raw_odds: List[Dict]) -> Dict[str, Dict]:
    """
    Parse raw Odds API response into standardized format.

    Iterates ALL bookmakers and selects the best available odds for each
    outcome. This maximizes expected value without additional API calls
    (all bookmakers are included in a single response).

    Returns:
        Dict[match_key -> {
            home_team, away_team, commence_time,
            h2h: {home, draw, away, bookmaker_home, bookmaker_draw, bookmaker_away},
            h2h_all: {bookmaker_key: {home, draw, away}},  # all bookmaker odds
            totals: {line: {over, under, bookmaker_over, bookmaker_under}},
            totals_all: {bookmaker_key: {line: {over, under}}},
            btts: {yes, no, bookmaker_yes, bookmaker_no},
        }]

    ``h2h`` and ``totals`` take the best price per outcome across bookmakers,
    which is right for finding a bet and **wrong as a probability source**: the
    result is a max over books rather than any single book's coherent view, so
    its implied probabilities frequently sum to below 1.0 and normalising them is
    meaningless. Anything deriving probabilities or goal rates must use
    ``h2h_all`` / ``totals_all`` and de-vig within each bookmaker first.
    """
    if not raw_odds:
        return {}

    matches = {}
    for event in raw_odds:
        home = normalize_team_name(event.get("home_team", ""))
        away = normalize_team_name(event.get("away_team", ""))
        key = f"{home}_vs_{away}"

        match_data = {
            "home_team": home,
            "away_team": away,
            "commence_time": event.get("commence_time"),
            "h2h": {},
            "h2h_all": {},  # All bookmaker odds for comparison
            "totals": {},
            "totals_all": {},  # Per-bookmaker, so a two-way market can be de-vigged
            "btts": {},
        }

        # Collect all bookmaker odds, then pick the best
        all_h2h = {}       # bk_key -> {home, draw, away}
        all_totals = {}    # line_key -> {over: [(price, bk)], under: [(price, bk)]}
        all_btts = {}      # bk_key -> {yes, no}
        # Books whose 1X2 could not be resolved to exactly home/draw/away.
        #
        # Reported because side resolution now runs off the event's own team names
        # rather than outcome order, and that is a DECLARED STAKING CHANGE: books
        # listing the away team first previously returned no away leg at all, so
        # their away price never entered best-price selection. Restoring it raises
        # the best away price, which widens the edge and therefore the Kelly stake.
        # Bounded by RISK["max_stake_pct"] = 0.05 and gated by min_edge, but it
        # must not be silent — a run that suddenly resolves more books should say
        # so, and a run that suddenly resolves fewer is a parsing regression.
        rejected_h2h: List[str] = []
        # bk_key -> line_key -> {over, under}. The best-price view below cannot
        # substitute: it keeps the best over from one book and the best under from
        # another, discarding which book paired them. A two-outcome market can
        # only be de-vigged within a single book, so without this the totals leg
        # of a market-implied goal rate has no legitimate input.
        totals_by_book: Dict[str, Dict[str, Dict[str, float]]] = {}

        for bookmaker in event.get("bookmakers", []):
            bk_key = bookmaker.get("key", "")

            for market in bookmaker.get("markets", []):
                market_key = market.get("key", "")
                outcomes = market.get("outcomes", [])

                if market_key == "h2h":
                    parsed = _parse_h2h(
                        outcomes,
                        home,
                        away,
                        event.get("home_team", ""),
                        event.get("away_team", ""),
                    )
                    if parsed:
                        all_h2h[bk_key] = parsed
                    elif outcomes:
                        rejected_h2h.append(bk_key)
                        logger.debug(
                            "rejected %s h2h for %s: outcomes did not resolve to "
                            "home/draw/away (%s)",
                            bk_key, key, [o.get("name") for o in outcomes],
                        )

                elif market_key == "totals":
                    for outcome in outcomes:
                        line = outcome.get("point")
                        if line is None:
                            continue
                        line_key = str(line)
                        if line_key not in all_totals:
                            all_totals[line_key] = {"over": [], "under": []}
                        name = outcome.get("name", "").lower()
                        if name in ("over", "under"):
                            all_totals[line_key][name].append((outcome["price"], bk_key))
                            totals_by_book.setdefault(bk_key, {}).setdefault(
                                line_key, {}
                            )[name] = outcome["price"]

                elif market_key == "btts":
                    bk_btts = {}
                    for outcome in outcomes:
                        name = outcome.get("name", "").lower()
                        if name in ("yes", "no"):
                            bk_btts[name] = outcome["price"]
                    if bk_btts:
                        all_btts[bk_key] = bk_btts

        # ── Select best H2H odds ──────────────────────────────────────
        match_data["h2h_all"] = all_h2h
        match_data["n_h2h_books"] = len(all_h2h)
        match_data["n_h2h_books_rejected"] = len(rejected_h2h)
        best_h2h = {"home": 0, "draw": 0, "away": 0}
        best_h2h_bk = {"home": "", "draw": "", "away": ""}

        for bk_key, odds in all_h2h.items():
            for outcome in ["home", "draw", "away"]:
                price = odds.get(outcome, 0)
                if price > best_h2h.get(outcome, 0):
                    best_h2h[outcome] = price
                    best_h2h_bk[outcome] = bk_key

        if any(v > 0 for v in best_h2h.values()):
            match_data["h2h"] = {
                **best_h2h,
                "bookmaker_home": best_h2h_bk["home"],
                "bookmaker_draw": best_h2h_bk["draw"],
                "bookmaker_away": best_h2h_bk["away"],
                "bookmaker": best_h2h_bk["home"],  # backward compat
            }

        # ── Select best totals odds ───────────────────────────────────
        for line_key, directions in all_totals.items():
            line_data = {}
            for direction in ["over", "under"]:
                prices = directions.get(direction, [])
                if prices:
                    best_price, best_bk = max(prices, key=lambda x: x[0])
                    line_data[direction] = best_price
                    line_data[f"bookmaker_{direction}"] = best_bk
            if line_data:
                match_data["totals"][line_key] = line_data

        # ── Per-bookmaker totals, complete two-sided lines only ───────
        # A line quoted on one side cannot be de-vigged, and keeping it would
        # invite a caller to normalise a single price to 1.0.
        for bk_key, lines in totals_by_book.items():
            complete = {
                line_key: dict(prices)
                for line_key, prices in lines.items()
                if "over" in prices and "under" in prices
            }
            if complete:
                match_data["totals_all"][bk_key] = complete

        # ── Select best BTTS odds ─────────────────────────────────────
        best_btts = {"yes": 0, "no": 0}
        best_btts_bk = {"yes": "", "no": ""}
        for bk_key, odds in all_btts.items():
            for outcome in ["yes", "no"]:
                price = odds.get(outcome, 0)
                if price > best_btts.get(outcome, 0):
                    best_btts[outcome] = price
                    best_btts_bk[outcome] = bk_key

        if any(v > 0 for v in best_btts.values()):
            match_data["btts"] = {
                **best_btts,
                "bookmaker_yes": best_btts_bk["yes"],
                "bookmaker_no": best_btts_bk["no"],
            }

        matches[key] = match_data

    return matches


def parse_alt_totals(raw_odds: List[Dict], market_name: str) -> Dict[str, Dict]:
    """
    Parse alternate totals (corners or cards) odds.

    Iterates ALL bookmakers and selects the best available odds for each
    line/direction combination.

    Args:
        raw_odds: Raw API response
        market_name: "alternate_totals_corners" or "alternate_totals_cards"

    Returns:
        Dict[match_key -> {lines: {line: {over, under, bookmaker_over, bookmaker_under}}}]
    """
    if not raw_odds:
        return {}

    matches = {}
    for event in raw_odds:
        home = normalize_team_name(event.get("home_team", ""))
        away = normalize_team_name(event.get("away_team", ""))
        key = f"{home}_vs_{away}"

        # Collect all prices: line_key -> {over: [(price, bk)], under: [(price, bk)]}
        all_lines = {}
        for bookmaker in event.get("bookmakers", []):
            bk_key = bookmaker.get("key", "")
            for market in bookmaker.get("markets", []):
                if market.get("key") != market_name:
                    continue
                for outcome in market.get("outcomes", []):
                    point = outcome.get("point")
                    if point is None:
                        continue
                    line_key = str(point)
                    if line_key not in all_lines:
                        all_lines[line_key] = {"over": [], "under": []}
                    name = outcome.get("name", "").lower()
                    if name in ("over", "under"):
                        all_lines[line_key][name].append((outcome["price"], bk_key))

        # Select best odds per line/direction
        lines = {}
        for line_key, directions in all_lines.items():
            line_data = {}
            for direction in ["over", "under"]:
                prices = directions.get(direction, [])
                if prices:
                    best_price, best_bk = max(prices, key=lambda x: x[0])
                    line_data[direction] = best_price
                    line_data[f"bookmaker_{direction}"] = best_bk
            if line_data:
                lines[line_key] = line_data

        if lines:
            matches[key] = {
                "home_team": home,
                "away_team": away,
                "lines": lines,
            }

    return matches


def _parse_h2h(
    outcomes: list,
    home: str,
    away: str,
    raw_home: str = "",
    raw_away: str = "",
) -> dict:
    """
    Parse one bookmaker's 1X2 outcomes, resolving sides by NAME, never by position.

    Returns ``{}`` — rejecting the book outright — unless all three of home, draw
    and away resolve. A partial book must not be returned, because downstream
    best-price selection reads a missing leg as "this book did not quote that
    side", which is indistinguishable from "we failed to parse it".

    The previous implementation guessed the home side from ``outcomes[0]``. Any
    bookmaker listing the away team first therefore matched the away price into
    ``home`` on the first iteration; the real home outcome then overwrote it, so
    the *home* price came out right and the book silently returned **no away leg
    at all** — quietly excluding that bookmaker from every away-side comparison.
    Where the team name also failed to normalise, the two sides swapped outright,
    which inverts supremacy and would wreck clean-sheet projections.

    ``raw_home``/``raw_away`` are the event payload's own ``home_team`` and
    ``away_team`` strings. They are authoritative: The Odds API populates h2h
    outcome names from the same source, so an exact match is the primary key and
    ``normalize_team_name`` is only the fallback for a book that spells the club
    its own way.
    """
    result: dict = {}
    for outcome in outcomes:
        name = outcome.get("name", "")
        price = outcome.get("price")
        if price is None:
            continue

        if name.strip().lower() == "draw":
            result["draw"] = price
            continue

        # Exact match against the event's own naming first, normalised second.
        if raw_home and name == raw_home:
            result["home"] = price
        elif raw_away and name == raw_away:
            result["away"] = price
        else:
            normalized = normalize_team_name(name)
            if normalized and normalized == home:
                result["home"] = price
            elif normalized and normalized == away:
                result["away"] = price
            # An outcome resolving to neither side is left unassigned, and the
            # completeness check below then rejects the book.

    if set(result) != {"home", "draw", "away"}:
        return {}
    return result


def find_best_odds(event: Dict) -> Dict[str, Dict]:
    """
    Find best available odds across all bookmakers for a single event.

    Convenience wrapper for use in the pipeline — extracts best odds
    from the full bookmaker list in a raw Odds API event.

    Args:
        event: Single event dict from raw Odds API response

    Returns:
        {market: {outcome: {price, bookmaker}}}
        e.g. {"h2h": {"home": {"price": 2.15, "bookmaker": "bet365"}, ...}}
    """
    best = {"h2h": {}, "totals": {}, "btts": {}}

    for bookmaker in event.get("bookmakers", []):
        bk_key = bookmaker.get("key", "")
        for market in bookmaker.get("markets", []):
            mk = market.get("key", "")
            for outcome in market.get("outcomes", []):
                price = outcome.get("price", 0)
                name = outcome.get("name", "").lower()

                if mk == "h2h":
                    if name in ("home", "draw", "away") or name not in best["h2h"]:
                        # Map team names to home/draw/away
                        key = name if name in ("draw",) else name
                        current = best["h2h"].get(key, {}).get("price", 0)
                        if price > current:
                            best["h2h"][key] = {"price": price, "bookmaker": bk_key}

                elif mk == "totals":
                    point = outcome.get("point")
                    if point is not None and name in ("over", "under"):
                        line_key = f"{point}_{name}"
                        current = best["totals"].get(line_key, {}).get("price", 0)
                        if price > current:
                            best["totals"][line_key] = {"price": price, "bookmaker": bk_key, "line": point}

                elif mk == "btts" and name in ("yes", "no"):
                    current = best["btts"].get(name, {}).get("price", 0)
                    if price > current:
                        best["btts"][name] = {"price": price, "bookmaker": bk_key}

    return best


def build_odds_comparison(
    model_probs: Dict,
    match_odds: Dict,
    corners_odds: Dict,
    cards_odds: Dict,
) -> List[Dict]:
    """
    Compare model probabilities with bookmaker odds across all markets.

    Returns list of value bet opportunities with edge calculations.
    """
    opportunities = []

    for match_key, model in model_probs.items():
        # 1X2 comparison
        if match_key in match_odds:
            bk = match_odds[match_key]
            if bk.get("h2h"):
                for outcome in ["home", "draw", "away"]:
                    bk_odds = bk["h2h"].get(outcome)
                    model_prob = model.get("probabilities", {}).get("1x2", {}).get(outcome)
                    if bk_odds and model_prob:
                        implied = 1.0 / bk_odds
                        edge = model_prob - implied
                        if edge > 0:
                            opportunities.append({
                                "match_key": match_key,
                                "market": "1x2",
                                "selection": outcome,
                                "model_prob": model_prob,
                                "implied_prob": implied,
                                "bookmaker_odds": bk_odds,
                                "edge": edge,
                            })

        # Corners comparison
        if match_key in corners_odds:
            corner_lines = corners_odds[match_key].get("lines", {})
            for line_str, bk_line in corner_lines.items():
                line = float(line_str)
                corner_probs = model.get("probabilities", {}).get("corners", {})
                line_probs = corner_probs.get(str(line), {})
                model_over = (
                    line_probs.get("over")
                    if isinstance(line_probs, dict)
                    else corner_probs.get(f"over_{line}")
                )
                if model_over and bk_line.get("over"):
                    implied = 1.0 / bk_line["over"]
                    edge = model_over - implied
                    if edge > 0:
                        opportunities.append({
                            "match_key": match_key,
                            "market": "corners",
                            "selection": f"over_{line}",
                            "model_prob": model_over,
                            "implied_prob": implied,
                            "bookmaker_odds": bk_line["over"],
                            "edge": edge,
                        })
                model_under = (
                    line_probs.get("under")
                    if isinstance(line_probs, dict)
                    else corner_probs.get(f"under_{line}")
                )
                if model_under and bk_line.get("under"):
                    implied = 1.0 / bk_line["under"]
                    edge = model_under - implied
                    if edge > 0:
                        opportunities.append({
                            "match_key": match_key,
                            "market": "corners",
                            "selection": f"under_{line}",
                            "model_prob": model_under,
                            "implied_prob": implied,
                            "bookmaker_odds": bk_line["under"],
                            "edge": edge,
                        })

        # Cards comparison
        if match_key in cards_odds:
            card_lines = cards_odds[match_key].get("lines", {})
            for line_str, bk_line in card_lines.items():
                line = float(line_str)
                card_probs = model.get("probabilities", {}).get("cards", {})
                line_probs = card_probs.get(str(line), {})
                model_over = (
                    line_probs.get("over")
                    if isinstance(line_probs, dict)
                    else card_probs.get(f"over_{line}")
                )
                if model_over and bk_line.get("over"):
                    implied = 1.0 / bk_line["over"]
                    edge = model_over - implied
                    if edge > 0:
                        opportunities.append({
                            "match_key": match_key,
                            "market": "cards",
                            "selection": f"over_{line}",
                            "model_prob": model_over,
                            "implied_prob": implied,
                            "bookmaker_odds": bk_line["over"],
                            "edge": edge,
                        })
                model_under = (
                    line_probs.get("under")
                    if isinstance(line_probs, dict)
                    else card_probs.get(f"under_{line}")
                )
                if model_under and bk_line.get("under"):
                    implied = 1.0 / bk_line["under"]
                    edge = model_under - implied
                    if edge > 0:
                        opportunities.append({
                            "match_key": match_key,
                            "market": "cards",
                            "selection": f"under_{line}",
                            "model_prob": model_under,
                            "implied_prob": implied,
                            "bookmaker_odds": bk_line["under"],
                            "edge": edge,
                        })

    # Sort by edge descending
    opportunities.sort(key=lambda x: x["edge"], reverse=True)
    return opportunities


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    client = OddsAPIClient()

    # Fetch all markets
    all_odds = client.fetch_all_odds()

    # fetch_all_odds returns {"main": [...], "additional": [...]} — the earlier
    # all_odds["corners"] / ["cards"] here raised KeyError, so this demo path had
    # never once been run.
    if all_odds["main"]:
        parsed = parse_match_odds(all_odds["main"])
        print(f"\nMain odds: {len(parsed)} matches")
        for key, data in list(parsed.items())[:3]:
            print(f"  {key}: h2h={data.get('h2h', {})}")
            print(f"    books quoting a complete 1X2: {len(data.get('h2h_all', {}))}")
            print(f"    books quoting two-sided totals: {len(data.get('totals_all', {}))}")

    if all_odds["additional"]:
        corners = parse_alt_totals(all_odds["additional"], "alternate_totals_corners")
        print(f"\nCorners odds: {len(corners)} matches")
        for key, data in list(corners.items())[:3]:
            print(f"  {key}: lines={list(data.get('lines', {}).keys())}")

        cards = parse_alt_totals(all_odds["additional"], "alternate_totals_cards")
        print(f"\nCards odds: {len(cards)} matches")

    print(f"\nAPI requests remaining: {client.remaining_requests}")
