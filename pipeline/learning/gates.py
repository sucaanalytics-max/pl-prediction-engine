"""
The gates a proposed parameter change must pass before it ships.

This module exists because the refit loop's most likely failure is not a crash.
It is a reviewable commit, with plausible before/after numbers, that makes the
model worse — and four independent routes lead there: optional stopping, a
model-dependent benchmark, a leaky re-projection, and using decision-level
regret as evidence. Each gate closes one.

**Why an anytime-valid bound and not a t-test.** The refit is re-run every
gameweek on an expanding window and ships the first time it passes. That is
optional stopping, and under it a fixed-alpha test has a family-wise error rate
that approaches 1: run it enough weeks and something always clears. A confidence
sequence is valid at ALL stopping times simultaneously, so "test weekly, ship
when it passes" is a legitimate procedure rather than a way of manufacturing
significance.

**Why the gates are separate functions.** Each is independently testable and
each states its own reason for existing. A single ``should_promote`` returning a
bool would pass its tests while silently skipping a check.

Nothing here fits anything. Fitting lives elsewhere; this only ever says no.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from pipeline.config import PARAM_REGISTRY, RISK

logger = logging.getLogger(__name__)

# Effective sample size below which a parameter is not identifiable at all.
# Clustered, not raw: minutes cluster at team-gameweek because a rotating
# manager rotates six players at once, so 15,000 raw rows can carry an ESS
# nearer 800.
MIN_EFFECTIVE_SAMPLE = 500.0

# Free parameters one block may move at once. More than this and the block is
# not identified by a single season's worth of weekly observations.
MAX_BLOCK_PARAMETERS = 4

# Fraction of its bound range a value may travel in one promotion. A parameter
# that can jump from one end to the other in a single week is not being fitted,
# it is being resampled.
MAX_RELATIVE_MOVE = 0.25

# Confidence level for the sequence. Deliberately not 0.05: this is re-tested
# every week for a season, and the whole point is to be conservative under
# repeated looks.
DEFAULT_ALPHA = 0.01

# Gameweeks of evidence before the sequence may promote anything.
#
# NOT cosmetic. The normal-mixture boundary is derived for a KNOWN variance, and
# it is fed the sample standard deviation. At two or three observations that
# estimate can be small purely by chance, and small-sigma draws are exactly the
# ones whose mean also looks large — so the bound becomes anti-conservative
# precisely where it is least trustworthy. Measured on 400 simulated seasons of
# pure noise, promoting on the first week the gate passes:
#
#     minimum n      2      5      8     10     15
#     false promo  0.077  0.018  0.005  0.003  0.003
#
# At the nominal alpha of 0.01 the naive version promotes noise 7.7% of the
# time. Ten observations brings it to 0.003, comfortably under nominal, and a
# genuine effect still clears easily. Ten gameweeks is also a reasonable floor
# on its own terms: nothing about a season is identifiable from fewer.
MIN_OBSERVATIONS = 10


@dataclass
class GateResult:
    """One gate's verdict. ``passed`` false always carries a reason."""

    name: str
    passed: bool
    reason: str = ""
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "gate": self.name, "passed": self.passed,
            "reason": self.reason, "detail": self.detail,
        }


def anytime_valid_bound(
    differences: Sequence[float], alpha: float = DEFAULT_ALPHA, rho: float = 1.0
) -> Tuple[float, float]:
    """
    Normal-mixture confidence sequence for the mean of paired differences.

    Returns ``(mean, radius)``; the interval ``mean +/- radius`` covers the true
    mean at every sample size simultaneously with probability ``1 - alpha``.
    That "simultaneously" is the whole point — it is what makes looking every
    week legitimate.

    The width shrinks like ``sqrt(log log n / n)`` rather than ``sqrt(1/n)``, so
    it is strictly wider than a fixed-n interval. Paying that is the cost of
    being allowed to stop whenever the answer looks good.

    ``rho`` tunes where the sequence is tightest; 1.0 is a reasonable default at
    the tens-of-observations scale a gameweek stream produces.
    """
    values = np.asarray(differences, dtype=float)
    n = len(values)
    if n < MIN_OBSERVATIONS:
        # Too few looks for the sample standard deviation to be trusted in a
        # boundary derived for known variance. Infinite radius means the gate
        # refuses rather than promoting on a run of lucky weeks.
        return (float(values.mean()) if n else 0.0), float("inf")

    mean = float(values.mean())
    sigma = float(values.std(ddof=1))
    if sigma == 0.0:
        # Every difference identical: the mean is known exactly.
        return mean, 0.0

    # Howard et al. normal-mixture boundary.
    inner = (n * rho ** 2 + 1.0)
    radius = sigma * math.sqrt(
        (2.0 * inner / (n ** 2 * rho ** 2)) * math.log(math.sqrt(inner) / alpha)
    )
    return mean, float(radius)


def gate_is_registered(name: str) -> GateResult:
    """
    Only parameters declared in the registry may be refit.

    Anything absent has no bounds, no tier and no stated provenance, so there is
    nothing to check a proposal against.
    """
    ok = name in PARAM_REGISTRY
    return GateResult(
        "registered", ok,
        "" if ok else f"{name} is not in PARAM_REGISTRY and is not refit-eligible",
    )


def gate_not_risk(name: str) -> GateResult:
    """
    The staking namespace is never touched by the learning loop.

    Kelly staking is real money and its parameters are a risk posture, not a
    forecast. A loop that could widen a stake cap by fitting is a different and
    far more dangerous system than one that fits expected points.
    """
    clash = name in RISK or name.split(".")[0] == "risk"
    return GateResult(
        "not_risk", not clash,
        "" if not clash else f"{name} is a staking parameter and is never refit",
    )


def gate_tier(name: str) -> GateResult:
    """
    Tier decides HOW a parameter may move, if at all.

    ``F`` fittable, ``S`` only as a shrunken deviation from its prior, ``C``
    never — there is not enough signal in 38 noisy gameweeks to identify a
    constant, and fitting one is exactly how the system would convince itself it
    had improved.
    """
    entry = PARAM_REGISTRY.get(name, {})
    tier = entry.get("tier")
    if tier == "C":
        return GateResult(
            "tier", False,
            f"{name} is tier C (human-authored constant) and is never refit",
            {"tier": tier},
        )
    if tier not in ("F", "S"):
        return GateResult("tier", False, f"{name} has unknown tier {tier!r}", {"tier": tier})
    return GateResult("tier", True, detail={"tier": tier})


def gate_bounds(name: str, proposed: float) -> GateResult:
    """A proposal outside the registry's bounds is rejected, never clipped."""
    entry = PARAM_REGISTRY.get(name, {})
    bounds = entry.get("bounds")
    if not bounds:
        return GateResult("bounds", False, f"{name} declares no bounds")
    low, high = float(bounds[0]), float(bounds[1])
    ok = low <= float(proposed) <= high
    return GateResult(
        "bounds", ok,
        "" if ok else (
            f"{proposed} is outside [{low}, {high}] for {name}. Clipping to the "
            f"bound would silently ship a value the fit did not choose"
        ),
        {"bounds": [low, high], "proposed": float(proposed)},
    )


def gate_move_size(
    name: str, current: float, proposed: float, max_relative: float = MAX_RELATIVE_MOVE
) -> GateResult:
    """
    Cap how far a value may travel in one promotion.

    A parameter that can cross its whole range in a week is being resampled
    rather than fitted, and a large jump is far more often a fitting artefact
    than a discovery.
    """
    bounds = PARAM_REGISTRY.get(name, {}).get("bounds")
    if not bounds:
        return GateResult("move_size", False, f"{name} declares no bounds")
    span = float(bounds[1]) - float(bounds[0])
    if span <= 0:
        return GateResult("move_size", False, f"{name} has a degenerate bound range")
    move = abs(float(proposed) - float(current)) / span
    ok = move <= max_relative
    return GateResult(
        "move_size", ok,
        "" if ok else (
            f"{name} would move {move:.1%} of its range in one step, above the "
            f"{max_relative:.0%} cap"
        ),
        {"relative_move": move, "cap": max_relative},
    )


def gate_effective_sample(
    ess: float, n_parameters: int = 1, minimum: float = MIN_EFFECTIVE_SAMPLE
) -> GateResult:
    """
    Enough independent information to identify the block, per parameter.

    Effective, not raw. Minutes observations cluster at team-gameweek — a
    rotating manager rotates six players at once — so a raw row count
    overstates the information by several times.
    """
    required = minimum * max(1, int(n_parameters))
    ok = float(ess) >= required
    return GateResult(
        "effective_sample", ok,
        "" if ok else (
            f"effective sample {ess:.0f} is below the {required:.0f} needed for "
            f"{n_parameters} parameter(s)"
        ),
        {"ess": float(ess), "required": required},
    )


def gate_block_size(n_parameters: int, maximum: int = MAX_BLOCK_PARAMETERS) -> GateResult:
    """
    A block moves at most a handful of parameters at once.

    Fourteen coupled parameters against one observation a week, with no
    counterfactual, is unidentified — and fitting them jointly is precisely the
    mechanism by which the system would convince itself it was improving.
    """
    ok = 1 <= int(n_parameters) <= maximum
    return GateResult(
        "block_size", ok,
        "" if ok else f"{n_parameters} parameters in one block, cap is {maximum}",
        {"n_parameters": int(n_parameters), "cap": maximum},
    )


def gate_out_of_sample(
    differences: Sequence[float],
    alpha: float = DEFAULT_ALPHA,
    rho: float = 1.0,
) -> GateResult:
    """
    The candidate must beat the incumbent out of sample, at an anytime-valid level.

    ``differences`` are per-gameweek loss improvements (incumbent loss minus
    candidate loss), so positive means better. The gate passes only when the
    ENTIRE confidence interval is above zero, which under a confidence sequence
    means the finding survives having been looked at every week.
    """
    mean, radius = anytime_valid_bound(differences, alpha=alpha, rho=rho)
    lower = mean - radius
    ok = bool(np.isfinite(lower)) and lower > 0.0
    return GateResult(
        "out_of_sample", ok,
        "" if ok else (
            f"improvement {mean:+.4f} has anytime-valid lower bound {lower:+.4f}, "
            f"which does not exclude zero at alpha={alpha}"
        ),
        {
            "n": len(differences), "mean": mean,
            "lower": lower if np.isfinite(lower) else None, "alpha": alpha,
        },
    )


def evaluate(
    name: str,
    current: float,
    proposed: float,
    differences: Sequence[float],
    ess: float,
    n_parameters: int = 1,
    alpha: float = DEFAULT_ALPHA,
) -> Tuple[bool, List[GateResult]]:
    """
    Run every gate. Promotion requires ALL of them.

    Every gate runs even after one fails, because a rejection report listing one
    reason invites fixing that reason and re-submitting — which is optional
    stopping wearing a different hat.
    """
    results = [
        gate_is_registered(name),
        gate_not_risk(name),
        gate_tier(name),
        gate_bounds(name, proposed),
        gate_move_size(name, current, proposed),
        gate_block_size(n_parameters),
        gate_effective_sample(ess, n_parameters),
        gate_out_of_sample(differences, alpha=alpha),
    ]
    passed = all(r.passed for r in results)
    if not passed:
        logger.info(
            "%s rejected: %s", name,
            "; ".join(r.reason for r in results if not r.passed),
        )
    return passed, results
