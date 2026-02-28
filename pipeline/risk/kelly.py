"""
Kelly Criterion + Risk Management.
Calculates optimal bet sizing, risk of ruin, and drawdown monitoring.
"""
import logging
from typing import Dict, List, Optional

import numpy as np

from pipeline.config import RISK

logger = logging.getLogger(__name__)


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


def find_value_bets(
    predictions: Dict,
    odds_benchmark: Dict,
    bankroll: float = 1000.0,
) -> List[Dict]:
    """
    Identify value bets where model edge exceeds threshold.

    Args:
        predictions: Match prediction with probabilities
        odds_benchmark: Bookmaker odds for the match
        bankroll: Current bankroll

    Returns:
        List of value bet opportunities
    """
    value_bets = []
    probs = predictions.get("probabilities", {})

    # 1X2 markets
    markets_1x2 = [
        ("Home Win", probs.get("1x2", {}).get("home", 0), "odds_home_pinnacle", "odds_home_bet365"),
        ("Draw", probs.get("1x2", {}).get("draw", 0), "odds_draw_pinnacle", "odds_draw_bet365"),
        ("Away Win", probs.get("1x2", {}).get("away", 0), "odds_away_pinnacle", "odds_away_bet365"),
    ]

    for market_name, model_prob, odds_key_1, odds_key_2 in markets_1x2:
        odds = odds_benchmark.get(odds_key_1) or odds_benchmark.get(odds_key_2)
        if odds and odds > 1 and model_prob > 0:
            stake = kelly_stake(model_prob, odds, bankroll)
            if stake["recommendation"] == "bet":
                value_bets.append({
                    "market": market_name,
                    **stake,
                })

    # Over/Under 2.5
    ou = probs.get("over_under", {}).get("2.5", {})
    for direction, prob in [("Over 2.5 Goals", ou.get("over", 0)), ("Under 2.5 Goals", ou.get("under", 0))]:
        odds_key = "implied_over25" if "Over" in direction else "implied_under25"
        implied = odds_benchmark.get(odds_key)
        if implied and implied > 0:
            odds = 1 / implied
            stake = kelly_stake(prob, odds, bankroll)
            if stake["recommendation"] == "bet":
                value_bets.append({"market": direction, **stake})

    # BTTS
    btts_prob = probs.get("btts", 0)
    if btts_prob > 0:
        # Approximate BTTS odds from implied probability
        pass  # Would need BTTS odds from data source

    return sorted(value_bets, key=lambda x: x.get("edge", 0), reverse=True)


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
