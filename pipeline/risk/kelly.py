"""
Kelly Criterion + Risk Management.
Calculates optimal bet sizing, risk of ruin, and drawdown monitoring.

Phase 2 upgrade:
- Extended to scan corners O/U, cards O/U, BTTS, player booked markets
- Market-specific edge thresholds (1X2: 5%, corners: 7%, cards: 8%, player: 10%)
- Confidence tiers (high/medium/low) based on edge magnitude + model agreement

Phase 3 upgrade:
- Overround devig: removes bookmaker margin before edge calculation
- Portfolio-level risk limits: per-match, per-team, per-market-type exposure caps
- Goalscorer market scanning
"""
import logging
import re
from collections import defaultdict
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

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
    "goalscorer": RISK.get("min_edge_goalscorer", 0.08),
}

# Portfolio exposure limits
#
# ## Measured on the 4.1.0 artifact, which is why two of these are new
#
# The published card held 14 selections at the per-bet cap of 2.5% (half Kelly of
# a 5% full-Kelly cap), for **35% of bankroll live at once**. Replaying it through
# the per-match, per-team and per-market-type limits below reduced nothing: the
# worst match held 7.5% against a 15% cap. The limits were not too loose — the
# aggregate they were supposed to bound simply did not exist.
#
# Two things were missing, and both are about correlation:
#
# * **No total.** Nothing capped simultaneous exposure, so 14 selections gave 35%
#   and 30 would have given 75%. Per-bet caps do not compose into a portfolio cap.
# * **Correlated positions summed as if independent.** 12.5% of bank sat on UNDER
#   across five matches. That is one bet on a low-scoring weekend, not five
#   independent ones — a high-scoring Saturday loses all of it together. Summing
#   per-bet Kelly fractions across correlated bets over-bets, and the overbet
#   grows with the number of legs.
#
# Kelly's additivity holds for INDEPENDENT bets. Nothing on one weekend's card in
# one league is independent.
PORTFOLIO_LIMITS = {
    "max_per_match_pct": RISK.get("max_per_match_pct", 0.15),      # 15% bankroll max on any single match
    "max_per_team_pct": RISK.get("max_per_team_pct", 0.30),        # 30% on any single team (all markets)
    "max_per_market_type_pct": RISK.get("max_per_market_type_pct", 0.40),  # 40% on any market type
    "max_correlated_bets": RISK.get("max_correlated_bets", 5),     # Max home-win bets in same gameweek

    # Total simultaneous exposure. THE missing cap: without it the others cannot
    # bound the portfolio, only its slices.
    #
    # 20% is a judgement, not a derivation, and it is deliberately conservative
    # because no gameweek has been sealed yet — `forecast_ledger.json` is the only
    # thing that could show these edges are real, and it has nothing in it. Raise
    # it in `RISK` once the ledger has a record, not before.
    "max_total_exposure_pct": RISK.get("max_total_exposure_pct", 0.20),

    # One direction of one market type, across the whole card: all the UNDERs, all
    # the OVERs, all the home wins. These share a factor, so they are closer to
    # one position than to N.
    "max_per_direction_pct": RISK.get("max_per_direction_pct", 0.10),
}

#: Thresholds for the 1X2 hold guards. Read with `RISK[...]`, not `.get` with a
#: default: a missing key should fail at import rather than quietly fall back to
#: a number nobody chose.
ONE_X_TWO_GUARDS = {
    "min_matches_in_window": RISK["min_matches_in_window_1x2"],
    "max_market_gap": RISK["max_market_gap_1x2"],
}

#: Totals lines on the same match, in the same direction, are NESTED rather than
#: merely correlated: `Under 2.5` winning implies `Under 3.5` winning. Betting
#: both is one directional view at the combined stake, so they are charged
#: against the single-bet cap together rather than each getting their own.
#:
#: Measured case: Man City v Bournemouth carried `Under 3.5` and `Under 2.5` at
#: 2.5% each. Presented as two bets diversifying each other; in fact 5% on "few
#: goals at the Etihad", which is the whole per-bet cap in one view.
_TOTALS_DIRECTIONS = ("over", "under")


def bet_direction(bet: Dict) -> Optional[str]:
    """
    The direction a selection leans, or None when it has no meaningful one.

    Used to group correlated positions. Returns a string like `over_under:under`
    or `1x2:home` — market type included, because an UNDER and a home win are not
    the same factor even though both are "one direction".
    """
    market = str(bet.get("market", "")).lower()
    market_type = str(bet.get("market_type", "") or "")

    for direction in _TOTALS_DIRECTIONS:
        if market.startswith(direction):
            return f"{market_type}:{direction}"

    if market_type == "1x2":
        for side in ("home", "draw", "away"):
            if market.startswith(side):
                return f"1x2:{side}"
    return None


def _totals_line(bet: Dict) -> Optional[float]:
    """The goal line of a totals selection, e.g. 2.5 — or None if not a total."""
    match = re.search(r"(\d+(?:\.\d+)?)", str(bet.get("market", "")))
    return float(match.group(1)) if match else None


def nesting_key(bet: Dict) -> Optional[str]:
    """
    Identifies selections on one match that imply one another.

    Only same-match, same-direction totals qualify today. `Under 2.5` and
    `Under 3.5` on the same fixture are not two views; they are one view at two
    prices, and the lower line's win implies the higher line's.
    """
    direction = bet_direction(bet)
    if direction is None or not direction.startswith("over_under:"):
        return None
    if _totals_line(bet) is None:
        return None
    return f"{bet.get('match', '')}|{direction}"


#: One view, two markets. On a single fixture a draw, an underdog win and an
#: UNDER all win together when the favourite underdelivers — a goalless or 1-0
#: afternoon pays every one of them, and the favourite scoring twice loses every
#: one of them. Measured case (2026-10-24 card): Hull v Brentford carried `Home
#: Win` (the market's underdog) AND `Under 2.5` at 2.5% each — 5% on "Brentford
#: do not turn up", the whole per-bet cap twice over on one view.
#:
#: Charged against ONE per-bet cap, by the same mechanism as `nesting_key`.
_UNDERDELIVERS = "favourite_underdelivers"


def correlation_key(bet: Dict) -> Optional[str]:
    """
    Groups same-fixture 1X2 and goals-totals selections that share one direction.

    In the group: every goals UNDER, every Draw, and a win for the side that is
    NOT the market favourite. A 1X2 win whose favourite is unknown is grouped
    too — when the side cannot be placed, the shared cap is the safe reading.
    Corners and cards totals are a different factor and are not grouped.

    The favourite comes from the de-vigged price (`market_favourite`, set by
    `find_value_bets`). Using the price here is allowed under the value-bet
    firewall because it can only ever group, i.e. only reduce a stake; it does
    not touch the edge or the lambda.
    """
    direction = bet_direction(bet)
    if direction is None:
        return None
    key = f"{bet.get('match', '')}|{_UNDERDELIVERS}"
    if direction == "over_under:under" or direction == "1x2:draw":
        return key
    if direction in ("1x2:home", "1x2:away"):
        favourite = bet.get("market_favourite")
        if favourite not in ("home", "away") or direction != f"1x2:{favourite}":
            return key
    return None


def devig_implied_prob(odds_dict: Dict[str, float]) -> Dict[str, float]:
    """
    Remove bookmaker margin (overround) to get true implied probabilities.

    Bookmakers set odds so that the implied probabilities sum to >1.0 (the overround,
    typically 1.03-1.06 for 1X2). This inflates every implied probability, so an
    edge measured as ``model_prob - 1/odds`` is measured against a number that is
    too big and is therefore **understated**.

    De-vigging divides each implied probability by the total, which lowers every
    one of them — so it makes edges LARGER and stakes BIGGER. That direction is
    worth stating plainly on a function that sizes real money, and this docstring
    previously asserted the opposite ("making model edges appear larger than they
    are"), which reads as a safety argument for a change that is not one.

    Method: multiplicative devig (each implied prob divided by the total).
    This is the standard approach for balanced markets.

    **A single outcome cannot be de-vigged.** With one entry the total IS that
    entry, so the result is 1.0 — a certainty. Returning that would make
    ``edge = p - 1.0`` hugely negative and silently drop the bet, so a one-sided
    market is returned untouched instead; see the guard below.

    Args:
        odds_dict: {outcome: decimal_odds} e.g. {"home": 2.10, "draw": 3.40, "away": 3.80}

    Returns:
        {outcome: devigged_probability} summing to 1.0

    Example:
        >>> devig_implied_prob({"home": 2.10, "draw": 3.40, "away": 3.80})
        # Raw implied: {0.476, 0.294, 0.263} → sum = 1.033 (3.3% overround)
        # Devigged:    {0.461, 0.285, 0.255} → sum = 1.000
    """
    if not odds_dict:
        return {}

    # Filter out invalid odds
    valid = {k: v for k, v in odds_dict.items() if v and v > 1.0}
    if not valid:
        return {}

    # Raw implied probabilities
    raw_implied = {k: 1.0 / v for k, v in valid.items()}
    total = sum(raw_implied.values())

    if total <= 0:
        return raw_implied

    if len(valid) < 2:
        # One side of the market only — the book returned no opposing price, which
        # happens on thin totals lines. There is no overround to remove from a
        # single number, and dividing it by itself yields 1.0: a certainty, which
        # would make every such bet score `edge = p - 1.0` and be skipped without
        # explanation. Returning the raw implied probability keeps the bet
        # assessable on a conservative (understated) edge, which is the safe
        # direction on the staking path.
        logger.debug(
            "one-sided market %s; no overround to remove, using raw implied",
            sorted(valid),
        )
        return raw_implied

    overround = total - 1.0
    if overround > 0:
        logger.debug(f"Overround: {overround:.3f} ({overround*100:.1f}%)")

    # Multiplicative devig: divide each by total overround
    return {k: v / total for k, v in raw_implied.items()}


def devig_edge(model_prob: float, decimal_odds: float, market_odds: Dict[str, float],
               outcome_key: str) -> float:
    """
    Compute edge using devigged implied probability instead of raw 1/odds.

    Args:
        model_prob: Model's probability for this outcome
        decimal_odds: Best available decimal odds for this outcome
        market_odds: Full market odds dict for devig context (e.g. all 3 1X2 outcomes)
        outcome_key: Which outcome in market_odds corresponds to this bet

    Returns:
        Devigged edge (model_prob - devigged_implied_prob)
    """
    devigged = devig_implied_prob(market_odds)
    devigged_prob = devigged.get(outcome_key, 1.0 / decimal_odds if decimal_odds > 1 else 1.0)
    return model_prob - devigged_prob


def check_portfolio_exposure(
    current_bets: List[Dict],
    new_bet: Dict,
    bankroll: float,
    correlated_cap: bool = True,
) -> Dict:
    """
    Check if a new bet would violate portfolio-level risk limits.

    Limits checked:
    1. Per-match: max 15% bankroll across all markets on one match
    2. Per-team: max 30% on any team (home win + corners + cards combined)
    3. Per-market-type: max 40% on any market type (e.g. all corners bets)
    4. Correlation: max 5 home-win bets in same gameweek (correlated outcomes)

    Args:
        current_bets: List of existing bet dicts with keys:
            match, market_type, team(s), stake, side (home/away)
        new_bet: Proposed bet dict with same keys + recommended_stake
        bankroll: Current bankroll

    Returns:
        Dict with: approved (bool), adjusted_stake, reason, exposures
    """
    if bankroll <= 0:
        return {"approved": False, "adjusted_stake": 0, "reason": "zero_bankroll"}

    new_stake = new_bet.get("half_kelly", new_bet.get("recommended_stake", 0))
    new_match = new_bet.get("match", "")
    new_market_type = new_bet.get("market_type", "")
    new_teams = _extract_teams(new_bet)

    # Compute current exposures
    match_exposure = defaultdict(float)
    team_exposure = defaultdict(float)
    market_type_exposure = defaultdict(float)
    home_win_count = 0

    for bet in current_bets:
        stake = bet.get("stake", 0)
        match_exposure[bet.get("match", "")] += stake
        market_type_exposure[bet.get("market_type", "")] += stake
        for team in _extract_teams(bet):
            team_exposure[team] += stake
        if bet.get("market_type") == "1x2" and bet.get("market", "").lower().startswith("home"):
            home_win_count += 1

    # Check limits with new bet added
    violations = []
    adjusted_stake = new_stake

    # 1. Per-match limit
    max_match = PORTFOLIO_LIMITS["max_per_match_pct"] * bankroll
    current_match = match_exposure.get(new_match, 0)
    if current_match + new_stake > max_match:
        allowed = max(0, max_match - current_match)
        adjusted_stake = min(adjusted_stake, allowed)
        violations.append(f"match_exposure ({current_match + new_stake:.0f} > {max_match:.0f})")

    # 2. Per-team limit
    max_team = PORTFOLIO_LIMITS["max_per_team_pct"] * bankroll
    for team in new_teams:
        current_team = team_exposure.get(team, 0)
        if current_team + new_stake > max_team:
            allowed = max(0, max_team - current_team)
            adjusted_stake = min(adjusted_stake, allowed)
            violations.append(f"team_exposure_{team} ({current_team + new_stake:.0f} > {max_team:.0f})")

    # 3. Per-market-type limit
    max_market = PORTFOLIO_LIMITS["max_per_market_type_pct"] * bankroll
    current_market = market_type_exposure.get(new_market_type, 0)
    if current_market + new_stake > max_market:
        allowed = max(0, max_market - current_market)
        adjusted_stake = min(adjusted_stake, allowed)
        violations.append(f"market_type_{new_market_type} ({current_market + new_stake:.0f} > {max_market:.0f})")

    # 3a. Total simultaneous exposure — the cap whose absence made the rest moot.
    max_total = PORTFOLIO_LIMITS["max_total_exposure_pct"] * bankroll
    current_total = sum(bet.get("stake", 0) for bet in current_bets)
    if current_total + new_stake > max_total:
        allowed = max(0, max_total - current_total)
        adjusted_stake = min(adjusted_stake, allowed)
        violations.append(
            f"total_exposure ({current_total + new_stake:.0f} > {max_total:.0f})"
        )

    # 3b. One direction of one market type across the card. All the UNDERs share a
    # factor; a high-scoring weekend loses them together, so they are charged
    # against one budget rather than each carrying its own.
    new_direction = bet_direction(new_bet)
    if new_direction is not None:
        max_direction = PORTFOLIO_LIMITS["max_per_direction_pct"] * bankroll
        current_direction = sum(
            bet.get("stake", 0) for bet in current_bets
            if bet_direction(bet) == new_direction
        )
        if current_direction + new_stake > max_direction:
            allowed = max(0, max_direction - current_direction)
            adjusted_stake = min(adjusted_stake, allowed)
            violations.append(
                f"direction_{new_direction} "
                f"({current_direction + new_stake:.0f} > {max_direction:.0f})"
            )

    # 3c. Nested selections on one match are ONE position, so they share the
    # single-bet cap instead of each getting the whole of it. `Under 2.5` winning
    # implies `Under 3.5` winning; two of them at the cap is double the intended
    # size on a single view.
    new_nest = nesting_key(new_bet)
    if new_nest is not None:
        max_single = RISK["max_stake_pct"] * bankroll / 2  # half-Kelly basis
        current_nest = sum(
            bet.get("stake", 0) for bet in current_bets
            if nesting_key(bet) == new_nest
        )
        if current_nest + new_stake > max_single:
            allowed = max(0, max_single - current_nest)
            adjusted_stake = min(adjusted_stake, allowed)
            violations.append(
                f"nested_{new_nest} "
                f"({current_nest + new_stake:.0f} > {max_single:.0f})"
            )

    # 3d. Same-fixture 1X2 + totals in the "favourite underdelivers" direction
    # are one view, so they share the single-bet cap exactly as 3c does.
    # `correlated_cap=False` exists only so `apply_portfolio_limits` can compute
    # the unguarded baseline it clamps every stake to; it is never the default.
    new_corr = correlation_key(new_bet) if correlated_cap else None
    if new_corr is not None:
        max_single = RISK["max_stake_pct"] * bankroll / 2  # half-Kelly basis
        current_corr = sum(
            bet.get("stake", 0) for bet in current_bets
            if correlation_key(bet) == new_corr
        )
        if current_corr + new_stake > max_single:
            allowed = max(0, max_single - current_corr)
            adjusted_stake = min(adjusted_stake, allowed)
            violations.append(
                f"correlated_{new_corr} "
                f"({current_corr + new_stake:.0f} > {max_single:.0f})"
            )

    # 4. Correlation check (home win concentration)
    if new_market_type == "1x2" and new_bet.get("market", "").lower().startswith("home"):
        if home_win_count >= PORTFOLIO_LIMITS["max_correlated_bets"]:
            violations.append(f"correlated_home_wins ({home_win_count + 1} > {PORTFOLIO_LIMITS['max_correlated_bets']})")
            # Don't reject, but flag — user can decide
            logger.warning(f"Concentration risk: {home_win_count + 1} home-win bets in gameweek")

    approved = adjusted_stake > 0
    reason = "approved" if not violations else "; ".join(violations)

    return {
        "approved": approved,
        "original_stake": float(new_stake),
        "adjusted_stake": float(adjusted_stake),
        "reason": reason,
        "violations": violations,
        "exposures": {
            "match": float(match_exposure.get(new_match, 0)),
            "teams": {t: float(team_exposure.get(t, 0)) for t in new_teams},
            "market_type": float(market_type_exposure.get(new_market_type, 0)),
            "home_win_count": home_win_count,
        },
    }


def _extract_teams(bet: Dict) -> List[str]:
    """Extract team names from a bet dict."""
    teams = []
    match = bet.get("match", "")
    if " vs " in match:
        parts = match.split(" vs ", 1)
        teams = [p.strip() for p in parts]
    if bet.get("team"):
        teams.append(bet["team"])
    return teams


def kelly_stake(
    model_prob: float,
    decimal_odds: float,
    bankroll: float = 1000.0,
    max_stake_pct: float = RISK["max_stake_pct"],
    min_edge: float = RISK["min_edge"],
    market_odds: Optional[Dict[str, float]] = None,
    outcome_key: Optional[str] = None,
) -> Dict:
    """
    Calculate Kelly Criterion stake.

    f* = (b*p - q) / b
    where p = model probability, q = 1-p, b = decimal odds - 1

    If market_odds is provided, edge is computed against devigged implied
    probability (removing bookmaker overround). Otherwise falls back to
    raw 1/odds.

    Returns:
        Dict with full_kelly, half_kelly, recommended_stake, edge, etc.
    """
    if decimal_odds <= 1:
        return {"full_kelly": 0, "half_kelly": 0, "edge": 0, "recommendation": "skip"}

    b = decimal_odds - 1
    p = model_prob
    q = 1 - p
    raw_implied_prob = 1 / decimal_odds

    # Use devigged probability if market context provided
    if market_odds and outcome_key:
        devigged = devig_implied_prob(market_odds)
        implied_prob = devigged.get(outcome_key, raw_implied_prob)
    else:
        implied_prob = raw_implied_prob

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
        "raw_implied_prob": float(raw_implied_prob),
        "expected_value": float(p * b - q),
        "recommendation": "bet",
        "decimal_odds": float(decimal_odds),
    }


def _one_x_two_market_context(
    model_1x2: Dict, h2h_odds: Dict[str, float],
) -> Tuple[Optional[float], Optional[str]]:
    """
    Fixture-level max |model - de-vigged market| over home/draw/away, and which
    side the market favours. Either is None when it cannot be measured — fewer
    than three priced outcomes, or a model probability missing — and the guards
    read None as "hold", never as "pass".

    Fixture-level rather than per-selection: a model that has a club's strength
    wrong has every outcome of that fixture wrong, so a Draw at a modest edge on
    a fixture whose away price is 20pp adrift inherits the same error.
    """
    devigged = devig_implied_prob(h2h_odds)
    outcomes = ("home", "draw", "away")
    if not all(k in devigged for k in outcomes):
        return None, None
    try:
        gap = max(abs(float(model_1x2[k]) - devigged[k]) for k in outcomes)
    except (KeyError, TypeError, ValueError):
        gap = None
    if gap is not None and not np.isfinite(gap):
        gap = None
    if devigged["home"] > devigged["away"]:
        favourite = "home"
    elif devigged["away"] > devigged["home"]:
        favourite = "away"
    else:
        favourite = None
    return (float(gap) if gap is not None else None), favourite


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

    # Build full 1X2 odds dict for devig context
    h2h_odds_for_devig = {}
    for label, _, ok1, ok2 in markets_1x2:
        o = odds_benchmark.get(ok1) or odds_benchmark.get(ok2)
        if o and o > 1:
            key = "home" if "Home" in label else ("draw" if "Draw" in label else "away")
            h2h_odds_for_devig[key] = o

    # Two READ-ONLY annotations for the guards in `apply_portfolio_limits`.
    # Computed after, and separately from, the edge: nothing below feeds
    # `kelly_stake`, so the price can veto or group a selection but can never
    # move its edge, its model probability or the lambda behind it.
    market_gap_1x2, market_favourite = _one_x_two_market_context(
        probs.get("1x2", {}), h2h_odds_for_devig,
    )

    for market_name, model_prob, odds_key_1, odds_key_2 in markets_1x2:
        odds = odds_benchmark.get(odds_key_1) or odds_benchmark.get(odds_key_2)
        if odds and odds > 1 and model_prob > 0:
            outcome_key = "home" if "Home" in market_name else ("draw" if "Draw" in market_name else "away")
            stake = kelly_stake(
                model_prob, odds, bankroll, min_edge=min_edge_1x2,
                market_odds=h2h_odds_for_devig, outcome_key=outcome_key,
            )
            if stake["recommendation"] == "bet":
                value_bets.append({
                    "market": market_name,
                    "market_type": "1x2",
                    "confidence": _confidence_tier(stake["edge"], "1x2"),
                    "confidence_tier": _confidence_tier(stake["edge"], "1x2"),
                    "bookmaker": odds_benchmark.get(f"bookmaker_{outcome_key}"),
                    **stake,
                    # Fraction (probability points), not a stake.
                    "market_gap_1x2": market_gap_1x2,
                    "market_favourite": market_favourite,
                })

    # ── Over/Under Goals ─────────────────────────────────────────────────
    totals_odds = odds_benchmark.get("totals", {})
    for line in ["2.5", "3.5"]:
        ou = probs.get("over_under", {}).get(line, {})
        line_odds = totals_odds.get(line, {})
        devig_context = {
            direction: line_odds.get(direction)
            for direction in ("over", "under")
            if line_odds.get(direction)
        }
        for direction_label, direction_key in [("Over", "over"), ("Under", "under")]:
            prob = ou.get(direction_key, 0)
            if prob <= 0:
                continue
            decimal_odds = line_odds.get(direction_key)
            if decimal_odds and decimal_odds > 1:
                stake = kelly_stake(
                    prob,
                    decimal_odds,
                    bankroll,
                    min_edge=min_edge_1x2,
                    market_odds=devig_context,
                    outcome_key=direction_key,
                )
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": f"{direction_label} {line} Goals",
                        "market_type": "over_under",
                        "confidence": _confidence_tier(stake["edge"], "over_under"),
                        "confidence_tier": _confidence_tier(stake["edge"], "over_under"),
                        "bookmaker": line_odds.get(f"bookmaker_{direction_key}"),
                        **stake,
                    })

    # ── BTTS ─────────────────────────────────────────────────────────────
    btts_probs = probs.get("btts", {})
    btts_odds_data = odds_benchmark.get("btts", {})
    if isinstance(btts_probs, dict) and isinstance(btts_odds_data, dict):
        btts_devig_odds = {
            key: value
            for key, value in btts_odds_data.items()
            if key in ("yes", "no")
            and isinstance(value, (int, float))
            and value > 1
        }
        for direction, prob in [("BTTS Yes", btts_probs.get("yes", 0)), ("BTTS No", btts_probs.get("no", 0))]:
            bk_key = "yes" if "Yes" in direction else "no"
            bk_odds = btts_odds_data.get(bk_key)
            if bk_odds and bk_odds > 1 and prob > 0:
                stake = kelly_stake(
                    prob, bk_odds, bankroll, min_edge=min_edge_1x2,
                    market_odds=btts_devig_odds, outcome_key=bk_key,
                )
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": direction,
                        "market_type": "btts",
                        "confidence": _confidence_tier(stake["edge"], "btts"),
                        "confidence_tier": _confidence_tier(stake["edge"], "btts"),
                        "bookmaker": btts_odds_data.get(f"bookmaker_{bk_key}"),
                        **stake,
                    })

    # ── Corners O/U ──────────────────────────────────────────────────────
    min_edge_corners = EDGE_THRESHOLDS["corners"]
    corner_probs = probs.get("corners", {})
    if corners_odds and corner_probs:
        for line_str, line_odds in corners_odds.items():
            line = float(line_str)
            for direction in ["over", "under"]:
                model_prob = (
                    corner_probs.get(str(line), {}).get(direction, 0)
                    if isinstance(corner_probs.get(str(line)), dict)
                    else corner_probs.get(f"{direction}_{line}", 0)
                )
                bk_odds = line_odds.get(direction)
                if model_prob > 0 and bk_odds and bk_odds > 1:
                    market_context = {
                        key: line_odds.get(key)
                        for key in ("over", "under")
                        if line_odds.get(key)
                    }
                    stake = kelly_stake(
                        model_prob,
                        bk_odds,
                        bankroll,
                        min_edge=min_edge_corners,
                        market_odds=market_context,
                        outcome_key=direction,
                    )
                    if stake["recommendation"] == "bet":
                        value_bets.append({
                            "market": f"Corners {direction.title()} {line}",
                            "market_type": "corners",
                            "confidence": _confidence_tier(stake["edge"], "corners"),
                            "confidence_tier": _confidence_tier(stake["edge"], "corners"),
                            "bookmaker": line_odds.get(f"bookmaker_{direction}"),
                            **stake,
                        })

    # ── Cards O/U ────────────────────────────────────────────────────────
    min_edge_cards = EDGE_THRESHOLDS["cards"]
    card_probs = probs.get("cards", {})
    if cards_odds and card_probs:
        for line_str, line_odds in cards_odds.items():
            line = float(line_str)
            for direction in ["over", "under"]:
                model_prob = (
                    card_probs.get(str(line), {}).get(direction, 0)
                    if isinstance(card_probs.get(str(line)), dict)
                    else card_probs.get(f"{direction}_{line}", 0)
                )
                bk_odds = line_odds.get(direction)
                if model_prob > 0 and bk_odds and bk_odds > 1:
                    market_context = {
                        key: line_odds.get(key)
                        for key in ("over", "under")
                        if line_odds.get(key)
                    }
                    stake = kelly_stake(
                        model_prob,
                        bk_odds,
                        bankroll,
                        min_edge=min_edge_cards,
                        market_odds=market_context,
                        outcome_key=direction,
                    )
                    if stake["recommendation"] == "bet":
                        value_bets.append({
                            "market": f"Cards {direction.title()} {line}",
                            "market_type": "cards",
                            "confidence": _confidence_tier(stake["edge"], "cards"),
                            "confidence_tier": _confidence_tier(stake["edge"], "cards"),
                            "bookmaker": line_odds.get(f"bookmaker_{direction}"),
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
                        "confidence_tier": _confidence_tier(stake["edge"], "player_booked"),
                        **stake,
                    })

    # ── Goalscorer (Anytime) ────────────────────────────────────────────
    min_edge_gs = EDGE_THRESHOLDS["goalscorer"]
    goalscorer_probs = predictions.get("goalscorer_probabilities", {})
    goalscorer_odds = odds_benchmark.get("goalscorer", {})
    if goalscorer_probs and goalscorer_odds:
        for player_name, model_prob in goalscorer_probs.items():
            bk_odds = goalscorer_odds.get(player_name)
            if bk_odds and bk_odds > 1 and model_prob > 0:
                stake = kelly_stake(model_prob, bk_odds, bankroll, min_edge=min_edge_gs)
                if stake["recommendation"] == "bet":
                    value_bets.append({
                        "market": f"{player_name} Anytime Goalscorer",
                        "market_type": "goalscorer",
                        "confidence": _confidence_tier(stake["edge"], "goalscorer"),
                        "confidence_tier": _confidence_tier(stake["edge"], "goalscorer"),
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


def matches_in_window(frame, teams: Iterable[str]) -> Dict[str, int]:
    """
    How many matches each club has in the frame the models were trained on.

    Counted from the same `HomeTeam`/`AwayTeam` columns Dixon-Coles indexes, so a
    club absent from the frame is a club the posterior has never seen and counts
    0 — which is the answer, not a gap. A frame that cannot be read returns {},
    and `one_x_two_hold_reasons` reads a missing team as "unknown → hold".

    A spelling mismatch between the fixture list and the training frame also
    lands on 0, and so on a hold. That is the safe side to fail on.
    """
    teams = [t for t in teams if t]
    if frame is None or not hasattr(frame, "columns"):
        return {}
    if "HomeTeam" not in frame.columns or "AwayTeam" not in frame.columns:
        return {}
    home = frame["HomeTeam"].value_counts()
    away = frame["AwayTeam"].value_counts()
    return {
        team: int(home.get(team, 0)) + int(away.get(team, 0))
        for team in teams
    }


def one_x_two_hold_reasons(
    bet: Dict,
    home_team: Optional[str],
    away_team: Optional[str],
    team_match_counts: Optional[Mapping[str, int]],
) -> List[str]:
    """
    Why a 1X2 selection must not be staked, or [] when nothing holds it.

    Two guards, both one-way:

    * **New to the training window.** Either club with fewer than
      `RISK["min_matches_in_window_1x2"]` matches in the training frame. The
      posterior for such a club is the league prior plus a handful of games, so
      a 1X2 "edge" on its fixture is mostly a measurement of that prior.
    * **Model adrift from the market.** Fixture-level max |model - de-vigged
      price| above `RISK["max_market_gap_1x2"]`. The price VETOES here and does
      nothing else — it never enters the edge, the model probability or lambda.

    Unknown is a hold, never a pass: no count supplied, a club missing from the
    counts, a non-numeric count, or no measurable gap all hold the selection.
    Non-1X2 markets are not guarded here.
    """
    if str(bet.get("market_type") or "") != "1x2":
        return []

    reasons: List[str] = []
    min_n = ONE_X_TWO_GUARDS["min_matches_in_window"]
    for team in (home_team, away_team):
        count = None
        if team_match_counts is not None and team:
            count = team_match_counts.get(team)
        try:
            count = None if count is None or isinstance(count, bool) else float(count)
        except (TypeError, ValueError):
            count = None
        if count is None or not np.isfinite(count):
            reasons.append(f"matches_in_window_unknown:{team}")
        elif count < min_n:
            reasons.append(f"new_to_training_window:{team} ({int(count)} < {min_n})")

    max_gap = ONE_X_TWO_GUARDS["max_market_gap"]
    gap = bet.get("market_gap_1x2")
    try:
        gap = None if gap is None or isinstance(gap, bool) else float(gap)
    except (TypeError, ValueError):
        gap = None
    if gap is None or not np.isfinite(gap):
        reasons.append("market_gap_unknown")
    elif gap > max_gap:
        reasons.append(f"model_market_gap_1x2 ({gap:.3f} > {max_gap:.2f})")
    return reasons


#: The four stake fields `latest.json` carries per bet: two CURRENCY
#: (`full_kelly`, `half_kelly`) and two FRACTION (`*_pct`). See
#: frontend/lib/data/units.ts. A held selection publishes all four at 0.0.
_STAKE_FIELDS = ("full_kelly", "half_kelly", "full_kelly_pct", "half_kelly_pct")


def _portfolio_pass(
    scored: List[Dict], bankroll: float, skip: set, correlated_cap: bool,
) -> Dict[int, Tuple[float, List[str]]]:
    """One greedy pass over the card in `scored` order. Returns id(bet) -> (allowed, violations)."""
    accepted: List[Dict] = []
    out: Dict[int, Tuple[float, List[str]]] = {}
    for row in scored:
        bet, context = row["bet"], row["context"]
        if id(bet) in skip:
            continue
        verdict = check_portfolio_exposure(
            accepted, context, bankroll, correlated_cap=correlated_cap,
        )
        allowed = float(verdict.get("adjusted_stake") or 0.0)
        out[id(bet)] = (
            allowed, list(verdict.get("violations") or [verdict.get("reason")]),
        )
        if allowed > 0:
            accepted.append({**context, "stake": allowed})
    return out


def apply_portfolio_limits(
    all_predictions: List[Dict],
    bankroll: float = 1000.0,
    team_match_counts: Optional[Mapping[str, int]] = None,
) -> Dict:
    """
    Enforce the portfolio caps across every match, in place.

    ## Why this function has to exist

    `find_value_bets` is called once per match, so it can only ever see one
    fixture. Every cap that matters is a cap across the card — total exposure, one
    direction of one market, one team appearing in two fixtures — and none of them
    is expressible from inside a single match.

    `check_portfolio_exposure` was written to enforce exactly this and had **no
    callers**. It was complete, correct, untested and unreachable, so the published
    card was bounded only by the per-selection `max_stake_pct`: 14 selections at
    2.5% each for 35% of bankroll live at once, with nothing to stop 30.

    ## Order

    Highest edge first, so when a cap binds the stake is taken from the weakest
    selection rather than from whichever happened to be scanned last. Ties break on
    the match and market strings, so two runs over the same card produce the same
    portfolio — a staking recommendation that reshuffles on re-run is not one that
    can be checked.

    ## The 1X2 hold guards, and why no stake can grow

    `one_x_two_hold_reasons` holds a 1X2 selection on a fixture with a club new
    to the training window, or where the model is adrift from the market. A held
    selection is not dropped: it moves to `prediction["held_bets"]` with all four
    stake fields at 0.0 and its `hold_reasons`, so the card says what it refused.
    `team_match_counts` comes from `matches_in_window`; omitting it holds every
    1X2 selection, because "unknown" must not read as "established".

    Holding one selection frees room under the total and direction caps, and a
    greedy pass would hand that room to the next selection down — a guard that
    INCREASES a stake. So the card is run twice: once exactly as before the
    guards existed (the baseline), once with holds removed and the correlated
    same-fixture cap on. Every kept selection gets the MIN of the two. That is
    within every guarded cap (stakes only fell) and never above the baseline.

    ## What it reports

    Returns a summary, and **logs every reduction and every hold**. A cap that
    quietly deletes six selections looks identical to a model that found eight —
    the reason the news view now names its own truncation, and the same principle
    applies here with money attached.
    """
    scored: List[Dict] = []
    for prediction in all_predictions:
        fixture = prediction.get("fixture") or {}
        match = f"{fixture.get('home_team')} v {fixture.get('away_team')}"
        for bet in prediction.get("value_bets") or []:
            scored.append({
                "bet": bet,
                "prediction": prediction,
                "context": {
                    **bet,
                    "match": match,
                    "home_team": fixture.get("home_team"),
                    "away_team": fixture.get("away_team"),
                },
            })

    scored.sort(key=lambda row: (
        -float(row["bet"].get("edge") or 0.0),
        row["context"]["match"],
        str(row["bet"].get("market") or ""),
    ))

    # A zero or negative bankroll approves nothing, and must not divide. Reported
    # as a percentage of bank everywhere below, so the guard has to come before
    # the first ratio rather than inside `check_portfolio_exposure` alone.
    def as_pct(amount: float) -> float:
        return amount / bankroll if bankroll > 0 else 0.0

    held_reasons: Dict[int, List[str]] = {}
    for row in scored:
        reasons = one_x_two_hold_reasons(
            row["bet"], row["context"]["home_team"], row["context"]["away_team"],
            team_match_counts,
        )
        if reasons:
            held_reasons[id(row["bet"])] = reasons

    baseline = _portfolio_pass(scored, bankroll, skip=set(), correlated_cap=False)
    guarded = _portfolio_pass(
        scored, bankroll, skip=set(held_reasons), correlated_cap=True,
    )

    accepted: List[Dict] = []
    kept_ids, held_ids, reductions, held = set(), set(), [], []

    for row in scored:
        bet, context = row["bet"], row["context"]
        proposed = float(bet.get("half_kelly") or 0.0)

        if id(bet) in held_reasons:
            reasons = held_reasons[id(bet)]
            held.append({
                "match": context["match"], "market": bet.get("market"),
                "edge": float(bet.get("edge") or 0.0),
                "was_pct": as_pct(proposed), "reasons": list(reasons),
            })
            for field in _STAKE_FIELDS:
                bet[field] = 0.0
            bet["recommendation"] = "hold_for_review"
            bet["hold_reasons"] = list(reasons)
            held_ids.add(id(bet))
            continue

        base_allowed, base_violations = baseline[id(bet)]
        guard_allowed, guard_violations = guarded[id(bet)]
        if guard_allowed <= base_allowed:
            allowed, violations = guard_allowed, guard_violations
        else:
            allowed = base_allowed
            violations = base_violations + ["room freed by held selections is not redeployed"]

        if allowed <= 0:
            reductions.append({
                "match": context["match"], "market": bet.get("market"),
                "was_pct": as_pct(proposed), "now_pct": 0.0,
                "reason": violations[:1],
            })
            continue

        if allowed < proposed - 1e-9:
            # Scale the whole bet down together. Rewriting `half_kelly` while
            # leaving `half_kelly_pct` alone would leave the artifact internally
            # inconsistent, and the frontend reads the _pct fields.
            factor = allowed / proposed if proposed > 0 else 0.0
            reductions.append({
                "match": context["match"], "market": bet.get("market"),
                "was_pct": as_pct(proposed), "now_pct": as_pct(allowed),
                "reason": violations[:1],
            })
            bet["half_kelly"] = allowed
            bet["full_kelly"] = float(bet.get("full_kelly") or 0.0) * factor
            bet["half_kelly_pct"] = as_pct(allowed)
            bet["full_kelly_pct"] = float(bet.get("full_kelly_pct") or 0.0) * factor

        accepted.append({**context, "stake": allowed})
        kept_ids.add(id(bet))

    # Drop what the caps refused, so nothing is published at a stake of zero in
    # `value_bets`. What the GUARDS refused is published, at zero, in its own
    # list — a hold is a decision someone should be able to read and review.
    for prediction in all_predictions:
        existing = prediction.get("value_bets") or []
        prediction["value_bets"] = [b for b in existing if id(b) in kept_ids]
        prediction["held_bets"] = [b for b in existing if id(b) in held_ids]

    total = sum(row["stake"] for row in accepted)
    summary = {
        "bankroll": float(bankroll),
        "n_bets_before": len(scored),
        "n_bets_after": len(accepted),
        "n_held": len(held),
        "total_exposure_pct": as_pct(total),
        "limits": dict(PORTFOLIO_LIMITS),
        "guards": dict(ONE_X_TWO_GUARDS),
        "max_stake_pct": RISK["max_stake_pct"],
        "reductions": reductions,
        "held": held,
    }

    for entry in held:
        logger.warning(
            "  HELD %s %s (edge %.3f, would have been %.2f%% before caps): %s",
            entry["match"], entry["market"], entry["edge"],
            entry["was_pct"] * 100, "; ".join(entry["reasons"]),
        )

    if reductions or held:
        # What the card would have staked before any cap or hold bound: every
        # selection that survived, plus the full original size of everything
        # reduced or held.
        before = as_pct(total) + sum(
            r["was_pct"] - r["now_pct"] for r in reductions
        ) + sum(h["was_pct"] for h in held)
        logger.warning(
            "portfolio limits reduced %d and held %d of %d selections; "
            "exposure %.1f%% -> %.1f%% of bank",
            len(reductions), len(held), len(scored), before * 100, as_pct(total) * 100,
        )
        for reduction in reductions:
            logger.info(
                "  %s %s: %.2f%% -> %.2f%% (%s)",
                reduction["match"], reduction["market"],
                reduction["was_pct"] * 100, reduction["now_pct"] * 100,
                reduction["reason"],
            )
    else:
        logger.info(
            "portfolio limits: nothing reduced; exposure %.1f%% of bank across %d selections",
            as_pct(total) * 100, len(accepted),
        )
    return summary
