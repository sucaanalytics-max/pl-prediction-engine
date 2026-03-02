"""
Main pipeline orchestrator.
Runs the full data → features → models → simulate → export flow.

Phase 5: Hardened for GitHub Actions reliability.
- HTTP retry with exponential backoff
- Model artifact caching (skip retraining when data hasn't changed)
- Stacking without full retrain (use cached OOF predictions)
- Per-step timeouts and graceful degradation
- PyMC reduced config for CI (fewer draws, auto-skip on timeout)

Usage:
    python -m pipeline.run_pipeline
    python -m pipeline.run_pipeline --force-refresh
    python -m pipeline.run_pipeline --skip-pymc --verbose
"""
import argparse
import hashlib
import json
import logging
import os
import pickle
import signal
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from pipeline.config import (
    PREDICTIONS_DIR, CURRENT_SEASON, SEASONS, N_SIMULATIONS, DERBIES,
    ENSEMBLE_WEIGHTS, DATA_PROCESSED,
)

logger = logging.getLogger(__name__)

PIPELINE_VERSION = "4.0.0"

# Model cache directory
MODEL_CACHE_DIR = DATA_PROCESSED / "model_cache"


# ── Timeout Helper ──────────────────────────────────────────────────────────

class StepTimeout(Exception):
    """Raised when a pipeline step exceeds its time budget."""
    pass


def _timeout_handler(signum, frame):
    raise StepTimeout("Step timed out")


class step_timeout:
    """Context manager for step-level timeouts (Unix only)."""

    def __init__(self, seconds: int, label: str = "step"):
        self.seconds = seconds
        self.label = label

    def __enter__(self):
        if hasattr(signal, "SIGALRM"):
            signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(self.seconds)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
        if exc_type is StepTimeout:
            logger.warning(f"  {self.label} timed out after {self.seconds}s")
            return True  # Suppress the exception
        return False


# ── Data Hash Helper ────────────────────────────────────────────────────────

def _data_hash(df: pd.DataFrame) -> str:
    """Quick hash of DataFrame shape + last few rows for cache invalidation."""
    sig = f"{len(df)}_{df.columns.tolist()}_{df.tail(3).to_json()}"
    return hashlib.md5(sig.encode()).hexdigest()[:12]


def _save_model_cache(key: str, obj):
    """Pickle a model to the cache directory."""
    MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_CACHE_DIR / f"{key}.pkl"
    with open(path, "wb") as f:
        pickle.dump(obj, f)
    logger.info(f"  Cached model: {key}")


def _load_model_cache(key: str, max_age_hours: float = 24.0):
    """Load a cached model if it exists and isn't too old."""
    path = MODEL_CACHE_DIR / f"{key}.pkl"
    if not path.exists():
        return None
    age_hours = (time.time() - path.stat().st_mtime) / 3600
    if age_hours > max_age_hours:
        logger.info(f"  Cache expired ({age_hours:.1f}h > {max_age_hours}h): {key}")
        return None
    try:
        with open(path, "rb") as f:
            obj = pickle.load(f)
        logger.info(f"  Loaded cached model: {key} ({age_hours:.1f}h old)")
        return obj
    except Exception as e:
        logger.warning(f"  Cache load failed for {key}: {e}")
        return None


# ── Pipeline ────────────────────────────────────────────────────────────────

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
    logger.info(f"PL PREDICTION ENGINE — PIPELINE START (v{PIPELINE_VERSION})")
    logger.info(f"Timestamp: {start_time.isoformat()}Z")
    logger.info(f"skip_pymc={skip_pymc}, force_refresh={force_refresh}")
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

    # FBref is the most fragile source — wrap with timeout + graceful fallback
    fbref_stats = None
    passing_stats = None
    fbref_features = pd.DataFrame()

    try:
        with step_timeout(60, "FBref team stats"):
            fbref_stats = fetch_fbref_team_stats(force=force_refresh)
    except Exception as e:
        logger.warning(f"  FBref team stats failed: {e}")

    try:
        with step_timeout(60, "FBref passing stats"):
            passing_stats = fetch_fbref_passing_stats(force=force_refresh)
    except Exception as e:
        logger.warning(f"  FBref passing stats failed: {e}")

    if fbref_stats is not None:
        fbref_features = build_advanced_features(fbref_stats, passing_stats)

    logger.info(
        f"  Matches: {len(matches)}, Upcoming: {len(upcoming)}, "
        f"Players: {len(player_stats)}, FBref teams: {len(fbref_features)}"
    )

    if len(upcoming) == 0:
        logger.warning("No upcoming fixtures found. Exporting empty predictions.")

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

        # Try cache first (PenaltyBlog is fast, but cache saves a few seconds)
        data_sig = _data_hash(matches)
        cache_key = f"penaltyblog_{data_sig}"
        pb_model = _load_model_cache(cache_key, max_age_hours=12)

        if pb_model is None:
            pb_model = PenaltyblogBaseline()
            pb_model.fit(matches)
            _save_model_cache(cache_key, pb_model)

        for _, row in upcoming.iterrows():
            key = f"{row['home_team']}_vs_{row['away_team']}"
            pb_predictions[key] = pb_model.predict_match(row["home_team"], row["away_team"])
        logger.info(f"  PenaltyBlog: {len(pb_predictions)} fixtures predicted")
    except Exception as e:
        logger.warning(f"  PenaltyBlog failed: {e}")

    # ── Step 5: Fit PyMC Dixon-Coles ─────────────────────────────────
    dc_model = None

    # Auto-detect: skip PyMC in CI if we're constrained
    ci_env = os.environ.get("CI", "false").lower() == "true"
    pipeline_timeout = int(os.environ.get("PIPELINE_TIMEOUT", "0"))
    elapsed_so_far = (datetime.utcnow() - start_time).total_seconds()

    # If we're in CI and already used >40% of timeout, skip PyMC to be safe
    if not skip_pymc and ci_env and pipeline_timeout > 0:
        remaining = pipeline_timeout - elapsed_so_far
        if remaining < 600:  # Less than 10 minutes left
            logger.warning(
                f"  Auto-skipping PyMC: only {remaining:.0f}s remaining "
                f"(elapsed {elapsed_so_far:.0f}s of {pipeline_timeout}s budget)"
            )
            skip_pymc = True

    if not skip_pymc:
        logger.info("\n[5/12] Fitting PyMC Dixon-Coles...")
        try:
            # Try loading cached model first
            data_sig = _data_hash(matches)
            cache_key = f"dixon_coles_{data_sig}"
            dc_model = _load_model_cache(cache_key, max_age_hours=12)

            if dc_model is None:
                from pipeline.models.dixon_coles import BayesianDixonColes

                # In CI, use reduced sampling for reliability
                if ci_env:
                    from pipeline.config import DIXON_COLES
                    original_draws = DIXON_COLES.get("pymc_draws", 2000)
                    original_tune = DIXON_COLES.get("pymc_tune", 1000)
                    DIXON_COLES["pymc_draws"] = min(original_draws, 1000)
                    DIXON_COLES["pymc_tune"] = min(original_tune, 500)
                    logger.info(
                        f"  CI mode: reduced sampling to "
                        f"{DIXON_COLES['pymc_draws']} draws, "
                        f"{DIXON_COLES['pymc_tune']} tune"
                    )

                dc_model = BayesianDixonColes()
                with step_timeout(480, "PyMC Dixon-Coles fitting"):
                    dc_model.fit(features)
                    _save_model_cache(cache_key, dc_model)
                logger.info("  PyMC Dixon-Coles fitted successfully")
            else:
                logger.info("  PyMC Dixon-Coles loaded from cache")
        except Exception as e:
            logger.warning(f"  PyMC Dixon-Coles failed: {e}. Using PenaltyBlog only.")
            dc_model = None
    else:
        logger.info("\n[5/12] Skipping PyMC Dixon-Coles (--skip-pymc flag)")

    # ── Step 6: Fit XGBoost ──────────────────────────────────────────
    logger.info("\n[6/12] Fitting XGBoost...")
    xgb_model = None
    try:
        from pipeline.models.xgboost_model import XGBoostGoalModel

        data_sig = _data_hash(features)
        cache_key = f"xgboost_{data_sig}"
        xgb_model = _load_model_cache(cache_key, max_age_hours=12)

        if xgb_model is None:
            xgb_model = XGBoostGoalModel()
            xgb_metrics = xgb_model.fit(features)
            _save_model_cache(cache_key, xgb_model)
            logger.info(f"  XGBoost metrics: {xgb_metrics}")
        else:
            logger.info("  XGBoost loaded from cache")
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

    # Goalscorer model
    from pipeline.models.goalscorer import GoalscorerModel
    goalscorer_model = GoalscorerModel()
    goalscorer_metrics = goalscorer_model.fit(player_stats)
    logger.info(f"  Goalscorer: {goalscorer_metrics}")

    # ── Step 7b: Attempt Stacking Meta-Learner ─────────────────────
    logger.info("\n[7b/12] Training stacking meta-learner...")
    stacking_weights = None
    ensemble_method = "weighted_average"  # default
    meta_learner = None

    try:
        from pipeline.models.ensemble import StackingMetaLearner, build_oof_predictions

        # Only attempt stacking if we have enough historical data
        if "season" in matches.columns and matches["season"].nunique() >= 3:

            # Check for cached OOF predictions (avoids retraining all models)
            oof_cache_key = f"oof_predictions_{_data_hash(matches)}"
            cached_oof = _load_model_cache(oof_cache_key, max_age_hours=168)  # 7 days

            if cached_oof is not None:
                oof_preds, actuals = cached_oof
                logger.info("  Loaded cached OOF predictions")
            else:
                # Build OOF — but ONLY with fast models (skip PyMC in OOF)
                def _build_pb(train_df):
                    from pipeline.models.penaltyblog_baseline import PenaltyblogBaseline
                    m = PenaltyblogBaseline()
                    m.fit(train_df)
                    return m

                model_builders = {"penaltyblog": _build_pb}

                # XGBoost builder (fast enough for OOF)
                def _build_xgb(train_df):
                    from pipeline.models.xgboost_model import XGBoostGoalModel
                    m = XGBoostGoalModel()
                    m.fit(train_df)
                    return m
                model_builders["xgboost"] = _build_xgb

                # NOTE: Dixon-Coles OOF deliberately excluded.
                # It was retraining MCMC for every fold × every season,
                # which is the #1 cause of pipeline timeouts.
                # Instead, we assign DC a fixed weight in the stacking input.

                seasons_list = sorted(matches["season"].unique().tolist())

                with step_timeout(300, "OOF predictions"):
                    oof_preds, actuals = build_oof_predictions(
                        matches, seasons_list, model_builders
                    )
                    _save_model_cache(oof_cache_key, (oof_preds, actuals))

            meta_learner = StackingMetaLearner()
            stacking_result = meta_learner.fit(oof_preds, actuals)

            if stacking_result.get("status") == "fitted":
                stacking_weights = stacking_result["learned_weights"]
                # If DC wasn't in OOF, inject its static weight
                if "dixon_coles" not in stacking_weights and dc_model is not None:
                    # Redistribute: give DC 40% of total, scale others down
                    dc_share = 0.40
                    other_total = sum(stacking_weights.values())
                    if other_total > 0:
                        stacking_weights = {
                            k: v * (1 - dc_share) / other_total
                            for k, v in stacking_weights.items()
                        }
                    stacking_weights["dixon_coles"] = dc_share
                ensemble_method = "stacking"
                logger.info(f"  Stacking weights: {stacking_weights}")
            else:
                logger.info(f"  Stacking fallback: {stacking_result.get('status')}")
        else:
            logger.info("  Insufficient seasons for stacking — using weighted average")
    except Exception as e:
        logger.warning(f"  Stacking meta-learner failed: {e}. Using static weights.")

    # ── Step 8: Fetch Live Odds ──────────────────────────────────────
    logger.info("\n[8/12] Fetching live odds from The Odds API...")
    all_live_odds = {"main": None, "corners": None, "cards": None}
    try:
        from pipeline.data.odds_api import OddsAPIClient, parse_match_odds, parse_alt_totals

        api_key = os.environ.get("ODDS_API_KEY", "")
        if not api_key:
            logger.warning("  ODDS_API_KEY not set. Skipping live odds.")
        else:
            odds_client = OddsAPIClient(api_key=api_key)
            with step_timeout(60, "Odds API fetch"):
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

    # In CI, reduce simulations for speed
    n_sims = N_SIMULATIONS
    if ci_env and N_SIMULATIONS > 5000:
        n_sims = 5000
        logger.info(f"  CI mode: reduced simulations to {n_sims}")

    simulator = MonteCarloSimulator(n_sims)
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
                lam_samples, mu_samples = dc_model.get_lambda_mu_samples(home, away, n_sims)
                lambda_h = float(np.mean(lam_samples))
                mu_a = float(np.mean(mu_samples))
            except Exception as e:
                logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")

        # Gather per-model lambdas for ensemble blending
        model_lambdas = {}
        if dc_model is not None:
            model_lambdas["dixon_coles"] = (lambda_h, mu_a)

        if xgb_model is not None:
            try:
                match_row = features[
                    (features["HomeTeam"] == home) & (features["AwayTeam"] == away)
                ]
                if len(match_row) > 0:
                    xgb_lam, xgb_mu = xgb_model.predict_single(match_row.iloc[-1].to_dict())
                    model_lambdas["xgboost"] = (xgb_lam, xgb_mu)
            except Exception as e:
                logger.warning(f"  XGBoost prediction failed: {e}")

        pb_pred = pb_predictions.get(key, {})
        pb_lam = pb_pred.get("expected_goals", {}).get("home", lambda_h)
        pb_mu = pb_pred.get("expected_goals", {}).get("away", mu_a)
        model_lambdas["penaltyblog"] = (pb_lam, pb_mu)

        # Blend using stacking weights if available, else static weights
        weights = stacking_weights if stacking_weights else ENSEMBLE_WEIGHTS
        total_w = sum(weights.get(m, 0) for m in model_lambdas)
        if total_w > 0 and len(model_lambdas) > 0:
            lambda_h = sum(weights.get(m, 0) * lam for m, (lam, _) in model_lambdas.items()) / total_w
            mu_a = sum(weights.get(m, 0) * mu for m, (_, mu) in model_lambdas.items()) / total_w

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
                lam_s, mu_s = dc_model.get_lambda_mu_samples(home, away, n_sims)
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

        # Goalscorer predictions
        goalscorer_pred = {}
        try:
            goalscorer_pred = goalscorer_model.predict_match(
                home, away,
                home_xg=lambda_h,
                away_xg=mu_a,
                top_n=8,
            )
        except Exception as e:
            logger.warning(f"  Goalscorer prediction failed: {e}")

        # Build odds comparison data for frontend
        odds_comparison = {}
        if key in parsed_main:
            live = parsed_main[key]
            if live.get("h2h_all"):
                odds_comparison["h2h"] = live["h2h_all"]
            if live.get("h2h"):
                for outcome in ["home", "draw", "away"]:
                    bk_key = live["h2h"].get(f"bookmaker_{outcome}")
                    if bk_key:
                        odds_comparison[f"bookmaker_{outcome}"] = bk_key

        # Compute model disagreement
        model_disagreement = None
        if len(model_lambdas) >= 2:
            from scipy.stats import poisson as poisson_dist
            model_1x2 = {}
            for mname, (ml, mm) in model_lambdas.items():
                ph = sum(poisson_dist.pmf(i, ml) * poisson_dist.pmf(j, mm) for i in range(8) for j in range(i))
                pd_ = sum(poisson_dist.pmf(i, ml) * poisson_dist.pmf(i, mm) for i in range(8))
                pa = max(0, 1 - ph - pd_)
                model_1x2[mname] = np.array([ph, pd_, pa])
            if meta_learner and meta_learner.is_fitted:
                model_disagreement = meta_learner.model_disagreement(model_1x2)
            else:
                stacked = np.array(list(model_1x2.values()))
                model_disagreement = float(stacked.std(axis=0).mean())

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

        # Build goalscorer probabilities dict for Kelly scanner
        goalscorer_probs_for_kelly = {}
        if goalscorer_pred.get("top_scorers"):
            for gs in goalscorer_pred["top_scorers"]:
                goalscorer_probs_for_kelly[gs["web_name"]] = gs["anytime_prob"]

        # Combine predictions with goalscorer probs for full market scanning
        predictions_with_gs = dict(markets)
        predictions_with_gs["goalscorer_probabilities"] = goalscorer_probs_for_kelly

        value_bets = find_value_bets(
            predictions=predictions_with_gs,
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
            "goalscorer": goalscorer_pred if goalscorer_pred else None,
            "odds_comparison": odds_comparison if odds_comparison else None,
            "model_disagreement": model_disagreement,
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
            "pipeline_version": PIPELINE_VERSION,
            "models": ["dixon_coles_pymc", "xgboost", "penaltyblog"],
            "sub_models": ["corners_negbin_adj", "cards_zip_referee", "player_cards", "goalscorer"],
            "n_simulations": n_sims,
            "calibrated": False,
            "odds_source": "the_odds_api" if any(all_live_odds.values()) else "football_data",
            "referee_profiles_count": len(referee_profiles),
            "ensemble_method": ensemble_method,
            "stacking_weights": stacking_weights,
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

    # ── Player Stats JSON (for frontend Players page) ──────────────
    logger.info("  Exporting player_stats.json...")
    try:
        ps_export = []
        for _, row in player_stats.iterrows():
            ps_export.append({
                "player_id": int(row.get("player_id", 0)),
                "name": str(row.get("name", "")),
                "web_name": str(row.get("web_name", "")),
                "team": str(row.get("team", "")),
                "position": str(row.get("position", "")),
                "minutes": int(row.get("minutes", 0)),
                "goals_scored": int(row.get("goals_scored", 0)),
                "assists": int(row.get("assists", 0)),
                "expected_goals": float(row.get("expected_goals", 0)),
                "expected_assists": float(row.get("expected_assists", 0)) if pd.notna(row.get("expected_assists")) else None,
                "xg_per_90": float(row.get("expected_goals", 0) / max(row.get("minutes", 1) / 90, 0.1)),
                "goals_per_90": float(row.get("goals_scored", 0) / max(row.get("minutes", 1) / 90, 0.1)),
                "assists_per_90": float(row.get("assists", 0) / max(row.get("minutes", 1) / 90, 0.1)),
                "yellows": int(row.get("yellow_cards", row.get("yellows", 0))),
                "yellows_per_90": float(row.get("yellow_cards", row.get("yellows", 0)) / max(row.get("minutes", 1) / 90, 0.1)),
                "fouls_committed": int(row.get("fouls_committed", 0)) if pd.notna(row.get("fouls_committed")) else None,
                "fouls_per_90": float(row.get("fouls_committed", 0) / max(row.get("minutes", 1) / 90, 0.1)) if pd.notna(row.get("fouls_committed")) else None,
                "fpl_price": float(row.get("now_cost", 0)) / 10 if row.get("now_cost") else None,
                "fpl_ownership": float(row.get("selected_by_percent", 0)) if row.get("selected_by_percent") else None,
                "form": float(row.get("form", 0)) if pd.notna(row.get("form")) else None,
                "available": bool(row.get("available", True)),
            })
        with open(PREDICTIONS_DIR / "player_stats.json", "w") as f:
            json.dump(ps_export, f, indent=2, default=str)
        logger.info(f"  player_stats.json: {len(ps_export)} players")
    except Exception as e:
        logger.warning(f"  player_stats.json export failed: {e}")

    # ── League Table JSON (for frontend Table page) ────────────────
    logger.info("  Exporting table.json...")
    try:
        from pipeline.config import CURRENT_SEASON
        # Filter matches for the current season that have a result
        season_matches = matches[(matches["season"] == CURRENT_SEASON) & (matches["FTR"].notna())]
        
        standings = {}
        for _, row in season_matches.iterrows():
            h, a = row["HomeTeam"], row["AwayTeam"]
            for t in [h, a]:
                if t not in standings:
                    standings[t] = {
                        "team": t, "played": 0, "won": 0, "drawn": 0, "lost": 0, 
                        "gf": 0, "ga": 0, "gd": 0, "points": 0, "form": []
                    }
            
            hg, ag = int(row["FTHG"]), int(row["FTAG"])
            standings[h]["played"] += 1
            standings[a]["played"] += 1
            standings[h]["gf"] += hg
            standings[h]["ga"] += ag
            standings[a]["gf"] += ag
            standings[a]["ga"] += hg
            standings[h]["gd"] += (hg - ag)
            standings[a]["gd"] += (ag - hg)
            
            if hg > ag:
                standings[h]["won"] += 1
                standings[h]["points"] += 3
                standings[h]["form"].append("W")
                standings[a]["lost"] += 1
                standings[a]["form"].append("L")
            elif hg == ag:
                standings[h]["drawn"] += 1
                standings[h]["points"] += 1
                standings[h]["form"].append("D")
                standings[a]["drawn"] += 1
                standings[a]["points"] += 1
                standings[a]["form"].append("D")
            else:
                standings[a]["won"] += 1
                standings[a]["points"] += 3
                standings[a]["form"].append("W")
                standings[h]["lost"] += 1
                standings[h]["form"].append("L")

        team_list = list(standings.values())
        # Sort by points, then gd, then gf
        team_list.sort(key=lambda x: (x["points"], x["gd"], x["gf"]), reverse=True)
        
        for i, t in enumerate(team_list):
            t["position"] = i + 1
            t["form"] = t["form"][-5:]  # only keep last 5
            
        with open(PREDICTIONS_DIR / "table.json", "w") as f:
            json.dump(team_list, f, indent=2, default=str)
        logger.info(f"  table.json: {len(team_list)} teams")
    except Exception as e:
        logger.warning(f"  table.json export failed: {e}")

    # ── H2H JSON (for frontend H2H page) ───────────────────────────
    logger.info("  Exporting h2h.json...")
    try:
        h2h_records = {}
        for _, row in matches[matches["FTR"].notna()].iterrows():
            h, a = row["HomeTeam"], row["AwayTeam"]
            key = tuple(sorted([h, a]))
            if key not in h2h_records:
                h2h_records[key] = {
                    "home_team": key[0],
                    "away_team": key[1],
                    "home_wins": 0,
                    "draws": 0,
                    "away_wins": 0,
                    "matches": []
                }
            
            hg, ag = int(row["FTHG"]), int(row["FTAG"])
            is_home_first = (h == key[0])
            
            if hg > ag:
                if is_home_first:
                    h2h_records[key]["home_wins"] += 1
                else:
                    h2h_records[key]["away_wins"] += 1
            elif hg == ag:
                h2h_records[key]["draws"] += 1
            else:
                if is_home_first:
                    h2h_records[key]["away_wins"] += 1
                else:
                    h2h_records[key]["home_wins"] += 1
                    
            h2h_records[key]["matches"].append({
                "date": row["Date"].isoformat() if hasattr(row["Date"], "isoformat") else str(row["Date"]),
                "home_team": h,
                "away_team": a,
                "home_goals": hg,
                "away_goals": ag,
                "season": row["season"]
            })
            
        # keep last 5 matches and format
        export_h2h = []
        for v in h2h_records.values():
            # sort matches by date descending
            v["matches"] = sorted(v["matches"], key=lambda x: x["date"], reverse=True)[:5]
            export_h2h.append(v)
            
        with open(PREDICTIONS_DIR / "h2h.json", "w") as f:
            json.dump(export_h2h, f, indent=2, default=str)
        logger.info(f"  h2h.json: {len(export_h2h)} matchups")
    except Exception as e:
        logger.warning(f"  h2h.json export failed: {e}")

    # ── Health JSON (for frontend Model Health page) ───────────────
    logger.info("  Exporting health.json...")
    try:
        health_data = {
            "last_updated": datetime.utcnow().isoformat() + "Z",
            "gameweek": gameweek,
            "n_predictions": len(all_predictions),
            "status": "healthy",
            "pipeline_version": PIPELINE_VERSION,
            "models": {
                "dixon_coles": {"status": "active" if dc_model else "skipped"},
                "xgboost": {"status": "active" if xgb_model else "failed"},
                "penaltyblog": {"status": "active" if pb_predictions else "failed"},
                "goalscorer": {"status": "active", "n_players": goalscorer_metrics.get("n_players", 0)},
            },
            "ensemble_method": ensemble_method,
            "stacking_weights": stacking_weights,
            "n_simulations": n_sims,
            "odds_source": "the_odds_api" if any(all_live_odds.values()) else "football_data",
            "referee_profiles_count": len(referee_profiles),
        }
        with open(PREDICTIONS_DIR / "health.json", "w") as f:
            json.dump(health_data, f, indent=2, default=str)
        logger.info("  health.json exported")
    except Exception as e:
        logger.warning(f"  health.json export failed: {e}")

    # ── Upload to Supabase Storage ───────────────────────────────────
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if supabase_url and supabase_key:
        logger.info("\n[12/12] Uploading JSONs to Supabase Storage...")
        try:
            from supabase import create_client
            supabase = create_client(supabase_url, supabase_key)
            bucket_name = "predictions"
            
            # Ensure bucket exists
            try:
                supabase.storage.get_bucket(bucket_name)
            except Exception:
                logger.info(f"  Creating bucket '{bucket_name}'...")
                supabase.storage.create_bucket(bucket_name, options={"public": True})
                
            files_to_upload = [
                "latest.json",
                "matches.json",
                "player_stats.json",
                "health.json",
                "table.json",
                "h2h.json"
            ]
            
            for f_name in files_to_upload:
                f_path = PREDICTIONS_DIR / f_name
                if f_path.exists():
                    with open(f_path, "rb") as f_data:
                        try:
                            supabase.storage.from_(bucket_name).upload(
                                file=f_data.read(),
                                path=f_name,
                                file_options={"content-type": "application/json", "upsert": "true"}
                            )
                            logger.info(f"  Uploaded {f_name} to Supabase")
                        except Exception as up_err:
                            logger.warning(f"  Failed to upload {f_name}: {up_err}")
                            
        except Exception as e:
            logger.error(f"  Supabase integration failed: {e}")

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
