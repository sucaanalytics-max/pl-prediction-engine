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
from typing import Dict

import numpy as np
import pandas as pd

from pipeline.config import (
    PREDICTIONS_DIR, CURRENT_SEASON, CURRENT_SEASON_LABEL,
    N_SIMULATIONS, DERBIES, ENSEMBLE_WEIGHTS, ENABLE_STACKING, DATA_PROCESSED,
    FPL_SIM,
)

logger = logging.getLogger(__name__)

PIPELINE_VERSION = "4.1.0"


def stable_seed_entropy(season: str, gameweek: int) -> int:
    """
    Deterministic simulation entropy for a (season, gameweek).

    Derived rather than random so a rerun reproduces the artifact bit-for-bit:
    a diff then means a real parameter change, not a reseed. Python's built-in
    hash is salted per process and cannot be used for this.
    """
    import hashlib

    digest = hashlib.sha256(f"{season}:{gameweek}:fpl".encode()).digest()
    return int.from_bytes(digest[:4], "big")

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
            return False
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

    from pipeline.data.football_data import load_all_seasons
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
    fbref_features = {}

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
    from pipeline.features.engineer import engineer_training_and_upcoming_features
    features, upcoming_features = engineer_training_and_upcoming_features(
        matches,
        upcoming,
        fbref_features=fbref_features,
        player_stats=player_stats,
        referee_profiles=referee_profiles,
    )
    logger.info(
        f"  Feature rows: training={len(features)}, upcoming={len(upcoming_features)}"
    )

    # ── Step 4: Fit PenaltyBlog Baseline ─────────────────────────────
    logger.info("\n[4/12] Fitting PenaltyBlog baseline...")
    pb_predictions = {}
    pb_model = None
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
            home, away = row["home_team"], row["away_team"]
            if home in pb_model.teams and away in pb_model.teams:
                pb_predictions[key] = pb_model.predict_match(home, away)
            else:
                logger.info(
                    f"  PenaltyBlog skipped for unseen team(s): {home} vs {away}"
                )
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

        # Only attempt the experimental path when explicitly enabled.
        if ENABLE_STACKING and "season" in matches.columns and matches["season"].nunique() >= 3:

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
        elif not ENABLE_STACKING:
            logger.info("  Stacking disabled — using validated static weights")
        else:
            logger.info("  Insufficient seasons for stacking — using weighted average")
    except Exception as e:
        logger.warning(f"  Stacking meta-learner failed: {e}. Using static weights.")

    # ── Step 8: Fetch Live Odds ──────────────────────────────────────
    logger.info("\n[8/12] Fetching live odds from The Odds API...")
    all_live_odds = {"main": None, "additional": []}
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
            n_additional = len(all_live_odds.get("additional") or [])
            logger.info(
                f"  Odds API: featured={n_main}, "
                f"additional={n_additional} events"
            )
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
        if all_live_odds.get("additional"):
            parsed_additional = parse_match_odds(all_live_odds["additional"])
            for match_key, extra in parsed_additional.items():
                if match_key not in parsed_main:
                    parsed_main[match_key] = extra
                elif extra.get("btts"):
                    parsed_main[match_key]["btts"] = extra["btts"]
            parsed_corners = parse_alt_totals(
                all_live_odds["additional"], "alternate_totals_corners"
            )
            parsed_cards = parse_alt_totals(
                all_live_odds["additional"], "alternate_totals_cards"
            )
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

    for _, row in upcoming.iterrows():
        home, away = row["home_team"], row["away_team"]
        key = f"{home}_vs_{away}"
        kickoff = pd.to_datetime(row.get("kickoff"), utc=True, errors="coerce")
        fixture_date = (
            kickoff.strftime("%Y%m%d")
            if pd.notna(kickoff)
            else CURRENT_SEASON
        )
        match_id = f"{fixture_date}_{home}_{away}".replace(" ", "_")
        derby = _is_derby(home, away)

        # Referees must come from the upcoming fixture itself. Reusing the
        # referee from a historical meeting creates false precision.
        match_referee = row.get("referee")
        if pd.isna(match_referee):
            match_referee = None

        match_feature_row = upcoming_features[
            upcoming_features["match_id"] == match_id
        ]

        # Make unchanged inputs reproducible across daily runs.
        fixture_seed = int(
            hashlib.sha256(f"{match_id}_{PIPELINE_VERSION}".encode()).hexdigest()[:8],
            16,
        )
        np.random.seed(fixture_seed)

        logger.info(f"  Simulating: {home} vs {away} (derby={derby}, ref={match_referee})...")

        # Get lambda/mu from available models
        lambda_h, mu_a = 1.4, 1.1  # Default
        dc_lam_samples = None
        dc_mu_samples = None

        if dc_model is not None:
            try:
                dc_lam_samples, dc_mu_samples = dc_model.get_lambda_mu_samples(
                    home, away, n_sims
                )
                lambda_h = float(np.mean(dc_lam_samples))
                mu_a = float(np.mean(dc_mu_samples))
            except Exception as e:
                logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")

        # Gather per-model lambdas for ensemble blending
        model_lambdas = {}
        if dc_lam_samples is not None and dc_mu_samples is not None:
            model_lambdas["dixon_coles"] = (lambda_h, mu_a)

        if xgb_model is not None:
            try:
                if len(match_feature_row) > 0:
                    xgb_lam, xgb_mu = xgb_model.predict_single(
                        match_feature_row.iloc[0].to_dict()
                    )
                    model_lambdas["xgboost"] = (xgb_lam, xgb_mu)
                else:
                    logger.warning(f"  No upcoming feature row found for {match_id}")
            except Exception as e:
                logger.warning(f"  XGBoost prediction failed: {e}")

        pb_pred = pb_predictions.get(key)
        if pb_pred:
            pb_lam = pb_pred.get("expected_goals", {}).get("home")
            pb_mu = pb_pred.get("expected_goals", {}).get("away")
            if pb_lam is not None and pb_mu is not None:
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

        if dc_lam_samples is not None and dc_mu_samples is not None:
            # Preserve the Bayesian posterior's relative uncertainty while
            # centring it on the actual ensemble-blended goal rates.
            lam_mean = max(float(np.mean(dc_lam_samples)), 1e-6)
            mu_mean = max(float(np.mean(dc_mu_samples)), 1e-6)
            blended_lam_samples = dc_lam_samples * (lambda_h / lam_mean)
            blended_mu_samples = dc_mu_samples * (mu_a / mu_mean)
            sims = simulator.simulate_from_posterior(
                blended_lam_samples, blended_mu_samples, **sim_kwargs
            )
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
            if live.get("totals"):
                odds_comparison["totals"] = live["totals"]
            if live.get("btts"):
                odds_comparison["btts"] = live["btts"]
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
                if len(match_feature_row) > 0:
                    shap_data = explain_match(
                        xgb_model.model_home, xgb_model.model_away,
                        match_feature_row, xgb_model.feature_cols
                    )
            except Exception as e:
                logger.warning(f"  SHAP failed: {e}")

        # Value bets (with all markets)
        from pipeline.risk.kelly import find_value_bets

        # Current recommendations are based exclusively on current Odds API
        # prices. Historical closing odds remain evaluation benchmarks only.
        odds_benchmark = {}
        if key in parsed_main:
            live = parsed_main[key]
            if live.get("h2h"):
                odds_benchmark["odds_home_bet365"] = live["h2h"].get("home")
                odds_benchmark["odds_draw_bet365"] = live["h2h"].get("draw")
                odds_benchmark["odds_away_bet365"] = live["h2h"].get("away")
                odds_benchmark["bookmaker_home"] = live["h2h"].get("bookmaker_home")
                odds_benchmark["bookmaker_draw"] = live["h2h"].get("bookmaker_draw")
                odds_benchmark["bookmaker_away"] = live["h2h"].get("bookmaker_away")
            if live.get("totals"):
                odds_benchmark["totals"] = live["totals"]
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
            "season": CURRENT_SEASON_LABEL,
            "gameweek": gameweek,
            "pipeline_version": PIPELINE_VERSION,
            "models": [
                name
                for name, active in [
                    ("dixon_coles_pymc", dc_model is not None),
                    ("xgboost", xgb_model is not None),
                    ("penaltyblog", bool(pb_predictions)),
                ]
                if active
            ],
            "sub_models": ["corners_negbin_adj", "cards_zip_referee", "player_cards", "goalscorer"],
            "n_simulations": n_sims,
            "calibrated": False,
            "odds_source": "the_odds_api" if parsed_main else "unavailable",
            "referee_profiles_count": len(referee_profiles),
            "ensemble_method": ensemble_method,
            "stacking_weights": stacking_weights,
        },
        "predictions": all_predictions,
    }

    from pipeline.validation.artifacts import assert_valid_prediction_output
    assert_valid_prediction_output(output)

    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)
    forecast_metrics = {}
    calibration_data = {"bins": []}

    from pipeline.validation.ledger import update_forecast_ledger, evaluate_ledger

    # The ledger WRITE must fail loudly. It is the only artifact proving a
    # forecast predated kickoff, and CLAUDE.md forbids sourcing any accuracy
    # claim from latest.json. This call used to sit inside a try/except that
    # only warned, which is exactly why forecast_ledger.json never existed for
    # the pipeline's entire history: every failure was invisible.
    forecast_ledger = update_forecast_ledger(
        output, PREDICTIONS_DIR / "forecast_ledger.json"
    )

    # Scoring the ledger is reporting, not a durability guarantee, and it
    # depends on live outcome data that may legitimately be unavailable
    # (off-season, unsettled fixtures). This half may degrade.
    try:
        forecast_metrics, calibration_data = evaluate_ledger(
            forecast_ledger, bootstrap, fixtures_raw
        )
    except Exception as e:
        logger.warning(f"  Forecast ledger evaluation failed: {e}")

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
        "season": CURRENT_SEASON_LABEL,
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
                # build_player_stats already converts FPL's integer tenths to £m.
                "fpl_price": float(row.get("now_cost", 0)) if row.get("now_cost") else None,
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
        from pipeline.data.fpl_api import build_league_table
        team_list = build_league_table(bootstrap, fixtures_raw)

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

    # ── FPL player-level expected points ─────────────────────────────
    # Additive and deliberately non-fatal. FPL_SIM["required"] stays False until
    # several gameweeks have been scored, so until then a failure here records
    # itself in health.json and leaves every match-prediction artifact — and the
    # Kelly path — completely untouched. The FPL layer must not be able to take
    # the betting pages down.
    #
    # Reuses `all_predictions`: expected_goals is the already-blended ensemble
    # expectation, so this hooks in without touching the Monte Carlo loop.
    # FPL_SIM is imported at MODULE scope, not here. The except clause below
    # reads it, and an ImportError inside this try — the very case the handler
    # exists to tolerate — would otherwise leave the name unbound and raise
    # NameError out of the handler, crashing the whole pipeline and taking the
    # betting pages down. That is the exact opposite of the intended behaviour.
    fpl_status: Dict = {"status": "skipped", "reason": "not attempted"}
    try:
        from pipeline.data.priors.snapshot import load_player_priors
        from pipeline.fpl.artifacts import export_gameweek_xp
        from pipeline.fpl.rules import load_rules as load_fpl_rules
        from pipeline.learning.backfill import load_archive_season
        from pipeline.models.fpl_inputs import (
            build_fpl_inputs,
            fixture_specs_from_predictions,
        )
        from pipeline.simulation.gameweek_sim import simulate_gameweek

        logger.info("\n[10b] FPL player-level expected points...")
        fpl_rules = load_fpl_rules(bootstrap)

        try:
            fpl_priors = load_player_priors()
        except FileNotFoundError:
            fpl_priors = None
            logger.warning("  no committed prior-season snapshot; using archive only")

        fpl_specs = fixture_specs_from_predictions(all_predictions, gameweek)
        if not fpl_specs:
            fpl_status = {"status": "skipped", "reason": "no fixtures with expected goals"}
        else:
            fpl_archive = load_archive_season("2526")
            fpl_inputs = build_fpl_inputs(
                bootstrap, fpl_archive, fpl_priors, fpl_rules
            )
            n_fpl_draws = (
                FPL_SIM["n_draws_ci"] if ci_env else FPL_SIM["n_draws_decision"]
            )
            fpl_draws = simulate_gameweek(
                fpl_specs,
                fpl_inputs.squads,
                fpl_inputs.events,
                fpl_rules,
                n_draws=n_fpl_draws,
                seed_entropy=stable_seed_entropy(CURRENT_SEASON, gameweek),
                all_element_ids=fpl_inputs.all_element_ids,
            )
            export_gameweek_xp(
                fpl_draws,
                CURRENT_SEASON,
                datetime.utcnow().isoformat() + "Z",
                fpl_rules,
                PREDICTIONS_DIR,
                stable_seed_entropy(CURRENT_SEASON, gameweek),
                fpl_specs,
            )
            fpl_status = {
                "status": "degraded" if fpl_rules.degraded else "ok",
                "gameweek": int(fpl_draws.gameweek),
                "n_players": len(fpl_draws.element_ids),
                "n_draws": n_fpl_draws,
                "rules_source": fpl_rules.source,
                "rules_degraded": bool(fpl_rules.degraded),
                "diagnostics": fpl_inputs.diagnostics,
                "simulation": fpl_draws.notes,
            }
            logger.info(f"  FPL xp exported for GW{fpl_draws.gameweek}")
    except Exception as e:
        if FPL_SIM.get("required"):
            raise
        fpl_status = {"status": "failed", "reason": str(e)[:300]}
        logger.warning(f"  FPL expected-points step failed (non-fatal): {e}")

    # ── Health JSON (for frontend Model Health page) ───────────────
    logger.info("  Exporting health.json...")
    try:
        health_data = {
            "last_updated": datetime.utcnow().isoformat() + "Z",
            "gameweek": gameweek,
            "n_predictions": len(all_predictions),
            "status": "healthy",
            "forecast_validation_status": (
                "evaluated"
                if forecast_metrics.get("n_evaluated_matches", 0) >= 100
                else "collecting"
            ),
            "model_metrics": forecast_metrics,
            "calibration": calibration_data,
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
            "odds_source": "the_odds_api" if parsed_main else "unavailable",
            "referee_profiles_count": len(referee_profiles),
            "fpl": fpl_status,
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
