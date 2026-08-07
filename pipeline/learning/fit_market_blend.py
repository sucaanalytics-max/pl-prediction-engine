"""
Fitting ``market.blend_weight`` out of sample against realised scorelines.

The parameter being fitted is ``w`` in the log-rate blend
:func:`pipeline.models.market_rates.blend_log` applies::

    log lambda = (1 - w) * log lambda_dc + w * log lambda_market

Everything here measures; nothing here ships. The output is a JSON report to a
scratch path and a recommendation for a human to apply to
:data:`pipeline.config.PARAM_REGISTRY`.

**Walk-forward, refitted every round.** For each evaluation round the statistical
component is refitted on matches strictly before that round's first kickoff, and
the market is inverted at that fit's own ``rho``. The cadence is every ROUND and
not quarterly, which is a correctness point rather than a performance one: a
stale statistical component is worse than the same model refitted today, so the
residual the market has to explain is larger than it really is and the optimiser
reads that as "trust the market more". A quarterly refit would therefore bias
``w`` UPWARD — a thumb on the scale of the exact quantity being measured.
:class:`~pipeline.models.dc_mle.MLEDixonColes` fits the production
parameterisation in milliseconds, so there is no reason to accept that bias.

**Loss: the log-likelihood of the realised EXACT scoreline** under
``BayesianDixonColes.scoreline_matrix(lam, mu, rho)``. It is a proper scoring rule
over the joint distribution, so both ``lambda`` and ``mu`` enter and a blend that
fixes the total by ruining the split cannot hide.

An earlier version of this docstring called that grid "the full bivariate object
the simulator draws from". **That is false, and the discrepancy is worth knowing
about.** ``pipeline/simulation/montecarlo.py`` draws
``np.random.poisson(lambda_home)`` and ``np.random.poisson(mu_away)``
independently and contains no reference to ``rho`` or ``tau`` at all — the
Dixon-Coles low-score correction, which is the entire reason to prefer
Dixon-Coles over independent Poisson, is estimated by the model and then not
applied when the published probabilities are generated. Measured at the corpus
mean rho of −0.063, the tau-corrected ``P(0-0)`` is 10.6%–11.3% HIGHER than the
independent-Poisson value.

The grid used here is the object ``invert_fixture`` matches the market against, so
it is the right loss for fitting *this* parameter. It is simply not a description
of what the simulator emits, and the ~2.94-nats levels below should not be read as
production's predictive loss. The simulator discrepancy is a separate, pre-existing
defect on the value-bet path; fixing it would move ``latest.json`` and therefore
stake sizing, so it needs its own change and its own before/after review.

Three secondary
metrics are REPORTED and never optimised — CRPS on total goals isolates the
level, log-loss on 1X2 isolates the split, and log-loss on each side's clean
sheet is tracked because clean sheets measured 0.066 predicted against 0.120
realised and they dominate FPL defender points. If the primary argmin disagrees
with the level and split argmins, that is evidence ``w`` should be split into
separate total and supremacy weights, and the report says so.

**Two caveats, in the report as literal strings because they bound how the number
may be used:**

1. :data:`CAVEAT_CLOSING_LINE` — the corpus holds CLOSING prices, which contain
   confirmed team news our pre-deadline line cannot. The fitted ``w`` is an
   **upper bound** on how much to trust the market we actually consume, so the
   recommendation carries a haircut (:data:`CLOSING_LINE_HAIRCUT`).
2. :data:`CAVEAT_THIN_BOOKS` — the corpus has two books per market against
   production's ~10, so ``aggregate_books`` marks every historical fixture
   ``thin`` and hands back ``weight`` around 0.5. ``w`` is fitted against the RAW
   inverted rate with that discount NEUTRALISED (``replace(market, weight=1.0)``),
   so ``w`` measures trust in the market alone. Production then multiplies
   coverage back in — ``blend_log`` computes ``effective = w * market.weight`` —
   which keeps the two questions separate: how good is a market, and how well
   covered is this one.

A third, :data:`CAVEAT_MLE_SUBSTITUTE`, emerged from the run rather than the
design: the statistical component here is an unregularised MLE and production's
is a hierarchical Bayesian posterior, so the market is being compared against a
weaker partner than it will face. That pushes ``w`` up too, in the same direction
as the closing-line gap, so both are charged as haircuts on the recommendation
(:data:`CLOSING_LINE_HAIRCUT`, :data:`MLE_SUBSTITUTE_HAIRCUT`).

**Fixtures deliberately excluded**, each because including it would let a
different parameter contaminate this one:

- No usable market under every requested de-vig method. The de-vig comparison is
  paired per round, and pairing requires the same fixture set.
- Either club absent from the round's fitted model. Those are governed by
  ``market.prior_only_weight`` (tier C, never refit), not by ``w``.
- Rounds whose training window holds fewer than :data:`MIN_TRAIN_MATCHES`
  results. An unregularised MLE on a thin window is not merely imprecise; it is
  unidentified, and ``dc_mle`` documents a 50-match window implying a 14.7-goal
  fixture.

Run by hand::

    PYTHONPATH=. .venv/bin/python -m pipeline.learning.fit_market_blend \\
        --out /tmp/market_blend_weight.json
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import tempfile
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from pipeline.config import MAX_GOALS, SEASONS
from pipeline.data.football_data import closing_market, load_closing_odds
from pipeline.learning.gates import (
    DEFAULT_ALPHA,
    MIN_OBSERVATIONS,
    anytime_valid_bound,
)
from pipeline.models.dc_mle import MLEDixonColes, SeparatedDesignError
from pipeline.models.devig import POWER, PROPORTIONAL, SHIN
from pipeline.models.dixon_coles import BayesianDixonColes
# `_outcome_probabilities` is private and imported anyway, deliberately: the 1X2
# split scored below has to be the SAME tril/trace/triu partition the inversion
# matched the market against. A local reimplementation would be two lines and
# would silently diverge the day either side's convention changed.
from pipeline.models.market_rates import (
    MarketRates,
    _outcome_probabilities,
    blend_log,
    invert_fixture,
)

logger = logging.getLogger(__name__)

# The grid the plan specifies. Coarse on purpose: the anytime-valid interval
# below is far wider than 0.05, so a finer grid would report precision the
# evidence does not carry.
WEIGHT_GRID: Tuple[float, ...] = tuple(round(0.05 * i, 2) for i in range(21))

# De-vig methods, proportional FIRST because it is the baseline the comparison
# has to beat rather than merely differ from.
DEVIG_METHODS: Tuple[str, ...] = (PROPORTIONAL, POWER, SHIN)

# No league level correction in this harness, and that is a modelling decision.
# `level_correction` exists to carry a market view forward to gameweeks that have
# no prices; here every scored fixture is priced, so the level would only add a
# nuisance term at interior w. It cancels exactly at w = 1 either way, which is
# what makes the grid endpoint reproduce the market.
NO_LEVEL: Tuple[float, float] = (0.0, 0.0)

# Results before this many training matches are burn-in, not evidence. See the
# module docstring and `dc_mle.PLAUSIBLE_RATE`: separation is refused outright,
# but the band above it where estimates are finite and wild is not, and a wild
# lambda would be charged to the market's account.
MIN_TRAIN_MATCHES = 200

# A scoreline cell can be exactly 0.0 once `scoreline_matrix` floors a negative
# tau, so the log needs a floor. Deliberately far below any real cell (the 7-7
# corner of a 1.4/1.2 fixture is ~1e-11) so it can never be the binding term for
# a scoreline the model merely thinks unlikely.
PROBABILITY_FLOOR = 1e-15

# Grid steps of disagreement between the primary argmin and a secondary argmin
# that count as agreement. Two steps: one step is grid resolution, three would be
# 0.15 of the range and a substantively different blend.
AGREEMENT_TOLERANCE = 0.10 + 1e-9

# Two relative haircuts on the fitted weight, for the two known biases that both
# point the SAME way — upward. Both are judgements, stated rather than measured,
# and together they are the largest remaining source of error in the
# recommendation.
#
# 1. The closing-line gap. Cannot be measured from this corpus: doing so would
#    mean de-vigging the PRE-match `PSH/PSD/PSA` columns, which
#    `football_data.load_closing_odds` deliberately does not read because they
#    are not a single book's closing view. The size is set by what the closing
#    line knows that we cannot — confirmed team news, worth on the order of
#    0.1-0.2 goals on a side's rate when a key player is out — against a market
#    whose contribution is a share of a log-rate difference that is itself
#    usually under 0.2. The real fix is refitting on
#    `predictions/market_snapshots.jsonl`, our own pre-deadline history, at which
#    point this constant is deleted rather than tuned.
#
# 2. The statistical component substitution. This harness blends the market
#    against an unregularised MLE point estimate, while production blends it
#    against a hierarchical Bayesian posterior mean. The MLE is the weaker
#    partner — it has no shrinkage, so a thin or unusual window degrades it in a
#    way the hierarchical prior prevents — and a weaker statistical component
#    leaves a larger residual for the market to explain, which reads as "trust
#    the market more". Anchored on a measurement from the real run: of 89
#    fittable rounds, 3 had no finite MLE at all and 2 more were fitted with
#    rates outside `dc_mle.PLAUSIBLE_RATE`, so on ~5% of rounds the MLE is
#    provably degenerate where the Bayesian model would not be. The smaller of
#    the two haircuts because the parameterisation is otherwise identical.
CLOSING_LINE_HAIRCUT = 0.15
MLE_SUBSTITUTE_HAIRCUT = 0.05

# Grid step, used to snap the recommendation. Rounded DOWN, not to nearest: both
# known biases push the fitted weight up, so the grid's own resolution should be
# spent in the conservative direction. Recommending 0.81 off a 0.05 grid would
# also claim precision the harness does not have.
GRID_STEP = 0.05

# A weight counts as indistinguishable from the optimum when its loss exceeds the
# minimum by less than this fraction of the TOTAL improvement the market buys
# (loss at w=0 minus loss at the argmin). That total is the natural yardstick:
# it is the whole effect being measured, so 5% of it is a rounding error on the
# finding rather than an absolute nats threshold that means nothing on its own.
FLAT_REGION_FRACTION = 0.05

CAVEAT_CLOSING_LINE = (
    "The corpus holds CLOSING prices, which are sharper than the pre-deadline "
    "prices production consumes because they contain confirmed team news ours "
    "cannot. The fitted w is therefore an UPPER BOUND on how much to trust our "
    "live line, and must be haircut before it is shipped."
)

CAVEAT_MLE_SUBSTITUTE = (
    "The statistical component here is an unregularised MLE point estimate "
    "(dc_mle.MLEDixonColes), not production's hierarchical Bayesian posterior. "
    "The MLE is the weaker partner, so the residual left for the market to "
    "explain is larger than it would be against production's model, which biases "
    "w UPWARD in the same direction as the closing-line gap. Measured on the real "
    "run: of 89 fittable rounds, 3 had no finite MLE and 2 more were fitted with "
    "rates outside the plausible band."
)

CAVEAT_THIN_BOOKS = (
    "The historical corpus has only TWO books per market while production has "
    "~10, so aggregate_books marks every historical fixture 'thin'. w is fitted "
    "against the RAW inverted market rate with the thin-ness discount "
    "neutralised (market.weight forced to 1.0), so w measures trust in the "
    "market ALONE. Production applies coverage-based shrinkage on top via "
    "effective = w * market.weight; the two are separate questions and are "
    "estimated separately."
)

METRIC_NAMES: Tuple[str, ...] = (
    "scoreline_nll",   # PRIMARY. Everything else is reported, never optimised.
    "total_crps",      # level only
    "outcome_nll",     # split only
    "home_cs_nll",
    "away_cs_nll",
)

PRIMARY_METRIC = "scoreline_nll"
LEVEL_METRIC = "total_crps"
SPLIT_METRIC = "outcome_nll"

DEFAULT_REPORT_PATH = Path(tempfile.gettempdir()) / "market_blend_weight.json"


# ── The corpus ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FixtureCase:
    """
    One out-of-sample fixture: past-only rates, its market, and what happened.

    ``markets`` is keyed by de-vig method and every entry already has
    ``weight == 1.0`` — see :data:`CAVEAT_THIN_BOOKS`. ``rho`` is the round's own
    fitted correlation, carried per case so the grid never has to guess which fit
    a case came from.
    """

    match_id: str
    season: str
    round_label: str
    home_team: str
    away_team: str
    home_goals: int
    away_goals: int
    lambda_home_dc: float
    mu_away_dc: float
    rho: float
    markets: Mapping[str, MarketRates]


@dataclass
class CorpusDiagnostics:
    """What the walk-forward saw, including everything it threw away."""

    n_rounds_total: int = 0
    n_rounds_burn_in: int = 0
    n_rounds_unfittable: int = 0
    n_rounds_scored: int = 0
    n_fixtures_seen: int = 0
    n_dropped_no_market: int = 0
    n_dropped_prior_only: int = 0
    market_statuses: Dict[str, int] = field(default_factory=dict)
    fit_seconds: float = 0.0
    # Round labels in the order a model was fitted for them. Exists so the
    # no-leakage test can pair each captured training frame with the round it was
    # fitted for and assert the cutoff, rather than trusting the loop.
    fitted_rounds: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n_rounds_total": self.n_rounds_total,
            "n_rounds_burn_in": self.n_rounds_burn_in,
            "n_rounds_unfittable": self.n_rounds_unfittable,
            "n_rounds_scored": self.n_rounds_scored,
            "n_fixtures_seen": self.n_fixtures_seen,
            "n_dropped_no_market": self.n_dropped_no_market,
            "n_dropped_prior_only": self.n_dropped_prior_only,
            "market_statuses": dict(self.market_statuses),
            "refit_seconds_total": round(self.fit_seconds, 4),
        }


def round_labels(frame: pd.DataFrame) -> pd.Series:
    """
    Bucket matches into evaluation rounds by ISO calendar week within a season.

    Not by counting ten fixtures at a time. A ten-match block in date order can
    split a single Saturday across two rounds, and the model fitted "before" the
    later block would then have been fitted on a match kicking off the same
    afternoon. A calendar week is a clean cutoff: the model for a round sees
    nothing from the Monday of that round onward, which costs up to six days of
    staleness on a Sunday fixture and leaks nothing.

    Measured on the three-season corpus: 109 rounds, median 10 matches, range
    1-20 (the 20 is a rearranged midweek programme landing in the same week as
    the weekend one).
    """
    iso = frame["date"].dt.isocalendar()
    return pd.Series(
        [
            f"{season}-{year}W{week:02d}"
            for season, year, week in zip(
                frame["season"].astype(str),
                iso["year"].to_numpy(dtype=int),
                iso["week"].to_numpy(dtype=int),
            )
        ],
        index=frame.index,
        dtype="object",
    )


def walk_forward_cases(
    frame: pd.DataFrame,
    methods: Sequence[str] = DEVIG_METHODS,
    min_train_matches: int = MIN_TRAIN_MATCHES,
    xi: Optional[float] = None,
    model_factory: Callable[[], Any] = MLEDixonColes,
) -> Tuple[List[FixtureCase], CorpusDiagnostics]:
    """
    Refit the statistical model before every round and invert that round's markets.

    ``frame`` is :func:`~pipeline.data.football_data.load_closing_odds` output.
    The training window is every match in it dated strictly before the round's
    first kickoff — ALL results, not only priced ones, because the statistical
    component should see every match that happened.

    ``model_factory`` is injectable so the no-leakage test can capture the frames
    handed to ``fit`` and assert the cutoff by construction.
    """
    frame = frame.copy()
    frame["round_label"] = round_labels(frame)
    first_kickoff = frame.groupby("round_label")["date"].min().sort_values()

    cases: List[FixtureCase] = []
    diagnostics = CorpusDiagnostics(n_rounds_total=int(len(first_kickoff)))

    for label, cutoff in first_kickoff.items():
        target = frame[frame["round_label"] == label]
        train = frame[frame["date"] < cutoff]
        if len(train) < min_train_matches:
            diagnostics.n_rounds_burn_in += 1
            continue
        try:
            model = model_factory().fit(train, xi=xi)
        except (SeparatedDesignError, ValueError) as exc:
            # Not swallowed silently: a skipped round changes the corpus the
            # weight is fitted on, so it has to be counted and named.
            logger.warning("round %s: model unfittable on %d matches (%s)",
                           label, len(train), exc)
            diagnostics.n_rounds_unfittable += 1
            continue
        diagnostics.fitted_rounds.append(str(label))
        diagnostics.fit_seconds += float(getattr(model, "fit_seconds", 0.0) or 0.0)
        rho = float(model.get_rho_mean())
        known = model.team_index

        round_cases: List[FixtureCase] = []
        for _, row in target.iterrows():
            diagnostics.n_fixtures_seen += 1
            if row["home_team"] not in known or row["away_team"] not in known:
                # Governed by market.prior_only_weight, a tier-C constant. Fitting
                # w on these would let a parameter we are not fitting move the one
                # we are.
                diagnostics.n_dropped_prior_only += 1
                continue
            dc_home, dc_away = model.rates(row["home_team"], row["away_team"])
            h2h, totals = closing_market(row)
            markets: Dict[str, MarketRates] = {}
            for method in methods:
                result = invert_fixture(
                    h2h, totals, rho,
                    devig_method=method,
                    dc_supremacy=dc_home - dc_away,
                )
                diagnostics.market_statuses[result.status] = (
                    diagnostics.market_statuses.get(result.status, 0) + 1
                )
                if result.usable:
                    # Thin-ness neutralised HERE, once, so no downstream caller
                    # has to remember to do it. See CAVEAT_THIN_BOOKS.
                    markets[method] = replace(result, weight=1.0)
            if len(markets) != len(methods):
                diagnostics.n_dropped_no_market += 1
                continue
            round_cases.append(
                FixtureCase(
                    match_id=str(row["match_id"]),
                    season=str(row["season"]),
                    round_label=str(label),
                    home_team=str(row["home_team"]),
                    away_team=str(row["away_team"]),
                    home_goals=int(row["home_goals"]),
                    away_goals=int(row["away_goals"]),
                    lambda_home_dc=float(dc_home),
                    mu_away_dc=float(dc_away),
                    rho=rho,
                    markets=markets,
                )
            )
        if round_cases:
            diagnostics.n_rounds_scored += 1
            cases.extend(round_cases)

    return cases, diagnostics


# ── Losses ───────────────────────────────────────────────────────────────────


def scoreline_log_loss(
    matrix: np.ndarray, home_goals: int, away_goals: int
) -> float:
    """
    Negative log-likelihood of the realised EXACT scoreline. The primary loss.

    Goals above the grid edge are clipped rather than dropped, which is the
    treatment consistent with the grid itself: ``scoreline_matrix`` renormalises
    over 0-7, so the 7 cell already carries the mass of everything at or above 7.
    One match in the three-season corpus needs it (an 8-goal away score).
    """
    size = matrix.shape[0] - 1
    cell = matrix[min(int(home_goals), size), min(int(away_goals), size)]
    return -math.log(max(float(cell), PROBABILITY_FLOOR))


def total_goals_crps(matrix: np.ndarray, total_goals: int) -> float:
    """
    CRPS of the total-goals distribution against the realised total.

    Isolates the LEVEL: it is invariant to how the total is split between the
    sides, which is exactly what makes it a useful cross-check on a primary loss
    that is not.

    Discrete form ``sum_k (F(k) - 1{y <= k})^2`` over the achievable totals.
    """
    size = matrix.shape[0]
    pmf = np.zeros(2 * size - 1, dtype=float)
    for home in range(size):
        pmf[home : home + size] += matrix[home]
    cdf = np.cumsum(pmf)
    observed = min(int(total_goals), len(pmf) - 1)
    step = (np.arange(len(pmf)) >= observed).astype(float)
    return float(np.sum((cdf - step) ** 2))


def outcome_log_loss(matrix: np.ndarray, home_goals: int, away_goals: int) -> float:
    """
    Negative log-likelihood of the realised 1X2 result.

    Isolates the SPLIT: home advantage and supremacy move it, the total barely
    does. The partition is ``market_rates._outcome_probabilities`` so that the
    quantity scored is the one the inversion matched the market against.
    """
    home_p, draw_p, away_p = _outcome_probabilities(matrix)
    if home_goals > away_goals:
        probability = home_p
    elif home_goals == away_goals:
        probability = draw_p
    else:
        probability = away_p
    return -math.log(max(float(probability), PROBABILITY_FLOOR))


def clean_sheet_log_losses(
    matrix: np.ndarray, home_goals: int, away_goals: int
) -> Tuple[float, float]:
    """
    Negative log-likelihood of each side's clean sheet, ``(home, away)``.

    Tracked because it is the error the market anchor was introduced to fix — a
    flat rate for every fixture predicted clean sheets at 0.066 against a
    realised 0.120 — and because clean sheets dominate FPL defender points, so a
    blend that improves the scoreline likelihood while degrading this is not an
    improvement for the decisions the projection feeds.

    The home side keeps a clean sheet when the AWAY team fails to score, so the
    probability is the away-zero column, not the home-zero row.
    """
    home_cs = float(matrix[:, 0].sum())
    away_cs = float(matrix[0, :].sum())

    def loss(probability: float, happened: bool) -> float:
        p = min(max(probability, PROBABILITY_FLOOR), 1.0 - PROBABILITY_FLOOR)
        return -math.log(p if happened else 1.0 - p)

    return loss(home_cs, int(away_goals) == 0), loss(away_cs, int(home_goals) == 0)


def blended_rates(case: FixtureCase, method: str, weight: float) -> Tuple[float, float]:
    """
    ``(lambda, mu)`` at one weight, through the production ``blend_log``.

    Never reimplemented locally: what is being fitted is the weight production
    will apply, including its residual cap. Recomputing the geometric mean here
    would fit a slightly different parameter and nothing would say so.
    """
    lam, mu, _ = blend_log(
        case.lambda_home_dc, case.mu_away_dc, case.markets[method], weight, NO_LEVEL
    )
    return lam, mu


def case_metrics(
    case: FixtureCase, method: str, weight: float, max_goals: int = MAX_GOALS
) -> Dict[str, float]:
    """Every metric for one fixture at one weight, from one scoreline grid."""
    lam, mu = blended_rates(case, method, weight)
    matrix = BayesianDixonColes.scoreline_matrix(lam, mu, case.rho, max_goals)
    home_cs, away_cs = clean_sheet_log_losses(matrix, case.home_goals, case.away_goals)
    return {
        "scoreline_nll": scoreline_log_loss(matrix, case.home_goals, case.away_goals),
        "total_crps": total_goals_crps(matrix, case.home_goals + case.away_goals),
        "outcome_nll": outcome_log_loss(matrix, case.home_goals, case.away_goals),
        "home_cs_nll": home_cs,
        "away_cs_nll": away_cs,
    }


def metric_table(
    cases: Sequence[FixtureCase],
    method: str,
    grid: Sequence[float] = WEIGHT_GRID,
    max_goals: int = MAX_GOALS,
) -> Dict[str, np.ndarray]:
    """``metric -> (n_cases, n_weights)`` losses for one de-vig method."""
    table = {
        name: np.empty((len(cases), len(grid)), dtype=float) for name in METRIC_NAMES
    }
    for row, case in enumerate(cases):
        for column, weight in enumerate(grid):
            values = case_metrics(case, method, weight, max_goals)
            for name in METRIC_NAMES:
                table[name][row, column] = values[name]
    return table


def round_means(
    cases: Sequence[FixtureCase], values: np.ndarray
) -> Tuple[List[str], np.ndarray]:
    """
    Collapse per-fixture losses to per-ROUND means, rounds in corpus order.

    The round is the unit of independence for the interval, not the fixture:
    every fixture in a round is scored through ONE refitted model, so their
    losses share that fit's error and are not independent draws. Treating 1,090
    fixtures as 1,090 observations would understate the radius by roughly the
    square root of the round size.
    """
    labels: List[str] = []
    index: Dict[str, int] = {}
    for case in cases:
        if case.round_label not in index:
            index[case.round_label] = len(labels)
            labels.append(case.round_label)
    totals = np.zeros((len(labels), values.shape[1]), dtype=float)
    counts = np.zeros(len(labels), dtype=float)
    for row, case in enumerate(cases):
        position = index[case.round_label]
        totals[position] += values[row]
        counts[position] += 1.0
    return labels, totals / counts[:, None]


# ── Intervals ────────────────────────────────────────────────────────────────


def _finite(value: float) -> Optional[float]:
    """JSON has no infinity, and an unbounded radius is a real answer here."""
    return float(value) if np.isfinite(value) else None


def paired_interval(
    differences: Sequence[float], alpha: float = DEFAULT_ALPHA
) -> Dict[str, Any]:
    """
    Anytime-valid interval on the mean of per-round paired differences.

    ``differences`` are ``baseline loss - candidate loss``, so positive means the
    candidate is better. The interval comes from
    :func:`pipeline.learning.gates.anytime_valid_bound`, which is deliberately
    wider than a fixed-n interval — the harness is meant to be re-run as seasons
    accumulate, and a fixed-alpha test re-read every season is optional stopping.
    """
    mean, radius = anytime_valid_bound(differences, alpha=alpha)
    lower, upper = mean - radius, mean + radius
    return {
        "n": int(len(differences)),
        "mean": float(mean),
        "radius": _finite(radius),
        "lower": _finite(lower),
        "upper": _finite(upper),
        "excludes_zero": bool(np.isfinite(radius) and (lower > 0.0 or upper < 0.0)),
        "alpha": float(alpha),
        "min_observations": MIN_OBSERVATIONS,
    }


# ── The report ───────────────────────────────────────────────────────────────


def _argmin_weight(curve: np.ndarray, grid: Sequence[float]) -> float:
    return float(grid[int(np.argmin(curve))])


def devig_comparison(
    cases: Sequence[FixtureCase],
    tables: Mapping[str, Dict[str, np.ndarray]],
    grid: Sequence[float],
    alpha: float = DEFAULT_ALPHA,
    baseline: str = PROPORTIONAL,
) -> Dict[str, Any]:
    """
    Compare de-vig methods AT w = 1, where the choice has power.

    At a production weight near 0.5 the market contributes a fraction of a
    log-rate difference and a ~1.6pp reshuffle between de-vig methods is buried
    under the Dixon-Coles component. At w = 1 the score IS the de-vigged market,
    so this is the only place the discrete hyperparameter is identifiable.

    Proportional is the baseline because it is the simplest, not because it is
    expected to win. A method is preferred only if its anytime-valid interval
    EXCLUDES zero in its favour; a better point estimate is not evidence.
    """
    if 1.0 not in tuple(grid):
        raise ValueError("the de-vig comparison needs w = 1.0 on the grid")
    column = tuple(grid).index(1.0)

    _, baseline_rounds = round_means(cases, tables[baseline][PRIMARY_METRIC])
    baseline_losses = baseline_rounds[:, column]

    pairs: List[Dict[str, Any]] = []
    for method in tables:
        if method == baseline:
            continue
        _, candidate_rounds = round_means(cases, tables[method][PRIMARY_METRIC])
        differences = baseline_losses - candidate_rounds[:, column]
        interval = paired_interval(differences, alpha=alpha)
        interval["method"] = method
        interval["baseline"] = baseline
        interval["mean_loss"] = float(candidate_rounds[:, column].mean())
        pairs.append(interval)

    decisive = [pair for pair in pairs if pair["excludes_zero"] and pair["mean"] > 0.0]
    if not pairs:
        recommended = baseline
        finding = (
            f"Only {baseline} was evaluated, so there is no comparison to make; "
            f"the de-vig choice is unmeasured in this run."
        )
    elif decisive:
        winner = max(decisive, key=lambda pair: pair["mean"])
        recommended = winner["method"]
        finding = (
            f"{recommended} beats {baseline} at w=1 by {winner['mean']:+.4f} nats "
            f"per match with an anytime-valid lower bound of {winner['lower']:+.4f}, "
            f"which excludes zero. Prefer {recommended}."
        )
    else:
        recommended = baseline
        finding = (
            f"No de-vig method's anytime-valid interval excludes zero against "
            f"{baseline} at w=1. Keep {baseline}, the simplest. The point "
            f"estimates differ ("
            + ", ".join(f"{p['method']} {p['mean']:+.4f}" for p in pairs)
            + ") but a point estimate is not evidence, and picking a winner on "
            "one would be choosing a hyperparameter on noise."
        )
    return {
        "at_weight": 1.0,
        "baseline": baseline,
        "baseline_mean_loss": float(baseline_losses.mean()),
        "pairs": pairs,
        "recommended_method": recommended,
        "finding": finding,
    }


def secondary_agreement(
    tables: Mapping[str, Dict[str, np.ndarray]],
    method: str,
    grid: Sequence[float],
    primary_argmin: float,
) -> Dict[str, Any]:
    """
    Do the level and split metrics want the same weight the primary loss does?

    A disagreement is a substantive finding, not a nuisance: the primary loss
    optimises one scalar for two things the market prices separately (a totals
    line and a 1X2), so if the total wants one weight and the split wants
    another, the blend should carry two.
    """
    argmins = {
        name: _argmin_weight(tables[method][name].mean(axis=0), grid)
        for name in METRIC_NAMES
    }
    level_gap = abs(argmins[LEVEL_METRIC] - primary_argmin)
    split_gap = abs(argmins[SPLIT_METRIC] - primary_argmin)
    agrees = level_gap <= AGREEMENT_TOLERANCE and split_gap <= AGREEMENT_TOLERANCE
    if agrees:
        verdict = (
            f"The level (CRPS on total goals, argmin {argmins[LEVEL_METRIC]:.2f}) and "
            f"the split (1X2 log-loss, argmin {argmins[SPLIT_METRIC]:.2f}) both agree "
            f"with the primary argmin {primary_argmin:.2f} to within "
            f"{AGREEMENT_TOLERANCE:.2f}. One scalar w is adequate; no evidence for "
            f"splitting it into separate total and supremacy weights."
        )
    else:
        verdict = (
            f"DISAGREEMENT: the primary argmin is {primary_argmin:.2f} but the level "
            f"(CRPS on total goals) wants {argmins[LEVEL_METRIC]:.2f} and the split "
            f"(1X2 log-loss) wants {argmins[SPLIT_METRIC]:.2f}. That is evidence for "
            f"splitting w into separate total and supremacy weights: the market "
            f"posts a totals line and a 1X2 as separate markets, and a single "
            f"scalar forces one compromise across both."
        )
    return {
        "argmins": argmins,
        "level_gap": float(level_gap),
        "split_gap": float(split_gap),
        "tolerance": round(AGREEMENT_TOLERANCE, 4),
        "agrees": bool(agrees),
        "verdict": verdict,
    }


def per_season_folds(
    cases: Sequence[FixtureCase],
    table: Mapping[str, np.ndarray],
    grid: Sequence[float],
    alpha: float = DEFAULT_ALPHA,
) -> List[Dict[str, Any]]:
    """
    The same fit restricted to each season's rounds.

    Not a cross-validation — every fold is still walk-forward and every fold's
    model still trained on earlier seasons. It is a stability check: a weight
    that swings across seasons is not one weight.
    """
    primary = table[PRIMARY_METRIC]
    folds: List[Dict[str, Any]] = []
    for season in sorted({case.season for case in cases}):
        mask = np.array([case.season == season for case in cases], dtype=bool)
        subset = [case for case in cases if case.season == season]
        curve = primary[mask].mean(axis=0)
        argmin = _argmin_weight(curve, grid)
        _, rounds = round_means(subset, primary[mask])
        column = tuple(grid).index(argmin)
        folds.append({
            "season": season,
            "n_matches": int(mask.sum()),
            "n_rounds": int(rounds.shape[0]),
            "argmin": argmin,
            "loss_at_argmin": float(curve[column]),
            "loss_at_0": float(curve[0]),
            "loss_at_1": float(curve[-1]),
            "vs_w0": paired_interval(rounds[:, 0] - rounds[:, column], alpha=alpha),
            "vs_w1": paired_interval(rounds[:, -1] - rounds[:, column], alpha=alpha),
        })
    return folds


def flat_region(
    curve: np.ndarray, grid: Sequence[float], fraction: float = FLAT_REGION_FRACTION
) -> Tuple[float, float]:
    """
    The span of weights indistinguishable from the argmin, as a practical matter.

    This is the real content of the answer and the argmin alone hides it. On the
    three-season run the curve falls 0.041 nats from w = 0 to its minimum and then
    varies by 0.0012 across the whole of [0.80, 1.00] — thirty times less than the
    anytime-valid radius. Reporting only "0.95" would present a choice within that
    span as if it were evidence-driven.
    """
    curve = np.asarray(curve, dtype=float)
    best = float(curve.min())
    improvement = float(curve[0] - best)
    tolerance = max(fraction * improvement, 0.0)
    inside = np.flatnonzero(curve <= best + tolerance)
    return float(grid[int(inside[0])]), float(grid[int(inside[-1])])


def recommendation(
    argmin: float,
    interval_vs_w0: Mapping[str, Any],
    interval_vs_w1: Mapping[str, Any],
    current: float,
    band: Tuple[float, float],
    closing_haircut: float = CLOSING_LINE_HAIRCUT,
    mle_haircut: float = MLE_SUBSTITUTE_HAIRCUT,
) -> Dict[str, Any]:
    """
    Turn the fitted weight into a value a human can apply, with both haircuts.

    The haircuts are for BIASES (:data:`CAVEAT_CLOSING_LINE` and
    :data:`CAVEAT_MLE_SUBSTITUTE`), not sampling error, so they multiply the point
    estimate rather than being read off the interval. The interval is reported
    alongside and answers a different question — whether the market helps at all.

    Composed multiplicatively because both act on the same log-space weight, and
    snapped DOWN to the grid: both biases push upward, so the grid's own 0.05
    resolution is spent toward the posterior.
    """
    raw = argmin * (1.0 - closing_haircut) * (1.0 - mle_haircut)
    value = round(math.floor(raw / GRID_STEP) * GRID_STEP, 2)
    # gate_move_size caps one promotion at 25% of the (0, 1) bound range.
    promotable = (round(current - 0.25, 2), round(current + 0.25, 2))
    within = promotable[0] <= value <= promotable[1]
    return {
        "fitted_argmin": argmin,
        "indistinguishable_band": list(band),
        "closing_line_haircut": closing_haircut,
        "mle_substitute_haircut": mle_haircut,
        "haircut_before_snapping": round(raw, 4),
        "recommended_value": value,
        "current_value": current,
        "promotable_band_one_step": list(promotable),
        "within_one_promotion": bool(within),
        "market_helps_vs_w0": bool(interval_vs_w0.get("excludes_zero")
                                  and (interval_vs_w0.get("mean") or 0.0) > 0.0),
        "posterior_helps_vs_w1": bool(interval_vs_w1.get("excludes_zero")
                                     and (interval_vs_w1.get("mean") or 0.0) > 0.0),
        "note": (
            f"Fitted argmin {argmin:.2f} on CLOSING prices, indistinguishable from "
            f"anything in [{band[0]:.2f}, {band[1]:.2f}]. Haircut "
            f"{closing_haircut:.0%} for the pre-deadline gap and {mle_haircut:.0%} "
            f"for the MLE standing in for the Bayesian posterior, then snapped down "
            f"to the grid: {value:.2f}. "
            + (f"Reachable from {current:.2f} in one promotion."
               if within else
               f"NOT reachable from {current:.2f} in one promotion "
               f"(gate_move_size caps a step at 0.25 of the bound range); it needs "
               f"two, or a deliberate override.")
        ),
    }


def build_report(
    cases: Sequence[FixtureCase],
    diagnostics: CorpusDiagnostics,
    methods: Sequence[str] = DEVIG_METHODS,
    grid: Sequence[float] = WEIGHT_GRID,
    alpha: float = DEFAULT_ALPHA,
    current_value: Optional[float] = None,
    max_goals: int = MAX_GOALS,
) -> Dict[str, Any]:
    """
    Score the grid, pick a de-vig method, and assemble the JSON report.

    Separated from :func:`fit_market_blend` so tests can drive it with hand-built
    cases and no fetch, and so a synthetic market whose answer is known can check
    the harness can actually distinguish w = 0 from w = 1.
    """
    if not cases:
        raise ValueError("no out-of-sample cases; nothing to fit")
    grid = tuple(float(w) for w in grid)
    tables = {
        method: metric_table(cases, method, grid, max_goals) for method in methods
    }
    comparison = devig_comparison(cases, tables, grid, alpha=alpha)
    method = comparison["recommended_method"]
    table = tables[method]

    curve = table[PRIMARY_METRIC].mean(axis=0)
    argmin = _argmin_weight(curve, grid)
    column = grid.index(argmin)
    labels, rounds = round_means(cases, table[PRIMARY_METRIC])

    interval_vs_w0 = paired_interval(rounds[:, 0] - rounds[:, column], alpha=alpha)
    interval_vs_w1 = paired_interval(rounds[:, -1] - rounds[:, column], alpha=alpha)

    if current_value is None:
        from pipeline.config import PARAM_REGISTRY

        current_value = float(PARAM_REGISTRY["market.blend_weight"]["value"])

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "parameter": "market.blend_weight",
        "n_matches": int(len(cases)),
        "n_rounds": int(len(labels)),
        "seasons": sorted({case.season for case in cases}),
        "weight_grid": list(grid),
        "devig_method": method,
        "corpus": diagnostics.as_dict(),
        "primary_loss": (
            "negative log-likelihood of the realised exact scoreline under "
            "BayesianDixonColes.scoreline_matrix(lam, mu, rho), per match"
        ),
        "loss_curve": {
            candidate: [float(v) for v in tables[candidate][PRIMARY_METRIC].mean(axis=0)]
            for candidate in tables
        },
        "argmin": {
            candidate: _argmin_weight(
                tables[candidate][PRIMARY_METRIC].mean(axis=0), grid
            )
            for candidate in tables
        },
        "headline": {
            "devig_method": method,
            "w_hat": argmin,
            "loss_at_w_hat": float(curve[column]),
            "loss_at_0": float(curve[0]),
            "loss_at_1": float(curve[-1]),
            "indistinguishable_band": list(flat_region(curve, grid)),
        },
        "intervals": {"vs_w0": interval_vs_w0, "vs_w1": interval_vs_w1},
        "devig_comparison": comparison,
        "secondary_metrics": {
            "note": (
                "Reported, never optimised. total_crps isolates the level, "
                "outcome_nll the split, *_cs_nll the clean sheets that dominate "
                "FPL defender points."
            ),
            "at_w_hat": {
                name: float(table[name].mean(axis=0)[column]) for name in METRIC_NAMES
            },
            "at_w0": {name: float(table[name].mean(axis=0)[0]) for name in METRIC_NAMES},
            "at_w1": {name: float(table[name].mean(axis=0)[-1]) for name in METRIC_NAMES},
            "curves": {
                name: [float(v) for v in table[name].mean(axis=0)]
                for name in METRIC_NAMES
            },
            "agreement": secondary_agreement(tables, method, grid, argmin),
        },
        "per_season": per_season_folds(cases, table, grid, alpha=alpha),
        "recommendation": recommendation(
            argmin, interval_vs_w0, interval_vs_w1, float(current_value),
            flat_region(curve, grid),
        ),
        "caveats": [CAVEAT_CLOSING_LINE, CAVEAT_THIN_BOOKS, CAVEAT_MLE_SUBSTITUTE],
    }


def fit_market_blend(
    seasons: Optional[Sequence[str]] = None,
    methods: Sequence[str] = DEVIG_METHODS,
    grid: Sequence[float] = WEIGHT_GRID,
    min_train_matches: int = MIN_TRAIN_MATCHES,
    alpha: float = DEFAULT_ALPHA,
    force: bool = False,
) -> Dict[str, Any]:
    """Load the corpus, walk forward over it, and build the report."""
    frame = load_closing_odds(seasons=list(seasons) if seasons else None, force=force)
    logger.info("corpus: %d played matches across %s", len(frame),
                sorted(frame["season"].unique()))
    cases, diagnostics = walk_forward_cases(
        frame, methods=methods, min_train_matches=min_train_matches
    )
    logger.info(
        "%d out-of-sample fixtures over %d rounds (%d burn-in, %d no market, "
        "%d prior-only), %.2fs of refits",
        len(cases), diagnostics.n_rounds_scored, diagnostics.n_rounds_burn_in,
        diagnostics.n_dropped_no_market, diagnostics.n_dropped_prior_only,
        diagnostics.fit_seconds,
    )
    return build_report(cases, diagnostics, methods=methods, grid=grid, alpha=alpha)


def summary(report: Mapping[str, Any]) -> str:
    """Human-readable digest. The JSON is the artifact; this is for the terminal."""
    head = report["headline"]
    lines = [
        f"market.blend_weight — {report['n_matches']} fixtures, "
        f"{report['n_rounds']} rounds, seasons {', '.join(report['seasons'])}",
        f"  de-vig: {report['devig_method']}",
        f"  w_hat = {head['w_hat']:.2f}   loss {head['loss_at_w_hat']:.4f} "
        f"(w=0 {head['loss_at_0']:.4f}, w=1 {head['loss_at_1']:.4f})",
        f"  indistinguishable band: "
        f"[{head['indistinguishable_band'][0]:.2f}, "
        f"{head['indistinguishable_band'][1]:.2f}]",
    ]
    for name, interval in report["intervals"].items():
        # An unbounded radius is a real answer below gates.MIN_OBSERVATIONS
        # rounds, and it must print as one rather than crash the summary.
        bounds = (
            f"[{interval['lower']:+.4f}, {interval['upper']:+.4f}]"
            if interval["lower"] is not None
            else f"unbounded (n < {MIN_OBSERVATIONS} rounds)"
        )
        lines.append(
            f"  {name}: {interval['mean']:+.4f} {bounds} "
            f"n={interval['n']} excludes_zero={interval['excludes_zero']}"
        )
    lines.append("  loss curve:")
    curve = report["loss_curve"][report["devig_method"]]
    for weight, value in zip(report["weight_grid"], curve):
        lines.append(f"    w={weight:.2f}  {value:.5f}")
    lines.append("  " + report["devig_comparison"]["finding"])
    lines.append("  " + report["secondary_metrics"]["agreement"]["verdict"])
    lines.append("  per season:")
    for fold in report["per_season"]:
        lines.append(
            f"    {fold['season']}: n={fold['n_matches']} rounds={fold['n_rounds']} "
            f"argmin={fold['argmin']:.2f} loss={fold['loss_at_argmin']:.4f}"
        )
    lines.append("  " + report["recommendation"]["note"])
    for caveat in report["caveats"]:
        lines.append("  CAVEAT: " + caveat)
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_REPORT_PATH,
        help=(
            "where to write the JSON report. Defaults to a scratch path and must "
            "NOT be inside predictions/: that directory is uploaded to Supabase "
            "and read by the frontend, so a research artifact there would look "
            "like a shipped contract."
        ),
    )
    parser.add_argument("--seasons", nargs="*", default=None,
                        help=f"season codes; default {SEASONS}")
    parser.add_argument("--min-train-matches", type=int, default=MIN_TRAIN_MATCHES)
    parser.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    parser.add_argument("--force", action="store_true",
                        help="re-download the season CSVs")
    args = parser.parse_args(argv)

    if "predictions" in args.out.parts:
        parser.error(
            "refusing to write into predictions/: that directory is the published "
            "artifact set, and this report is a measurement"
        )

    report = fit_market_blend(
        seasons=args.seasons,
        min_train_matches=args.min_train_matches,
        alpha=args.alpha,
        force=args.force,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(summary(report))
    print(f"\nreport: {args.out}")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    raise SystemExit(main())
