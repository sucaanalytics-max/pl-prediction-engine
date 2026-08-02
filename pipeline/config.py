"""
PL Prediction Engine — Configuration
All hyperparameters, URLs, paths, and constants.
"""
import os
from pathlib import Path
from typing import Any, Dict

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

# Where the stripped, publishable copy of a decision goes. The frontend reads
# from here; the private artifact with counterfactuals and the selection-stream
# score stays under predictions/fpl/.
FPL_PUBLIC_DIR = ROOT_DIR / "frontend" / "public" / "predictions" / "fpl"

# ── FPL agent: the two entries ─────────────────────────────────────────────
# Two teams, two mandates, one simulator. The objectives are mathematically
# opposed and that is the point: writing your margin over the field as
# D = sum_j (m_j - EO_j) * P_j, the term sum_j EO_j * xP_j is a constant nobody
# can influence, so effective ownership CANNOT change the EV-optimal pick — it
# only changes Var[D]. The season team therefore ignores ownership entirely and
# the weekly team is entirely about it. Three players from one attack is wrong
# for one squad and right for the other, from identical projections.
#
# `entry_id` stays None until the accounts exist. `squad` empty means the
# opening build, where the whole budget is cash; once a squad is held, `bank`
# (cash in hand, in TENTHS) and `purchase_prices` must both be supplied, because
# selling price is purchase plus half the rise and cannot be recovered from
# now_cost alone.
FPL_ENTRIES: Dict[str, Dict[str, Any]] = {
    "season": {
        # "Ronny" — https://fantasy.premierleague.com/en/entry/2561567/
        "entry_id": int(os.environ.get("FPL_ENTRY_SEASON", "2561567")),
        "team_name": "Ronny",
        "objective": "season",       # maximise expected points; variance is a cost
        "squad": [],
        "bank": None,
        "free_transfers": 1,
        "purchase_prices": None,
    },
    "weekly": {
        # "Wazza" — https://fantasy.premierleague.com/en/entry/2561099/
        "entry_id": int(os.environ.get("FPL_ENTRY_WEEKLY", "2561099")),
        "team_name": "Wazza",
        # Maximise P(score >= threshold). Variance is an ASSET here: a weekly
        # prize needs a right-tail outcome, and correlated players are how a
        # tail is reached.
        "objective": "weekly",
        "squad": [],
        "bank": None,
        "free_transfers": 1,
        "purchase_prices": None,
    },
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
        "value": 0.25,
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
    "minutes.recency_half_life_fixtures": {
        "value": 1.5,
        "bounds": (1.0, 80.0),
        "tier": "F",
        "source": (
            "Half-life in fixtures for exponentially down-weighting a player's "
            "older appearances. Selected on the 2024-25 walk-forward backtest "
            "and validated on held-out 2025-26.\n\n"
            "Added because uniform weighting was a real deficiency, not a "
            "refinement: with the recency baseline correctly implemented, a "
            "trivial five-fixture heuristic beat this model on Brier (0.1069 vs "
            "0.1313) and on both MAE bands, losing only on calibration. A model "
            "that weights a benched player's thirty-game-old starts as heavily "
            "as last week cannot track a lost place in the side.\n\n"
            "1.5 fixtures is aggressive and deliberately so: Brier is flat "
            "across 1.0-1.5 on the tuning season and ECE breaks that tie at 1.5. "
            "It means the last one or two team selections dominate, which is "
            "what the data says predicts the next one. The lower bound is 1.0 "
            "because the tuning sweep reached it; the registry test refused the "
            "value until the bound was widened to match the evidence, which is "
            "the guardrail behaving correctly."
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
        "value": 0.25,
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
    "minutes.horizon_availability_floor": {
        "value": 0.80,
        "bounds": (0.5, 1.0),
        "tier": "F",
        "source": (
            "Availability decays with forecast horizon and then flattens: a "
            "player fit today may be injured, rested or out of favour in six "
            "weeks, but the risk accumulates toward a long-run base rate rather "
            "than compounding forever.\n\n"
            "Measured in our own archive over both seasons (12,000+ anchors per "
            "step): players who started gameweek g average 69.4 minutes at g+1 "
            "and 56.3 at g+9, a ratio of 0.811 with a steep-then-flat shape. "
            "Fitted floor + (1-floor)*rho^h gives floor 0.80, rho 0.73, RMSE "
            "0.0025 across nine steps.\n\n"
            "The structure was noticed in FPL Review's own exported projections, "
            "whose xMins for GW1 starters falls 87.8 to 74.1 across ten "
            "gameweeks (ratio 0.844) — broad-based, monotone, with no player "
            "collapsing to zero. The INSIGHT is theirs; these PARAMETERS are "
            "fitted to our data, not copied."
        ),
    },
    "minutes.horizon_availability_rho": {
        "value": 0.73,
        "bounds": (0.3, 0.99),
        "tier": "F",
        "source": (
            "Rate of reversion toward minutes.horizon_availability_floor. See "
            "that parameter for the fit. Governs how fast current team-selection "
            "information stops being informative about a future gameweek."
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
    "minutes.substitutes_per_fixture": {
        "value": 4.14,
        "bounds": (2.0, 6.0),
        "tier": "F",
        "source": (
            "Measured directly: 4.14 substitutes appear per fixture-team across "
            "the settled 2025-26 season (760 fixture-team observations, grouped "
            "by fixture so a double gameweek is not merged). Used to calibrate "
            "the bench-appearance layer at squad level.\n\n"
            "This corrects a genuine data limitation rather than tuning a taste "
            "parameter. The quantity the simulator needs is P(appear | named "
            "among the substitutes), but the archive lists the whole registered "
            "squad — about 39 rows per fixture-team — so the estimable quantity "
            "P(appear | did not start) is diluted by players who were never in "
            "the matchday squad. Uncalibrated, the model produced 2.99 "
            "substitute appearances against a real 4.14, a 28% shortfall. One "
            "aggregate against 760 observations is comfortably identifiable, "
            "unlike the per-player conditional it stands in for."
        ),
    },
    "events.recency_half_life_fixtures": {
        "value": 40.0,
        "bounds": (1.0, 80.0),
        "tier": "F",
        "source": (
            "Half-life in fixtures for exponentially down-weighting a player's "
            "older event exposure. Selected on the 2024-25 walk-forward "
            "backtest, validated on held-out 2025-26.\n\n"
            "Longer than the minutes half-life of 1.5 on purpose. Team selection "
            "is a decision that flips week to week, so the last one or two "
            "matter most; scoring RATES are a slower-moving property of a "
            "player and averaging them over one or two games would be almost "
            "pure noise. Same mechanism, different natural timescale."
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
