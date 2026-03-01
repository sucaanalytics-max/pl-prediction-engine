"""
Main pipeline orchestrator.
Runs the full data → features → models → simulate → export flow.

Phase 2: Now includes referee profiles, passing stats, Odds API,
correlated corners/cards simulation, and player booking model.

Usage:
    python -m pipeline.run_pipeline
    python -m pipeline.run_pipeline --force-refresh
    python -m pipeline.run_pipeline --skip-pymc --verbose
"""
import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from pipeline.config import (
    PREDICTIONS_DIR, CURRENT_SEASON, SEASONS, N_SIMULATIONS, DERBIES
)

logger = logging.getLogger(__name__)


def _is_derby(home: str, away: str) -> bool:
    """Check if a match is a derby/rivalry."""
    return (home, away) in DERBIES or (away, home) in DERBIES


def run_pipeline(force_refresh: bool = False, skip_pymc: bool = False) -> Dict:
    """
    Execute the full prediction pipeline.

    Steps:
        1. Fetch data (Football-Data, FBref + passing, FPL)
        2. Build referee profiles
        3. Engineer features (with referee, passing, derby)
        4. Fit models (PenaltyBlog, PyMC Dixon-Coles, XGBoost)
        5. Fit sub-models (Corners NegBin, Cards ZIP, Player Cards)
        6. Fetch live odds (The Odds API)
        7. Run Monte Carlo simulation (correlated corners/cards)
        8. Derive all betting markets
        9. Calculate SHAP explanations
        10. Find value bets (Kelly criterion, all markets)
        11. Generate narratives
        12. Export JSON

    Returns:
        Status dict with metrics and output path
    """
    start_time = datetime.utcnow()
    logger.info("=" * 60)
    logger.info("PL PREDICTION ENGINE — PIPELINE START (Phase 2)")
    logger.info(f"Timestamp: {start_time.isoformat()}Z")
    logger.info("=" * 60)

    # ── Step 1: Fetch Data ─────────────────────────────────────────────
    logger.info("\n[1/12] Fetching data...")

    from pipeline.data.football_data import load_all_seasons, extract_odds_benchmark
    matches = load_all_seasons(force=force_refresh)

    from pipeline.data.fpl_api import (
        fetch_bootstrap_static, fetch_fixtures,
        get_upcoming_fixtures, build_player_stats, get_current_gameweek,
    )
    bootstrap = fetch_bootstrap_static(force=force_refresh)
    fixtures_raw = fetch_fixtures(force=force_refresh)
    gameweek = get_current_gameweek(bootstrap)
    upcoming = get_upcoming_fixtures(bootstrap, fixtures_raw)
    player_stats = build_player_stats(bootstrap)

    from pipeline.data.fbref import (
        fetch_fbref_team_stats, fetch_fbref_passing_stats,
        build_advanced_features,
    )
    fbref_stats = fetch_fbref_team_stats(force=force_refresh)
    passing_stats = fetch_fbref_passing_stats(force=force_refresh)
    fbref_features = build_advanced_features(fbref_stats, passing_stats)

    logger.info(
        f"  Matches: {len(matches)}, Upcoming: {len(upcoming)}, "
        f"Players: {len(player_stats)}, FBref teams: {len(fbref_features)}"
    )

    # ── Step 2: Build Referee Profiles ────────────────────────────────
    logger.info("\n[2/12] Building referee profiles...")
    from pipeline.data.referee_profiles import build_referee_profiles
    referee_profiles = build_referee_profiles(matches)
    logger.info(f"  Referee profiles: {len(referee_profiles)} referees")

    # ── Step 3: Engineer Features ────────────────────────────────────
    logger.info("\n[3/12] Engineering features...")
    from pipeline.features.engineer import engineer_features
    features = engineer_features(matches, fbref_features, player_stats, referee_profiles)

    # ── Step 4: Fit PenaltyBlog Baseline ─────────────────────────────
    logger.info("\n[4/12] Fitting PenaltyBlog baseline...")
    pb_predictions = {}
    try:
        from pipeline.models.penaltyblog_baseline import PenaltyblogBaseline
        pb_model = PenaltyblogBaseline()
        pb_model.fit(matches)
        for _, row in upcoming.iterrows():
            key = f"{row['home_team']}_vs_{row['away_team']}"
            pb_predictions[key] = pb_model.predict_match(row["home_team"], row["away_team"])
        logger.info(f"  PenaltyBlog: {len(pb_predictions)} fixtures predicted")
    except Exception as e:
        logger.warning(f"  PenaltyBlog failed: {e}")

    # ── Step 5: Fit PyMC Dixon-Coles ─────────────────────────────────
    dc_model = None
    if not skip_pymc:
        logger.info("\n[5/12] Fitting PyMC Dixon-Coles...")
        try:
            from pipeline.models.dixon_coles import BayesianDixonColes
            dc_model = BayesianDixonColes()
            dc_model.fit(features)
            logger.info("  PyMC Dixon-Coles fitted successfully")
        except Exception as e:
            logger.warning(f"  PyMC Dixon-Coles failed: {e}. Using PenaltyBlog only.")
    else:
        logger.info("\n[5/12] Skipping PyMC Dixon-Coles (--skip-pymc flag)")

    # ── Step 6: Fit XGBoost ──────────────────────────────────────────
    logger.info("\n[6/12] Fitting XGBoost...")
    xgb_model = None
    try:
        from pipeline.models.xgboost_model import XGBoostGoalModel
        xgb_model = XGBoostGoalModel()
        xgb_metrics = xgb_model.fit(features)
        logger.info(f"  XGBoost metrics: {xgb_metrics}")
    except Exception as e:
        logger.warning(f"  XGBoost failed: {e}")

    # ── Step 7: Fit Sub-Models (Corners, Cards, Player Cards) ────────
    logger.info("\n[7/12] Fitting corners, cards, and player booking models...")
    from pipeline.models.corners_negbin import CornersNegBinModel
    from pipeline.models.cards_zip import CardsZIPModel
    from pipeline.models.player_cards import PlayerCardsModel

    corners_model = CornersNegBinModel()
    corners_model.fit(matches)

    cards_model = CardsZIPModel()
    cards_model.fit(matches, referee_profiles=referee_profiles)

    player_cards_model = PlayerCardsModel()
    player_cards_metrics = player_cards_model.fit(player_stats)
    logger.info(f"  Player cards: {player_cards_metrics}")

    # ── Step 8: Fetch Live Odds ──────────────────────────────────────
    logger.info("\n[8/12] Fetching live odds from The Odds API...")
    all_live_odds = {"main": None, "corners": None, "cards": None}
    try:
        from pipeline.data.odds_api import OddsAPIClient, parse_match_odds, parse_alt_totals
        odds_client = OddsAPIClient()
        all_live_odds = odds_client.fetch_all_odds()
        n_main = len(all_live_odds.get("main") or [])
        n_corners = len(all_live_odds.get("corners") or [])
        n_cards = len(all_live_odds.get("cards") or [])
        logger.info(f"  Odds API: main={n_main}, corners={n_corners}, cards={n_cards} events")
    except Exception as e:
        logger.warning(f"  Odds API failed: {e}. Continuing without live odds.")

    # Parse live odds
    parsed_main = {}
    parsed_corners = {}
    parsed_cards = {}
    try:
        from pipeline.data.odds_api import parse_match_odds, parse_alt_totals
        if all_live_odds.get("main"):
            parsed_main = parse_match_odds(all_live_odds["main"])
        if all_live_odds.get("corners"):
            parsed_corners = parse_alt_totals(all_live_odds["corners"], "alternate_totals_corners")
        if all_live_odds.get("cards"):
            parsed_cards = parse_alt_totals(all_live_odds["cards"], "alternate_totals_cards")
    except Exception as e:
        logger.warning(f"  Odds parsing failed: {e}")

    # ── Step 9: Monte Carlo Simulation ───────────────────────────────
    logger.info("\n[9/12] Running Monte Carlo simulation (correlated)...")
    from pipeline.simulation.montecarlo import MonteCarloSimulator

    simulator = MonteCarloSimulator(N_SIMULATIONS)
    all_predictions = []

    # Odds benchmark from Football-Data (fallback)
    odds_bench = extract_odds_benchmark(matches)

    for _, row in upcoming.iterrows():
        home, away = row["home_team"], row["away_team"]
        key = f"{home}_vs_{away}"
        match_id = f"{datetime.utcnow().strftime('%Y%m%d')}_{home}_{away}".replace(" ", "_")
        derby = _is_derby(home, away)

        # Try to get referee for this match
        match_referee = None
        # Check if we have referee data from Football-Data for this fixture
        ref_match = matches[
            (matches["HomeTeam"] == home) & (matches["AwayTeam"] == away)
        ]
        if len(ref_match) > 0 and "Referee" in ref_match.columns:
            last_ref = ref_match.iloc[-1].get("Referee")
            if pd.notna(last_ref):
                match_referee = last_ref

        logger.info(f"  Simulating: {home} vs {away} (derby={derby}, ref={match_referee})...")

        # Get lambda/mu from available models
        lambda_h, mu_a = 1.4, 1.1  # Default

        if dc_model is not None:
            try:
                lam_samples, mu_samples = dc_model.get_lambda_mu_samples(home, away, N_SIMULATIONS)
                lambda_h = float(np.mean(lam_samples))
                mu_a = float(np.mean(mu_samples))
            except Exception as e:
                logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")

        if xgb_model is not None:
            try:
                match_row = features[
                    (features["HomeTeam"] == home) & (features["AwayTeam"] == away)
                ]
                if len(match_row) > 0:
                    xgb_lam, xgb_mu = xgb_model.predict_single(match_row.iloc[-1].to_dict())
                    pb_pred = pb_predictions.get(key, {})
                    pb_lam = pb_pred.get("expected_goals", {}).get("home", lambda_h)
                    pb_mu = pb_pred.get("expected_goals", {}).get("away", mu_a)
                    lambda_h = 0.6 * lambda_h + 0.3 * xgb_lam + 0.1 * pb_lam
                    mu_a = 0.6 * mu_a + 0.3 * xgb_mu + 0.1 * pb_mu
            except Exception as e:
                logger.warning(f"  XGBoost prediction failed: {e}")

        # Simulate (correlated corners/cards)
        sim_kwargs = dict(
            corners_model=corners_model,
            cards_model=cards_model,
            home_team=home,
            away_team=away,
            referee=match_referee,
            is_derby=derby,
        )

        if dc_model is not None:
            try:
                lam_s, mu_s = dc_model.get_lambda_mu_samples(home, away, N_SIMULATIONS)
                sims = simulator.simulate_from_posterior(lam_s, mu_s, **sim_kwargs)
            except Exception:
                sims = simulator.simulate_match(lambda_h, mu_a, **sim_kwargs)
        else:
            sims = simulator.simulate_match(lambda_h, mu_a, **sim_kwargs)

        # Derive markets
        markets = simulator.derive_all_markets(sims)

        # Player booking predictions
        player_bookings_pred = {}
        try:
            player_bookings_pred = player_cards_model.predict_match(
                home, away,
                referee=match_referee,
                referee_profiles=referee_profiles,
                team_foul_drawn=cards_model.team_foul_drawn,
                is_derby=derby,
            )
        except Exception as e:
            logger.warning(f"  Player cards prediction failed: {e}")

        # SHAP explanation
        shap_data = {"combined_features": []}
        if xgb_model is not None:
            try:
                from pipeline.explainability.shap_explain import explain_match
                match_row = features[(features["HomeTeam"] == home)].tail(1)
                if len(match_row) > 0:
                    shap_data = explain_match(
                        xgb_model.model_home, xgb_model.model_away,
                        match_row, xgb_model.feature_cols
                    )
            except Exception as e:
                logger.warning(f"  SHAP failed: {e}")

        # Value bets (with all markets)
        from pipeline.risk.kelly import find_value_bets

        # Build odds benchmark dict
        odds_benchmark = {}
        match_odds_fd = odds_bench[
            (odds_bench["HomeTeam"] == home) & (odds_bench["AwayTeam"] == away)
        ]
        if len(match_odds_fd) > 0:
            odds_benchmark = match_odds_fd.iloc[-1].to_dict()

        # Merge in live odds if available
        if key in parsed_main:
            live = parsed_main[key]
            if live.get("h2h"):
                odds_benchmark["odds_home_bet365"] = live["h2h"].get("home")
                odds_benchmark["odds_draw_bet365"] = live["h2h"].get("draw")
                odds_benchmark["odds_away_bet365"] = live["h2h"].get("away")
            if live.get("btts"):
                odds_benchmark["btts"] = live["btts"]

        corners_odds_match = parsed_corners.get(key, {}).get("lines", {})
        cards_odds_match = parsed_cards.get(key, {}).get("lines", {})

        # Build player booking odds dict (if available from Odds API)
        player_booking_probs = {}
        player_booking_odds_dict = {}
        if player_bookings_pred.get("top_bookings"):
            for b in player_bookings_pred["top_bookings"]:
                player_booking_probs[b["web_name"]] = b["adjusted_prob"]

        value_bets = find_value_bets(
            predictions=markets,
            odds_benchmark=odds_benchmark,
            corners_odds=corners_odds_match if corners_odds_match else None,
            cards_odds=cards_odds_match if cards_odds_match else None,
            player_bookings=player_booking_probs if player_booking_probs else None,
            player_booking_odds=player_booking_odds_dict if player_booking_odds_dict else None,
        )

        # Narrative
        from pipeline.explainability.shap_explain import generate_narrative
        narrative = generate_narrative(markets, shap_data, home, away, gameweek)

        # Assemble match prediction
        prediction = {
            "match_id": match_id,
            "fixture": {
                "date": row.get("kickoff", datetime.utcnow().isoformat()),
                "home_team": home,
                "away_team": away,
                "gameweek": gameweek,
                "referee": match_referee,
                "is_derby": derby,
            },
            **markets,
            "player_bookings": {
                "top_bookings": player_bookings_pred.get("top_bookings", []),
                "adjustments": player_bookings_pred.get("adjustments", {}),
            },
            "shap_features": shap_data.get("combined_features", []),
            "value_bets": value_bets,
            "narrative": narrative,
        }

        all_predictions.append(prediction)

    # ── Step 10: Export JSON ──────────────────────────────────────────
    logger.info("\n[10/12] Exporting predictions JSON...")

    output = {
        "metadata": {
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "season": "2025-26",
            "gameweek": gameweek,
            "pipeline_version": "2.0.0",
            "models": ["dixon_coles_pymc", "xgboost", "penaltyblog"],
            "sub_models": ["corners_negbin_adj", "cards_zip_referee", "player_cards"],
            "n_simulations": N_SIMULATIONS,
            "calibrated": False,
            "odds_source": "the_odds_api" if any(all_live_odds.values()) else "football_data",
            "referee_profiles_count": len(referee_profiles),
        },
        "predictions": all_predictions,
    }

    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)
    latest_path = PREDICTIONS_DIR / "latest.json"
    with open(latest_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    # Archive
    archive_dir = PREDICTIONS_DIR / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = archive_dir / f"matchweek_{gameweek}.json"
    with open(archive_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    # Matches metadata
    matches_meta = {
        "season": "2025-26",
        "gameweek": gameweek,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "matches": [
            {
                "match_id": p["match_id"],
                "date": p["fixture"]["date"],
                "home_team": p["fixture"]["home_team"],
                "away_team": p["fixture"]["away_team"],
                "referee": p["fixture"].get("referee"),
                "is_derby": p["fixture"].get("is_derby", False),
                "model_prediction": max(
                    p["probabilities"]["1x2"],
                    key=p["probabilities"]["1x2"].get,
                ),
                "confidence_pct": round(
                    max(p["probabilities"]["1x2"].values()) * 100, 1
                ),
                "n_value_bets": len(p.get("value_bets", [])),
            }
            for p in all_predictions
        ],
    }
    with open(PREDICTIONS_DIR / "matches.json", "w") as f:
        json.dump(matches_meta, f, indent=2, default=str)

    # ── Done ─────────────────────────────────────────────────────────
    elapsed = (datetime.utcnow() - start_time).total_seconds()
    total_value_bets = sum(len(p.get("value_bets", [])) for p in all_predictions)

    logger.info(f"\n{'=' * 60}")
    logger.info(f"PIPELINE COMPLETE in {elapsed:.1f}s")
    logger.info(f"Predictions: {latest_path}")
    logger.info(f"Matches: {len(all_predictions)}")
    logger.info(f"Value bets found: {total_value_bets}")
    logger.info(f"{'=' * 60}")

    return {
        "status": "success",
        "n_predictions": len(all_predictions),
        "n_value_bets": total_value_bets,
        "gameweek": gameweek,
        "output_path": str(latest_path),
        "elapsed_seconds": elapsed,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PL Prediction Engine Pipeline")
    parser.add_argument("--force-refresh", action="store_true", help="Force re-download all data")
    parser.add_argument("--skip-pymc", action="store_true", help="Skip PyMC MCMC (use PenaltyBlog only)")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    result = run_pipeline(
        force_refresh=args.force_refresh,
        skip_pymc=args.skip_pymc,
    )
    print(f"\nResult: {json.dumps(result, indent=2)}")
    sys.exit(0 if result["status"] == "success" else 1)
