"""
Turning no-vig bookmaker prices into home and away goal rates, and blending them
with the Dixon-Coles posterior.

**Why team-level prices rather than player prices.** FPLReview, the service this
replaces, read player anytime-goalscorer and clean-sheet markets directly. Its
author put scorer-market margins at around 45% and called removing them "a bit of
a dark art", while noting that match-result and clean-sheet margins are far
cleaner. Inverting 1X2 and goal totals is therefore a deliberate fork toward the
low-margin, high-liquidity end of the board, accepting that we must then allocate
team goals to players with our own event model. It is a different design with a
stated reason, not a reproduction.

**The firewall.** These rates go to the FPL projection layer only. The value-bet
path must keep computing its edge against prices using a lambda that was NOT
derived from those prices, or the "edge" is a readout of the price and Kelly
stakes real money on a circularity.

**No extrapolation beyond the posted market.** Bookmakers price one or two
gameweeks ahead. A model that predicts future odds is a model *of prices* fitted
*on prices*, with no realised-outcome ground truth at the horizon where it is
used, and its only covariates would be team strength and fixture — which is what
Dixon-Coles already computes. A synthetic GW+5 "market" would be our own model
laundered through a market-shaped wrapper and then labelled ``market``, destroying
the provenance distinction the whole design rests on. Instead
:func:`level_correction` carries forward the one thing that genuinely transfers:
the market's view that our league-wide scoring level or home advantage is off.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from pipeline.config import MAX_GOALS
from pipeline.models.devig import (
    SHIN,
    BookConsensus,
    aggregate_books,
)
from pipeline.models.dixon_coles import BayesianDixonColes

logger = logging.getLogger(__name__)

# Rates outside this are not football results; they indicate a mislabelled side,
# a stale price or a failed solve.
MIN_RATE = 0.15
MAX_RATE = 5.0

# Bounds on the (u, v) parameterisation: u = log(total goals), v = log(home/away).
U_BOUNDS = (math.log(0.6), math.log(7.0))
V_BOUNDS = (-2.5, 2.5)

STATUS_CONVERGED = "converged"
STATUS_NOT_CONVERGED = "not_converged"
STATUS_THIN = "thin"
STATUS_ABSENT = "absent"
STATUS_REJECTED_RATE = "rejected_implausible_rate"
STATUS_REJECTED_SIGN = "rejected_supremacy_sign"

# A fit worse than this in UNWEIGHTED logit RMS means a Dixon-Coles bivariate
# Poisson at our rho cannot represent this market at all — usually a stale leg.
MAX_RESIDUAL = 0.35


def _logit(p: float) -> float:
    p = min(max(float(p), 1e-9), 1.0 - 1e-9)
    return math.log(p / (1.0 - p))


@dataclass(frozen=True)
class MarketRates:
    """Goal rates implied by one fixture's de-vigged prices."""

    lambda_home: float
    mu_away: float
    status: str
    n_bookmakers: int = 0
    dispersion: float = float("nan")
    # UNWEIGHTED logit RMS at the optimum — the solver's weights are divided back
    # out, so this is comparable across fixtures with different book coverage.
    # Because the system is overdetermined it is a real diagnostic rather than
    # always zero: it measures how badly our forward model can fit the market,
    # which is exactly when to trust it less.
    residual: float = float("nan")
    n_constraints: int = 0
    devig_method: str = SHIN
    weight: float = 0.0

    @property
    def supremacy(self) -> float:
        return self.lambda_home - self.mu_away

    @property
    def total_goals(self) -> float:
        return self.lambda_home + self.mu_away

    @property
    def usable(self) -> bool:
        return self.status == STATUS_CONVERGED and self.weight > 0.0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "lambda_home": self.lambda_home,
            "mu_away": self.mu_away,
            "supremacy": self.supremacy,
            "total_goals": self.total_goals,
            "status": self.status,
            "n_bookmakers": self.n_bookmakers,
            "dispersion": self.dispersion,
            "residual": self.residual,
            "n_constraints": self.n_constraints,
            "devig_method": self.devig_method,
            "weight": self.weight,
        }


def _rates_from_uv(u: float, v: float) -> Tuple[float, float]:
    total = math.exp(u)
    share = 1.0 / (1.0 + math.exp(-v))
    return total * share, total * (1.0 - share)


def _outcome_probabilities(
    matrix: np.ndarray,
) -> Tuple[float, float, float]:
    """P(home win), P(draw), P(away win) from a scoreline grid."""
    home = float(np.tril(matrix, -1).sum())
    draw = float(np.trace(matrix))
    away = float(np.triu(matrix, 1).sum())
    return home, draw, away


def _p_over(matrix: np.ndarray, line: float) -> float:
    """P(total goals > line). Lines are half-integers, so no push to handle."""
    size = matrix.shape[0]
    total = 0.0
    for i in range(size):
        for j in range(size):
            if i + j > line:
                total += matrix[i, j]
    return float(total)


def _solve_1d(objective, low: float, high: float, tolerance: float = 1e-10) -> float:
    """Bisection on a monotone objective; returns the closer end if unbracketed."""
    f_low, f_high = objective(low), objective(high)
    if f_low * f_high > 0:
        return low if abs(f_low) < abs(f_high) else high
    for _ in range(120):
        middle = 0.5 * (low + high)
        value = objective(middle)
        if abs(value) < tolerance or high - low < tolerance:
            return middle
        if value * f_low > 0:
            low, f_low = middle, value
        else:
            high = middle
    return 0.5 * (low + high)


def residual_weight(consensus: BookConsensus) -> float:
    """
    How hard one market pulls the inversion's fit.

    Dispersion alone INVERTS for a single book: ``aggregate_books`` reports
    dispersion 0.0 when there is nothing to disagree with, so ``1/dispersion``
    handed a one-book market the MAXIMUM weight while a well-sampled five-book
    market with genuine disagreement got less. Multiplying by the consensus' own
    ``weight`` — n/(n+2) when thin, 1.0 otherwise — restores the intent: agreement
    across many books earns influence, and a single book cannot buy it by having
    no one to disagree with.

    Module level rather than nested inside ``invert_fixture`` so it is directly
    testable. It was nested first, and the test written against it asserted the
    CONSENSUS weight instead — so it passed with the inverted version in place.
    """
    return consensus.weight / max(consensus.dispersion, 0.05)


def invert_fixture(
    h2h_by_book: Mapping[str, Mapping[str, float]],
    totals_by_book: Mapping[str, Mapping[str, Mapping[str, float]]],
    rho: float,
    devig_method: str = SHIN,
    max_goals: int = MAX_GOALS,
    dc_supremacy: Optional[float] = None,
) -> MarketRates:
    """
    Solve for the goal rates whose scoreline grid reproduces the market.

    Takes PER-BOOKMAKER prices only. There is deliberately no code path accepting
    the aggregated best-price dict, because that vector is a max over books whose
    implied probabilities do not sum to a margin — de-vigging it is meaningless,
    and a signature that accepted it would eventually be handed it.

    Parameterised as ``u = log(lambda + mu)`` and ``v = log(lambda / mu)``.
    ``P(over line)`` is almost purely a function of the total and
    ``P(home) - P(away)`` almost purely of the ratio, so the Jacobian is nearly
    diagonal, positivity is free, and the two warm-start solves below are already
    close to the answer.

    Warm-started from the MARKET, never from Dixon-Coles. Warm-starting from the
    thing we are blending toward would make a partially converged solve look like
    the model — which is precisely the failure that would hide.
    """
    h2h = aggregate_books(h2h_by_book, method=devig_method)

    # Totals arrive keyed book -> line -> side; regroup to line -> book -> side so
    # each line can be aggregated across books independently.
    by_line: Dict[str, Dict[str, Mapping[str, float]]] = {}
    for bookmaker, lines in (totals_by_book or {}).items():
        for line, sides in (lines or {}).items():
            by_line.setdefault(line, {})[bookmaker] = sides
    totals: Dict[float, BookConsensus] = {}
    for line, per_book in by_line.items():
        try:
            value = float(line)
        except (TypeError, ValueError):
            continue
        consensus = aggregate_books(per_book, method=devig_method)
        if consensus.probabilities.get("over") is not None:
            totals[value] = consensus

    if not h2h.probabilities or not totals:
        return MarketRates(
            lambda_home=float("nan"), mu_away=float("nan"),
            status=STATUS_ABSENT, devig_method=devig_method,
            n_bookmakers=h2h.n_books,
        )

    # ── Warm start: two monotone 1-D solves ──────────────────────────────
    # 1. Total, treating goals as one Poisson. Only for the starting point; the
    #    refinement below uses the full bivariate grid with the tau correction.
    line, consensus = min(totals.items(), key=lambda item: abs(item[0] - 2.5))
    target_over = consensus.probabilities["over"]

    def total_objective(total: float) -> float:
        from scipy.stats import poisson

        return float(1.0 - poisson.cdf(math.floor(line), total)) - target_over

    total_start = _solve_1d(total_objective, 0.3, 7.0)
    u0 = math.log(max(total_start, 0.31))

    # 2. Split, from the de-vigged home/away ratio at that total.
    home_p = h2h.probabilities.get("home", 0.0)
    away_p = h2h.probabilities.get("away", 0.0)
    target_share = (
        home_p / (home_p + away_p) if (home_p + away_p) > 0 else 0.5
    )

    def split_objective(v: float) -> float:
        lam, mu = _rates_from_uv(u0, v)
        matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho, max_goals)
        h, _, a = _outcome_probabilities(matrix)
        return (h / (h + a) if (h + a) > 0 else 0.5) - target_share

    v0 = _solve_1d(split_objective, V_BOUNDS[0], V_BOUNDS[1])

    # ── Residuals: logit space, weighted by cross-book disagreement ──────
    # Logit rather than raw difference so a 1pp error on a 0.05 leg is not treated
    # as equal to one on a 0.45 leg. Weighted by dispersion so a market where the
    # books disagree pulls the fit less — reusing a quantity already computed
    # rather than introducing a tuning parameter.
    constraints: List[Tuple[str, float, float]] = []
    h2h_weight = residual_weight(h2h)
    # Home and away only: the draw is implied by the three summing to one, so
    # including it would double-count.
    constraints.append(("h2h_home", h2h.probabilities.get("home", 0.0), h2h_weight))
    constraints.append(("h2h_away", h2h.probabilities.get("away", 0.0), h2h_weight))
    for value, line_consensus in sorted(totals.items()):
        constraints.append((
            f"over_{value}",
            line_consensus.probabilities["over"],
            residual_weight(line_consensus),
        ))

    def residuals(params: np.ndarray) -> np.ndarray:
        lam, mu = _rates_from_uv(float(params[0]), float(params[1]))
        matrix = BayesianDixonColes.scoreline_matrix(lam, mu, rho, max_goals)
        home, _, away = _outcome_probabilities(matrix)
        out = []
        for name, target, weight in constraints:
            if name == "h2h_home":
                modelled = home
            elif name == "h2h_away":
                modelled = away
            else:
                modelled = _p_over(matrix, float(name.split("_", 1)[1]))
            out.append(weight * (_logit(modelled) - _logit(target)))
        return np.asarray(out, dtype=float)

    from scipy.optimize import least_squares

    # Clipped into the box. An unbracketed 1-D warm start can land outside, and
    # least_squares then refuses to start at all — which would report an
    # internally inconsistent market as a *bounds* error rather than as the
    # convergence failure it is. The solver should get its chance; the residual
    # check below is what decides whether the answer is usable.
    x0 = np.array([
        float(np.clip(u0, *U_BOUNDS)),
        float(np.clip(v0, *V_BOUNDS)),
    ], dtype=float)

    try:
        solution = least_squares(
            residuals,
            x0=x0,
            bounds=(
                np.array([U_BOUNDS[0], V_BOUNDS[0]]),
                np.array([U_BOUNDS[1], V_BOUNDS[1]]),
            ),
            method="trf",
        )
    except Exception as exc:  # noqa: BLE001 - a solver failure is a status, not a crash
        logger.warning("market inversion failed to solve: %s", exc)
        return MarketRates(
            lambda_home=float("nan"), mu_away=float("nan"),
            status=STATUS_NOT_CONVERGED, devig_method=devig_method,
            n_bookmakers=h2h.n_books, dispersion=h2h.dispersion,
            n_constraints=len(constraints),
        )

    lam, mu = _rates_from_uv(float(solution.x[0]), float(solution.x[1]))
    weights = np.array([weight for _, _, weight in constraints], dtype=float)
    residual = float(
        np.sqrt(np.mean((solution.fun / np.maximum(weights, 1e-9)) ** 2))
    )
    # The BEST-covered totals line, not the minimum across lines.
    #
    # Taking the minimum let one thinly-quoted extra line collapse the whole
    # anchor: five books on 2.5 and 3.5 plus a single book on 1.5 gave weight
    # 0.333, so the effective blend became 0.55 x 0.333 = 0.18 rather than 0.55.
    # Books splitting between lines is the ordinary case with one main line each,
    # not an edge case, so the minimum would have quietly gutted the anchor most
    # weeks. Every line still constrains the fit; only the trust weight uses the
    # best-covered one.
    best_totals_weight = max(c.weight for c in totals.values())
    weight = h2h.weight * best_totals_weight
    status = STATUS_CONVERGED if solution.success else STATUS_NOT_CONVERGED

    if status == STATUS_CONVERGED and residual > MAX_RESIDUAL:
        # Our forward model cannot represent this market at all. Usually a stale
        # leg; occasionally rho being wrong for this fixture. Either way the
        # anchor deserves no weight.
        status = STATUS_NOT_CONVERGED
    if not (MIN_RATE <= lam <= MAX_RATE and MIN_RATE <= mu <= MAX_RATE):
        status = STATUS_REJECTED_RATE
    if (
        status == STATUS_CONVERGED
        and dc_supremacy is not None
        and abs(dc_supremacy) > 0.5
        and abs(lam - mu) > 0.5
        and np.sign(lam - mu) != np.sign(dc_supremacy)
    ):
        # Opposite signs on a lopsided fixture is almost certainly a mislabelled
        # home/away rather than a market insight, and it would invert every
        # clean-sheet projection in the fixture. Deliberately asymmetric:
        # disagreement on a near-even match is information and is kept.
        logger.error(
            "market supremacy %.2f opposes Dixon-Coles %.2f; rejecting the anchor",
            lam - mu, dc_supremacy,
        )
        status = STATUS_REJECTED_SIGN

    if h2h.status == STATUS_THIN and status == STATUS_CONVERGED:
        status = STATUS_CONVERGED  # thin is carried in `weight`, not in `status`

    return MarketRates(
        lambda_home=float(lam),
        mu_away=float(mu),
        status=status,
        n_bookmakers=h2h.n_books,
        dispersion=float(h2h.dispersion),
        residual=residual,
        n_constraints=len(constraints),
        devig_method=devig_method,
        weight=float(weight) if status == STATUS_CONVERGED else 0.0,
    )


def level_correction(
    anchored: Sequence[Tuple[MarketRates, float, float]],
    shrinkage: float = 5.0,
    clamp: float = 0.20,
) -> Tuple[float, float]:
    """
    League-wide multiplicative correction in log space, ``(home, away)``.

    This is the substitute for extrapolating odds, and the reason a market anchor
    can inform a gameweek it has no prices for. If the market says this week's
    fixtures average 2.75 goals and Dixon-Coles says 2.55, naive per-fixture
    anchoring makes week 1 rates about 8% higher than week 2 for reasons unrelated
    to fixture difficulty. The optimiser then sees a spurious "this week is
    better", which barely touches captaincy but directly distorts transfers — the
    decisions the horizon exists to inform.

    Carrying only the LEVEL forward removes that discontinuity by construction:
    the shift is uniform across every week, and only the idiosyncratic per-fixture
    part is market-informed, and only where a market exists.

    Shrunk by ``n / (n + shrinkage)`` so one anchored fixture cannot move the
    whole league, and clamped: a correction beyond ±22% is a data problem, not a
    discovery.
    """
    usable = [
        (market, dc_home, dc_away)
        for market, dc_home, dc_away in anchored
        if market.usable and dc_home > 0 and dc_away > 0
    ]
    if not usable:
        return 0.0, 0.0

    home_deltas = [
        math.log(market.lambda_home / dc_home) for market, dc_home, _ in usable
    ]
    away_deltas = [
        math.log(market.mu_away / dc_away) for market, _, dc_away in usable
    ]
    n = len(usable)
    factor = n / (n + shrinkage)

    def _bounded(values: List[float]) -> float:
        value = float(np.mean(values)) * factor
        if abs(value) > clamp:
            logger.warning(
                "league level correction %.3f exceeds the clamp %.2f; capping. "
                "This is a data problem rather than a discovery.", value, clamp,
            )
        return float(np.clip(value, -clamp, clamp))

    return _bounded(home_deltas), _bounded(away_deltas)


def blend_log(
    dc_home: float,
    dc_away: float,
    market: Optional[MarketRates],
    weight: float,
    level: Tuple[float, float] = (0.0, 0.0),
) -> Tuple[float, float, str]:
    """
    Combine the posterior with the market in log-rate space.

        log lambda = (1 - w) * log lambda_dc + w * log lambda_market

    Log space because lambda is *defined* multiplicatively in Dixon-Coles
    (``exp(intercept + attack - defence + home_adv)``), so this averages in the
    model's own natural parameter space; the posterior is approximately log-normal
    by construction, making the geometric combination the consistent one; it
    cannot produce a non-positive rate for any inputs; and it commutes with the
    multiplicative posterior rescale the pipeline already applies.

    Every fixture receives the league LEVEL correction, including those with no
    market of their own — that is what keeps week 1 and week 2 on the same scale.
    Only a fixture with a usable market additionally receives its own idiosyncratic
    deviation.

    ``level`` is the RAW league correction; this function scales it by ``weight``
    itself. Passing a pre-scaled level from outside was a real defect: the residual
    below subtracts the full league mean, so scaling the base by ``w`` while
    subtracting ``w·L`` left a spurious ``w(1−w)·L`` term. Measured — an anchored
    fixture whose market said exactly the league level came out 2.5% above an
    otherwise identical un-anchored fixture at w = 0.55, and the week-1/week-2
    discontinuity the decomposition exists to remove roughly doubled. It vanished
    only at w = 1, which is precisely the value the original test used.

    With the scaling done here the identity is exact:

        log λ = log dc + w·L + w·(D − L) = log dc + w·D      (D = log(mkt/dc))

    which is what ``market.blend_weight`` documents. An anchored fixture with
    ``D == L`` is then bit-identical to an un-anchored one.

    Returns ``(lambda, mu, rate_source)``.
    """
    weight = float(np.clip(weight, 0.0, 1.0))
    base_home = dc_home * math.exp(weight * level[0])
    base_away = dc_away * math.exp(weight * level[1])

    if market is None or not market.usable or weight <= 0.0:
        source = (
            "dixon_coles_posterior+level"
            if (level[0] or level[1])
            else "dixon_coles_posterior"
        )
        return base_home, base_away, source

    # The market's fixture-specific part only. The FULL raw level is subtracted
    # here and re-added at `weight` in the base above, which is what makes the
    # league mean enter exactly once.
    #
    # `effective` down-weights only the fixture-specific part, by this fixture's
    # own market quality. The league level keeps the full `weight`, because it was
    # estimated from every anchored fixture rather than from this one.
    effective = float(np.clip(weight * market.weight, 0.0, 1.0))
    residual_home = math.log(market.lambda_home) - math.log(dc_home) - level[0]
    residual_away = math.log(market.mu_away) - math.log(dc_away) - level[1]

    # Cap the applied deviation rather than clipping toward Dixon-Coles: a large
    # disagreement is usually the market knowing something the posterior cannot
    # see — a promoted club, a manager change, an injury — which is the case the
    # anchor exists for. Capping bounds the damage without hiding the signal.
    cap = 0.5
    residual_home = float(np.clip(residual_home, -cap, cap))
    residual_away = float(np.clip(residual_away, -cap, cap))

    lam = base_home * math.exp(effective * residual_home)
    mu = base_away * math.exp(effective * residual_away)
    return lam, mu, "market_blend"
