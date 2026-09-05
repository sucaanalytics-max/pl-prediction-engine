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

from pipeline.decide.field import REQUIRED_CALIBRATED_GAMEWEEKS, field_is_usable
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

# What the decision engine is measured to be worth, travelling with every
# proposal it makes. Buried in a docstring this gets read once; on the artifact
# it is in front of whoever is deciding whether to follow the recommendation.
#
# Established by pipeline/learning/backtest_decisions.py over both archive
# seasons, with every strategy sharing identical projections so the comparison
# is paired.
EVIDENCE = {
    # Provenance, so staleness is visible rather than inferred. These numbers
    # are transcribed by hand from a manually-run backtest — nothing recomputes
    # them — so a reader must be able to see WHAT they were measured on and
    # judge whether that still describes the current code.
    "measured_on": {
        "seasons": ["2023-24", "2024-25", "2025-26"],
        "gameweeks": "8-38 each, 93 paired observations",
        "harness": "pipeline/learning/backtest_decisions.py",
        "note": (
            "transcribed by hand from a manual run; re-run the harness after any "
            "change to the projection or the optimiser, and update these figures "
            "with it. Seasons before 2022-23 are unusable: the archive has no "
            "`starts` column, and 2022-23 only populates it from GW16"
        ),
    },
    "beats_doing_nothing": {
        "verdict": "established",
        "margin_2023_24": 411,
        "margin_2024_25": 560,
        "margin_2025_26": 184,
        "note": (
            "positive in all three seasons; pooled +12.42/GW over 93 gameweeks, "
            "se 1.91, t=+6.49"
        ),
    },
    "beats_greedy_transfers": {
        # Still stated as a failure. Three seasons moved the pooled sign
        # positive but came nowhere near resolving it.
        "verdict": "not established",
        "margin_2023_24": 67,
        "margin_2024_25": 60,
        "margin_2025_26": -66,
        "note": (
            "pooled +0.66/GW over 93 gameweeks, se 1.20, t=+0.55 — positive in "
            "two seasons of three. At this effect size and variance, resolving "
            "it at t=2 would need roughly 1,200 gameweeks, about 30 seasons"
        ),
    },
    "projection_calibration": {
        "verdict": "established",
        "note": (
            "31 gameweeks, 24,265 player-weeks, coverage 1.000: every published "
            "tail within 0.0024 of realised frequency"
        ),
    },
}


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
    field_model: str = "uncalibrated"
    generated_at: str = ""
    # The deadline this advice is about, ISO-8601 UTC. Not decoration: a decision
    # is advice about one specific deadline, and after it the advice is not merely
    # old but wrong. Consumers need it to refuse to render expired advice as
    # actionable, and they cannot derive it — comparing the artifact to itself
    # could never detect that the deadline had passed. None only when the caller
    # genuinely has no schedule (a backtest replaying a settled gameweek).
    deadline: Optional[str] = None
    # Per-player xp for the squad this decision concerns, so the NEXT run can say
    # what moved. Bounded to the chosen squad plus whatever was held — around 30
    # entries — rather than all 570: an unbounded snapshot on every decision would
    # grow the artifact for the sake of players nobody owns or was considering.
    #
    # Without it the news delta can report that the recommended move flipped but
    # not by how much any projection changed, because the "before" number exists
    # only inside a run that has already finished.
    xp_snapshot: Dict[int, float] = field(default_factory=dict)

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
            "deadline": self.deadline,
            # Keys stringified by json.dumps anyway; done here so the round trip is
            # symmetric and a reader does not have to guess the key type.
            "xp_snapshot": {str(k): round(float(v), 4)
                            for k, v in sorted(self.xp_snapshot.items())},
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
            # Whether the weekly right tail was measured or merely modelled.
            "field_model": self.field_model,
            "warnings": list(self.warnings),
            "execution": "propose_only",
            # What this engine is measured to be worth, including the criterion
            # it FAILS. A proposal that travels without its evidence invites
            # more confidence than the evidence supports.
            "evidence": EVIDENCE,
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
    field_calibrated_gameweeks: int = 0,
    deadline: Optional[str] = None,
) -> Decision:
    """
    Produce one entry's proposal.

    ``draws_select`` and ``draws_report`` must be independently seeded. Passing
    the same object twice makes ``optimism_gap`` identically zero, which would
    read as "no selection bias" when it in fact means "not measured".

    ``deadline`` is the ISO-8601 UTC deadline this proposal is advice about. It
    defaults to None rather than to "now plus something" because a fabricated
    deadline is worse than an absent one: a consumer can refuse to act on advice
    with no deadline, but it will act on advice with a wrong one.
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

    # The weekly objective ranks on a modelled right tail. Until the field model
    # has held its calibration band for six consecutive gameweeks that tail is
    # not measured, and presenting it as though it were would be worse than
    # having no weekly team — it would be acted on with confidence it has not
    # earned. Fall back to expected points, and say so loudly.
    if objective == "weekly" and not field_is_usable(field_calibrated_gameweeks):
        warnings.append(
            f"field model is UNCALIBRATED ({field_calibrated_gameweeks} of "
            f"{REQUIRED_CALIBRATED_GAMEWEEKS} consecutive gameweeks inside the "
            f"band); the weekly team fell back to the EV-optimal plan, and any "
            f"tail figure below is modelled rather than measured"
        )
        objective = "season"

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
        field_model=(
            "calibrated" if field_is_usable(field_calibrated_gameweeks)
            else "uncalibrated"
        ),
        generated_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        deadline=deadline,
        xp_snapshot=_squad_xp(reported.plan, held, xp_of(candidates)),
    )


def _squad_xp(
    plan: Any, held: Sequence[int], xp: Mapping[int, float],
) -> Dict[int, float]:
    """
    xp for the players this decision is about: the chosen squad plus whatever was
    already held.

    Both, not just the chosen squad: a player dropped BY this decision is exactly
    the one whose projection collapsed, and omitting him would lose the movement
    that explains the move.
    """
    relevant = set(int(p) for p in plan.squad) | {int(p) for p in held}
    return {p: float(xp[p]) for p in sorted(relevant) if p in xp}


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
    decision: Decision,
    predictions_dir: Path,
    public_dir: Optional[Path] = None,
    *,
    sealed: bool,
) -> Dict[str, Path]:
    """
    Write the private artifact and, optionally, the stripped public copy.

    ``sealed`` records HOW this run used the solve, which is not a property of
    the solve itself — the same `Decision` is a commitment when the seal writes
    it and provisional advice when a refresh does. It lives here rather than on
    the dataclass for that reason.

    Required, with no default. Every artifact written before this existed came
    from `_seal`, because `_decide_for_entries` had exactly one caller; now that
    it has two, a default would be silently wrong for whichever caller forgot
    it — and the direction a `True` default gets wrong is a midweek plan
    published with the seal's authority.
    """
    directory = Path(predictions_dir) / "fpl"
    directory.mkdir(parents=True, exist_ok=True)

    name = f"decision_gw{decision.gameweek:02d}_{decision.entry_label}.json"
    private = {**decision.as_dict(), "sealed": bool(sealed)}
    written = {"decision": write_json_atomically(private, directory / name)}

    if public_dir is not None:
        public = Path(public_dir)
        public.mkdir(parents=True, exist_ok=True)
        written["public"] = write_json_atomically(
            {**strip_for_publication(decision), "sealed": bool(sealed)},
            public / f"decision_public_gw{decision.gameweek:02d}_{decision.entry_label}.json",
        )
    return written
