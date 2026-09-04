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

# ── Availability news feeds ────────────────────────────────────────────────
#
# The press-conference cluster. Six feeds, all verified live, all permitted to
# CONSUME — which is not the same as permitted to republish, so only derived
# claims and short quotes reach any artifact.
#
# Deliberately excluded, on terms rather than on cost:
#   * premierinjuries.com — terms §3.4 permits storing content "but not any
#     server or other storage device connected to a network"; §1.2 forbids
#     reproduction. robots.txt is all-allow and irrelevant. A licensing route
#     exists at /newsroom/injury-data if this ever needs revisiting.
#   * YouTube transcripts — barred by four separate clauses. Metadata via the
#     official Data API is fine and is a separate connector.
#
# `tier` maps onto TIERS in pipeline/learning/availability_evidence.py and is the
# ONLY thing that grants a feed authority. Rule R4 already prevents a tier-2 or
# tier-3 source from raising availability above FPL's own field; it may only push
# it down. Wiring a feed at the wrong tier is therefore a real safety bug, which
# is why every entry is asserted in the tests.
#
# URLs are the POST-REDIRECT canonical form. Three of the six 301 to a different
# host or path, and following a redirect on every poll doubles the request count
# for no benefit.
NEWS_FEEDS = (
    {
        "name": "hayters",
        "url": "https://hayters.com/feed/",
        "tier": 2,
        # The agency whose reporters are actually in the press conferences, so
        # this carries primary quotes rather than aggregation.
        "note": "press agency, primary quotes",
    },
    {
        "name": "allaboutfpl",
        "url": "https://allaboutfpl.com/feed/",
        "tier": 3,
        # The SITE feed, not a category feed. Measured 2026-08-06:
        #
        #   /feed/                                    newest 2026-08-05  ACTIVE
        #   /category/fpl-press-conference-updates/   newest 2025-10-02  dormant
        #   /category/fpl-injury-news/                newest 2025-10-23  dormant
        #   /category/fpl-team-news/                   404
        #
        # The category endpoints were the obvious choice and are the wrong one: the
        # site posts daily but stopped filing under those taxonomies. Their presser
        # roundups ("FPL GW7 Predicted Lineups, Injuries, & Press Conference
        # Updates") appear in the main feed too, so nothing is lost by watching it
        # instead — and one feed rather than two avoids recording the same article
        # twice under two source names.
        #
        # Tier 3 rather than 2, by the definition in availability_evidence.py:
        # tier 3 is "aggregator, predicted lineup", and a predicted line-up is
        # precisely what their flagship format is. Tier 2 is for the press
        # conference itself, which is Hayters' beat.
        "note": "site feed (not a category feed); FPL editorial + presser roundups",
    },
    {
        "name": "premierfantasytools",
        "url": "https://www.premierfantasytools.com/feed/",
        "tier": 3,
        # MEASURED 2026-08-06: the RSS carries editorial blog posts, NOT the
        # structured OUT/DOUBT/IN player table the research attributed to this
        # site. That table is on a web page, which is a scrape rather than a feed
        # and therefore out of scope. Low value via RSS.
        "note": "editorial blog posts only; the OUT/DOUBT/IN table is not in the feed",
    },
    {
        "name": "fantasyfootballscout",
        "url": "https://www.fantasyfootballscout.co.uk/feed",
        "tier": 3,
        "note": "FPL editorial; occasional injury and lineup mentions",
    },
    {
        "name": "bbc_football",
        "url": "https://feeds.bbci.co.uk/sport/football/rss.xml",
        "tier": 3,
        # Tier 3 rather than 2 despite being a primary outlet: the feed is
        # league-wide sport news, so an item is usually not team news at all.
        # Only a direct managerial quote would justify tier 2, and the extractor
        # cannot establish that from a headline.
        "note": "broad; low team-news density",
    },
    {
        "name": "sky_football",
        "url": "https://www.skysports.com/rss/11095",
        "tier": 3,
        "note": "broad; low team-news density",
    },
)

# Politeness and safety for the poller.
NEWS_FETCH = {
    # Response bytes accepted before parsing. Applied BEFORE feedparser sees the
    # payload, so a hostile or broken response cannot be parsed at all rather
    # than being parsed and then rejected.
    "max_bytes": 4_000_000,
    "timeout_seconds": 20,
    # Floor between two requests to the same host, regardless of the cron tick.
    # BBC and Sky return NO ETag and NO Last-Modified, so a conditional GET is
    # impossible for them and this interval is the only thing preventing a
    # 15-minute full re-download of feeds that change a few times a day.
    "min_interval_seconds": {"default": 600, "feeds.bbci.co.uk": 1800,
                             "www.skysports.com": 1800},
    "user_agent": "pl-prediction-engine/1.0 (+https://github.com/sucaanalytics-max/pl-prediction-engine)",
    # Entries older than this are not re-examined. Team news has a short shelf
    # life and the store is append-only, so re-reading a month of history on
    # every tick would cost work without producing a single new claim.
    "max_entry_age_days": 10,
}

# Adaptive polling window, derived from the fixture list because NO published
# press-conference schedule exists anywhere. Pressers land roughly a day or two
# before kickoff; the deadline itself is the other hot window.
# ── The Grok/X feed ──────────────────────────────────────────────────────────
#
# A file YOU control, which Grok appends to and the poller reads. Not X's API:
# the free tier has no tweet-read access and pay-per-use is ~£35/mo, which the
# £0 decision excludes. Reading your own notes is what the manual claim lane
# was built for.
#
# Dormant until GROK_FEED_URL is set as a repository secret. Schema and the
# prompt to paste to Grok: docs/grok-x-feed-schema.md.
# ── The X browser scan
#
# Accounts a Claude Code session reads from the logged-out X profile page via the
# Chrome MCP, writing rows to `predictions/fpl/x_inbox.csv` for the poller.
#
# Configuration lives here rather than in the scan prompt so the target list is
# reviewable in a diff. Adding an account is a code change with an owner, not an
# instruction someone typed once.
#
# `club` pins every row from a club-specific account; None means detect it per
# post from the text, via `x_scan.club_in`.
#
# Kept short deliberately. The logged-out view serves ~5 recent posts per profile,
# so value comes from picking accounts that post signal rather than from breadth,
# and every extra account is another page load per scan.
#
# ADMISSION CRITERION: "files FPL-relevant team news", NOT "tweets about
# football". This list is now also the trust boundary — `x_relevance` admits a
# post only from a page listed here (or from its author), including reposts, so an
# entry added in good faith widens what may be filed. @PolymarketSport is exactly
# the trap: nominally a sports account, and its measured contribution to the
# corpus is a post about Arsenal's wedding-package brochure. Without the criterion
# written down, this list rots by accretion and the trust layer decays into the
# club-name gate we deliberately refused to build.
X_SCAN_ACCOUNTS = (
    # Market-derived projections and pre-season minutes summaries. Named in the
    # plan as a comparator rather than a data dependency — we invert the same
    # no-vig prices ourselves in `models/market_rates.py`.
    {"handle": "robtFPL", "source": "x:robtFPL", "club": None},
)

#: How old a scraped post may be and still count as news.
#:
#: The name says max age and the comment used to describe scan CADENCE ("Twice
#: daily"), which is a different quantity — and neither mattered, because nothing
#: imported this while `x_scan.py` hardcoded the identical `3` at three separate
#: sites. A config constant that looks authoritative and is inert is worse than no
#: constant: the next person changes it and nothing moves.
#:
#: Three days is set by the scrape, not by taste: the logged-out page shows only the
#: most recent posts, so anything older has already fallen off the surface this can
#: see, and a longer window would only re-admit posts `merge_inbox` already deduped.
X_SCAN_MAX_AGE_DAYS = 3

GROK_FEED = {
    # xAI chat-completions endpoint. Only used when GROK_API_KEY is set; with a
    # GROK_FEED_URL instead, nothing here is read.
    "api_url": "https://api.x.ai/v1/chat/completions",
    "model": os.environ.get("GROK_MODEL", "grok-4-latest"),
    # Deterministic-ish. This is an extraction task, not a writing task, and a
    # warm model invents quotes — which is the one failure the schema cannot
    # detect.
    "temperature": 0.0,
    # The API call is metered, so this is a real ceiling and not a guess: at the
    # 3-hourly cadence it bounds the daily spend.
    "max_tokens": 4000,
    # Hours of X to search. Matches the agent's cadence so consecutive runs
    # barely overlap; see the dedupe note in docs/grok-x-feed-schema.md.
    "window_hours": 3,
    "timeout_seconds": 20,
    # Same size cap as the RSS fetcher, applied before parsing.
    "max_bytes": 2_000_000,
    # Items older than this are ignored: a claim about last month's fitness is
    # not team news, and the store is append-only so re-reading costs work
    # without producing a new claim.
    "max_age_days": 3,
}

# ── YouTube upload metadata ──────────────────────────────────────────────────
#
# Metadata only. Transcripts are excluded permanently — YouTube's terms bar them
# four separate ways, and buying them from a vendor does not launder that.
#
# Channel ids are deliberately absent until the key exists: an id list with no
# way to poll it is configuration pretending to be a connector. Add entries as
# {"name": ..., "channel_id": "UC...", "tier": 3} once YOUTUBE_API_KEY is set as
# a GitHub Actions repository secret. Tier 3 is the ceiling for this source —
# a video title is not a press conference, and R4 lets a tier-3 claim push
# availability down but never up.
YOUTUBE_CHANNELS: tuple = ()

YOUTUBE = {
    # Free tier is 10,000 units/day. Half is a deliberate ceiling, not a
    # prediction: fifteen channels at four polls an hour is ~1,440 units, and
    # the headroom absorbs a retry storm without starving tomorrow.
    "daily_unit_ceiling": 5_000,
    "max_results": 10,
    "timeout_seconds": 20,
    # YouTube's terms, not a tuning knob: API-derived data must be deleted
    # within 30 days.
    "max_storage_days": 30,
    # Distinct channels that must mention a club in one poll before it counts as
    # a burst. One channel posting four times is a content schedule; four
    # channels posting once each is news.
    "burst_threshold": 3,
}

NEWS_WINDOW = {
    "hours_before_kickoff_open": 72,
    "hours_before_kickoff_close": 2,
    "hours_before_deadline_open": 30,
}

# ── The news -> decision delta ─────────────────────────────────────────────
#
# What counts as a change worth telling the human about. Two stages, because the
# 15-minute poller runs on `requests` + `feedparser` alone while the MILP needs
# numpy and scipy at run time:
#
#   stage 1  the poller     resolution changed -> emit immediately (pure stdlib)
#   stage 2  the agent      xp and root-move impact -> enrich the same event
#
# Stage 2's threshold is the one that matters and it is **on the decision, not on
# the projection**: an xp move of 0.3 that flips nothing is not news, and one of
# 0.1 that flips the captain is. Stage 1 cannot see a decision, so its threshold
# is a materiality test on the availability value itself.
DELTA = {
    # FPL only ever emits 0/25/50/75/100 for chance_of_playing, so any move is a
    # band change and is material. The threshold exists for tier-2/3 claims filed
    # by hand, which can carry any integer.
    "chance_of_playing_points": 20,
    # A shift in an expected return date smaller than this is a nudge, not news.
    "return_date_days": 4,
    # Below this the plan is unchanged in substance even if the arithmetic moved.
    "xp_points": 0.30,
    # A flip of the root move or the captain is ALWAYS a delta regardless of EV,
    # because it changes what the human is being told to do.
    "always_on_flip": True,
    # First-run flood guard: a resolution appearing for the first time is only
    # news if it is not the ordinary available state. Without this, the first tick
    # after deployment emits one delta per flagged player in the league.
    "notable_new_chance_below": 100,
    "prune_to_gameweeks": 4,
}

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

    # Notional bankroll the published stake figures are denominated in. 1000.0
    # matches the default already hardcoded in `kelly_stake`, `find_value_bets`
    # and `check_portfolio_exposure`, so naming it here changes no number — it
    # gives the portfolio pass one place to read instead of a fourth literal.
    #
    # Every cap is a PERCENTAGE, so this only sets the units of `half_kelly` and
    # `full_kelly`; changing it does not change how much of the bank is risked.
    "bankroll": 1000.0,

    # Portfolio caps. See PORTFOLIO_LIMITS in pipeline/risk/kelly.py for the
    # measurement that produced the last two: the published card carried 35% of
    # bankroll live across 14 selections because no aggregate cap existed.
    "max_per_match_pct": 0.15,
    "max_per_team_pct": 0.30,
    "max_per_market_type_pct": 0.40,
    "max_correlated_bets": 5,
    "max_total_exposure_pct": 0.20,
    "max_per_direction_pct": 0.10,
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

# ── FPL agent: the owner's entry ───────────────────────────────────────────
# One entry, one objective: maximise expected points; variance is a cost.
# Effective ownership cannot move that pick anyway — writing the margin over
# the field as D = sum_j (m_j - EO_j) * xP_j, the term sum_j EO_j * xP_j is a
# constant nobody can influence, so EO changes Var[D] but never the EV-optimal
# squad.
#
# A `weekly` objective — maximise P(score >= threshold), where EO and
# correlated players ARE the point — used to run here as a second entry. It
# is gone, not merged: it was gated on `field_is_usable`, which reads a
# calibration verdict store that nothing writes, so the gate never opened and
# the weekly entry silently fell back to this same season objective on every
# run while claiming to be different. One entry on the objective it was
# actually running retires that dead gate along with the second account.
#
# `entry_id` stays None until the account exists. `squad` empty means the
# opening build, where the whole budget is cash; once a squad is held, `bank`
# (cash in hand, in TENTHS) and `purchase_prices` must both be supplied, because
# selling price is purchase plus half the rise and cannot be recovered from
# now_cost alone.
FPL_ENTRIES: Dict[str, Dict[str, Any]] = {
    # The owner's own team, and the only one this repo decides for.
    # https://fantasy.premierleague.com/en/entry/20945/
    #
    # Ronny (2561567) and Wazza (2561099) were removed on 2026-08-24 and moved to
    # a separate project that runs them on its own scheduled workflows. They read
    # this repo's published `xp_public_gw{NN}.json`; they must never write into
    # `predictions/fpl/ledger/` or any seal path here.
    #
    # The label is what names the artifact: `decision_gw{NN}_owner.json`.
    "owner": {
        "entry_id": int(os.environ.get("FPL_ENTRY_OWNER", "20945")),
        "team_name": "Jay's Team",
        # Maximise expected points; variance is a cost. The `weekly` objective is
        # deliberately absent: it is gated on `field_is_usable`, which reads a
        # calibration verdict store that nothing writes, so a weekly entry fell
        # back to this objective on every run while claiming to be different.
        "objective": "season",
        # Manual override and pre-season default only. `_read_entry` prefers the
        # committed capture, then FPL live, and only then these.
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
    # ── How an existing impairment decays across the horizon ─────────────
    # These four govern the bracket in
    #     a_h = horizon_availability_factor(h) * [1 - (1 - a_0) * kappa^h]
    # which reduces to the bare factor at a_0 = 1, so the two fitted parameters
    # above keep exactly the meaning they were fitted with.
    #
    # SAMPLE-SIZE HONESTY, up front: none of these four can pass
    # gates.gate_effective_sample, and they are not meant to. It requires ESS 500
    # per parameter, and flagged-player observations cluster at INJURY EPISODE,
    # not player-gameweek — one hamstring tear produces six correlated rows. A
    # season yields a few hundred episodes across the whole league. They are tier
    # S human-authored values with the derivations below; tier F would advertise a
    # refit path that will not open for at least two seasons.
    #
    # Measured from the committed pre-season snapshot (564 elements, 55 with
    # news): 10 absences carry an explicit return date, median 4.64 weeks out
    # (range 3.9-11.1); 18 are graded at 75%; 22 state an unknown return date.
    "minutes.impairment_persistence_graded": {
        "value": 0.45,
        "bounds": (0.10, 0.90),
        "tier": "S",
        "source": (
            "Weekly persistence of the availability deficit for a player FPL has "
            "graded with an explicit chance of playing (in the snapshot, always "
            "75%). A graded flag is a knock FPL expects to resolve imminently, so "
            "the deficit must decay fast: at 0.45 a 75% player reaches 84% of the "
            "healthy path after one week and 86% after two, i.e. converged.\n\n"
            "Derived as: a knock carrying a published 75% chance should have "
            "substantially resolved within ~2 gameweeks, so kappa^2 <= 0.2, "
            "giving kappa <= 0.45. Deliberately interior to its bounds so a "
            "future fit can move either way inside gate_move_size's 25% cap.\n\n"
            "Distinct from the open-ended rate below because the two are "
            "different processes, and one rate cannot serve both: a 75% knock "
            "does not persist for six weeks, while an undiagnosed injury does."
        ),
    },
    "minutes.impairment_persistence_open": {
        "value": 0.85,
        "bounds": (0.50, 0.98),
        "tier": "S",
        "source": (
            "Weekly persistence of the availability deficit for an absence with "
            "NO published return date — the 22 'Unknown return date' cases, plus "
            "any injured/suspended player carrying no chance field.\n\n"
            "These are precisely the absences FPL cannot date, so the 4.64-week "
            "median of the DATED subset is a lower bound on their length: a "
            "diagnosable injury is a shorter injury. At 0.85 a player at the 10% "
            "injured default reaches 22% of full availability after one week, 45% "
            "after four and 62% after eight — most undiagnosed injuries do resolve "
            "inside two months, and the curve says so without asserting a return.\n\n"
            "A single rate shared with the graded class was tried first and "
            "rejected: at the graded-appropriate 0.45 an unknown-return injury "
            "jumped from 10% to 35% availability in one week, which is not a "
            "defensible reading of 'we do not know when he is back'."
        ),
    },
    "minutes.return_ramp_weeks": {
        "value": 2.0,
        "bounds": (0.0, 6.0),
        "tier": "S",
        "source": (
            "Weeks over which a player returning from a DATED FITNESS absence "
            "climbs back to the healthy availability path. Applies only to "
            "'Expected back <date>' — a suspension gets no ramp at all, because a "
            "ban is an eligibility constraint and the player has been training "
            "throughout. That distinction is structural, not a tuned constant, so "
            "it cannot drift.\n\n"
            "Two weeks reflects the standard reintegration pattern of bench "
            "minutes before a full start. Not fitted: it needs return dates joined "
            "to realised minutes over many episodes, which the archive cannot "
            "supply because it carries no news column."
        ),
    },
    "minutes.return_ramp_floor": {
        "value": 0.60,
        "bounds": (0.20, 1.00),
        "tier": "S",
        "source": (
            "Fraction of the healthy availability path a player holds in his first "
            "week back from a dated fitness absence. Linear to 1.0 over "
            "minutes.return_ramp_weeks — linear because there is no evidence to "
            "prefer a curve, and two interpretable endpoints are easier to argue "
            "about than a decay rate.\n\n"
            "0.60 encodes 'available but likely a substitute in week one'. Setting "
            "it to 1.0 would project a returning player as immediately nailed, "
            "which is the error this ramp exists to prevent."
        ),
    },
    # ── Horizon churn in who starts ──────────────────────────────────────
    # Unlike the four above, these two ARE properly fittable: the estimand is a
    # player-gameweek rate clustered at team-gameweek, and the measurement below
    # rests on 16,548 anchors across two seasons.
    "minutes.horizon_start_reversion_cap": {
        "value": 0.447,
        "bounds": (0.10, 0.90),
        "tier": "F",
        "source": (
            "Maximum fraction of the way a start probability is pulled toward its "
            "position base rate at long horizon, in cap*(1-rho^h).\n\n"
            "This carries horizon uncertainty for a FIT player, and it had to "
            "replace a uniform availability multiplier because that multiplier is "
            "absorbed: the simulator samples an exact-count lineup, so scaling "
            "every player's availability by a common factor leaves each marginal "
            "start probability unchanged. Measured — a club-wide 0.878 haircut "
            "moved simulated expected points by under 1%.\n\n"
            "Measured over 16,548 anchors across 2024-25 and 2025-26: players who "
            "started gameweek g average 82.4 minutes that week, 68.7 at g+1, 62.4 "
            "at g+3, 56.1 at g+9, against a pool mean of 26.1 over all "
            "player-gameweeks. As a fraction of the gap to that pool mean the "
            "reversion runs 0.243 / 0.356 / 0.467 at h = 1 / 3 / 9. Least squares "
            "on cap*(1-rho^h) gives cap 0.447, rho 0.541, RMSE 0.0174.\n\n"
            "It saturates below 0.5 rather than reaching the pool mean, which is "
            "the substantive point: a nailed starter is still a far better bet "
            "than an average squad member nine weeks out, and a model reverting "
            "fully would erase the distinction the optimiser is buying."
        ),
    },
    "minutes.horizon_start_reversion_rho": {
        "value": 0.541,
        "bounds": (0.20, 0.95),
        "tier": "F",
        "source": (
            "Rate at which start probability reverts toward the position base "
            "rate across the horizon. See minutes.horizon_start_reversion_cap for "
            "the joint fit and the 16,548-anchor measurement behind it. The low "
            "value encodes a steep-then-flat shape: most of the churn in who "
            "starts happens within two gameweeks, after which the estimate is "
            "about as informative as it is going to get."
        ),
    },
    # ── Market anchor ────────────────────────────────────────────────────
    "market.blend_weight": {
        "value": 0.55,
        "bounds": (0.0, 1.0),
        "tier": "F",
        "source": (
            "Weight on market-implied goal rates against the Dixon-Coles "
            "posterior, in log-rate space: log lambda = (1-w)*log dc + w*log mkt.\n\n"
            "A PRIOR, CONFIRMED OUT OF SAMPLE BUT NOT REPLACED BY THE FIT.\n\n"
            "pipeline/learning/fit_market_blend.py has now been run: walk-forward "
            "over 903 fixtures in 86 rounds across 2023-24 to 2025-26, statistical "
            "component refit before every round, loss = log-likelihood of the "
            "realised exact scoreline.\n\n"
            "WHAT IT ESTABLISHED. The market genuinely helps. Against w=0 the "
            "argmin gains 0.0482 nats/match, anytime-valid interval [+0.0166, "
            "+0.0798] at alpha=0.01, n=86 — EXCLUDES ZERO, and it survives three "
            "selection-free constructions (split-half, honest forward chaining, "
            "and a pre-specified w=1-vs-w=0 comparison that involves no selection "
            "at all).\n\n"
            "WHY THE VALUE DID NOT MOVE. The grid argmin is 0.95, but 0.55 is only "
            "0.0076 nats/match worse and that difference does NOT exclude zero "
            "(+0.01068, interval [-0.00264, +0.02400]). The whole span [0.45, 1.00] "
            "is statistically indistinguishable. gate_out_of_sample requires an "
            "improvement interval to exclude zero, so promoting 0.95 — or the "
            "haircut 0.75 the harness recommended — is not licensed by this "
            "evidence. The loss curve is also NOT monotone: it turns up at the "
            "final step (0.95 -> 1.00 costs +0.000048), so the argmin is decided "
            "by 1/35 of its own interval radius and is not a finding.\n\n"
            "THREE KNOWN BIASES, two up and one down, which is a further reason "
            "not to chase the argmin:\n"
            "  (1) UP. The corpus holds CLOSING prices, sharper than the "
            "pre-deadline prices production consumes. Previously asserted; now "
            "MEASURED — same book, same fixtures, pre-match against closing over "
            "970 rows: closing is sharper by 0.00533 nats/match, which is 11% of "
            "the entire market-vs-model effect.\n"
            "  (2) UP. The harness blends against an unregularised MLE Dixon-Coles "
            "while production uses a hierarchical Bayesian posterior. A weaker "
            "statistical partner inflates the residual the market appears to "
            "explain. Measured at roughly 5% of rounds where the MLE is provably "
            "degenerate and the Bayesian model would not be.\n"
            "  (3) DOWN. Football-Data carries at most two closing books and "
            "devig.DEFAULT_MIN_BOOKS is 3, so every historical fixture resolved to "
            "a SINGLE book, against production's ~10-book median. A one-book market "
            "is noisier, so this fit understates the weight a well-covered market "
            "deserves.\n\n"
            "The honest reading is that the fit confirms the prior rather than "
            "improving on it. Revisit once predictions/market_snapshots.jsonl holds "
            "~10 gameweeks of our OWN pre-deadline prices, which removes bias (1) "
            "and (3) together and is the only way to earn a move."
        ),
    },
    "market.prior_only_weight": {
        "value": 0.90,
        "bounds": (0.5, 1.0),
        "tier": "C",
        "source": (
            "Weight floor on the market anchor for a fixture involving a club the "
            "posterior has never seen — a promoted side. For those the posterior's "
            "rate IS the hierarchical league prior, carrying no club-specific "
            "information at all, so there is nothing to blend and the market is "
            "the only evidence available.\n\n"
            "Constant, not fitted: a handful of promoted clubs a season cannot "
            "identify it, and the measured consequence of getting this wrong is "
            "already on record — a flat rate for every fixture predicted "
            "clean sheets at 0.066 against a realised 0.120."
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
# `PL_TEAMS` used to sit here, described as "a documented fallback for offline use".
# Nothing imported it, so it was not a fallback — it was a second list of twenty
# clubs that no code consulted and no test checked against the real roster. Every
# path derives the mapping from FPL bootstrap (`update_fpl_team_map`), which is the
# authoritative source the comment already named. A hand-maintained twin of a
# promoted-and-relegated list is a thing to be wrong, not a thing to fall back on.

# ── Player Data Quality Corrections ──────────────────────────────────────────
# Keep season-specific corrections empty by default. The live FPL roster and
# status fields are authoritative; hardcoded transfer overrides become harmful
# when team IDs and squads roll into a new season.
PLAYER_TEAM_OVERRIDES: dict = {}
EXCLUDED_PLAYERS: set = set()

# ── Team view: attack and defence from a second xG model ─────────────────────
# Feeds `/teams` and nothing else. Deliberately not a model input, so nothing
# here can move a projection or a stake — see the spec at
# docs/superpowers/specs/2026-09-04-verified-team-metrics-design.md, decision 1.
TEAM_VIEW = {
    # Empirical-Bayes shrinkage weight: a club's own rate gets n/(n+k) and the
    # league mean gets the rest. At k=6, two matches of evidence carry a quarter
    # of the weight — which is the point. The measurement that set this: across
    # the six columns of a widely-read GW3 "zonal weakness" thread, only 16% of
    # the 720 team pairs were separable at 95% from two matches, and one column
    # separated 2%. An unshrunk rank off two games is a rank attached to noise.
    #
    # PROVISIONAL. `quant-modeller` owns this number; 6 is a defensible starting
    # point (roughly "trust the club over the league once it has played ~6"), not
    # a fitted value. Fit it against forecast_ledger.json before defending it.
    "shrinkage_k": 6.0,
    # Below this, no rank is shown at all — the club renders "not yet
    # measurable". Shrinkage alone would still emit an ordering, and an ordering
    # is what gets read off a page regardless of the interval beside it.
    "min_matches_for_rank": 3,
    # Metrics carried per club, each in both directions where the source has
    # both. `ppda` is one-directional by definition: it describes the pressing
    # this club does, not what is done to it.
    "metrics": (
        "np_xg", "xg", "deep_completions", "goals",
    ),
}
