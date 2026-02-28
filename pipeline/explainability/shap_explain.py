"""
SHAP explainability for XGBoost predictions.
Generates feature importance waterfall data for each match.
"""
import logging
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def explain_prediction(
    xgb_model,
    match_features: pd.DataFrame,
    feature_cols: List[str],
    top_n: int = 10,
) -> List[Dict]:
    """
    Generate SHAP explanation for a match prediction.

    Args:
        xgb_model: Fitted XGBoost model (home or away)
        match_features: Single-row DataFrame of features
        feature_cols: Feature column names
        top_n: Number of top features to include

    Returns:
        List of {feature, value, shap_value} dicts sorted by |shap_value|
    """
    try:
        import shap
    except ImportError:
        logger.warning("SHAP not installed. Skipping explainability.")
        return []

    X = match_features[feature_cols].fillna(0)

    explainer = shap.TreeExplainer(xgb_model)
    shap_values = explainer.shap_values(X)

    if len(shap_values.shape) == 1:
        sv = shap_values
    else:
        sv = shap_values[0]

    # Build feature importance list
    features = []
    for i, col in enumerate(feature_cols):
        features.append({
            "feature": col,
            "value": float(X.iloc[0][col]) if col in X.columns else 0,
            "shap_value": float(sv[i]),
        })

    # Sort by absolute SHAP value, take top N
    features.sort(key=lambda x: abs(x["shap_value"]), reverse=True)
    return features[:top_n]


def explain_match(
    xgb_home_model,
    xgb_away_model,
    match_features: pd.DataFrame,
    feature_cols: List[str],
    top_n: int = 10,
) -> Dict:
    """
    Generate combined SHAP explanation for both home and away predictions.
    """
    home_shap = explain_prediction(xgb_home_model, match_features, feature_cols, top_n)
    away_shap = explain_prediction(xgb_away_model, match_features, feature_cols, top_n)

    # Merge: average absolute SHAP values across home/away
    combined = {}
    for item in home_shap + away_shap:
        feat = item["feature"]
        if feat not in combined:
            combined[feat] = {"feature": feat, "value": item["value"], "shap_values": []}
        combined[feat]["shap_values"].append(item["shap_value"])

    merged = []
    for feat, data in combined.items():
        merged.append({
            "feature": data["feature"],
            "value": data["value"],
            "shap_value": float(np.mean(data["shap_values"])),
            "shap_abs": float(np.mean([abs(s) for s in data["shap_values"]])),
        })

    merged.sort(key=lambda x: x["shap_abs"], reverse=True)
    return {
        "home_features": home_shap,
        "away_features": away_shap,
        "combined_features": merged[:top_n],
    }


def generate_narrative(
    match_pred: Dict,
    shap_data: Dict,
    home: str,
    away: str,
    gameweek: int,
) -> str:
    """
    Generate a narrative match preview from predictions and SHAP.
    """
    probs = match_pred.get("probabilities", {})
    p_1x2 = probs.get("1x2", {})
    xg = match_pred.get("expected_goals", {})

    p_home = p_1x2.get("home", 0.33)
    p_draw = p_1x2.get("draw", 0.33)
    p_away = p_1x2.get("away", 0.33)

    # Determine favorite
    if p_home > p_away and p_home > p_draw:
        favorite = home
        fav_pct = p_home * 100
        fair_odds = 1 / p_home if p_home > 0 else 0
    elif p_away > p_home and p_away > p_draw:
        favorite = away
        fav_pct = p_away * 100
        fair_odds = 1 / p_away if p_away > 0 else 0
    else:
        favorite = "Neither side"
        fav_pct = p_draw * 100
        fair_odds = 1 / p_draw if p_draw > 0 else 0

    # Top SHAP features
    top_features = shap_data.get("combined_features", [])[:3]
    feature_str = ", ".join([f["feature"].replace("_", " ") for f in top_features]) if top_features else "form and recent results"

    xg_home = xg.get("home", 1.3)
    xg_away = xg.get("away", 1.1)

    # Corners and cards
    corners = match_pred.get("expected_corners", 10)
    cards = match_pred.get("expected_cards", 3)

    ou_25 = probs.get("over_under", {}).get("2.5", {})
    p_over = ou_25.get("over", 0.5)

    btts = probs.get("btts", 0.5)

    # Value bets mention
    value_bets = match_pred.get("value_bets", [])
    value_str = ""
    if value_bets:
        top_bet = value_bets[0]
        value_str = (
            f"\n\nValue alert: {top_bet['market']} at {top_bet.get('decimal_odds', 0):.2f} "
            f"implies {top_bet.get('implied_prob', 0):.1%} but our model gives "
            f"{top_bet.get('model_prob', 0):.1%} (edge: {top_bet.get('edge', 0):.1%}). "
            f"Kelly recommends {top_bet.get('half_kelly_pct', 0):.1%} of bankroll."
        )

    narrative = (
        f"{home} vs {away} — Matchweek {gameweek}\n\n"
        f"Our model rates {favorite} as {fav_pct:.0f}% favorites "
        f"(fair odds: {fair_odds:.2f}), driven primarily by {feature_str}. "
        f"{home}'s expected goals stand at {xg_home:.1f} while {away} "
        f"are projected for {xg_away:.1f} xG.\n\n"
        f"The match has a {p_over:.0%} chance of going over 2.5 goals, "
        f"with both teams to score probability at {btts:.0%}. "
        f"We expect around {corners:.0f} total corners and {cards:.0f} cards."
        f"{value_str}"
    )

    return narrative
