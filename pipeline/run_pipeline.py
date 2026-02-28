"""
Main pipeline orchestrator.
Runs the full data → features → models → simulate → export flow.

Usage:
    python -m pipeline.run_pipeline
    python -m pipeline.run_pipeline --force-refresh
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
    PREDICTIONS_DIR, CURRENT_SEASON, SEASONS, N_SIMULATIONS
)

logger = logging.getLogger(__name__)


def run_pipeline(force_refresh: bool = False, skip_pymc: bool = False) -> Dict:
    """
    Execute the full prediction pipeline.

    Steps:
        1. Fetch data (Football-Data, FBref, FPL)
        2. Engineer features
        3. Fit models (PenaltyBlog, PyMC Dixon-Coles, XGBoost)
        4. Fit sub-models (Corners NegBin, Cards ZIP)
        5. Generate ensemble predictions
        6. Run Monte Carlo simulation (10K per match)
        7. Derive all betting markets
        8. Calculate SHAP explanations
        9. Find value bets (Kelly criterion)
        10. Generate narratives
        11. Export JSON

    Returns:
        Status dict with metrics and output path
    """
    start_time = datetime.utcnow()
    logger.info("=" * 60)
    logger.info("PL PREDICTION ENGINE — PIPELINE START")
    logger.info(f"Timestamp: {start_time.isoformat()}Z")
    logger.info("=" * 60)

    # ── Step 1: Fetch Data ─────────────────────────────────────────────
    logger.info("\n[1/11] Fetching data...")

    from pipeline.data.football_data import load_all_seasons, extract_odds_benchmark
    matches = load_all_seasons(force=force_refresh)

    from pipeline.data.fpl_api import fetch_bootstrap_static, fetch_fixtures, get_upcoming_fixtures, build_player_stats, get_current_gameweek
    bootstrap = fetch_bootstrap_static(force=force_refresh)
    fixtures_raw = fetch_fixtures(force=force_refresh)
    gameweek = get_current_gameweek(bootstrap)
    upcoming = get_upcoming_fixtures(bootstrap, fixtures_raw)
    player_stats = build_player_stats(bootstrap)

    from pipeline.data.fbref import fetch_fbref_team_stats, build_xg_features
    fbref_stats = fetch_fbref_team_stats(force=force_refresh)
    fbref_features = build_xg_features(fbref_stats)

    logger.info(f"  Matches: {len(matches)}, Upcoming fixtures: {len(upcoming)}, Players: {len(player_stats)}")

    # ── Step 2: Engineer Features ──────────────────────────────────────
    logger.info("\n[2/11] Engineering features...")
    from pipeline.features.engineer import engineer_features
    features = engineer_features(matches, fbref_features, player_stats)

    # ── Step 3: Fit PenaltyBlog Baseline ───────────────────────────────
    logger.info("\n[3/11] Fitting PenaltyBlog baseline...")
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

    # ── Step 4: Fit PyMC Dixon-Coles ───────────────────────────────────
    dc_model = None
    if not skip_pymc:
        logger.info("\n[4/11] Fitting PyMC Dixon-Coles...")
        try:
            from pipeline.models.dixon_coles import BayesianDixonColes
            dc_model = BayesianDixonColes()
            dc_model.fit(features)
            logger.info("  PyMC Dixon-Coles fitted successfully")
        except Exception as e:
            logger.warning(f"  PyMC Dixon-Coles failed: {e}. Using PenaltyBlog only.")
    else:
        logger.info("\n[4/11] Skipping PyMC Dixon-Coles (--skip-pymc flag)")

    # ── Step 5: Fit XGBoost ────────────────────────────────────────────
    logger.info("\n[5/11] Fitting XGBoost...")
    xgb_model = None
    try:
        from pipeline.models.xgboost_model import XGBoostGoalModel
        xgb_model = XGBoostGoalModel()
        xgb_metrics = xgb_model.fit(features)
        logger.info(f"  XGBoost metrics: {xgb_metrics}")
    except Exception as e:
        logger.warning(f"  XGBoost failed: {e}")

    # ── Step 6: Fit Sub-Models (Corners, Cards) ────────────────────────
    logger.info("\n[6/11] Fitting corners and cards models...")
    from pipeline.models.corners_negbin import CornersNegBinModel
    from pipeline.models.cards_zip import CardsZIPModel

    corners_model = CornersNegBinModel()
    corners_model.fit(matches)

    cards_model = CardsZIPModel()
    cards_model.fit(matches)

    # ── Step 7: Monte Carlo Simulation ─────────────────────────────────
    logger.info("\n[7/11] Running Monte Carlo simulation...")
    from pipeline.simulation.montecarlo import MonteCarloSimulator

    simulator = MonteCarloSimulator(N_SIMULATIONS)
    all_predictions = []

    # Odds benchmark for value bets
    odds_bench = extract_odds_benchmark(matches)

    for _, row in upcoming.iterrows():
        home, away = row["home_team"], row["away_team"]
        key = f"{home}_vs_{away}"
        match_id = f"{datetime.utcnow().strftime('%Y%m%d')}_{home}_{away}".replace(" ", "_")

        logger.info(f"  Simulating: {home} vs {away}...")

        # Get lambda/mu from available models
        lambda_h, mu_a = 1.4, 1.1  # Default

        # Try Dixon-Coles posterior
        if dc_model is not None:
            try:
                lam_samples, mu_samples = dc_model.get_lambda_mu_samples(home, away, N_SIMULATIONS)
                lambda_h = float(np.mean(lam_samples))
                mu_a = float(np.mean(mu_samples))
            except Exception as e:
                logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")

        # Try XGBoost adjustment
        if xgb_model is not None:
            try:
                # Find latest features for this matchup
                match_row = features[
                    (features["HomeTeam"] == home) & (features["AwayTeam"] == away)
                ]
                if len(match_row) > 0:
                    xgb_lam, xgb_mu = xgb_model.predict_single(match_row.iloc[-1].to_dict())
                    # Blend: 60% DC, 30% XGB, 10% PB
                    pb_pred = pb_predictions.get(key, {})
                    pb_lam = pb_pred.get("expected_goals", {}).get("home", lambda_h)
                    pb_mu = pb_pred.get("expected_goals", {}).get("away", mu_a)

                    lambda_h = 0.6 * lambda_h + 0.3 * xgb_lam + 0.1 * pb_lam
                    mu_a = 0.6 * mu_a + 0.3 * xgb_mu + 0.1 * pb_mu
            except Exception as e:
                logger.warning(f"  XGBoost prediction failed: {e}")

        # Corners and cards parameters
        corners_pred = corners_model.predict(home, away)
        cards_pred = cards_model.predict(home, away)

        # Simulate
        if dc_model is not None:
            try:
                lam_s, mu_s = dc_model.get_lambda_mu_samples(home, away, N_SIMULATIONS)
                sims = simulator.simulate_from_posterior(
                    lam_s, mu_s,
                    corners_params={"home": corners_model.params_home.get(home), "away": corners_model.params_away.get(away)},
                    cards_params={"home": cards_model.params_home.get(home), "away": cards_model.params_away.get(away)},
                )
            except Exception:
                sims = simulator.simulate_match(
                    lambda_h, mu_a,
                    corners_params={"home": corners_model.params_home.get(home), "away": corners_model.params_away.get(away)},
                    cards_params={"home": cards_model.params_home.get(home), "away": cards_model.params_away.get(away)},
                )
        else:
            sims = simulator.simulate_match(
                lambda_h, mu_a,
                corners_params={"home": corners_model.params_home.get(home), "away": corners_model.params_away.get(away)},
                cards_params={"home": cards_model.params_home.get(home), "away": cards_model.params_away.get(away)},
            )

        # Derive markets
        markets = simulator.derive_all_markets(sims)

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

        # Value bets
        from pipeline.risk.kelly import find_value_bets
        match_odds = odds_bench[
            (odds_bench["HomeTeam"] == home) & (odds_bench["AwayTeam"] == away)
        ]
        value_bets = []
        if len(match_odds) > 0:
            value_bets = find_value_bets(markets, match_odds.iloc[-1].to_dict())

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
            },
            **markets,
            "shap_features": shap_data.get("combined_features", []),
            "value_bets": value_bets,
            "narrative": narrative,
        }

        all_predictions.append(prediction)

    # ── Step 8: Export JSON ────────────────────────────────────────────
    logger.info("\n[8/11] Exporting predictions JSON...")

    output = {
        "metadata": {
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "season": "2025-26",
            "gameweek": gameweek,
            "pipeline_version": "1.0.0",
            "models": ["dixon_coles_pymc", "xgboost", "penaltyblog"],
            "n_simulations": N_SIMULATIONS,
            "calibrated": False,  # Will be True once calibrator is fitted
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
                "model_prediction": max(
                    p["probabilities"]["1x2"],
                    key=p["probabilities"]["1x2"].get,
                ),
                "confidence_pct": round(
                    max(p["probabilities"]["1x2"].values()) * 100, 1
                ),
            }
            for p in all_predictions
        ],
    }
    with open(PREDICTIONS_DIR / "matches.json", "w") as f:
        json.dump(matches_meta, f, indent=2, default=str)

    # ── Done ───────────────────────────────────────────────────────────
    elapsed = (datetime.utcnow() - start_time).total_seconds()
    logger.info(f"\n{'=' * 60}")
    logger.info(f"PIPELINE COMPLETE in {elapsed:.1f}s")
    logger.info(f"Predictions: {latest_path}")
    logger.info(f"Matches: {len(all_predictions)}")
    logger.info(f"{'=' * 60}")

    return {
        "status": "success",
        "n_predictions": len(all_predictions),
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
