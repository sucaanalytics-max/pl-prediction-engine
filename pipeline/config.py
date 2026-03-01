"""
PL Prediction Engine — Configuration
All hyperparameters, URLs, paths, and constants.
"""
import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT_DIR / "data" / "raw"
DATA_PROCESSED = ROOT_DIR / "data" / "processed"
PREDICTIONS_DIR = ROOT_DIR / "predictions"

# ── Seasons ────────────────────────────────────────────────────────────────
SEASONS = ["2324", "2425", "2526"]
SEASON_LABELS = {"2324": "2023-24", "2425": "2024-25", "2526": "2025-26"}
CURRENT_SEASON = "2526"

# ── Data Sources ───────────────────────────────────────────────────────────
FOOTBALL_DATA_URL = "https://www.football-data.co.uk/mmz4281/{season}/E0.csv"
FOOTBALL_DATA_SEASONS = {
    "2324": "2324",
    "2425": "2425",
    "2526": "2526",
}

FPL_API_BASE = "https://fantasy.premierleague.com/api"
FPL_BOOTSTRAP = f"{FPL_API_BASE}/bootstrap-static/"
FPL_FIXTURES = f"{FPL_API_BASE}/fixtures/"
FPL_ELEMENT_SUMMARY = f"{FPL_API_BASE}/element-summary/{{player_id}}/"

# ── Team Name Mapping ──────────────────────────────────────────────────────
# Maps Football-Data.co.uk names → canonical names
# Extended in team_mapping.py with FBref + FPL mappings

# ── Model Hyperparameters ──────────────────────────────────────────────────
DIXON_COLES = {
    "xi_decay": 0.003,              # Time decay parameter
    "rho_bounds": (-0.3, 0.3),      # Low-score correlation bounds
    "home_advantage_prior_mean": 0.25,
    "home_advantage_prior_sd": 0.1,
    "pymc_draws": 2000,
    "pymc_tune": 1000,
    "pymc_chains": 2,               # 2 chains for Actions runtime budget
    "pymc_target_accept": 0.9,
}

XGBOOST = {
    "n_estimators": 500,
    "max_depth": 6,
    "learning_rate": 0.05,
    "early_stopping_rounds": 50,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
}

CORNERS = {
    "distribution": "negative_binomial",
    "rolling_window": 10,
}

CARDS = {
    "distribution": "zero_inflated_poisson",
    "rolling_window": 10,
}

# ── Ensemble Weights ───────────────────────────────────────────────────────
ENSEMBLE_WEIGHTS = {
    "dixon_coles": 0.60,
    "xgboost": 0.30,
    "penaltyblog": 0.10,
}

# ── Feature Engineering ────────────────────────────────────────────────────
ROLLING_WINDOWS = [3, 5, 10]
ELO = {
    "k_factor": 20,
    "home_advantage": 50,
    "initial_rating": 1500,
    "mean_reversion": 0.33,         # Regress 1/3 to mean each season
}

# ── Simulation ─────────────────────────────────────────────────────────────
N_SIMULATIONS = 10_000
MAX_GOALS = 7                        # Max goals per team in scoreline grid

# ── Risk Management ────────────────────────────────────────────────────────
RISK = {
    "kelly_fraction": 1.0,           # Full Kelly
    "half_kelly": True,              # Also compute half Kelly
    "min_edge": 0.05,               # 5% minimum edge to flag
    "max_stake_pct": 0.05,          # 5% max bankroll per bet
    "drawdown_soft_limit": 0.20,    # Reduce stakes at 20% drawdown
    "drawdown_hard_limit": 0.30,    # Pause at 30% drawdown
}

# ── Evaluation Targets ─────────────────────────────────────────────────────
EVAL = {
    "brier_target": 0.22,
    "log_loss_target": 1.0,
    "calibration_error_target": 0.05,
    "backtest_min_matches": 100,
}

# ── Premier League Teams 2025-26 ──────────────────────────────────────────
# Promoted from Championship 2024-25: Burnley, Leeds, Sunderland
# Relegated after 2024-25: Ipswich, Leicester, Southampton
PL_TEAMS = [
    "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
    "Burnley", "Chelsea", "Crystal Palace", "Everton", "Fulham",
    "Leeds", "Liverpool", "Man City", "Man United", "Newcastle",
    "Nott'm Forest", "Sunderland", "Tottenham", "West Ham", "Wolves",
]
