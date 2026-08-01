"""
Is the simulator's DISTRIBUTION calibrated, not just its mean?

This matters more here than in most places. Published benchmarks put the best
available projection model at MAE 1.973 against a simulated *omniscient* model at
~1.957 — the headroom on mean accuracy is essentially nil, and R^2 ~ 0.15 is a
ceiling. If nobody can meaningfully beat anybody on means, the remaining edge is
in decision quality under uncertainty, which is distributional by definition.

So the distribution is our claimed advantage. An untested claimed advantage is a
liability: the weekly objective maximises a right-tail probability, and a
miscalibrated tail would send it confidently after the wrong players.

Two tests, both against settled outcomes:

**Coverage.** A calibrated q10 should sit above the realised score 10% of the
time. FPL points are heavily tied at zero and integer-valued everywhere, so a
single number is misleading: we report the closed and open bounds
``P(actual <= q)`` and ``P(actual < q)``. A calibrated quantile lies between
them. Reporting one alone would let ties flatter or damn the model arbitrarily.

**Tail reliability.** The forecast states P(>=5), P(>=10) and P(>=15) explicitly.
Those are exactly the numbers a captaincy or differential decision keys on, and
they are directly checkable against realised frequency.

**The measurement is the hard part, not the model.** Earlier runs of this check
reported a large ``p_ge_2`` miss and a miscalibrated q90. Both were artefacts of
how the projection was produced, not properties of the simulator, and the chase
cost real time. Two flaws, now fixed in
:mod:`pipeline.learning.walk_forward`:

* projecting one season's gameweeks from a DIFFERENT season's bootstrap, which
  matched barely half the player rows — so the report described a different
  population from the one it named;
* fitting team strengths on the whole archive, including the gameweek being
  predicted, which makes the defence ratings a partial readout of the results
  being forecast.

On a clean walk-forward — 31 gameweeks of 2025-26, 24,265 player-weeks,
coverage 1.000, everything fitted strictly on the past — the tails are
calibrated:

    tail        predicted   actual     bias
    p_ge_2         0.2222   0.2244   -0.0022
    p_ge_5         0.0871   0.0856   +0.0015
    p_ge_10        0.0171   0.0183   -0.0012
    p_ge_15        0.0033   0.0031   +0.0002

Fitted per-fixture rates help exactly where the weekly objective needs it:
p_ge_10 improves from -0.0024 to -0.0012 and p_ge_15 from -0.0003 to +0.0002
against flat rates. Small, but in the right direction on the tails that decide
a captaincy.

**Read the coverage bounds with care.** FPL points are heavily tied at zero, so
the closed/open interval at q10 runs from 0.022 to 0.679 — nominal 0.10 falls
inside it almost trivially, and "no miss" there is close to no information. The
tail probabilities are the informative check; the quantile bounds mainly guard
against gross error.

One archive fact worth keeping, since it explains where the remaining
distributional risk lives: of the 1,371 sixty-minute appearances that scored
under two points, 79% are DEF or GKP and 86% of those conceded two or more.
P(>=2 | 60+) is 0.699 for defenders and 0.773 for keepers against 0.926 for
midfielders and 0.941 for forwards. A sixty-minute appearance pays two points
automatically, so anything that moves this band is the conceded penalty — not
minutes, and not cards, which appear in only 41% of the sub-two cases.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# Quantiles the artifact publishes, and their nominal coverage.
QUANTILE_LEVELS = {"q10": 0.10, "q50": 0.50, "q90": 0.90, "q99": 0.99}

# Tail probabilities the artifact publishes, and the threshold each claims.
TAIL_CLAIMS = {"p_ge_2": 2, "p_ge_5": 5, "p_ge_10": 10, "p_ge_15": 15}


@dataclass
class CalibrationReport:
    """Coverage and tail reliability for one evaluation set."""

    n: int
    coverage: Dict[str, Dict[str, float]] = field(default_factory=dict)
    tails: Dict[str, Dict[str, float]] = field(default_factory=dict)

    def worst_tail_ratio(self) -> float:
        """
        Largest relative error across the tail claims, ignoring empty ones.

        A ratio, not a difference: p_ge_10 being 0.02 against a realised 0.04 is
        a 2x error that a difference of 0.02 would make look trivial.
        """
        ratios = [
            max(t["predicted"], t["actual"]) / max(min(t["predicted"], t["actual"]), 1e-9)
            for t in self.tails.values()
            if t["actual"] > 0 or t["predicted"] > 0
        ]
        return float(max(ratios)) if ratios else 1.0

    def as_dict(self) -> Dict[str, Any]:
        return {"n": self.n, "coverage": self.coverage, "tails": self.tails}


def check_calibration(
    forecasts: Sequence[Dict[str, Any]], actual_points: Sequence[float]
) -> CalibrationReport:
    """
    Compare published quantiles and tail probabilities against realised points.

    ``forecasts`` are artifact player rows; ``actual_points`` the realised total
    for each, in the same order.
    """
    actual = np.asarray(actual_points, dtype=float)
    report = CalibrationReport(n=int(len(actual)))
    if not len(actual):
        return report

    for name, nominal in QUANTILE_LEVELS.items():
        q = np.array([float(row.get(name, 0.0)) for row in forecasts])
        closed = float((actual <= q).mean())
        open_ = float((actual < q).mean())
        # The calibrated value lies inside [open, closed] for a discrete target.
        # Distance to the interval is 0 when nominal falls within it.
        miss = 0.0
        if nominal > closed:
            miss = nominal - closed
        elif nominal < open_:
            miss = open_ - nominal
        report.coverage[name] = {
            "nominal": nominal,
            "closed": closed,
            "open": open_,
            "miss": miss,
            "calibrated": miss < 0.02,
        }

    for name, threshold in TAIL_CLAIMS.items():
        predicted = float(
            np.mean([float(row.get(name, 0.0)) for row in forecasts])
        )
        realised = float((actual >= threshold).mean())
        report.tails[name] = {
            "threshold": threshold,
            "predicted": predicted,
            "actual": realised,
            "bias": predicted - realised,
        }

    return report


def summarise(report: CalibrationReport) -> str:
    """Human-readable summary, for a log line or a score artifact."""
    lines = [f"calibration over {report.n} player-gameweeks"]
    lines.append(f"  {'quantile':10s} {'nominal':>8s} {'open':>8s} {'closed':>8s} {'miss':>7s}")
    for name, row in report.coverage.items():
        lines.append(
            f"  {name:10s} {row['nominal']:8.2f} {row['open']:8.3f} "
            f"{row['closed']:8.3f} {row['miss']:7.3f}"
            + ("" if row["calibrated"] else "   MISCALIBRATED")
        )
    lines.append(f"  {'tail':10s} {'predicted':>10s} {'actual':>8s} {'bias':>8s}")
    for name, row in report.tails.items():
        lines.append(
            f"  {name:10s} {row['predicted']:10.4f} {row['actual']:8.4f} "
            f"{row['bias']:+8.4f}"
        )
    return "\n".join(lines)
