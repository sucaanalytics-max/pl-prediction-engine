"""
The decision itself: pool -> MILP shortlist -> simulator adjudication -> artifact.

**Two independent draw streams, and this is the point of the module.** A plan
chosen by maximising an empirical functional over one set of draws is the plan
best fitted to *those draws*. Over the ~10^15 legal squads the optimiser ranges
across, the winner is selected partly on simulation noise, so re-reporting its
score on the same draws overstates it — the winner's curse, R5 in the plan.

So the shortlist is generated and ranked on stream A, and every number that
reaches a human is recomputed on stream B, which nothing selected on. The
difference between the two is recorded as ``optimism_gap``. That number is
diagnostic in its own right: a large gap means the shortlist is being chosen by
noise, and the honest response is more draws, not a better-sounding rationale.

**Propose-only.** Nothing here writes to FPL. The artifact is a proposal; a
human submits it. That costs nothing in learning quality, because the ledger
records what the agent DECIDED before the deadline, independent of whether
anyone acted on it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pipeline.decide.horizon import solve_horizon
from pipeline.decide.milp import Plan, solve
from pipeline.decide.plan_eval import PlanEvaluation, adjudicate, evaluate_plan
from pipeline.decide.pool import PoolReport, build_pool, positions_of, xp_of
from pipeline.fpl.artifacts import write_json_atomically
from pipeline.fpl.rules import Rules

logger = logging.getLogger(__name__)

# How many squads the MILP hands the simulator. Large enough that the true best
# plan is very likely inside it, small enough that adjudication stays cheap.
SHORTLIST_SIZE = 8

# Above this, the rationale is suppressed. A shortlist selected mostly on noise
# should not be narrated as though the winner were meaningfully better; printing
# "net +10.7 vs bar 1.6" from a plan admitted at a wide gap is how a confident
# wrong recommendation gets made.
MAX_CREDIBLE_OPTIMISM = 2.0


@dataclass
class Decision:
    """A complete, auditable proposal for one gameweek and one entry."""

    gameweek: int
    entry_label: str
    objective: str
    chosen: PlanEvaluation
    # The same plan re-scored on draws that had no part in choosing it.
    reported: PlanEvaluation
    optimism_gap: float
    shortlist: List[PlanEvaluation] = field(default_factory=list)
    pool: Optional[PoolReport] = None
    warnings: List[str] = field(default_factory=list)
    horizon: Optional[Dict[str, Any]] = None
    generated_at: str = ""

    @property
    def credible(self) -> bool:
        """Whether the margin is large enough to explain rather than just state."""
        return self.optimism_gap <= MAX_CREDIBLE_OPTIMISM

    def as_dict(self) -> Dict[str, Any]:
        return {
            "gameweek": self.gameweek,
            "entry_label": self.entry_label,
            "objective": self.objective,
            "generated_at": self.generated_at,
            # Reported numbers come from the independent stream. The selection
            # stream's numbers are kept alongside, clearly named, so the gap is
            # auditable rather than a claim.
            "decision": self.reported.as_dict(),
            "selection_stream": self.chosen.as_dict(),
            "optimism_gap": round(self.optimism_gap, 4),
            "credible_margin": self.credible,
            "runners_up": [e.as_dict() for e in self.shortlist[1:]],
            "pool": self.pool.as_dict() if self.pool else None,
            # None means the decision was made on a single gameweek and is
            # myopic. Recorded so that is never inferred from silence.
            "horizon": self.horizon,
            "warnings": list(self.warnings),
            "execution": "propose_only",
        }


def decide(
    gameweek: int,
    draws_select: Any,
    draws_report: Any,
    bootstrap: Mapping[str, Any],
    rules: Rules,
    xp_rows: Sequence[Mapping[str, Any]],
    entry_label: str = "season",
    objective: str = "season",
    held: Sequence[int] = (),
    bank: Optional[int] = None,
    free_transfers: int = 1,
    purchase_prices: Optional[Mapping[int, int]] = None,
    shortlist_size: int = SHORTLIST_SIZE,
    tail_threshold: int = 70,
    xp_by_week: Optional[Sequence[Mapping[int, float]]] = None,
    transfer_horizon: Optional[int] = None,
) -> Decision:
    """
    Produce one entry's proposal.

    ``draws_select`` and ``draws_report`` must be independently seeded. Passing
    the same object twice makes ``optimism_gap`` identically zero, which would
    read as "no selection bias" when it in fact means "not measured".
    """
    warnings: List[str] = []

    if draws_select is draws_report:
        # Not fatal — a single-stream run is still a usable proposal — but the
        # gap must not be reported as evidence when it cannot be computed.
        warnings.append(
            "selection and reporting used the SAME draws; optimism_gap is not "
            "measured and must not be read as zero selection bias"
        )

    candidates, pool_report = build_pool(
        xp_rows, bootstrap, rules, held=held, purchase_prices=purchase_prices,
    )
    if pool_report.price_uncertain:
        warnings.append(
            f"{len(pool_report.held_missing_purchase_price)} held players priced at "
            f"now_cost with no purchase history; the bank may be overstated"
        )

    positions = positions_of(candidates)
    xp = xp_of(candidates)

    # Bank is cash in hand. With a squad held it cannot be defaulted to the full
    # budget without inventing 100.0m, so the MILP refuses; make the omission a
    # clear error here rather than letting it surface from two layers down.
    if held and bank is None:
        raise ValueError(
            "bank (cash in hand, in tenths) is required when a squad is held"
        )

    if xp_by_week:
        # Keyed by element id and aligned HERE, not by the caller. The caller
        # cannot know the pool's ordering until build_pool has run, so a
        # positional interface would invite exactly the R11 failure: a plan that
        # is legal, plausible, and about the wrong players. A player absent from
        # a week's projection scores zero for that week — a blank, which is what
        # a missing fixture means.
        aligned = [
            [float(week.get(c.element_id, 0.0)) for c in candidates]
            for week in xp_by_week
        ]
        thin = [
            w for w, week in enumerate(xp_by_week)
            if len(set(week) & {c.element_id for c in candidates}) < len(candidates) // 2
        ]
        if thin:
            warnings.append(
                f"weeks {thin} project fewer than half the pool; those gameweeks "
                f"are mostly zeros and the horizon will avoid them for the wrong reason"
            )

        # Plan over the horizon, act on week 0. A one-week solve cannot buy a
        # player whose run starts in three weeks, nor decline a marginal upgrade
        # now to hold the cash for a better one later.
        horizon_plans = solve_horizon(
            candidates, aligned, rules, current_squad=held, bank=bank,
            free_transfers=free_transfers, top_k=shortlist_size,
            transfer_horizon=transfer_horizon,
        )
        plans: List[Plan] = [p.now for p in horizon_plans]
        horizon_meta: Optional[Dict[str, Any]] = {
            "eval_horizon": horizon_plans[0].eval_horizon,
            "transfer_horizon": horizon_plans[0].transfer_horizon,
            "provisional": horizon_plans[0].as_dict()["provisional"],
        }
    else:
        # Single-week fallback. Correct but myopic, and labelled as such in the
        # artifact so a horizon-less run is never mistaken for a planned one.
        plans = solve(
            candidates, rules, current_squad=held, bank=bank,
            free_transfers=free_transfers, top_k=shortlist_size,
        )
        horizon_meta = None
        warnings.append(
            "no multi-gameweek projection available; this decision is myopic and "
            "cannot see a fixture swing beyond the current gameweek"
        )
    if len(plans) < shortlist_size:
        warnings.append(
            f"MILP returned {len(plans)} distinct plans, fewer than the "
            f"{shortlist_size} requested; the pool may be too constrained"
        )

    ranked = adjudicate(
        plans, draws_select, positions, rules=rules, xp=xp,
        objective=objective, tail_threshold=tail_threshold,
    )
    chosen = ranked[0]

    # The winner re-scored on draws that played no part in choosing it.
    reported = evaluate_plan(
        chosen.plan, draws_report, positions, rules=rules, xp=xp
    )
    optimism_gap = chosen.mean_points - reported.mean_points

    if optimism_gap > MAX_CREDIBLE_OPTIMISM:
        warnings.append(
            f"optimism gap {optimism_gap:.2f} exceeds {MAX_CREDIBLE_OPTIMISM}: the "
            f"shortlist is being separated by simulation noise, so the margin "
            f"between plans is not credible. Increase draws before trusting the rank."
        )

    if plans[0].squad != chosen.plan.squad:
        logger.info(
            "simulator overruled the MILP: %d players differ from the linear optimum",
            len(set(plans[0].squad) ^ set(chosen.plan.squad)) // 2,
        )

    return Decision(
        gameweek=int(gameweek),
        entry_label=entry_label,
        objective=objective,
        chosen=chosen,
        reported=reported,
        optimism_gap=float(optimism_gap),
        shortlist=ranked,
        pool=pool_report,
        warnings=warnings,
        horizon=horizon_meta,
        generated_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )


def strip_for_publication(decision: Decision) -> Dict[str, Any]:
    """
    The version that reaches ``frontend/public/``.

    Drops the runners-up and the selection-stream numbers. Both are genuine
    audit material and both stay in the private artifact and in git, but neither
    belongs on a public page: the counterfactuals are the agent's reasoning, and
    the selection-stream score is the optimistic one.
    """
    payload = decision.as_dict()
    payload.pop("runners_up", None)
    payload.pop("selection_stream", None)
    return payload


def write_decision(
    decision: Decision, predictions_dir: Path, public_dir: Optional[Path] = None
) -> Dict[str, Path]:
    """Write the private artifact and, optionally, the stripped public copy."""
    directory = Path(predictions_dir) / "fpl"
    directory.mkdir(parents=True, exist_ok=True)

    name = f"decision_gw{decision.gameweek:02d}_{decision.entry_label}.json"
    written = {"decision": write_json_atomically(decision.as_dict(), directory / name)}

    if public_dir is not None:
        public = Path(public_dir)
        public.mkdir(parents=True, exist_ok=True)
        written["public"] = write_json_atomically(
            strip_for_publication(decision),
            public / f"decision_public_gw{decision.gameweek:02d}_{decision.entry_label}.json",
        )
    return written
