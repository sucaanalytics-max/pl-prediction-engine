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
# SEASONS are completed Premier League seasons used for model training.
# CURRENT_SEASON identifies the season served by the live FPL API. Keeping
# these concepts separate avoids labelling a new season with the final
# training season.
SEASONS = ["2324", "2425", "2526"]
SEASON_LABELS = {
    "2324": "2023-24",
    "2425": "2024-25",
    "2526": "2025-26",
    "2627": "2026-27",
}
CURRENT_SEASON = os.environ.get("PL_CURRENT_SEASON", "2627")
CURRENT_SEASON_LABEL = SEASON_LABELS.get(CURRENT_SEASON, CURRENT_SEASON)

# ── Data Sources ───────────────────────────────────────────────────────────
FOOTBALL_DATA_URL = "https://www.football-data.co.uk/mmz4281/{season}/E0.csv"
FOOTBALL_DATA_SEASONS = {
    "2324": "2324",
    "2425": "2425",
    "2526": "2526",
}

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_BASE = "https://api.the-odds-api.com/v4"
ODDS_API_SPORT = "soccer_epl"
ODDS_API_CACHE_MINUTES = 30
# Additional soccer markets use the per-event endpoint and consume materially
# more quota than featured h2h/totals. They are opt-in for scheduled runs.
ODDS_FETCH_ADDITIONAL = os.environ.get("ODDS_FETCH_ADDITIONAL", "false").lower() == "true"
ODDS_ADDITIONAL_REGIONS = os.environ.get("ODDS_ADDITIONAL_REGIONS", "uk")
ODDS_ADDITIONAL_HORIZON_HOURS = int(os.environ.get("ODDS_ADDITIONAL_HORIZON_HOURS", "72"))

FPL_API_BASE = "https://fantasy.premierleague.com/api"
FPL_BOOTSTRAP = f"{FPL_API_BASE}/bootstrap-static/"
FPL_FIXTURES = f"{FPL_API_BASE}/fixtures/"
FPL_ELEMENT_SUMMARY = f"{FPL_API_BASE}/element-summary/{{player_id}}/"
FPL_EVENT_LIVE = f"{FPL_API_BASE}/event/{{gameweek}}/live/"

# Manager-specific ("entry") endpoints. All unauthenticated GETs.
FPL_ENTRY = f"{FPL_API_BASE}/entry/{{entry_id}}/"
FPL_ENTRY_HISTORY = f"{FPL_API_BASE}/entry/{{entry_id}}/history/"
FPL_ENTRY_TRANSFERS = f"{FPL_API_BASE}/entry/{{entry_id}}/transfers/"
FPL_ENTRY_PICKS = f"{FPL_API_BASE}/entry/{{entry_id}}/event/{{gameweek}}/picks/"

# ── FPL agent: prior-season priors and archive backfill ────────────────────
# The pre-season bootstrap carries LAST season's per-player aggregates
# (total_points, minutes, starts, defensive_contribution, ...). FPL zeroes
# them the moment the new season starts, with no recovery path from the API.
# PRIORS_DIR is committed to git deliberately: it is the only durable copy.
PRIORS_DIR = ROOT_DIR / "pipeline" / "data" / "priors"

# Community mirror of settled per-gameweek player data. Used only for
# training priors, baselines and the scoring-function replay oracle — never
# in a live decision path, and never as a source of rules.
FPL_ARCHIVE_URL = (
    "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League"
    "/master/data/{season_label}/gws/merged_gw.csv"
)
# 2425 lacks the defensive-contribution columns (the mechanic did not exist),
# so it supports the minutes and goal-share blocks only.
FPL_ARCHIVE_SEASONS = ["2526", "2425"]

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
    "trailing_boost": 0.20,  # +20% corner rate when trailing
}

CARDS = {
    "distribution": "zero_inflated_poisson",
    "rolling_window": 10,
    "trailing_foul_boost": 0.15,  # +15% card rate when trailing
    "derby_boost": 0.8,  # +0.8 expected cards in derbies
    "min_player_minutes": 900,  # Min minutes for player card model
}

# ── Ensemble Weights ───────────────────────────────────────────────────────
ENSEMBLE_WEIGHTS = {
    "dixon_coles": 0.60,
    "xgboost": 0.30,
    "penaltyblog": 0.10,
}
# Stacking remains experimental until its OOF path uses the same engineered
# fixture features as production inference.
ENABLE_STACKING = os.environ.get("ENABLE_STACKING", "false").lower() == "true"

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
    "min_edge": 0.05,               # 5% minimum edge to flag (1X2/BTTS)
    "min_edge_corners": 0.07,       # 7% min edge for corners (semi-liquid)
    "min_edge_cards": 0.08,         # 8% min edge for cards (less liquid)
    "min_edge_player_booked": 0.10, # 10% min edge for player booked (thin)
    "max_stake_pct": 0.05,          # 5% max bankroll per bet
    "drawdown_soft_limit": 0.20,    # Reduce stakes at 20% drawdown
    "drawdown_hard_limit": 0.30,    # Pause at 30% drawdown
}

# ── FPL agent: simulation ──────────────────────────────────────────────────
FPL_SIM = {
    # Stays False until four gameweeks have been scored. While False, an FPL
    # layer failure must not block the match-prediction artifacts.
    "required": False,
    "n_draws_decision": 10_000,
    "n_draws_horizon": 5_000,
    "n_draws_ci": 5_000,
    "horizon": 6,
}

# ── FPL agent: learnable parameters ────────────────────────────────────────
# Every parameter the learning loop may touch is declared here with a tier,
# hard bounds and a stated provenance. Anything not in this registry is not
# refit-eligible, by construction.
#
# Tiers:
#   F  fittable — enough independent observations to identify it. Refit is
#      gated on out-of-sample improvement plus the guardrails below.
#   S  shrunk — fitted only as a deviation from a prior, never freely.
#   C  constant — human-authored. There is not enough signal in 38 noisy
#      gameweeks a season to identify these, and fitting them is precisely how
#      a system convinces itself it is improving. Never refit-eligible.
#
# `bounds` are hard clamps: a refit outside them is rejected, not clipped.
# `source` is required and tested — an unsourced parameter is a magic number.
#
# INVARIANT (tested): set(PARAM_REGISTRY) and set(RISK) are disjoint. Nothing
# the learning loop can move may touch staking.
PARAM_REGISTRY = {
    "minutes.start_shrinkage": {
        "value": 0.75,
        "bounds": (0.1, 40.0),
        "tier": "F",
        "source": (
            "Beta-binomial pseudo-count in fixtures. Selected on the 2024-25 "
            "walk-forward backtest and validated on held-out 2025-26; the "
            "validation season was not consulted during selection. A clear "
            "interior optimum: Brier bottoms at 0.5-0.75 and ECE at 0.75, "
            "degrading both above (fringe players dragged toward the position "
            "mean) and below 0.5 (single observations become overconfident). "
            "The initial guess of 8.0 over-predicted appearance by 5.7x in the "
            "lowest calibration bin — 0.068 against a realised 0.012 — which "
            "is exactly the error that makes cheap bench filler look playable."
        ),
    },
    "minutes.minutes_shrinkage": {
        "value": 2.0,
        "bounds": (0.1, 40.0),
        "tier": "F",
        "source": (
            "As start_shrinkage, for mean minutes conditional on role. WEAKLY "
            "IDENTIFIED: minutes MAE moves only 17.36 to 17.69 across a 21x "
            "range of this parameter on the tuning season, so the data does not "
            "distinguish values in it. Set to a non-boundary value within noise "
            "of the optimum rather than to the argmin, which would be false "
            "precision."
        ),
    },
    "minutes.p60_shrinkage": {
        "value": 0.75,
        "bounds": (0.1, 40.0),
        "tier": "F",
        "source": (
            "As start_shrinkage, for P(60+ minutes | started), and selected "
            "jointly with it on the 2024-25 tuning season."
        ),
    },
    "minutes.doubtful_default": {
        "value": 0.75,
        "bounds": (0.3, 0.95),
        "tier": "S",
        "source": (
            "Applied only when status is 'd' and chance_of_playing is absent. "
            "FPL's own field is sparse and lags, so this fills a gap rather "
            "than replacing data. Never 1.0: a doubt is information."
        ),
    },
    "minutes.injured_default": {
        "value": 0.10,
        "bounds": (0.0, 0.4),
        "tier": "S",
        "source": (
            "Applied when status is 'i' or 's' and chance_of_playing is absent. "
            "Deliberately low but non-zero, because FPL sometimes clears a "
            "player without updating the chance field."
        ),
    },
    "minutes.news_staleness_days": {
        "value": 21.0,
        "bounds": (7.0, 60.0),
        "tier": "C",
        "source": (
            "Age at which an unchanged injury note stops suppressing "
            "availability. Constant: with a handful of long-term absences per "
            "season there is no power to fit a decay curve."
        ),
    },
    "events.rate_shrinkage_per90": {
        "value": 450.0,
        "bounds": (90.0, 2000.0),
        "tier": "F",
        "source": (
            "Pseudo-minutes for shrinking a per-90 rate toward its position "
            "prior. 450 is five full matches. Unfitted."
        ),
    },
}

# ── Derby / Rivalry Matchups ──────────────────────────────────────────────
# These matchups historically produce more fouls and cards
DERBIES = [
    ("Arsenal", "Tottenham"),       # North London derby
    ("Liverpool", "Everton"),       # Merseyside derby
    ("Man United", "Man City"),     # Manchester derby
    ("Man United", "Liverpool"),    # Historic rivalry
    ("Arsenal", "Chelsea"),         # London derby
    ("Chelsea", "Tottenham"),       # London derby
    ("Crystal Palace", "Brighton"), # M23 derby
    ("Wolves", "Aston Villa"),      # West Midlands derby
    ("Newcastle", "Sunderland"),    # Tyne-Wear derby
    ("Leeds", "Man United"),        # Roses rivalry
    ("Burnley", "Leeds"),           # Pennine derby
    ("Everton", "Liverpool"),       # (reverse)
    ("Tottenham", "Arsenal"),       # (reverse)
    ("Man City", "Man United"),     # (reverse)
]

# ── Evaluation Targets ─────────────────────────────────────────────────────
EVAL = {
    "brier_target": 0.22,
    "log_loss_target": 1.0,
    "calibration_error_target": 0.05,
    "backtest_min_matches": 100,
}

# ── Premier League Teams 2026-27 ──────────────────────────────────────────
# The live pipeline derives the authoritative mapping from FPL bootstrap data;
# this list is a documented fallback for offline use.
PL_TEAMS = [
    "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
    "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham",
    "Hull City", "Ipswich", "Leeds", "Liverpool", "Man City",
    "Man United", "Newcastle", "Nott'm Forest", "Sunderland", "Tottenham",
]

# ── Player Data Quality Corrections ──────────────────────────────────────────
# Keep season-specific corrections empty by default. The live FPL roster and
# status fields are authoritative; hardcoded transfer overrides become harmful
# when team IDs and squads roll into a new season.
PLAYER_TEAM_OVERRIDES: dict = {}
EXCLUDED_PLAYERS: set = set()
