"""
Kelly Criterion + Risk Management.
Calculates optimal bet sizing, risk of ruin, and drawdown monitoring.

Phase 2 upgrade:
- Extended to scan corners O/U, cards O/U, BTTS, player booked markets
- Market-specific edge thresholds (1X2: 5%, corners: 7%, cards: 8%, player: 10%)
- Confidence tiers (high/medium/low) based on edge magnitude + model agreement
"""
import logging
from typing import Dict, List, Optional

import numpy as np

from pipeline.config import RISK

logger = logging.getLogger(__name__)

# Market-specific minimum edge thresholds
EDGE_THRESHOLDS = {
    "1x2": RISK.get("min_edge", 0.05),
    "over_under": RISK.get("min_edge", 0.05),
    "btts": RISK.get("min_edge", 0.05),
    "corners": RISK.get("min_edge_corners", 0.07),
    "cards": RISK.get("min_edge_cards", 0.08),
    "player_booked": RISK.get("min_edge_player_booked", 0.10),
}


def kelly_stake(
    model_prob: float,
    decimal_odds: float,
    bankroll: float = 1000.0,
    max_stake_pct: float = RISK["max_stake_pct"],
    min_edge: float = RISK["min_edge"],
) -> Dict:
    """
    Calculate Kelly Criterion stake.

    f* = (b*p - q) / b
    where p = model probability, q = 1-p, b = decimal odds - 1

    Returns:
        Dict with full_kelly, half_kelly, recommended_stake, edge, etc.
    """
    if decimal_odds <= 1:
        return {"full_kelly": 0, "half_kelly": 0, "edge": 0, "recommendation": "skip"}

    b = decimal_odds - 1
    p = model_prob
    q = 1 - p
    implied_prob = 1 / decimal_odds

    edge = p - implied_prob

    # Kelly fraction
    f_star = (b * p - q) / b if b > 0 else 0

    # No bet if negative Kelly or insufficient edge
    if f_star <= 0 or edge < min_edge:
        return {
            "full_kelly": 0,
            "half_kelly": 0,
            "edge": float(edge),
            "model_prob": float(p),
            "implied_prob": float(implied_prob),
            "recommendation": "skip",
            "reason": "insufficient_edge" if edge < min_edge else "negative_kelly",
        }

    # Apply constraints
    full_kelly_pct = min(f_star, max_stake_pct)
    half_kelly_pct = full_kelly_pct / 2

    full_kelly_stake = full_kelly_pct * bankroll
    half_kelly_stake = half_kelly_pct * bankroll

    return {
        "full_kelly": float(full_kelly_stake),
        "half_kelly": float(half_kelly_stake),
        "full_kelly_pct": float(full_kelly_pct),
        "half_kelly_pct": float(half_kelly_pct),
        "edge": float(edge),
        "model_prob": float(p),
        "implied_prob": float(implied_prob),
        "expected_value": float(p * b - q),
        "recommendation": "bet",
        "decimal_odds": float(decimal_odds),
    }


def _confidence_tier(edge: float, market: str) -> str:
    """
    Assign confidence tier based on edge magnitude relative to market threshold.

    High: edge > 2x threshold
    Medium: edge > 1.5x threshold
    Low: edge > threshold
    """
    threshold = EDGE_THRESHOLDS.get(market, 0.05)
    if edge >= threshold * 2.5:
        return "high"
    elif edge >= threshold * 1.5:
        return "medium"
    else:
        return "low"


def find_value_bets(
    predictions: Dict,
    odds_benchmark: Dict,
    bankroll: float = 1000.0,
    corners_odds: Optional[Dict] = None,
    cards_odds: Optional[Dict] = None,
    player_bookings: Optional[Dict] = None,
    player_booking_odds: Optional[Dict] = None,
) -> List[Dict]:
    """
    Identify value bets where model edge exceeds market-specific threshold.

    Args:
        predictions: Match prediction with probabilities
        odds_benchmark: Bookmaker odds for the match (1X2, O/U, BTTS)
        bankroll: Current bankroll
        corners_odds: Dict with corner line odds {line: {over: odds, under: odds}}
        cards_odds: Dict with card line odds {line: {over: odds, under: odds}}
        player_bookings: Dict with player booking probs from PlayerCardsModel
        player_booking_odds: Dict with bookmaker odds for player to be booked

    Returns:
        List of value bet opportunities sorted by edge.
    """
    value_bets = []
    probs = predictions.get("probabilities", {})

    # ── 1X2 markets ──────────────────────────────────────────────────────
    min_edge_1x2 = EDGE_THRESHOLDS["1x2"]
    markets_1x2 = [
        ("Home Win", probs.get("1x2", {}).get("home", 0), "odds_home_pinnacle", "odds_home_bet365"),
        ("Draw", probs.get("1x2", {}).get("draw", 0), "odds_draw_pinnacle", "odds_draw_bet365"),
        ("Away Win", probs.get("1x2", {}).get("away", 0), "odds_away_pinnacle", "odds_away_bet365"),
    ]

    for market_name, model_prob, odds_key_1, odds_key_2 in markets_1x2:
        odds = odds_benchmark.get(odds_key_1) or odds_benchmark.get(odds_key_2)
        if odds and odds > 1 and model_prob > 0:
            stake = kelly_stake(model_prob, odds, bankroll, min_edge=min_edge_1x2)
            if stake["recommendation"] == "bet":
                value_bets.append({
                    "market": market_name,
                    "market_type": "1x2",
                    "confidence": _confidence_tier(stake["edge"], "1x2"),
                    **stake,
                })

    # ── Over/Under Goals ─────────────────────────────────────────────────
    for line in ["2.5", "3.5"]:
        ou = probs.get("over_under", {}).get(line, {})
        for direction_label, direction_key in [("Over", "over"), ("Under", "under")]:
            prob = ou.get(direction_key, 0)
            if prob <= 0:
                continue
            odds_key = f"implied_{direction_key}{line.replace('.', '')}"
            implied = odds_benchmark.get(odds_key)
            if implied and implied > 0:
                odds = 1 / implied
                stake = kelly_stake(prob, odds, bankroll, min_edge=min_edge_1x2)
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": f"{direction_label} {line} Goals",
                        "market_type": "over_under",
                        "confidence": _confidence_tier(stake["edge"], "over_under"),
                        **stake,
                    })

    # ── BTTS ─────────────────────────────────────────────────────────────
    btts_probs = probs.get("btts", {})
    btts_odds_data = odds_benchmark.get("btts", {})
    if isinstance(btts_probs, dict):
        for direction, prob in [("BTTS Yes", btts_probs.get("yes", 0)), ("BTTS No", btts_probs.get("no", 0))]:
            bk_key = "yes" if "Yes" in direction else "no"
            bk_odds = btts_odds_data.get(bk_key) if isinstance(btts_odds_data, dict) else None
            if bk_odds and bk_odds > 1 and prob > 0:
                stake = kelly_stake(prob, bk_odds, bankroll, min_edge=min_edge_1x2)
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": direction,
                        "market_type": "btts",
                        "confidence": _confidence_tier(stake["edge"], "btts"),
                        **stake,
                    })

    # ── Corners O/U ──────────────────────────────────────────────────────
    min_edge_corners = EDGE_THRESHOLDS["corners"]
    corner_probs = probs.get("corners", {})
    if corners_odds and corner_probs:
        for line_str, line_odds in corners_odds.items():
            line = float(line_str)
            for direction in ["over", "under"]:
                model_prob = corner_probs.get(f"{direction}_{line}", 0)
                bk_odds = line_odds.get(direction)
                if model_prob > 0 and bk_odds and bk_odds > 1:
                    stake = kelly_stake(model_prob, bk_odds, bankroll, min_edge=min_edge_corners)
                    if stake["recommendation"] == "bet":
                        value_bets.append({
                            "market": f"Corners {direction.title()} {line}",
                            "market_type": "corners",
                            "confidence": _confidence_tier(stake["edge"], "corners"),
                            **stake,
                        })

    # ── Cards O/U ────────────────────────────────────────────────────────
    min_edge_cards = EDGE_THRESHOLDS["cards"]
    card_probs = probs.get("cards", {})
    if cards_odds and card_probs:
        for line_str, line_odds in cards_odds.items():
            line = float(line_str)
            for direction in ["over", "under"]:
                model_prob = card_probs.get(f"{direction}_{line}", 0)
                bk_odds = line_odds.get(direction)
                if model_prob > 0 and bk_odds and bk_odds > 1:
                    stake = kelly_stake(model_prob, bk_odds, bankroll, min_edge=min_edge_cards)
                    if stake["recommendation"] == "bet":
                        value_bets.append({
                            "market": f"Cards {direction.title()} {line}",
                            "market_type": "cards",
                            "confidence": _confidence_tier(stake["edge"], "cards"),
                            **stake,
                        })

    # ── Player to be Booked ──────────────────────────────────────────────
    min_edge_player = EDGE_THRESHOLDS["player_booked"]
    if player_bookings and player_booking_odds:
        for player_name, model_prob in player_bookings.items():
            bk_odds = player_booking_odds.get(player_name)
            if bk_odds and bk_odds > 1 and model_prob > 0:
                stake = kelly_stake(model_prob, bk_odds, bankroll, min_edge=min_edge_player)
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": f"{player_name} to be Booked",
                        "market_type": "player_booked",
                        "confidence": _confidence_tier(stake["edge"], "player_booked"),
                        **stake,
                    })

    return sorted(value_bets, key=lambda x: x.get("edge", 0), reverse=True)


def find_value_bets_multi_match(
    all_predictions: List[Dict],
    all_odds: Dict,
    bankroll: float = 1000.0,
) -> List[Dict]:
    """
    Scan all matches for value bets across all markets.

    Args:
        all_predictions: List of per-match prediction dicts
        all_odds: Combined odds data from OddsAPIClient (main, corners, cards)
        bankroll: Current bankroll

    Returns:
        List of all value bet opportunities across all matches.
    """
    from pipeline.data.odds_api import parse_match_odds, parse_alt_totals

    # Parse raw odds
    match_odds = parse_match_odds(all_odds.get("main", [])) if all_odds.get("main") else {}
    corners_parsed = parse_alt_totals(all_odds.get("corners", []), "alternate_totals_corners") if all_odds.get("corners") else {}
    cards_parsed = parse_alt_totals(all_odds.get("cards", []), "alternate_totals_cards") if all_odds.get("cards") else {}

    all_bets = []
    for pred in all_predictions:
        fixture = pred.get("fixture", {})
        home = fixture.get("home_team", "")
        away = fixture.get("away_team", "")
        match_key = f"{home}_vs_{away}"

        # Get odds for this match
        m_odds = match_odds.get(match_key, {})
        c_odds = corners_parsed.get(match_key, {}).get("lines", {})
        cd_odds = cards_parsed.get(match_key, {}).get("lines", {})

        # Build odds_benchmark dict from parsed odds
        odds_benchmark = {}
        if m_odds.get("h2h"):
            h2h = m_odds["h2h"]
            odds_benchmark["odds_home_bet365"] = h2h.get("home")
            odds_benchmark["odds_draw_bet365"] = h2h.get("draw")
            odds_benchmark["odds_away_bet365"] = h2h.get("away")
        if m_odds.get("btts"):
            odds_benchmark["btts"] = m_odds["btts"]

        bets = find_value_bets(
            predictions=pred,
            odds_benchmark=odds_benchmark,
            bankroll=bankroll,
            corners_odds=c_odds if c_odds else None,
            cards_odds=cd_odds if cd_odds else None,
        )

        for bet in bets:
            bet["match"] = f"{home} vs {away}"
            bet["match_key"] = match_key

        all_bets.extend(bets)

    return sorted(all_bets, key=lambda x: x.get("edge", 0), reverse=True)


def risk_of_ruin(
    edge: float,
    win_prob: float,
    bankroll_units: float = 100,
    n_simulations: int = 10000,
    n_bets: int = 500,
) -> Dict:
    """
    Monte Carlo risk-of-ruin simulation.

    Simulates n_bets sequential bets and tracks bankroll trajectory.
    """
    ruin_count = 0
    max_drawdowns = []
    final_bankrolls = []

    for _ in range(n_simulations):
        bankroll = bankroll_units
        peak = bankroll
        max_dd = 0

        for _ in range(n_bets):
            if bankroll <= 0:
                ruin_count += 1
                break

            # Stake: half Kelly
            stake = min(bankroll * edge / 2, bankroll * RISK["max_stake_pct"])
            if stake <= 0:
                continue

            # Simulate bet outcome
            if np.random.random() < win_prob:
                bankroll += stake * (1 / win_prob - 1)  # Win at fair odds
            else:
                bankroll -= stake

            # Track drawdown
            peak = max(peak, bankroll)
            dd = (peak - bankroll) / peak if peak > 0 else 0
            max_dd = max(max_dd, dd)

        max_drawdowns.append(max_dd)
        final_bankrolls.append(bankroll)

    return {
        "ruin_probability": float(ruin_count / n_simulations),
        "expected_final_bankroll": float(np.mean(final_bankrolls)),
        "median_final_bankroll": float(np.median(final_bankrolls)),
        "max_drawdown_median": float(np.median(max_drawdowns)),
        "max_drawdown_95th": float(np.percentile(max_drawdowns, 95)),
        "profitable_pct": float(np.mean(np.array(final_bankrolls) > bankroll_units)),
    }


def check_drawdown(
    current_bankroll: float,
    peak_bankroll: float,
    soft_limit: float = RISK["drawdown_soft_limit"],
    hard_limit: float = RISK["drawdown_hard_limit"],
) -> Dict:
    """
    Check drawdown status and recommend stake adjustment.
    """
    if peak_bankroll <= 0:
        return {"status": "error", "message": "Invalid peak bankroll"}

    drawdown = (peak_bankroll - current_bankroll) / peak_bankroll

    if drawdown >= hard_limit:
        return {
            "status": "hard_stop",
            "drawdown_pct": float(drawdown),
            "stake_multiplier": 0.0,
            "message": f"Drawdown {drawdown:.1%} exceeds hard limit {hard_limit:.0%}. All betting paused.",
        }
    elif drawdown >= soft_limit:
        return {
            "status": "reduced",
            "drawdown_pct": float(drawdown),
            "stake_multiplier": 0.5,
            "message": f"Drawdown {drawdown:.1%} exceeds soft limit {soft_limit:.0%}. Stakes reduced 50%.",
        }
    else:
        return {
            "status": "normal",
            "drawdown_pct": float(drawdown),
            "stake_multiplier": 1.0,
            "message": "Normal operation.",
        }
