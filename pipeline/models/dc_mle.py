"""
Maximum-likelihood Dixon-Coles: the same model family as production, fitted in
milliseconds instead of twenty minutes.

**Why this exists.** The production statistical model is
:class:`~pipeline.models.dixon_coles.BayesianDixonColes` (PyMC/NUTS), and it is
the documented top cause of pipeline timeouts — 2 chains x (1000 tune + 2000
draws) over a hand-built ``pm.Potential`` takes 20+ minutes. That cost is
acceptable once a day. It is fatal to a *walk-forward* fit of the market blend
weight, which needs the statistical component refitted at every validation point:
38 gameweeks x 20 minutes is over twelve hours per candidate weight, so the
plan's fallback was to refit quarterly and reuse a stale posterior in between.

A stale posterior does not bias the fitted weight in a harmless direction. It
biases it **upward**. A model fitted on data up to ten weeks old is worse than
the same model refitted today, so the residual the market has to explain is
larger than it really is, and the optimiser reads that as "trust the market
more". The whole point of the harness is to decide how much weight the market
deserves, and the shortcut would have put a thumb on that scale.

Refitting an MLE of the *same* family at every gameweek removes the bias
entirely, at the cost of a point estimate instead of a posterior. That trade is
right for this job: the harness consumes ``(lambda, mu)`` — the posterior mean —
and never the posterior width.

**Parameterisation is identical to production**, deliberately, so the two are
comparable rather than merely similar::

    log lambda_ij = intercept + attack_i - defence_j + home_adv
    log mu_ij     = intercept + attack_j - defence_i

with ``attack`` and ``defence`` sum-to-zero constrained, the Dixon-Coles
low-score correction ``tau(x, y, lambda, mu, rho)``, and exponential time-decay
weights ``exp(-xi * days_before_max_date)`` at ``DIXON_COLES["xi_decay"]``.
The ``tau`` values come from :func:`pipeline.models.dixon_coles._tau` — the
production scalar, called once per low-score cell over a boolean mask — so the
correction cannot drift away from the one the simulator draws through.

**Measured fit times** on real Football-Data.co.uk results (Apple M-series,
scipy 1.18, single core, analytic gradient, L-BFGS-B, median of 11 runs):

=========================  =======  ===========  ============
corpus                     teams    fit time     iterations
=========================  =======  ===========  ============
380 matches (2526)         20       0.0027 s     32
1140 matches (3 seasons)   25       0.0083 s     82
=========================  =======  ===========  ============

The first fit in a process costs 0.18 s wall, almost all of it the lazy
``scipy.optimize`` import; ``fit_seconds`` excludes it because it is paid once,
not per refit. A full 38-gameweek walk-forward — refitting on two prior seasons
plus the season to date, so windows of 760 to 1140 matches — takes **0.19 s in
total**, against roughly twelve hours for the same 38 NUTS fits. That is the
whole argument for this module.

**Known limitation, charged rather than hidden.** This is an unregularised MLE,
so it has a genuine failure mode the Bayesian model does not: with a thin window
the likelihood can have no finite maximum. A club that has not yet scored raises
its ``attack`` forever, L-BFGS-B stops at :data:`PARAM_BOUND`, and — measured on
the first 40 matches of real 2526 results — reports ``converged=True`` alongside
an implied home rate of 48,000 goals. :class:`SeparatedDesignError` refuses that
fit outright. Between separation and a usable fit there is a band where estimates
are finite but wild (a 50-match window implies a 14.7-goal fixture), and that is
logged by :meth:`MLEDixonColes._warn_on_implausible_rates` rather than clamped,
because a clamped rate is indistinguishable from a real forecast. On real results
the warning stops firing from about 120 matches on. Callers doing early-season
walk-forward must include prior seasons in the window, which is what a real
walk-forward does anyway.
"""
from __future__ import annotations

import logging
import time
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline.config import DIXON_COLES
from pipeline.models.dixon_coles import _tau

logger = logging.getLogger(__name__)

# The only scorelines tau touches. Everything else gets tau = 1.
LOW_SCORE_CELLS: Tuple[Tuple[int, int], ...] = ((0, 0), (1, 0), (0, 1), (1, 1))

# rho bounds match pm.Uniform(-0.5, 0.5) in the production model. Wider than
# config's rho_bounds of (-0.3, 0.3) on purpose: that pair is the *reporting*
# range, and clamping the likelihood tighter than the Bayesian model samples
# would make the two estimators answer different questions.
RHO_BOUNDS = (-0.5, 0.5)

# Generous box on the log-rate parameters. Not a modelling choice, and not the
# real defence against a thin window either — SeparatedDesignError is. This is
# only the numeric backstop for the cases separation detection cannot see in
# advance, such as a club with a single match played: exp() gets a finite
# argument instead of overflowing partway through an optimisation.
PARAM_BOUND = 6.0

# Rates outside this are not football results. Only a post-fit diagnostic, never
# a clamp: silently pulling a rate back into range would turn a broken fit into a
# plausible-looking one, which is the failure mode this repo is least able to
# detect. Same band as market_rates' solver guard.
PLAUSIBLE_RATE = (0.15, 5.0)

# tau can go non-positive for large lambda*mu at positive rho (the 0-0 cell is
# 1 - lambda*mu*rho). Production handles that by flooring and renormalising
# rather than by constraining rho — pm.Potential floors log(tau) at log(1e-10),
# scoreline_matrix floors the joint at 0 and renormalises — so this floors too.
# Flooring makes the term locally constant, so its gradient contribution is
# masked off in step with it.
TAU_FLOOR = 1e-10

_COLUMN_ALIASES = {
    "home_team": ("home_team", "HomeTeam"),
    "away_team": ("away_team", "AwayTeam"),
    "home_goals": ("home_goals", "FTHG"),
    "away_goals": ("away_goals", "FTAG"),
    "date": ("date", "Date"),
}


def _resolve_columns(matches: pd.DataFrame) -> pd.DataFrame:
    """
    Accept either naming convention and return the canonical five columns.

    Two conventions are live in this repo and neither is going away: the
    Football-Data.co.uk loader emits ``HomeTeam/FTHG/Date`` and everything
    written since ``fixture_rates`` emits ``home_team/home_goals/date``. Failing
    on the other one would mean every caller writes the same rename, and one of
    them would get it subtly wrong.
    """
    resolved = {}
    for canonical, candidates in _COLUMN_ALIASES.items():
        for candidate in candidates:
            if candidate in matches.columns:
                resolved[canonical] = matches[candidate]
                break
        else:
            raise ValueError(
                f"matches is missing {canonical!r} (accepted: {list(candidates)}); "
                f"got columns {sorted(matches.columns)}"
            )
    return pd.DataFrame(resolved)


class SeparatedDesignError(ValueError):
    """
    The likelihood has no finite maximum, so there is nothing to return.

    Raised when some club has scored no goals at all, or conceded none, in the
    fitted window. Its ``attack`` (or ``defence``) then increases the likelihood
    monotonically forever and the MLE sits at infinity — the standard separation
    problem in Poisson regression. The optimiser does not notice: it stops at
    :data:`PARAM_BOUND` and reports success. Measured on real 2526 results, a fit
    on the first 40 matches came back ``converged=True`` with an implied home rate
    of 48,000 goals.

    That is the exact shape of failure this repo cannot afford — the pipeline runs
    unattended, so a confidently wrong number propagates. A caller doing an
    early-season walk-forward should catch this and either widen its window or
    skip the gameweek. The Bayesian model has no such failure because its
    hierarchical prior shrinks an unidentified club toward the league mean; that
    is the real price of the MLE, and it is charged here rather than hidden.
    """


def _unpack(theta: np.ndarray, n_teams: int) -> Tuple[float, float, float, np.ndarray, np.ndarray]:
    """
    Free vector -> (intercept, home_adv, rho, attack, defence).

    The sum-to-zero constraint is imposed by *construction*: only ``n_teams - 1``
    attack values are free and the last is minus their sum. Centring a fully free
    vector (what the PyMC model does, where it costs nothing) would leave the
    likelihood exactly flat along "add c to every attack", and handing L-BFGS-B a
    singular direction is how a deterministic optimiser stops being reproducible.
    """
    intercept = float(theta[0])
    home_adv = float(theta[1])
    rho = float(theta[2])
    k = n_teams - 1
    attack = np.empty(n_teams)
    attack[:k] = theta[3 : 3 + k]
    attack[k] = -attack[:k].sum()
    defence = np.empty(n_teams)
    defence[:k] = theta[3 + k : 3 + 2 * k]
    defence[k] = -defence[:k].sum()
    return intercept, home_adv, rho, attack, defence


def _tau_vector(
    home_goals: np.ndarray,
    away_goals: np.ndarray,
    lam: np.ndarray,
    mu: np.ndarray,
    rho: float,
) -> np.ndarray:
    """
    Per-observation tau, evaluated by the production scalar over four masks.

    ``dixon_coles._tau`` branches only on the two goal counts, so calling it with
    scalar goals and *array* rates returns the whole masked block at once. That
    keeps the arithmetic literally the same expression production uses; a change
    there lands here without anyone remembering to copy it.
    """
    tau = np.ones(home_goals.shape[0], dtype=float)
    for cell_home, cell_away in LOW_SCORE_CELLS:
        mask = (home_goals == cell_home) & (away_goals == cell_away)
        if mask.any():
            tau[mask] = _tau(cell_home, cell_away, lam[mask], mu[mask], rho)
    return tau


def _tau_gradient(
    home_goals: np.ndarray,
    away_goals: np.ndarray,
    lam: np.ndarray,
    mu: np.ndarray,
    rho: float,
    tau: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    d log tau / d(log lambda), d log tau / d(log mu), d log tau / d rho.

    Written out per cell rather than differentiated automatically, and checked
    against a finite difference of :func:`_tau_vector` by a test — that test is
    what makes the duplication safe, since an inconsistency between tau and its
    derivative would otherwise show up only as a slightly-off optimum.
    """
    n = home_goals.shape[0]
    d_log_lam = np.zeros(n)
    d_log_mu = np.zeros(n)
    d_rho = np.zeros(n)

    # Where tau was floored the term is constant, so it contributes no gradient.
    active = tau > TAU_FLOOR
    denom = np.where(active, tau, 1.0)

    def cell(cell_home: int, cell_away: int) -> np.ndarray:
        return (home_goals == cell_home) & (away_goals == cell_away) & active

    m = cell(0, 0)  # tau = 1 - lambda*mu*rho
    d_log_lam[m] = -lam[m] * mu[m] * rho / denom[m]
    d_log_mu[m] = d_log_lam[m]
    d_rho[m] = -lam[m] * mu[m] / denom[m]

    m = cell(1, 0)  # tau = 1 + mu*rho
    d_log_mu[m] = mu[m] * rho / denom[m]
    d_rho[m] = mu[m] / denom[m]

    m = cell(0, 1)  # tau = 1 + lambda*rho
    d_log_lam[m] = lam[m] * rho / denom[m]
    d_rho[m] = lam[m] / denom[m]

    m = cell(1, 1)  # tau = 1 - rho
    d_rho[m] = -1.0 / denom[m]

    return d_log_lam, d_log_mu, d_rho


def _negative_log_likelihood(
    theta: np.ndarray,
    home_idx: np.ndarray,
    away_idx: np.ndarray,
    home_goals: np.ndarray,
    away_goals: np.ndarray,
    weights: np.ndarray,
    n_teams: int,
    log_factorial: float,
) -> Tuple[float, np.ndarray]:
    """
    Time-decay-weighted negative DC log-likelihood and its analytic gradient.

    Same expression as the ``pm.Potential`` in the production model::

        log L = sum_i w_i * [Poisson(x_i | lambda_i) + Poisson(y_i | mu_i)
                             + log tau(x_i, y_i, lambda_i, mu_i, rho)]

    ``log_factorial`` is the weighted ``gammaln`` constant, added back so the
    returned value is a real log-likelihood comparable to the Bayesian model's
    rather than one up to an additive constant.
    """
    intercept, home_adv, rho, attack, defence = _unpack(theta, n_teams)

    log_lam = intercept + attack[home_idx] - defence[away_idx] + home_adv
    log_mu = intercept + attack[away_idx] - defence[home_idx]
    lam = np.exp(log_lam)
    mu = np.exp(log_mu)

    tau = _tau_vector(home_goals, away_goals, lam, mu, rho)
    log_tau = np.log(np.maximum(tau, TAU_FLOOR))

    log_like = float(
        np.sum(
            weights
            * (
                home_goals * log_lam
                - lam
                + away_goals * log_mu
                - mu
                + log_tau
            )
        )
        - log_factorial
    )

    d_log_lam, d_log_mu, d_rho = _tau_gradient(
        home_goals, away_goals, lam, mu, rho, tau
    )

    # d log L / d(log lambda_i) and d log L / d(log mu_i).
    g_lam = weights * (home_goals - lam + d_log_lam)
    g_mu = weights * (away_goals - mu + d_log_mu)

    grad = np.empty_like(theta)
    grad[0] = g_lam.sum() + g_mu.sum()          # intercept enters both rates
    grad[1] = g_lam.sum()                        # home_adv enters lambda only
    grad[2] = float(np.sum(weights * d_rho))

    # A club attacks at home and away; it defends against both, with a sign flip.
    g_attack = np.bincount(home_idx, g_lam, n_teams) + np.bincount(away_idx, g_mu, n_teams)
    g_defence = -np.bincount(away_idx, g_lam, n_teams) - np.bincount(home_idx, g_mu, n_teams)

    # Chain through attack[last] = -sum(free): every free entry also moves the last.
    k = n_teams - 1
    grad[3 : 3 + k] = g_attack[:k] - g_attack[k]
    grad[3 + k : 3 + 2 * k] = g_defence[:k] - g_defence[k]

    return -log_like, -grad


class MLEDixonColes:
    """
    Point-estimate Dixon-Coles with the production parameterisation.

    Deliberately exposes ``team_index`` and ``get_rho_mean`` under the names
    :class:`~pipeline.models.dixon_coles.BayesianDixonColes` uses, so a caller
    that only needs rates and rho can take either object. ``get_rho_mean``
    returns the MLE rather than a posterior mean; the name is about the call
    site, and a second name for the same quantity would just invite a branch.
    """

    def __init__(self) -> None:
        self.intercept: float = 0.0
        self.home_adv: float = 0.0
        self.rho: float = 0.0
        self.attack: np.ndarray = np.zeros(0)
        self.defence: np.ndarray = np.zeros(0)
        self.teams: list = []
        self.n_teams: int = 0
        self.xi: float = float(DIXON_COLES["xi_decay"])
        self.log_likelihood: float = float("nan")
        self.n_matches: int = 0
        self.n_iterations: int = 0
        self.fit_seconds: float = float("nan")
        self.converged: bool = False
        self._team_index: Dict[str, int] = {}
        self._fitted = False

    @property
    def team_index(self) -> Dict[str, int]:
        return self._team_index

    def fit(self, matches: pd.DataFrame, xi: Optional[float] = None) -> "MLEDixonColes":
        """
        Fit by L-BFGS-B on the weighted DC log-likelihood.

        Args:
            matches: home_team, away_team, home_goals, away_goals, date
                (the Football-Data ``HomeTeam/FTHG/Date`` spelling also works).
            xi: time-decay rate per day. Defaults to ``DIXON_COLES["xi_decay"]``.
                Pass ``0.0`` for an unweighted fit — which is what a parameter
                recovery check needs, since with decay there is no single fixed
                parameter vector the data was generated from.

        Returns:
            self, so a walk-forward loop can write ``MLEDixonColes().fit(df)``.
        """
        from scipy.optimize import minimize
        from scipy.special import gammaln

        # Cleared first, because everything below can raise and this method is
        # called repeatedly on one instance by a walk-forward. A failed refit must
        # not leave the object holding the previous fit's parameters alongside the
        # new window's team index — that pairing would price the wrong clubs.
        self._fitted = False

        df = _resolve_columns(matches).dropna(subset=["home_goals", "away_goals"]).copy()
        if df.empty:
            raise ValueError("no matches with both scores present")
        df["home_goals"] = df["home_goals"].astype(int)
        df["away_goals"] = df["away_goals"].astype(int)
        df["date"] = pd.to_datetime(df["date"])

        self.teams = sorted(set(df["home_team"]) | set(df["away_team"]))
        self.n_teams = len(self.teams)
        if self.n_teams < 2:
            raise ValueError(f"need at least 2 teams, got {self.n_teams}")
        self._team_index = {team: i for i, team in enumerate(self.teams)}

        home_idx = df["home_team"].map(self._team_index).to_numpy(dtype=np.intp)
        away_idx = df["away_team"].map(self._team_index).to_numpy(dtype=np.intp)
        home_goals = df["home_goals"].to_numpy(dtype=float)
        away_goals = df["away_goals"].to_numpy(dtype=float)

        scored = np.bincount(home_idx, home_goals, self.n_teams) + np.bincount(
            away_idx, away_goals, self.n_teams
        )
        conceded = np.bincount(home_idx, away_goals, self.n_teams) + np.bincount(
            away_idx, home_goals, self.n_teams
        )
        starved = [self.teams[i] for i in np.flatnonzero(scored == 0)]
        airtight = [self.teams[i] for i in np.flatnonzero(conceded == 0)]
        if starved or airtight:
            raise SeparatedDesignError(
                f"no finite MLE on these {len(df)} matches: "
                f"scored nothing: {starved or 'none'}; conceded nothing: "
                f"{airtight or 'none'}. Widen the window or skip this fit."
            )

        self.xi = float(DIXON_COLES["xi_decay"]) if xi is None else float(xi)
        days_ago = (df["date"].max() - df["date"]).dt.days.to_numpy(dtype=float)
        weights = np.exp(-self.xi * days_ago)

        log_factorial = float(
            np.sum(weights * (gammaln(home_goals + 1.0) + gammaln(away_goals + 1.0)))
        )

        # Start at the league-average model: every club average, home advantage
        # explaining the whole home/away split. Cheap, and it means the first
        # gradient step is about team differences rather than the overall level.
        mean_home = max(home_goals.mean(), 1e-3)
        mean_away = max(away_goals.mean(), 1e-3)
        theta0 = np.zeros(3 + 2 * (self.n_teams - 1))
        theta0[0] = np.log(mean_away)
        theta0[1] = np.log(mean_home) - np.log(mean_away)
        theta0[2] = 0.0

        bounds = [(-PARAM_BOUND, PARAM_BOUND), (-PARAM_BOUND, PARAM_BOUND), RHO_BOUNDS]
        bounds += [(-PARAM_BOUND, PARAM_BOUND)] * (2 * (self.n_teams - 1))

        started = time.perf_counter()
        result = minimize(
            _negative_log_likelihood,
            theta0,
            args=(
                home_idx,
                away_idx,
                home_goals,
                away_goals,
                weights,
                self.n_teams,
                log_factorial,
            ),
            method="L-BFGS-B",
            jac=True,
            bounds=bounds,
            options={"maxiter": 2000, "ftol": 1e-12, "gtol": 1e-8},
        )
        self.fit_seconds = time.perf_counter() - started

        (
            self.intercept,
            self.home_adv,
            self.rho,
            self.attack,
            self.defence,
        ) = _unpack(result.x, self.n_teams)
        self.log_likelihood = -float(result.fun)
        self.n_matches = len(df)
        self.n_iterations = int(result.nit)
        self.converged = bool(result.success)
        self._fitted = True

        if not self.converged:
            # Loud, because an unconverged fit still returns usable-looking rates
            # and this model is meant to run unattended inside a walk-forward.
            logger.warning(
                "MLE Dixon-Coles did not converge on %d matches: %s",
                self.n_matches,
                result.message,
            )
        self._warn_on_implausible_rates()
        logger.info(
            "MLE Dixon-Coles: %d matches, %d teams, %d iters, %.3fs, "
            "logL=%.2f, home_adv=%.3f, rho=%.4f",
            self.n_matches,
            self.n_teams,
            self.n_iterations,
            self.fit_seconds,
            self.log_likelihood,
            self.home_adv,
            self.rho,
        )
        return self

    def _warn_on_implausible_rates(self) -> None:
        """
        Separation is not the only way a thin window goes wrong; it is only the
        way that is provable in advance. A club with two matches played has finite
        but wild estimates, and on real 2526 results a 50-match fit implies a
        14.7-goal fixture while passing every convergence check. Reported, not
        corrected — see :data:`PLAUSIBLE_RATE`.
        """
        low, high = PLAUSIBLE_RATE
        extreme = np.exp(
            self.intercept
            + self.attack.max()
            - self.defence.min()
            + max(self.home_adv, 0.0)
        )
        gentlest = np.exp(
            self.intercept
            + self.attack.min()
            - self.defence.max()
            + min(self.home_adv, 0.0)
        )
        if extreme > high or gentlest < low:
            logger.warning(
                "MLE Dixon-Coles rates span %.2f-%.2f on %d matches, outside the "
                "plausible %.2f-%.2f — treat this fit as unidentified",
                gentlest,
                extreme,
                self.n_matches,
                low,
                high,
            )

    def _team_params(self, team: str) -> Tuple[float, float]:
        """
        (attack, defence) for one club, falling back to the league average.

        A promoted club is the whole reason this is a fallback and not a raise:
        it appears in the fixture list with no history, and ``attack = defence =
        0`` is exactly what the Bayesian model's hierarchical prior gives it
        (see ``get_lambda_mu_samples``). Dropping the fixture instead would leave
        a hole in a walk-forward's coverage on precisely the fixtures a market
        anchor is most useful for.
        """
        idx = self._team_index.get(team)
        if idx is None:
            return 0.0, 0.0
        return float(self.attack[idx]), float(self.defence[idx])

    def rates(self, home: str, away: str) -> Tuple[float, float]:
        """Expected goals ``(lambda_home, mu_away)`` for one fixture."""
        if not self._fitted:
            raise RuntimeError("Model not fitted")
        attack_home, defence_home = self._team_params(home)
        attack_away, defence_away = self._team_params(away)
        lam = np.exp(self.intercept + attack_home - defence_away + self.home_adv)
        mu = np.exp(self.intercept + attack_away - defence_home)
        return float(lam), float(mu)

    def get_rho_mean(self) -> float:
        """
        Fitted rho, named to match ``BayesianDixonColes.get_rho_mean``.

        Returns 0.0 unfitted, again matching production — an uncorrected
        bivariate Poisson is the right degenerate answer, not an exception,
        because the caller is asking for a correction factor.
        """
        if not self._fitted:
            return 0.0
        return float(self.rho)

    def team_strengths(self) -> Dict[str, Dict[str, float]]:
        """Per-club attack and defence, for logging and for eyeballing a fit."""
        if not self._fitted:
            raise RuntimeError("Model not fitted")
        return {
            team: {
                "attack": float(self.attack[i]),
                "defence": float(self.defence[i]),
            }
            for team, i in self._team_index.items()
        }
