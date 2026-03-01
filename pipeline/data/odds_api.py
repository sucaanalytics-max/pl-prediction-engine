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
from pathlib import Path
from typing import Dict, List, Optional

import requests

from pipeline.config import (
    ODDS_API_KEY,
    ODDS_API_BASE,
    ODDS_API_SPORT,
    ODDS_API_CACHE_MINUTES,
    DATA_PROCESSED,
)
from pipeline.data.team_mapping import normalize_team_name

logger = logging.getLogger(__name__)

# Markets we fetch
MARKETS = {
    "main": "h2h,totals,btts",
    "corners": "alternate_totals_corners",
    "cards": "alternate_totals_cards",
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

    def _get(self, endpoint: str, params: dict, cache_key: str) -> Optional[dict]:
        """Make API request with caching."""
        cache_path = self.cache_dir / f"{cache_key}.json"

        if self._is_cache_valid(cache_path):
            logger.info(f"Loading cached odds: {cache_key}")
            return json.loads(cache_path.read_text())

        if not self.api_key:
            logger.warning("No ODDS_API_KEY set. Skipping odds fetch.")
            if cache_path.exists():
                logger.warning("Using stale odds cache")
                return json.loads(cache_path.read_text())
            return None

        url = f"{self.base_url}{endpoint}"
        params["apiKey"] = self.api_key

        try:
            resp = requests.get(url, params=params, timeout=30)

            # Track usage
            self.remaining_requests = resp.headers.get("x-requests-remaining")
            self.used_requests = resp.headers.get("x-requests-used")
            if self.remaining_requests:
                logger.info(f"Odds API: {self.remaining_requests} requests remaining")

            resp.raise_for_status()
            data = resp.json()

            # Cache response
            cache_path.write_text(json.dumps(data, indent=2))
            return data

        except requests.RequestException as e:
            logger.error(f"Odds API error: {e}")
            if cache_path.exists():
                logger.warning("Using stale odds cache")
                return json.loads(cache_path.read_text())
            return None

    def fetch_match_odds(self, regions: str = "uk") -> Optional[List[Dict]]:
        """
        Fetch main market odds (1X2, O/U, BTTS) for upcoming EPL matches.

        Returns list of match dicts with nested bookmaker odds.
        """
        return self._get(
            f"/sports/{self.sport}/odds",
            {
                "regions": regions,
                "markets": MARKETS["main"],
                "oddsFormat": "decimal",
            },
            cache_key="main_odds",
        )

    def fetch_corners_odds(self, regions: str = "uk") -> Optional[List[Dict]]:
        """Fetch corners O/U odds for upcoming EPL matches."""
        return self._get(
            f"/sports/{self.sport}/odds",
            {
                "regions": regions,
                "markets": MARKETS["corners"],
                "oddsFormat": "decimal",
            },
            cache_key="corners_odds",
        )

    def fetch_cards_odds(self, regions: str = "uk") -> Optional[List[Dict]]:
        """Fetch cards O/U odds for upcoming EPL matches."""
        return self._get(
            f"/sports/{self.sport}/odds",
            {
                "regions": regions,
                "markets": MARKETS["cards"],
                "oddsFormat": "decimal",
            },
            cache_key="cards_odds",
        )

    def fetch_all_odds(self, regions: str = "uk") -> Dict[str, Optional[List[Dict]]]:
        """
        Fetch all market odds in one go (3 API calls).

        Returns dict with keys: main, corners, cards.
        """
        return {
            "main": self.fetch_match_odds(regions),
            "corners": self.fetch_corners_odds(regions),
            "cards": self.fetch_cards_odds(regions),
        }


def parse_match_odds(raw_odds: List[Dict]) -> Dict[str, Dict]:
    """
    Parse raw Odds API response into standardized format.

    Returns:
        Dict[match_key -> {
            home_team, away_team, commence_time,
            h2h: {home, draw, away},  # best available odds
            totals: {line: {over, under}},
            btts: {yes, no},
        }]
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
            "totals": {},
            "btts": {},
        }

        for bookmaker in event.get("bookmakers", []):
            bk_key = bookmaker.get("key", "")

            for market in bookmaker.get("markets", []):
                market_key = market.get("key", "")
                outcomes = market.get("outcomes", [])

                if market_key == "h2h" and not match_data["h2h"]:
                    match_data["h2h"] = _parse_h2h(outcomes, home, away)
                    match_data["h2h"]["bookmaker"] = bk_key

                elif market_key == "totals":
                    for outcome in outcomes:
                        line = outcome.get("point")
                        if line is not None:
                            line_key = str(line)
                            if line_key not in match_data["totals"]:
                                match_data["totals"][line_key] = {}
                            name = outcome.get("name", "").lower()
                            if name == "over":
                                match_data["totals"][line_key]["over"] = outcome["price"]
                            elif name == "under":
                                match_data["totals"][line_key]["under"] = outcome["price"]

                elif market_key == "btts" and not match_data["btts"]:
                    for outcome in outcomes:
                        name = outcome.get("name", "").lower()
                        if name == "yes":
                            match_data["btts"]["yes"] = outcome["price"]
                        elif name == "no":
                            match_data["btts"]["no"] = outcome["price"]

        matches[key] = match_data

    return matches


def parse_alt_totals(raw_odds: List[Dict], market_name: str) -> Dict[str, Dict]:
    """
    Parse alternate totals (corners or cards) odds.

    Args:
        raw_odds: Raw API response
        market_name: "alternate_totals_corners" or "alternate_totals_cards"

    Returns:
        Dict[match_key -> {line: {over: odds, under: odds}}]
    """
    if not raw_odds:
        return {}

    matches = {}
    for event in raw_odds:
        home = normalize_team_name(event.get("home_team", ""))
        away = normalize_team_name(event.get("away_team", ""))
        key = f"{home}_vs_{away}"

        lines = {}
        for bookmaker in event.get("bookmakers", []):
            for market in bookmaker.get("markets", []):
                if market.get("key") != market_name:
                    continue
                for outcome in market.get("outcomes", []):
                    point = outcome.get("point")
                    if point is None:
                        continue
                    line_key = str(point)
                    if line_key not in lines:
                        lines[line_key] = {"bookmaker": bookmaker.get("key", "")}
                    name = outcome.get("name", "").lower()
                    if name == "over":
                        lines[line_key]["over"] = outcome["price"]
                    elif name == "under":
                        lines[line_key]["under"] = outcome["price"]

        if lines:
            matches[key] = {
                "home_team": home,
                "away_team": away,
                "lines": lines,
            }

    return matches


def _parse_h2h(outcomes: list, home: str, away: str) -> dict:
    """Parse 1X2 outcomes into standardized format."""
    result = {}
    for o in outcomes:
        name = o.get("name", "")
        normalized = normalize_team_name(name)
        if normalized == home or name == event_home_name(outcomes, home):
            result["home"] = o["price"]
        elif normalized == away or name == event_away_name(outcomes, away):
            result["away"] = o["price"]
        elif name.lower() == "draw":
            result["draw"] = o["price"]
    return result


def event_home_name(outcomes: list, home: str) -> str:
    """Find the outcome name matching the home team."""
    # First outcome is typically home for h2h
    if outcomes:
        return outcomes[0].get("name", "")
    return home


def event_away_name(outcomes: list, away: str) -> str:
    """Find the outcome name matching the away team."""
    # Last non-Draw outcome is typically away
    for o in reversed(outcomes):
        if o.get("name", "").lower() != "draw":
            return o.get("name", "")
    return away


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
                model_over = model.get("probabilities", {}).get("corners", {}).get(f"over_{line}")
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
                model_under = model.get("probabilities", {}).get("corners", {}).get(f"under_{line}")
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
                model_over = model.get("probabilities", {}).get("cards", {}).get(f"over_{line}")
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
                model_under = model.get("probabilities", {}).get("cards", {}).get(f"under_{line}")
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

    if all_odds["main"]:
        parsed = parse_match_odds(all_odds["main"])
        print(f"\nMain odds: {len(parsed)} matches")
        for key, data in list(parsed.items())[:3]:
            print(f"  {key}: h2h={data.get('h2h', {})}")

    if all_odds["corners"]:
        corners = parse_alt_totals(all_odds["corners"], "alternate_totals_corners")
        print(f"\nCorners odds: {len(corners)} matches")
        for key, data in list(corners.items())[:3]:
            print(f"  {key}: lines={list(data.get('lines', {}).keys())}")

    if all_odds["cards"]:
        cards = parse_alt_totals(all_odds["cards"], "alternate_totals_cards")
        print(f"\nCards odds: {len(cards)} matches")

    print(f"\nAPI requests remaining: {client.remaining_requests}")
