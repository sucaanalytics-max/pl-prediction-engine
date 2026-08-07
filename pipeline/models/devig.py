"""
Removing the bookmaker margin from a set of prices.

**The input discipline is the first-order concern, ahead of the method.** A
bookmaker's prices for one market imply probabilities summing to more than one;
that surplus is the margin, and removing it is what de-vigging means. The
best-price-across-bookmakers vector that ``parse_match_odds`` produces is a *max
over books* and frequently sums to LESS than one, so "normalising" it inflates
every probability instead of deflating them. There is no margin there to remove.
Every function here therefore takes one bookmaker's prices, and
:func:`aggregate_books` combines the results afterwards.

That is not a fussy point about magnitude. The distortion from best-price mixing
is only ~1-2pp, but it is **unstable** — it scales with how many books happened to
quote, which changes daily — so it injects noise of roughly 0.05-0.10 goals into
any derived goal rate. Noise in a covariate attenuates a fitted blend weight
toward zero, and we would then conclude "the market does not help much" from our
own preprocessing rather than from the market.

**Three methods, and the choice is measured rather than argued.** Proportional
normalisation is the standard and has a known favourite-longshot bias; Shin's
model derives the margin from an assumed share of insider money; the power method
is a flexible middle. They differ by up to ~1.6pp on the longest leg of a
5% three-way book. Measured end to end, that maps to a median 0.075 and a maximum
0.212 goals of difference in the inverted rate — the same order as, not five to
ten times below, a posterior standard deviation of 0.15-0.25. So the method choice
is not negligible and must be decided by the same out-of-sample loss as the blend
weight, keeping the simplest only if the difference does not survive it.

**Exchanges are not margin books.** A back price on an exchange has no bookmaker
margin to model; its spread is a bid/ask between punters. Applying an
insider-trading margin model to it is a category error, so exchanges take the
proportional path and are labelled.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

PROPORTIONAL = "proportional"
POWER = "power"
SHIN = "shin"
METHODS = (PROPORTIONAL, POWER, SHIN)

BOOK_MARGIN = "margin_book"
BOOK_EXCHANGE = "exchange"

# A real single-book market carries a margin in this band. Below it the "book" is
# not one book — most often a best-price vector mixed across bookmakers, which
# must never be de-vigged. Above it the book is either a novelty market or stale.
MIN_PLAUSIBLE_MARGIN = 0.005
MAX_PLAUSIBLE_MARGIN = 0.15

# Fewer than this and a median across books is not a median. Below the floor we
# fall back to the single lowest-margin book and shrink its influence.
DEFAULT_MIN_BOOKS = 3

# Dispersion to assume when it cannot be MEASURED — one book has no one to
# disagree with, and two disagree too noisily to trust.
#
# Reporting 0.0 there was a real defect, because a consumer dividing by dispersion
# reads "no disagreement" as "maximum confidence": a lone book scored better than
# a five-book consensus whose measured logit dispersion was 0.163. Unmeasurable is
# not zero. This value is deliberately pessimistic relative to that typical 0.16,
# so an unmeasurable market can never outrank a measured one.
UNMEASURED_DISPERSION = 0.20


class DevigError(ValueError):
    """The prices cannot be de-vigged, and guessing would be worse than failing."""


def book_margin(prices: Mapping[str, float]) -> float:
    """Overround: how much more than 1.0 the implied probabilities sum to."""
    total = sum(1.0 / float(price) for price in prices.values() if float(price) > 0)
    return total - 1.0


def _check(prices: Mapping[str, float]) -> Dict[str, float]:
    if len(prices) < 2:
        raise DevigError(f"need at least two outcomes, got {sorted(prices)}")
    clean: Dict[str, float] = {}
    for outcome, price in prices.items():
        value = float(price)
        if not value > 1.0:
            raise DevigError(
                f"decimal odds must exceed 1.0; {outcome!r} is {value}"
            )
        clean[outcome] = value
    return clean


def assert_single_book(prices: Mapping[str, float]) -> None:
    """
    Refuse a price vector that is not one bookmaker's coherent view.

    This is the guard that makes the whole module's premise enforceable rather
    than merely documented. A book summing to at or below 1.0 is either an
    arbitrage — which does not survive in a real market — or, far more likely, a
    best-price vector assembled across bookmakers.
    """
    margin = book_margin(_check(prices))
    if margin < MIN_PLAUSIBLE_MARGIN:
        raise DevigError(
            f"implied probabilities sum to {1 + margin:.4f}, which is not a single "
            f"bookmaker's book. A best-price-across-bookmakers vector has no "
            f"margin to remove and must not be de-vigged."
        )
    if margin > MAX_PLAUSIBLE_MARGIN:
        raise DevigError(
            f"margin {margin:.1%} exceeds the plausible single-book band "
            f"(<= {MAX_PLAUSIBLE_MARGIN:.0%}); treating this book as unusable"
        )


def devig_proportional(prices: Mapping[str, float]) -> Dict[str, float]:
    """
    Scale every implied probability by the same factor. The standard method.

    Known bias: it assumes the margin is applied proportionally across outcomes,
    whereas bookmakers load more of it onto longshots. So it understates the
    favourite and overstates the longshot.
    """
    clean = _check(prices)
    raw = {outcome: 1.0 / price for outcome, price in clean.items()}
    total = sum(raw.values())
    return {outcome: value / total for outcome, value in raw.items()}


def _solve_scalar(
    objective, low: float, high: float, tolerance: float = 1e-12
) -> float:
    """
    Bisection on a monotone objective.

    Hand-rolled rather than scipy.optimize.brentq so this module stays a pure
    function of its inputs with no solver configuration to drift, and so it can
    be reasoned about: the objectives below are monotone by construction, which
    is exactly the condition bisection needs.
    """
    f_low, f_high = objective(low), objective(high)
    if f_low == 0.0:
        return low
    if f_high == 0.0:
        return high
    if f_low * f_high > 0:
        raise DevigError(
            f"no solution bracketed in [{low}, {high}] "
            f"(objective {f_low:.6f} .. {f_high:.6f})"
        )
    for _ in range(200):
        middle = 0.5 * (low + high)
        value = objective(middle)
        if abs(value) < tolerance or high - low < tolerance:
            return middle
        if value * f_low > 0:
            low, f_low = middle, value
        else:
            high = middle
    return 0.5 * (low + high)


def devig_power(prices: Mapping[str, float]) -> Dict[str, float]:
    """
    Raise each implied probability to a common power chosen so they sum to 1.

    Because every implied probability is below 1, a power above 1 shrinks them
    all — and shrinks the small ones proportionally more, which is the
    favourite-longshot direction.
    """
    clean = _check(prices)
    raw = [1.0 / price for price in clean.values()]

    def objective(k: float) -> float:
        return sum(value ** k for value in raw) - 1.0

    exponent = _solve_scalar(objective, 0.5, 10.0)
    adjusted = {
        outcome: (1.0 / price) ** exponent for outcome, price in clean.items()
    }
    # The solve is to 1e-12; renormalise so the result sums to exactly 1.
    total = sum(adjusted.values())
    return {outcome: value / total for outcome, value in adjusted.items()}


def devig_shin(prices: Mapping[str, float]) -> Dict[str, float]:
    """
    Shin's model: the margin arises from a share ``z`` of insider money.

        p_i = ( sqrt(z^2 + 4(1-z)*r_i^2/S) - z ) / ( 2(1-z) ),  r_i = 1/o_i,
        S = sum r_j

    with ``z`` solved so the probabilities sum to one. At zero margin ``S = 1``
    and ``z`` goes to zero, recovering the raw implied probabilities — which is
    the property the tests pin, rather than trusting the closed form from memory.

    Moves the longshot further than proportional does, which is the empirically
    observed direction of bookmaker margin loading.
    """
    clean = _check(prices)
    raw = {outcome: 1.0 / price for outcome, price in clean.items()}
    total = sum(raw.values())

    def implied(z: float) -> Dict[str, float]:
        # No special case at z = 0: the formula is well defined there and gives
        # r_i / sqrt(S), which sums to sqrt(S) rather than 1. Short-circuiting to
        # the proportional result instead made the objective zero at z = 0, so the
        # bisection returned z = 0 immediately and Shin silently became
        # proportional for every input — identical to 12 decimal places, which is
        # exactly how that mistake hides.
        denominator = 2.0 * (1.0 - z)
        return {
            outcome: (
                math.sqrt(z * z + 4.0 * (1.0 - z) * value * value / total) - z
            ) / denominator
            for outcome, value in raw.items()
        }

    def objective(z: float) -> float:
        return sum(implied(z).values()) - 1.0

    # z is bounded below 1 by construction; 0.4 is far above any real football
    # market and keeps the bracket away from the singularity at z = 1.
    try:
        z = _solve_scalar(objective, 0.0, 0.4)
    except DevigError:
        logger.debug("Shin did not bracket; falling back to proportional")
        return devig_proportional(clean)

    result = implied(z)
    result_total = sum(result.values())
    return {outcome: value / result_total for outcome, value in result.items()}


_METHOD_FUNCTIONS = {
    PROPORTIONAL: devig_proportional,
    POWER: devig_power,
    SHIN: devig_shin,
}


def classify_book(bookmaker_key: str) -> str:
    """Whether a bookmaker charges a margin or is an exchange."""
    key = (bookmaker_key or "").lower()
    if "_ex_" in key or key.endswith("_ex") or key.startswith("betfair_ex"):
        return BOOK_EXCHANGE
    return BOOK_MARGIN


def devig(
    prices: Mapping[str, float],
    method: str = SHIN,
    bookmaker_key: str = "",
    strict: bool = True,
) -> Dict[str, float]:
    """
    De-vig one bookmaker's prices.

    ``strict`` runs :func:`assert_single_book` first and is on by default, because
    the input error this module exists to prevent is silent and the failure it
    causes looks like a small modelling difference rather than a bug.
    """
    if method not in METHODS:
        raise DevigError(f"unknown de-vig method {method!r}; expected {METHODS}")
    if strict:
        assert_single_book(prices)
    if classify_book(bookmaker_key) == BOOK_EXCHANGE and method != PROPORTIONAL:
        # An exchange back price carries no bookmaker margin; its spread is a
        # bid/ask. Modelling it as insider-driven margin is a category error.
        return devig_proportional(prices)
    return _METHOD_FUNCTIONS[method](prices)


@dataclass(frozen=True)
class BookConsensus:
    """A cross-bookmaker view of one market, with its own quality diagnostics."""

    probabilities: Dict[str, float]
    n_books: int
    # Largest absolute deviation of any single book from the consensus, in logit
    # space. The natural detector for a thin or stale price, and it is what
    # weights this market's residual in the inversion — a market where books
    # disagree should pull the fit less.
    dispersion: float
    status: str            # "ok" | "thin" | "absent"
    # Multiplier in [0, 1] on how much this consensus should be trusted. Smooth
    # rather than a cliff, so a two-book fixture is not treated as a five-book one
    # and is not discarded either.
    weight: float
    dropped: Dict[str, str] = field(default_factory=dict)
    method: str = SHIN

    def as_dict(self) -> Dict[str, Any]:
        return {
            "probabilities": dict(self.probabilities),
            "n_books": self.n_books,
            "dispersion": self.dispersion,
            "status": self.status,
            "weight": self.weight,
            "dropped": dict(self.dropped),
            "method": self.method,
        }


def _logit(p: float) -> float:
    p = min(max(p, 1e-9), 1.0 - 1e-9)
    return math.log(p / (1.0 - p))


def aggregate_books(
    per_book: Mapping[str, Mapping[str, float]],
    method: str = SHIN,
    min_books: int = DEFAULT_MIN_BOOKS,
) -> BookConsensus:
    """
    De-vig each bookmaker separately, then take the coordinatewise median.

    Median rather than mean because a stale book is an outlier and the median
    simply ignores it — no threshold to tune, and no need to decide how stale is
    too stale. The median of points on a simplex need not sum to one, so the
    result is renormalised; the correction is a fraction of a percent.

    Below ``min_books`` there is no meaningful median, so the single
    lowest-margin book is used and the consensus is marked ``thin`` with a reduced
    weight. Discarding the fixture instead would throw away real information, and
    treating it as equal to a five-book consensus would overstate it.
    """
    devigged: Dict[str, Dict[str, float]] = {}
    dropped: Dict[str, str] = {}
    margins: Dict[str, float] = {}

    # Handed a flat {outcome: price} mapping instead of {bookmaker: {outcome:
    # price}}, every "book" would be a float and the error would surface as a
    # TypeError deep inside a margin calculation. That flat shape is exactly the
    # best-price vector this module exists to refuse, so name it: it is a caller
    # bug, and a caller bug should be loud rather than degraded to "no market".
    for bookmaker, prices in per_book.items():
        if not isinstance(prices, Mapping):
            raise DevigError(
                f"expected {{bookmaker: {{outcome: price}}}} but {bookmaker!r} maps "
                f"to {type(prices).__name__}. A flat mapping of outcomes to prices "
                f"is a best-price vector, not a bookmaker's book, and must not be "
                f"de-vigged."
            )

    for bookmaker, prices in per_book.items():
        if not prices:
            dropped[bookmaker] = "no prices"
            continue
        try:
            margin = book_margin(_check(prices))
            assert_single_book(prices)
            devigged[bookmaker] = devig(
                prices, method=method, bookmaker_key=bookmaker, strict=False
            )
            margins[bookmaker] = margin
        except DevigError as exc:
            dropped[bookmaker] = str(exc)

    if not devigged:
        return BookConsensus(
            probabilities={}, n_books=0, dispersion=float("nan"),
            status="absent", weight=0.0, dropped=dropped, method=method,
        )

    outcomes = sorted(next(iter(devigged.values())))
    # A book that quoted a different outcome set cannot be medianed with the rest.
    for bookmaker in list(devigged):
        if sorted(devigged[bookmaker]) != outcomes:
            dropped[bookmaker] = "outcome set differs from the consensus"
            devigged.pop(bookmaker)
            margins.pop(bookmaker, None)
    if not devigged:
        return BookConsensus(
            probabilities={}, n_books=0, dispersion=float("nan"),
            status="absent", weight=0.0, dropped=dropped, method=method,
        )

    if len(devigged) < min_books:
        best = min(margins, key=lambda bookmaker: margins[bookmaker])
        probabilities = dict(devigged[best])
        n = len(devigged)
        return BookConsensus(
            probabilities=probabilities,
            n_books=n,
            # Floored at the unmeasurable prior, never 0. One book cannot earn
            # confidence by having nobody to disagree with, and two disagree too
            # noisily for the measurement to be trusted on its own.
            dispersion=max(
                UNMEASURED_DISPERSION,
                0.0 if n == 1 else _dispersion(devigged, probabilities),
            ),
            status="thin",
            # n/(n+2): one book gets a third of the weight of many, two get a
            # half. Smooth, and it needs no threshold beyond min_books itself.
            weight=n / (n + 2.0),
            dropped=dropped,
            method=method,
        )

    consensus: Dict[str, float] = {}
    for outcome in outcomes:
        values = sorted(book[outcome] for book in devigged.values())
        middle = len(values) // 2
        consensus[outcome] = (
            values[middle] if len(values) % 2
            else 0.5 * (values[middle - 1] + values[middle])
        )
    total = sum(consensus.values())
    consensus = {outcome: value / total for outcome, value in consensus.items()}

    return BookConsensus(
        probabilities=consensus,
        n_books=len(devigged),
        dispersion=_dispersion(devigged, consensus),
        status="ok",
        weight=1.0,
        dropped=dropped,
        method=method,
    )


def _dispersion(
    devigged: Mapping[str, Mapping[str, float]], consensus: Mapping[str, float]
) -> float:
    """Largest absolute logit deviation of any book from the consensus."""
    worst = 0.0
    for book in devigged.values():
        for outcome, value in book.items():
            worst = max(worst, abs(_logit(value) - _logit(consensus[outcome])))
    return worst


def apply_margin(
    probabilities: Mapping[str, float], booksum: float, method: str = PROPORTIONAL
) -> Dict[str, float]:
    """
    Turn true probabilities into decimal odds carrying a known margin.

    The inverse of the de-vig functions, and it exists for the round-trip test:
    generate exact prices from known probabilities, remove the margin, and check
    the original probabilities come back. Without an inverse, a de-vig can only be
    checked against itself.
    """
    if method != PROPORTIONAL:
        raise DevigError(
            f"only the proportional inverse is implemented; got {method!r}"
        )
    if booksum <= 1.0:
        raise DevigError(f"booksum must exceed 1.0 to carry a margin; got {booksum}")
    return {
        outcome: 1.0 / (probability * booksum)
        for outcome, probability in probabilities.items()
    }
