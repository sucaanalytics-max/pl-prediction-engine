"""
Re-fit `TEAM_VIEW["shrinkage_k"]` and `min_matches_for_rank` from prior seasons.

Run by hand, not by the pipeline. Nothing here is imported at pipeline runtime
and nothing here writes to `predictions/`; it prints a table and stops. The
numbers it produced on 2026-09-04 are recorded in `pipeline/config.py` next to
the constants themselves, so this script exists to let the next person disagree
with them rather than to be believed.

    PYTHONPATH=. .venv/bin/python -m pipeline.learning.fit_team_view_k

## What is being fitted

`team_view.shrink` pulls a club's per-match rate toward the league mean by
`n / (n + k)`. Under the normal-normal hierarchical model that weight is optimal
when `k = sigma^2_within / tau^2_between` — per-match noise over genuine
between-club spread — so k is a property of the metric and is measurable. Two
independent estimates are reported: that variance decomposition, and a direct
out-of-sample search.

## The out-of-sample criterion

For each club take its first n matches, shrink toward the league mean *of the
same window* (which is what `build_team_view` does), and score the result
against that club's mean over the remainder of the same season. Minimise MSE
over k.

The holdout is itself noisy. That is fine and worth stating precisely: the
remainder mean is unbiased for the club's true rate and its sampling error is
independent of the first-n window, so it contributes a constant to the MSE plus
a cross term that is zero in expectation. The MSE floor is therefore inflated
but the argmin over k is unbiased.

The chronological split also leaves each club's early schedule unbalanced in
opponent strength and home/away. That is deliberate: the published figure is an
unadjusted per-match rate, so the noise it must be shrunk against genuinely
includes schedule imbalance.

## Data

Understat, `read_team_match_stats`, ten seasons. Bounded by construction — one
call per season, and `soccerdata` caches raw responses under `~/soccerdata`, so
a rerun costs no network. Understat is used rather than FBref for the reason
`team_view` records: both FBref routes are unrunnable on this machine.
"""

from __future__ import annotations

import logging
from typing import Iterable, List

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

METRICS = ("np_xg", "xg", "deep_completions", "goals")
SIDES = ("for", "against")
#: Seasons Understat covers for the PL and that predate the current one.
DEFAULT_SEASONS = tuple(f"{y}-{y + 1}" for y in range(2016, 2026))
#: The window where shrinkage is load-bearing: past ~10 matches n/(n+k) is
#: close enough to 1 for any plausible k that the choice stops mattering.
FIT_NS = (2, 3, 4, 5, 6, 8, 10)
KGRID = np.arange(0.0, 60.0001, 0.25)


def load(seasons: Iterable[str] = DEFAULT_SEASONS) -> pd.DataFrame:
    """Ten seasons of Understat match rows, concatenated. One call per season."""
    from soccerdata import Understat

    frames: List[pd.DataFrame] = []
    for season in seasons:
        try:
            df = Understat(
                leagues="ENG-Premier League", seasons=season,
            ).read_team_match_stats().reset_index()
        except Exception as exc:  # optional scraped source; skip, do not raise
            logger.warning("fit_team_view_k: %s unavailable (%s)", season, exc)
            continue
        df["season_label"] = season
        frames.append(df)
    if not frames:
        raise RuntimeError("Understat returned nothing for any season")
    return pd.concat(frames, ignore_index=True)


def long_table(df: pd.DataFrame) -> pd.DataFrame:
    """
    One row per (season, club, match), chronological, carrying for and against.

    Same both-clubs-per-row unpacking as `team_view.aggregate_matches`, and the
    same trap: reading the home column as "this club's attack" is right for one
    side and exactly inverted for the other, invisibly so in any league total.
    """
    df = df.sort_values(["season_label", "date"]).reset_index(drop=True)
    parts = []
    for own, other in (("home", "away"), ("away", "home")):
        part = pd.DataFrame({
            "season": df["season_label"],
            "date": df["date"],
            "team": df[f"{own}_team"],
        })
        for metric in METRICS:
            part[f"{metric}_for"] = pd.to_numeric(df[f"{own}_{metric}"], errors="coerce")
            part[f"{metric}_against"] = pd.to_numeric(df[f"{other}_{metric}"], errors="coerce")
        parts.append(part)
    long = pd.concat(parts, ignore_index=True).sort_values(["season", "team", "date"])
    long["match_no"] = long.groupby(["season", "team"]).cumcount() + 1
    return long.reset_index(drop=True)


def mse_curve(long: pd.DataFrame, col: str, n: int) -> np.ndarray:
    """MSE against the rest of the season, over the whole k grid, at one n."""
    train_rows = long[long["match_no"] <= n]
    test_rows = long[long["match_no"] > n]
    joined = pd.concat([
        train_rows.groupby(["season", "team"])[col].mean().rename("train"),
        test_rows.groupby(["season", "team"])[col].mean().rename("test"),
    ], axis=1).dropna()
    league = joined.index.get_level_values("season").map(
        train_rows.groupby("season")[col].mean()
    ).to_numpy()
    train = joined["train"].to_numpy()
    test = joined["test"].to_numpy()
    weight = n / (n + KGRID)
    pred = league[:, None] + (train - league)[:, None] * weight[None, :]
    return ((pred - test[:, None]) ** 2).mean(axis=0)


def pooled_curve(long: pd.DataFrame, col: str, ns: Iterable[int] = FIT_NS) -> np.ndarray:
    """
    One curve over k for a column, pooling n.

    Each n is divided by its own minimum before summing. Without that the n with
    the largest raw MSE would decide k on its own, which is a scale accident
    rather than a statement about evidence.
    """
    total = np.zeros_like(KGRID)
    for n in ns:
        curve = mse_curve(long, col, n)
        total += curve / curve.min()
    return total


def variance_k(long: pd.DataFrame, col: str, season_length: int = 38) -> float:
    """
    The analytic k, as a cross-check on the search.

    `k = sigma^2_within / tau^2_between`. The between-club variance of observed
    season means overstates tau^2 by sigma^2_within / season_length, because a
    38-match mean is still an estimate; that inflation is subtracted.
    """
    grouped = long.groupby(["season", "team"])[col]
    within = grouped.var(ddof=1).mean()
    between_observed = grouped.mean().groupby("season").var(ddof=1).mean()
    tau2 = between_observed - within / season_length
    return float(within / tau2) if tau2 > 0 else float("inf")


def concordance(long: pd.DataFrame, col: str, n: int) -> tuple:
    """
    The threshold question, in the unit a reader uses.

    A published rank is a set of pairwise claims, so score the fraction of club
    pairs whose first-n ordering still holds over the rest of the season.
    Chance is 0.5. Returns (mean, standard error, mean |rank move| out of 20).
    """
    from scipy.stats import rankdata

    scores, moves = [], []
    for season in long["season"].unique():
        d = long[long["season"] == season]
        joined = pd.concat([
            d[d["match_no"] <= n].groupby("team")[col].mean().rename("a"),
            d[d["match_no"] > n].groupby("team")[col].mean().rename("b"),
        ], axis=1).dropna()
        a, b = joined["a"].to_numpy(), joined["b"].to_numpy()
        upper = np.triu_indices(len(a), 1)
        scores.append(
            (np.sign(a[:, None] - a[None, :])[upper]
             == np.sign(b[:, None] - b[None, :])[upper]).mean()
        )
        moves.append(np.abs(rankdata(a) - rankdata(b)).mean())
    return float(np.mean(scores)), float(np.std(scores) / np.sqrt(len(scores))), float(np.mean(moves))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    long = long_table(load())
    columns = [f"{m}_{s}" for m in METRICS for s in SIDES]
    print(f"{len(long)} club-matches over {long['season'].nunique()} seasons\n")

    print("=== k by column: out-of-sample argmin, and the analytic cross-check ===")
    print("column".ljust(26) + "k* (search)   k (variance)   cost of k=6.0")
    pooled = {}
    for col in columns:
        curve = pooled_curve(long, col)
        pooled[col] = curve
        at_six = curve[int(np.searchsorted(KGRID, 6.0))] / curve.min()
        print(col.ljust(26)
              + f"{KGRID[int(np.argmin(curve))]:<14.2f}"
              + f"{variance_k(long, col):<15.1f}"
              + f"+{(at_six - 1) * 100:.2f}%")

    joint = sum(pooled[c] / pooled[c].min() for c in columns)
    print(f"\nsingle k across all eight columns: {KGRID[int(np.argmin(joint))]:.2f}")

    # Only np_xg reaches the page with a shrunk value, so it decides the default.
    ranked = sum(pooled[c] / pooled[c].min() for c in ("np_xg_for", "np_xg_against"))
    flat = KGRID[ranked <= ranked.min() * 1.01]
    print(f"k for the two columns that are actually published shrunk "
          f"(np_xg for/against): {KGRID[int(np.argmin(ranked))]:.2f}, "
          f"within 1% of optimal for k in [{flat.min():.2f}, {flat.max():.2f}]")

    print("\n=== the threshold: pairwise concordance with the rest of the season ===")
    print("(chance = 0.500; 'move' is the mean rank change out of 20 places)")
    print("n".ljust(4) + "".join(c.ljust(30) for c in ("np_xg_for", "np_xg_against")))
    for n in (1, 2, 3, 4, 5, 6, 8, 10):
        cells = []
        for col in ("np_xg_for", "np_xg_against"):
            mean, se, move = concordance(long, col, n)
            cells.append(f"{mean:.3f} +/- {se:.3f}   move {move:.1f}")
        print(str(n).ljust(4) + "".join(c.ljust(30) for c in cells))

    print("\n=== does k reorder anything? ===")
    season = long["season"].unique()[-1]
    window = long[(long["season"] == season) & (long["match_no"] <= 3)]
    means = window.groupby("team")["np_xg_for"].mean()
    league_mean = window["np_xg_for"].mean()
    orders = {
        k: tuple((league_mean + (means - league_mean) * (3 / (3 + k)))
                 .sort_values(ascending=False).index)
        for k in (0.0, 1.0, 3.0, 6.0, 12.0, 30.0, 100.0)
    }
    print(f"  {season}, n=3, every club on equal n: "
          + ("identical ordering for every k — as the algebra requires, since "
             "shrinkage is then a strictly increasing affine map"
             if len(set(orders.values())) == 1 else "ORDER CHANGES — investigate"))
    for k in (0.0, 3.0, 6.0, 10.0, 20.0):
        v = league_mean + (means - league_mean) * (3 / (3 + k))
        print(f"    k={k:<5} column spans {v.min():.2f}-{v.max():.2f} "
              f"(sd {v.std(ddof=1):.3f}) about a league mean of {league_mean:.2f}")


if __name__ == "__main__":
    main()
