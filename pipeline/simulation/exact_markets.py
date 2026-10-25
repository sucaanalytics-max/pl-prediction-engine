"""
Exact (Rao-Blackwellised) goals markets for the value-bet path.

## Why

Edge on the value-bet path is ``p_model - p_devig`` with the price fixed, so the
Monte Carlo standard error of a model probability is the standard error of the
edge. Measured on the GW8 fixtures (2026-10-25) it was 0.69pp at the CI setting
of 5,000 simulations, against a 5pp minimum edge: 10 priced selections sat within
two standard errors of their threshold, 8 selections flipped on or off the card
across 20 seeds, and one bet (Villa v City draw, true edge about 4.05pp) was on
the card only because of noise.

Every goals-only market is a functional of the scoreline distribution, and that
distribution is available in closed form: given one posterior draw
``(lambda, mu, rho)`` it is the Dixon-Coles grid. So instead of drawing a
scoreline per simulation and counting, this module averages the grid itself over
the posterior draws. That is Rao-Blackwellisation: conditioning on the draw
removes the scoreline-sampling variance entirely. Averaging over EVERY posterior
draw, rather than ``n`` resampled indices, also removes the posterior-resampling
noise, including the noise in the Dixon-Coles point rate that enters the blend.

What remains is the finite-posterior (MCMC) error of the fit itself, which the
Monte Carlo path also carries and which is the same for both.

## What "exact" means here

The target is the expectation of what the simulator computes, not a different
model. The per-draw grid is :func:`pipeline.simulation.montecarlo.dc_joint_flat`,
the function ``sample_dixon_coles`` draws from: the same 0..10 truncation, the
same zero floor on the four corrected cells, the same per-draw renormalisation
and the same degenerate-row fallback. Market definitions (line semantics, the 7x7
correct-score export, the push-aware "home goals + line > away goals" handicap, the
Binomial(FT, 0.45) half-time split) mirror ``derive_all_markets``.

## The rho contract: aligned triples

:func:`scoreline_grid_mixture` takes ALIGNED arrays ``(lam_i, mu_i, rho_i)`` plus
optional weights and returns the weighted mean of their grids. Whether rho is
paired with the lambda/mu draw or independent of it is purely the caller's
choice of triples:

* paired (production semantics since #6, matching the simulator's
  ``rho_paired=True``): ``scoreline_grid_mixture(lam, mu, rho)`` with the three
  posterior arrays in the same order;
* independent (the simulator's ``rho_paired=False``, which resamples rho with
  its own indices): :func:`independent_rho_scoreline_grid`, the mean over
  the full Cartesian product of (lambda, mu) draws and rho draws.

The independent case would be ``S * R`` grids done naively. It collapses because
the Dixon-Coles correction is linear in rho and the renormalising total does not
depend on rho: the four corrections sum to
``lam*mu*rho*p0*q0*(-1 + 1 + 1 - 1) = 0``, so the truncated total is
``(sum p_i)(sum q_j)`` for every rho. Wherever the zero floor does not bind, the
grid is therefore affine in rho and its mean over the rho draws equals the grid
at the mean rho. Draws where the floor CAN bind for some rho in the sample are
expanded over every rho draw explicitly, so the result is exact either way
(pinned by a test against the brute-force product, including floored draws).
"""
import logging
from typing import Dict, Optional

import numpy as np

from pipeline.simulation.montecarlo import (
    AH_LINES,
    DC_SAMPLING_MAX_GOALS,
    HT_GOAL_SHARE,
    asian_handicap_no_push,
    dc_joint_flat,
)

logger = logging.getLogger(__name__)

#: Provenance values recorded in each prediction's ``goal_markets.method``.
METHOD_POSTERIOR_GRID = "exact_dc_posterior_grid"
METHOD_POISSON_GRID = "exact_independent_poisson_grid"

#: Rows per vectorised chunk. Memory only (121 floats a row); no effect on
#: the result beyond summation order.
_CHUNK_ROWS = 50_000

#: Tolerance on the total probability of a finished grid. A grid that misses it
#: is a bug, and is raised, never renormalised away.
_GRID_TOTAL_TOL = 1e-9

#: Lines and labels shared with ``MonteCarloSimulator.derive_all_markets``.
OU_GOAL_LINES = (0.5, 1.5, 2.5, 3.5, 4.5)
CORRECT_SCORE_MAX = 6      # 0..6 per side: the 7x7 export grid
GOALS_DIST_LEN = 8


class ExactMarketsError(RuntimeError):
    """The exact goals-market computation could not produce a valid grid.

    Raised rather than falling back to Monte Carlo: the pipeline runs
    unattended, and a silent fallback would publish noisy numbers under the
    exact path's name.
    """


def _as_1d(name: str, values) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if arr.ndim != 1 or arr.size == 0:
        raise ExactMarketsError(f"{name} must be a non-empty 1-D array, got shape {arr.shape}")
    if not np.all(np.isfinite(arr)):
        raise ExactMarketsError(f"{name} contains non-finite values")
    return arr


def _check_grid(grid: np.ndarray, what: str) -> np.ndarray:
    if not np.all(np.isfinite(grid)) or np.any(grid < 0):
        raise ExactMarketsError(f"{what}: grid has negative or non-finite cells")
    total = float(grid.sum())
    if abs(total - 1.0) > _GRID_TOTAL_TOL:
        raise ExactMarketsError(f"{what}: grid sums to {total!r}, not 1")
    return grid


def scoreline_grid_mixture(
    lam,
    mu,
    rho,
    weights=None,
    max_goals: int = DC_SAMPLING_MAX_GOALS,
) -> np.ndarray:
    """
    Weighted mean of the Dixon-Coles grids of aligned triples ``(lam_i, mu_i, rho_i)``.

    Returns ``(max_goals + 1, max_goals + 1)``, home goals on axis 0. With no
    weights every triple counts equally, which is the expectation of drawing one
    scoreline per triple. Pairing is the caller's: pass the posterior arrays in
    the same order for paired rho, or use :func:`independent_rho_scoreline_grid`.
    """
    lam = _as_1d("lam", lam)
    mu = _as_1d("mu", mu)
    rho = _as_1d("rho", rho)
    if not (lam.shape == mu.shape == rho.shape):
        raise ExactMarketsError(
            f"lam, mu and rho must be aligned, got {lam.shape}, {mu.shape}, {rho.shape}"
        )
    if np.any(lam <= 0) or np.any(mu <= 0):
        raise ExactMarketsError("goal rates must be strictly positive")
    if weights is None:
        w = np.ones_like(lam)
    else:
        w = _as_1d("weights", weights)
        if w.shape != lam.shape or np.any(w < 0) or w.sum() <= 0:
            raise ExactMarketsError("weights must be aligned, non-negative and not all zero")

    width = max_goals + 1
    acc = np.zeros(width * width)
    for start in range(0, lam.size, _CHUNK_ROWS):
        stop = start + _CHUNK_ROWS
        flat = dc_joint_flat(lam[start:stop], mu[start:stop], rho[start:stop], max_goals)
        acc += w[start:stop] @ flat
    grid = (acc / w.sum()).reshape(width, width)
    return _check_grid(grid, "scoreline_grid_mixture")


def _floor_can_bind(lam: np.ndarray, mu: np.ndarray, rho_lo: float, rho_hi: float) -> np.ndarray:
    """
    Per draw: could any of the four tau factors go negative for a rho in
    ``[rho_lo, rho_hi]``? Each factor is affine in rho, so checking both ends of
    the interval is sufficient.
    """
    bind = np.zeros(lam.shape, dtype=bool)
    for r in (rho_lo, rho_hi):
        bind |= (1.0 - lam * mu * r) < 0
        bind |= (1.0 + mu * r) < 0
        bind |= (1.0 + lam * r) < 0
        bind |= (1.0 - r) < 0
    return bind


def independent_rho_scoreline_grid(
    lam,
    mu,
    rho_samples,
    max_goals: int = DC_SAMPLING_MAX_GOALS,
) -> np.ndarray:
    """
    Mean grid over every (lambda, mu) draw crossed with every rho draw.

    This is the expectation of the simulator with ``rho_paired=False``, which
    resamples rho with its own indices, independently of the lambda/mu draw. See the module docstring
    for why it collapses to one grid per (lambda, mu) draw at the mean rho
    wherever the zero floor cannot bind; draws where it can are expanded over
    every rho draw.
    """
    lam = _as_1d("lam", lam)
    mu = _as_1d("mu", mu)
    rho = _as_1d("rho_samples", rho_samples)
    if lam.shape != mu.shape:
        raise ExactMarketsError(f"lam and mu must be aligned, got {lam.shape}, {mu.shape}")

    bind = _floor_can_bind(lam, mu, float(rho.min()), float(rho.max()))
    n_total = lam.size
    width = max_goals + 1
    grid = np.zeros((width, width))

    affine = ~bind
    if affine.any():
        rho_bar = np.full(int(affine.sum()), float(rho.mean()))
        grid += scoreline_grid_mixture(lam[affine], mu[affine], rho_bar, max_goals=max_goals) * (
            affine.sum() / n_total
        )
    for k in np.flatnonzero(bind):
        expanded = scoreline_grid_mixture(
            np.full(rho.size, lam[k]), np.full(rho.size, mu[k]), rho, max_goals=max_goals
        )
        grid += expanded / n_total
    if bind.any():
        logger.debug(f"  exact grid: {int(bind.sum())} of {n_total} draws expanded over rho (floor binds)")
    return _check_grid(grid, "independent_rho_scoreline_grid")


def independent_poisson_grid(lam: float, mu: float, tail_tol: float = 1e-13) -> np.ndarray:
    """
    Two independent, untruncated Poissons: the expectation of
    ``MonteCarloSimulator.simulate_match``, which draws ``rng.poisson`` with no
    cap and no Dixon-Coles correction.

    The grid extends until each side's tail is below ``tail_tol``, so the mass
    left outside it is below ``2 * tail_tol``. That residual is NOT renormalised
    away; it is far inside the artifact validator's 1e-6 tolerance.
    """
    from scipy.stats import poisson

    lam = float(lam)
    mu = float(mu)
    if not (np.isfinite(lam) and np.isfinite(mu) and lam > 0 and mu > 0):
        raise ExactMarketsError(f"invalid goal rates for the Poisson grid: {lam}, {mu}")
    top = int(max(poisson.isf(tail_tol, max(lam, mu)), DC_SAMPLING_MAX_GOALS)) + 1
    goals = np.arange(top + 1)
    grid = np.outer(poisson.pmf(goals, lam), poisson.pmf(goals, mu))
    return _check_grid(grid, "independent_poisson_grid")


def _discrete_percentile(marginal: np.ndarray, q: float) -> float:
    """The large-sample limit of ``np.percentile(samples, 100 * q)`` for an
    integer variable with pmf ``marginal``: the smallest k with CDF(k) > q."""
    cdf = np.cumsum(marginal)
    return float(min(int(np.searchsorted(cdf, q, side="right")), marginal.size - 1))


def goal_markets_from_grid(grid: np.ndarray) -> Dict:
    """
    Every goals-only field of ``derive_all_markets``, computed from a scoreline
    grid instead of from simulated scores.

    Returns ``{"probabilities": {...}, "expected_goals": {...},
    "distributions": {"goals_home", "goals_away"}, "confidence": {...}}`` with the
    same keys and semantics as the Monte Carlo version, so it can replace those
    fields in place. Corners and cards are not here: they are conditioned on
    simulated goals and stay Monte Carlo.
    """
    grid = _check_grid(np.asarray(grid, dtype=float), "goal_markets_from_grid")
    size_h, size_a = grid.shape
    i_idx = np.arange(size_h)[:, None]
    j_idx = np.arange(size_a)[None, :]
    gd = i_idx - j_idx
    tg = i_idx + j_idx

    p_home = float(grid[gd > 0].sum())
    p_draw = float(grid[gd == 0].sum())
    p_away = float(grid[gd < 0].sum())

    over_under = {}
    for line in OU_GOAL_LINES:
        over_under[str(line)] = {
            "over": float(grid[tg > line].sum()),
            "under": float(grid[tg <= line].sum()),
        }

    p_btts_yes = float(grid[1:, 1:].sum())
    p_btts_no = 1.0 - p_btts_yes

    marg_home = grid.sum(axis=1)
    marg_away = grid.sum(axis=0)

    correct_score = {
        f"{i}-{j}": float(grid[i, j]) if i < size_h and j < size_a else 0.0
        for i in range(CORRECT_SCORE_MAX + 1)
        for j in range(CORRECT_SCORE_MAX + 1)
    }

    # Push-aware: a whole line landing on the goal difference refunds the
    # stake (``asian_handicap_no_push``), it does not lose.
    asian_handicap_push = {
        f"home_{line}": float(grid[(gd + line) == 0].sum()) for line in AH_LINES
    }
    asian_handicap = {
        f"home_{line}": asian_handicap_no_push(
            float(grid[(gd + line) > 0].sum()), asian_handicap_push[f"home_{line}"]
        )
        for line in AH_LINES
    }

    ht_ft = _ht_ft(grid)

    goals_home_dist = [float(marg_home[k]) if k < size_h else 0.0 for k in range(GOALS_DIST_LEN)]
    goals_away_dist = [float(marg_away[k]) if k < size_a else 0.0 for k in range(GOALS_DIST_LEN)]

    e_home = float(np.arange(size_h) @ marg_home)
    e_away = float(np.arange(size_a) @ marg_away)

    probs_1x2 = [p_home, p_draw, p_away]
    entropy = (
        float(-sum(p * np.log(p) for p in probs_1x2))
        if all(p > 0 for p in probs_1x2)
        else 0
    )

    return {
        "probabilities": {
            "1x2": {"home": p_home, "draw": p_draw, "away": p_away},
            "over_under": over_under,
            "btts": {"yes": p_btts_yes, "no": p_btts_no},
            "clean_sheet": {"home": float(marg_away[0]), "away": float(marg_home[0])},
            "correct_score": correct_score,
            "asian_handicap": asian_handicap,
            "asian_handicap_push": asian_handicap_push,
            "ht_ft": ht_ft,
        },
        "expected_goals": {"home": e_home, "away": e_away},
        "distributions": {"goals_home": goals_home_dist, "goals_away": goals_away_dist},
        "confidence": {
            "entropy": entropy,
            "home_goals_ci": [_discrete_percentile(marg_home, 0.05), _discrete_percentile(marg_home, 0.95)],
            "away_goals_ci": [_discrete_percentile(marg_away, 0.05), _discrete_percentile(marg_away, 0.95)],
        },
    }


def _ht_ft(grid: np.ndarray) -> Dict[str, float]:
    """
    Exact HT/FT: each side's half-time goals are Binomial(full-time goals,
    HT_GOAL_SHARE), independently, which is ``_split_half_time``.
    """
    from scipy.stats import binom

    size = max(grid.shape)
    counts = np.arange(size)
    # thin[n, h] = P(h half-time goals | n full-time goals)
    thin = binom.pmf(counts[None, :], counts[:, None], HT_GOAL_SHARE)
    th = thin[: grid.shape[0]]
    ta = thin[: grid.shape[1]]
    hh = np.arange(size)[:, None]
    aa = np.arange(size)[None, :]
    ht_given_ft = {
        "H": th @ (hh > aa).astype(float) @ ta.T,
        "D": th @ (hh == aa).astype(float) @ ta.T,
        "A": th @ (hh < aa).astype(float) @ ta.T,
    }
    i_idx = np.arange(grid.shape[0])[:, None]
    j_idx = np.arange(grid.shape[1])[None, :]
    ft = {"H": i_idx > j_idx, "D": i_idx == j_idx, "A": i_idx < j_idx}
    return {
        f"{ht}/{ftl}": float((grid * ht_given_ft[ht] * ft[ftl]).sum())
        for ht in ("H", "D", "A")
        for ftl in ("H", "D", "A")
    }


def apply_exact_goal_markets(
    mc_markets: Dict,
    exact: Dict,
    provenance: Optional[Dict] = None,
) -> Dict:
    """
    Replace the goals-only fields of a ``derive_all_markets`` result with exact
    ones, keeping the Monte Carlo corners and cards (and ``n_simulations``,
    which still describes them).
    """
    out = dict(mc_markets)
    probs = dict(mc_markets["probabilities"])
    probs.update(exact["probabilities"])
    out["probabilities"] = probs
    out["expected_goals"] = exact["expected_goals"]
    dists = dict(mc_markets["distributions"])
    dists.update(exact["distributions"])
    out["distributions"] = dists
    out["confidence"] = exact["confidence"]
    if provenance is not None:
        out["goal_markets"] = dict(provenance)
    return out
