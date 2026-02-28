"""
Feature engineering for the prediction engine.
Transforms raw match data into model-ready features:
  - Rolling stats (3/5/10 game windows with exponential decay)
  - Elo ratings
  - Opponent-adjusted metrics
  - Home/away splits
"""
import logging
from typing import Optional

import numpy as np
import pandas as pd

from pipeline.config import ROLLING_WINDOWS, ELO

logger = logging.getLogger(__name__)


# ── Elo Rating System ──────────────────────────────────────────────────────

class EloRating:
    """
    Elo rating system for Premier League teams.
    Updates after each match; regresses toward mean at season boundaries.
    """

    def __init__(
        self,
        k_factor: int = ELO["k_factor"],
        home_advantage: int = ELO["home_advantage"],
        initial_rating: int = ELO["initial_rating"],
        mean_reversion: float = ELO["mean_reversion"],
    ):
        self.k = k_factor
        self.home_adv = home_advantage
        self.initial = initial_rating
        self.mean_reversion = mean_reversion
        self.ratings = {}

    def get_rating(self, team: str) -> float:
        return self.ratings.get(team, self.initial)

    def expected_score(self, rating_a: float, rating_b: float) -> float:
        """Expected score for team A vs team B."""
        return 1 / (1 + 10 ** ((rating_b - rating_a) / 400))

    def update(self, home: str, away: str, home_goals: int, away_goals: int):
        """Update ratings after a match."""
        r_home = self.get_rating(home) + self.home_adv
        r_away = self.get_rating(away)

        e_home = self.expected_score(r_home, r_away)
        e_away = 1 - e_home

        # Actual score (1 = win, 0.5 = draw, 0 = loss)
        if home_goals > away_goals:
            s_home, s_away = 1.0, 0.0
        elif home_goals == away_goals:
            s_home, s_away = 0.5, 0.5
        else:
            s_home, s_away = 0.0, 1.0

        # Goal difference multiplier
        gd = abs(home_goals - away_goals)
        gd_mult = np.log(max(gd, 1) + 1)

        self.ratings[home] = self.get_rating(home) + self.k * gd_mult * (s_home - e_home)
        self.ratings[away] = self.get_rating(away) + self.k * gd_mult * (s_away - e_away)

    def season_reset(self):
        """Regress all ratings toward mean at start of new season."""
        mean_rating = np.mean(list(self.ratings.values())) if self.ratings else self.initial
        for team in self.ratings:
            self.ratings[team] = (
                self.ratings[team] * (1 - self.mean_reversion)
                + mean_rating * self.mean_reversion
            )


def compute_elo_ratings(matches: pd.DataFrame) -> pd.DataFrame:
    """
    Compute Elo ratings for all teams across all matches.
    Adds home_elo, away_elo, elo_diff columns to matches.
    """
    elo = EloRating()
    elo_home = []
    elo_away = []

    prev_season = None
    for _, row in matches.iterrows():
        season = row.get("season", "")
        if prev_season and season != prev_season:
            elo.season_reset()
        prev_season = season

        h, a = row["HomeTeam"], row["AwayTeam"]
        elo_home.append(elo.get_rating(h))
        elo_away.append(elo.get_rating(a))

        if pd.notna(row.get("FTHG")) and pd.notna(row.get("FTAG")):
            elo.update(h, a, int(row["FTHG"]), int(row["FTAG"]))

    matches = matches.copy()
    matches["home_elo"] = elo_home
    matches["away_elo"] = elo_away
    matches["elo_diff"] = matches["home_elo"] - matches["away_elo"]

    return matches, elo


# ── Rolling Statistics ─────────────────────────────────────────────────────

def _team_rolling_stats(
    matches: pd.DataFrame, team: str, window: int, decay: float = 0.9
) -> pd.DataFrame:
    """
    Compute rolling stats for a single team (both home and away games).

    Returns one row per match for the team with rolling features.
    """
    # Home games
    home = matches[matches["HomeTeam"] == team].copy()
    home["is_home"] = 1
    home["goals_for"] = home["FTHG"]
    home["goals_against"] = home["FTAG"]
    home["shots_for"] = home.get("HS", pd.Series(dtype=float))
    home["shots_against"] = home.get("AS", pd.Series(dtype=float))
    home["corners_for"] = home.get("HC", pd.Series(dtype=float))
    home["corners_against"] = home.get("AC", pd.Series(dtype=float))
    home["yellows"] = home.get("HY", pd.Series(dtype=float))

    # Away games
    away = matches[matches["AwayTeam"] == team].copy()
    away["is_home"] = 0
    away["goals_for"] = away["FTAG"]
    away["goals_against"] = away["FTHG"]
    away["shots_for"] = away.get("AS", pd.Series(dtype=float))
    away["shots_against"] = away.get("HS", pd.Series(dtype=float))
    away["corners_for"] = away.get("AC", pd.Series(dtype=float))
    away["corners_against"] = away.get("HC", pd.Series(dtype=float))
    away["yellows"] = away.get("AY", pd.Series(dtype=float))

    team_matches = pd.concat([home, away]).sort_values("Date")

    stats_cols = [
        "goals_for", "goals_against", "shots_for", "shots_against",
        "corners_for", "corners_against", "yellows"
    ]

    # Exponentially weighted moving average
    for col in stats_cols:
        if col in team_matches.columns:
            team_matches[f"ewm_{col}_{window}"] = (
                team_matches[col]
                .ewm(span=window, min_periods=max(1, window // 2))
                .mean()
                .shift(1)  # CRITICAL: shift to avoid leakage
            )

    team_matches["team"] = team
    return team_matches


def compute_rolling_features(matches: pd.DataFrame) -> pd.DataFrame:
    """
    Compute rolling features for all teams across all windows.
    Returns the matches DataFrame with rolling features attached.
    """
    teams = set(matches["HomeTeam"].unique()) | set(matches["AwayTeam"].unique())
    all_rolling = {}

    for team in teams:
        for window in ROLLING_WINDOWS:
            team_stats = _team_rolling_stats(matches, team, window)

            # Store latest rolling stats per match for this team
            for _, row in team_stats.iterrows():
                mid = row.get("match_id", "")
                if mid not in all_rolling:
                    all_rolling[mid] = {}

                is_home = row["is_home"]
                prefix = "home" if is_home else "away"

                for col in team_stats.columns:
                    if col.startswith("ewm_"):
                        all_rolling[mid][f"{prefix}_{col}"] = row[col]

    # Merge rolling features back into matches
    rolling_df = pd.DataFrame.from_dict(all_rolling, orient="index")
    rolling_df.index.name = "match_id"
    rolling_df = rolling_df.reset_index()

    matches = matches.merge(rolling_df, on="match_id", how="left")

    return matches


# ── Additional Features ────────────────────────────────────────────────────

def add_rest_days(matches: pd.DataFrame) -> pd.DataFrame:
    """Add days since last match for each team."""
    matches = matches.copy()

    last_match = {}
    home_rest = []
    away_rest = []

    for _, row in matches.iterrows():
        h, a = row["HomeTeam"], row["AwayTeam"]
        date = row["Date"]

        h_rest = (date - last_match[h]).days if h in last_match else 7
        a_rest = (date - last_match[a]).days if a in last_match else 7
        home_rest.append(min(h_rest, 30))  # Cap at 30 days
        away_rest.append(min(a_rest, 30))

        last_match[h] = date
        last_match[a] = date

    matches["home_rest_days"] = home_rest
    matches["away_rest_days"] = away_rest

    return matches


def add_h2h_features(matches: pd.DataFrame) -> pd.DataFrame:
    """Add head-to-head historical record."""
    matches = matches.copy()
    h2h_cache = {}

    h2h_home_wins = []
    h2h_draws = []
    h2h_away_wins = []

    for _, row in matches.iterrows():
        h, a = row["HomeTeam"], row["AwayTeam"]
        key = tuple(sorted([h, a]))

        record = h2h_cache.get(key, {"hw": 0, "d": 0, "aw": 0, "n": 0})
        total = max(record["n"], 1)
        h2h_home_wins.append(record["hw"] / total)
        h2h_draws.append(record["d"] / total)
        h2h_away_wins.append(record["aw"] / total)

        # Update record
        if pd.notna(row.get("FTR")):
            result = row["FTR"]
            if result == "H":
                record["hw"] += 1
            elif result == "D":
                record["d"] += 1
            else:
                record["aw"] += 1
            record["n"] += 1
            h2h_cache[key] = record

    matches["h2h_home_win_rate"] = h2h_home_wins
    matches["h2h_draw_rate"] = h2h_draws
    matches["h2h_away_win_rate"] = h2h_away_wins

    return matches


def add_form_indicator(matches: pd.DataFrame) -> pd.DataFrame:
    """
    Add recent form indicator (points from last 5 games, normalized 0-1).
    """
    matches = matches.copy()

    form = {}  # team -> list of recent results (3 pts win, 1 pt draw)
    home_form = []
    away_form = []

    for _, row in matches.iterrows():
        h, a = row["HomeTeam"], row["AwayTeam"]

        # Current form (before this match)
        h_pts = form.get(h, [])
        a_pts = form.get(a, [])
        home_form.append(sum(h_pts[-5:]) / max(len(h_pts[-5:]) * 3, 1))
        away_form.append(sum(a_pts[-5:]) / max(len(a_pts[-5:]) * 3, 1))

        # Update form after match
        if pd.notna(row.get("FTR")):
            result = row["FTR"]
            if result == "H":
                form.setdefault(h, []).append(3)
                form.setdefault(a, []).append(0)
            elif result == "D":
                form.setdefault(h, []).append(1)
                form.setdefault(a, []).append(1)
            else:
                form.setdefault(h, []).append(0)
                form.setdefault(a, []).append(3)

    matches["home_form_5"] = home_form
    matches["away_form_5"] = away_form

    return matches


# ── Main Feature Engineering Pipeline ──────────────────────────────────────

def engineer_features(
    matches: pd.DataFrame,
    fbref_features: Optional[dict] = None,
    player_stats: Optional[pd.DataFrame] = None,
) -> pd.DataFrame:
    """
    Full feature engineering pipeline.

    Args:
        matches: Raw match data from Football-Data.co.uk
        fbref_features: Optional xG features from FBref
        player_stats: Optional player data from FPL API

    Returns:
        Feature-engineered DataFrame ready for modeling
    """
    logger.info("Engineering features...")

    # Step 1: Elo ratings
    matches, elo = compute_elo_ratings(matches)
    logger.info(f"  Elo ratings computed for {len(elo.ratings)} teams")

    # Step 2: Rolling stats
    matches = compute_rolling_features(matches)
    logger.info(f"  Rolling features computed (windows: {ROLLING_WINDOWS})")

    # Step 3: Rest days
    matches = add_rest_days(matches)
    logger.info("  Rest days computed")

    # Step 4: H2H features
    matches = add_h2h_features(matches)
    logger.info("  H2H features computed")

    # Step 5: Form indicator
    matches = add_form_indicator(matches)
    logger.info("  Form indicators computed")

    # Step 6: FBref xG features (if available)
    if fbref_features:
        for prefix, team_col in [("home", "HomeTeam"), ("away", "AwayTeam")]:
            xg_vals = []
            xga_vals = []
            for _, row in matches.iterrows():
                team = row[team_col]
                fb = fbref_features.get(team, {})
                xg_vals.append(fb.get("xg"))
                xga_vals.append(fb.get("xga"))
            matches[f"{prefix}_season_xg"] = xg_vals
            matches[f"{prefix}_season_xga"] = xga_vals
        logger.info("  FBref xG features merged")

    # Step 7: Squad availability (if player stats available)
    if player_stats is not None:
        team_availability = (
            player_stats[player_stats["minutes"] > 90]  # Regular starters
            .groupby("team")
            .agg(
                squad_available=("available", "mean"),
                avg_form=("form", "mean"),
                total_xg=("expected_goals", "sum"),
            )
            .to_dict("index")
        )
        for prefix, team_col in [("home", "HomeTeam"), ("away", "AwayTeam")]:
            matches[f"{prefix}_squad_availability"] = matches[team_col].map(
                lambda t: team_availability.get(t, {}).get("squad_available", 1.0)
            )
            matches[f"{prefix}_avg_player_form"] = matches[team_col].map(
                lambda t: team_availability.get(t, {}).get("avg_form", 0.0)
            )
        logger.info("  Squad availability features merged")

    # Step 8: Target variables (for training)
    matches["total_goals"] = matches["FTHG"] + matches["FTAG"]
    matches["btts"] = ((matches["FTHG"] > 0) & (matches["FTAG"] > 0)).astype(int)
    matches["result"] = matches["FTR"].map({"H": 0, "D": 1, "A": 2})

    logger.info(f"Feature engineering complete: {matches.shape[1]} columns, {len(matches)} matches")

    return matches


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from pipeline.data.football_data import load_all_seasons
    matches = load_all_seasons()
    features = engineer_features(matches)
    print(f"\nFeature columns:\n{sorted(features.columns.tolist())}")
