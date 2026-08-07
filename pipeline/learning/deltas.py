"""
What changed, and whether it changes what you should do.

## The gap this closes

The competitor study's finding, from eight products: *"the projection layer and the
news layer are completely disconnected. Nobody closes the loop: news arrives ->
xMins update -> projections and plan recompute -> you are told what changed and
whether your decision flips."* FPL Review has the best model and no news feed at
all; Fantasy Football Scout has the best news and weak projections. This module is
the join.

## Two stages, because of a hard dependency boundary

The 15-minute poller installs `requests` and `feedparser` only — deliberately, so
a tick finishes in seconds rather than spending minutes installing PyMC. But
`pipeline/decide/milp.py` needs numpy at import and scipy's `milp` at run time. So
the poller **cannot** compute a root move, and waiting for the three-hourly agent
would put a three-hour latency on "he is out", which is the entire thing this is
for.

The split follows the dependency profile:

* **Stage 1, the poller.** `resolve_claims` is pure stdlib, so the poller can
  resolve the claim store before and after and emit a ``resolution_change`` the
  moment a press conference lands. That alone is the news->model join.
* **Stage 2, the agent.** Enriches the same event with ``xp_moved``,
  ``root_move`` and ``ev_cost_of_inaction`` at its own cadence.

## Append-only, so enrichment is a second record

The file is JSONL and never rewritten — the same forward-only discipline as the
evidence store and the parameter log. An enrichment is therefore its own record
carrying the ``delta_id`` it enriches, not an edit to the original. A reader joins
them. That also means a partially-known event is *visible as partially known*
rather than withheld until complete, which is the right default when the thing
being reported is time-critical.

## ev_cost_of_inaction, defined once

**EV(new best move) - EV(previously recommended move, re-scored under the new
information).**

Not the raw EV gap between two plans. That difference matters: the raw gap counts
ordinary model drift as urgency, and would report a number every time the
simulator was reseeded. This definition answers only "what does it cost me to
ignore this news", which is the question a human actually has.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from pipeline.learning.availability_conflicts import Resolution

logger = logging.getLogger(__name__)

DELTAS_FILENAME = "deltas.jsonl"
SCHEMA_VERSION = 1

KIND_RESOLUTION = "resolution_change"
KIND_IMPACT = "decision_impact"


class DeltaError(RuntimeError):
    """A delta could not be recorded or read."""


# ─────────────────────────────────────────────────────────────────────────────
# Snapshots and diffing
# ─────────────────────────────────────────────────────────────────────────────

# The claim types that bear on availability, mirroring AVAILABILITY_TYPES. Kept
# local rather than imported so a change there is a deliberate change here too:
# adding a type to the availability view without deciding whether it is news is
# how a feed becomes a notification firehose.
WATCHED = ("status", "chance_of_playing", "return_date", "unavailable_until",
           "permanent_exit")


def snapshot(resolutions: Mapping[Tuple[int, str], Resolution]) -> Dict[str, Any]:
    """
    Reduce a resolution map to the comparable minimum.

    Only the value and the rule, keyed by "element:claim_type". Deliberately NOT
    the whole Resolution: `conflicts` changes whenever a new losing claim arrives,
    and diffing on that would report a delta every time a second outlet repeated
    the same story.
    """
    out: Dict[str, Any] = {}
    for (element_id, claim_type), resolution in resolutions.items():
        if claim_type not in WATCHED:
            continue
        out[f"{element_id}:{claim_type}"] = {
            "value": resolution.value,
            "rule": resolution.rule,
            "winning_claim_id": resolution.winning_claim_id,
        }
    return out


def _as_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_date(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def is_material(
    claim_type: str,
    before: Any,
    after: Any,
    config: Mapping[str, Any],
) -> Tuple[bool, str]:
    """
    Whether a resolution change is worth telling the human about, and why.

    Returns the reason as well as the verdict, because "we decided this was not
    news" is itself something a reader may need to audit — a threshold that
    silently swallows a real change is indistinguishable from a broken poller.
    """
    if before == after:
        return False, "unchanged"

    # Appearing for the first time. Without this guard the first tick after
    # deployment emits one delta per flagged player in the league, which trains
    # the human to ignore the feed on day one.
    if before is None:
        if claim_type == "chance_of_playing":
            chance = _as_number(after)
            floor = float(config.get("notable_new_chance_below", 100))
            if chance is not None and chance >= floor:
                return False, f"new but unremarkable ({chance:g}%)"
            return True, f"newly flagged at {after}"
        if claim_type == "status":
            # 'a' is available; anything else is a flag.
            if str(after).lower() == "a":
                return False, "new but available"
            return True, f"newly flagged {after!r}"
        return True, f"newly present: {after!r}"

    # Disappearing. A claim that was there and is not is always worth knowing:
    # either the source retracted it or it aged past the staleness horizon, and
    # both change what the projection is using.
    if after is None:
        return True, f"no longer resolved (was {before!r})"

    if claim_type == "chance_of_playing":
        old, new = _as_number(before), _as_number(after)
        if old is None or new is None:
            return True, f"{before!r} -> {after!r}"
        threshold = float(config.get("chance_of_playing_points", 20))
        if abs(new - old) < threshold:
            return False, f"moved {abs(new - old):g} points, under {threshold:g}"
        return True, f"{old:g}% -> {new:g}%"

    if claim_type in ("return_date", "unavailable_until"):
        old, new = _as_date(before), _as_date(after)
        if old is None or new is None:
            return True, f"{before!r} -> {after!r}"
        days = abs((new - old).days)
        threshold = int(config.get("return_date_days", 4))
        if days < threshold:
            return False, f"moved {days}d, under {threshold}d"
        return True, f"{before} -> {after} ({days}d)"

    # `status` and `permanent_exit`: any change is material. A status letter only
    # moves between available / doubtful / injured / suspended / unavailable, and
    # an exit is by definition the end of the story.
    return True, f"{before!r} -> {after!r}"


@dataclass(frozen=True)
class ResolutionChange:
    """One availability resolution that moved."""

    element_id: int
    claim_type: str
    before: Any
    after: Any
    reason: str
    rule: Optional[str] = None
    winning_claim_id: Optional[str] = None

    @property
    def key(self) -> str:
        return f"{self.element_id}:{self.claim_type}"


def diff(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    config: Mapping[str, Any],
) -> Tuple[List[ResolutionChange], Dict[str, str]]:
    """
    Material changes between two snapshots, plus the ones judged immaterial.

    Both are returned. The suppressed set is what makes the threshold auditable
    instead of a silent filter — if a real change goes unreported, the reason it
    was dropped is on the record.
    """
    material: List[ResolutionChange] = []
    suppressed: Dict[str, str] = {}

    for key in sorted(set(before) | set(after)):
        element_text, _, claim_type = key.partition(":")
        if claim_type not in WATCHED:
            continue
        old_entry = before.get(key) or {}
        new_entry = after.get(key) or {}
        old_value = old_entry.get("value") if key in before else None
        new_value = new_entry.get("value") if key in after else None

        matters, reason = is_material(claim_type, old_value, new_value, config)
        if not matters:
            if old_value != new_value:
                suppressed[key] = reason
            continue

        try:
            element_id = int(element_text)
        except ValueError:
            continue
        material.append(ResolutionChange(
            element_id=element_id,
            claim_type=claim_type,
            before=old_value,
            after=new_value,
            reason=reason,
            rule=new_entry.get("rule"),
            winning_claim_id=new_entry.get("winning_claim_id"),
        ))
    return material, suppressed


# ─────────────────────────────────────────────────────────────────────────────
# Records
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Trigger:
    """Where the change came from, for the evidence surface."""

    source: str
    source_tier: int
    claimed_at: Optional[str]
    quote: Optional[str] = None
    url: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "source_tier": self.source_tier,
            "claimed_at": self.claimed_at,
            "quote": self.quote,
            "url": self.url,
        }


@dataclass(frozen=True)
class Delta:
    """
    A stage-1 record: something the model is using has changed.

    Carries no xp and no root move. Those need the models and arrive as a separate
    ``decision_impact`` record; a reader shows this one as "impact not yet
    assessed" rather than waiting for it.
    """

    change: ResolutionChange
    observed_at: str
    gameweek: int
    player_name: Optional[str] = None
    club: Optional[str] = None
    trigger: Optional[Trigger] = None
    schema_version: int = SCHEMA_VERSION

    @property
    def delta_id(self) -> str:
        """
        Content hash over the change, not over the observation time.

        So re-resolving the same store at the next tick produces the same id and
        the reader can join an enrichment to it — and so a poller that runs twice
        does not report the same news twice.
        """
        payload = json.dumps(
            [self.change.element_id, self.change.claim_type,
             self.change.before, self.change.after, self.gameweek],
            sort_keys=True, allow_nan=False, default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "kind": KIND_RESOLUTION,
            "delta_id": self.delta_id,
            "observed_at": self.observed_at,
            "gameweek": self.gameweek,
            "element_id": self.change.element_id,
            "player_name": self.player_name,
            "club": self.club,
            "claim_type": self.change.claim_type,
            "before": self.change.before,
            "after": self.change.after,
            "why_material": self.change.reason,
            "rule_applied": self.change.rule,
            "winning_claim_id": self.change.winning_claim_id,
            "trigger": self.trigger.as_dict() if self.trigger else None,
        }


@dataclass(frozen=True)
class DecisionImpact:
    """
    A stage-2 record: what the change did to the plan.

    ``ev_cost_of_inaction`` is EV(new best move) minus EV(the previously
    recommended move, re-scored under the new information) — not the raw gap
    between two plans, which would count model drift as urgency.
    """

    delta_id: str
    observed_at: str
    gameweek: int
    entry_label: str
    xp_moved: Tuple[Dict[str, Any], ...] = ()
    root_move_before: Optional[str] = None
    root_move_after: Optional[str] = None
    captain_before: Optional[int] = None
    captain_after: Optional[int] = None
    ev_cost_of_inaction: Optional[float] = None
    note: str = ""
    schema_version: int = SCHEMA_VERSION

    @property
    def flipped(self) -> bool:
        """Whether the human is now being told to do something different."""
        return (
            (self.root_move_before or None) != (self.root_move_after or None)
            or self.captain_before != self.captain_after
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "kind": KIND_IMPACT,
            "delta_id": self.delta_id,
            "observed_at": self.observed_at,
            "gameweek": self.gameweek,
            "entry_label": self.entry_label,
            "xp_moved": [dict(row) for row in self.xp_moved],
            "root_move": {
                "before": self.root_move_before,
                "after": self.root_move_after,
                "flipped": self.flipped,
            },
            "captain": {"before": self.captain_before, "after": self.captain_after},
            "ev_cost_of_inaction": (
                None if self.ev_cost_of_inaction is None
                else round(float(self.ev_cost_of_inaction), 4)
            ),
            "note": self.note,
        }


def impact_is_reportable(
    impact: DecisionImpact, config: Mapping[str, Any],
) -> Tuple[bool, str]:
    """
    Whether a computed impact clears the stage-2 threshold.

    **The threshold is on the decision, not the projection.** A flip is always
    reportable regardless of EV, because it changes what the human is told to do;
    an xp move that flips nothing has to clear a points bar to be worth an
    interruption.
    """
    if impact.flipped and config.get("always_on_flip", True):
        return True, "the recommended move changed"

    # A None on either side means the player was absent from one of the two xp
    # artifacts — newly added, or gone. That is not a measurable move, and
    # coercing it to 0.0 would silently score "we do not know" as "no change".
    # `default=0.0` covers an impact with no xp rows at all.
    moved = max(
        (abs(float(row["after"]) - float(row["before"]))
         for row in impact.xp_moved
         if row.get("before") is not None and row.get("after") is not None),
        default=0.0,
    )
    threshold = float(config.get("xp_points", 0.30))
    if moved >= threshold:
        return True, f"xp moved {moved:.2f}, at or over {threshold:.2f}"

    cost = impact.ev_cost_of_inaction
    if cost is not None and abs(cost) >= threshold:
        return True, f"inaction costs {cost:.2f}"

    return False, f"largest xp move {moved:.2f} flips nothing, under {threshold:.2f}"


# ─────────────────────────────────────────────────────────────────────────────
# Store
# ─────────────────────────────────────────────────────────────────────────────

def path_for(predictions_dir: Path) -> Path:
    return Path(predictions_dir) / "fpl" / DELTAS_FILENAME


def known_ids(predictions_dir: Path) -> Dict[str, set]:
    """
    Which delta ids are already on file, by kind.

    Read rather than tracked in memory because the poller is a fresh process every
    fifteen minutes: without this, an unchanged resolution would be re-reported on
    every tick for as long as it stood.
    """
    path = path_for(predictions_dir)
    seen: Dict[str, set] = {KIND_RESOLUTION: set(), KIND_IMPACT: set()}
    if not path.exists():
        return seen
    for number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            # Unlike the evidence store, a corrupt line here is survivable: the
            # worst case is re-reporting one delta, whereas refusing to read would
            # stop all reporting. The evidence store raises because a shortened
            # claim history silently changes a projection; a shortened delta log
            # only costs a duplicate notification.
            logger.warning("%s:%d is not valid JSON; skipping", path, number)
            continue
        kind = payload.get("kind")
        delta_id = payload.get("delta_id")
        if kind in seen and delta_id:
            seen[kind].add(str(delta_id))
    return seen


def record(
    records: Sequence[Any],
    predictions_dir: Path,
    dry_run: bool = False,
) -> Optional[Path]:
    """
    Append every record whose (kind, delta_id) is not already on file.

    Returns the path if anything landed. Deduplication is by kind as well as id,
    so a stage-2 impact can be appended for a stage-1 change that is already
    recorded — the two are different assertions about the same event.
    """
    if not records:
        return None

    seen = known_ids(predictions_dir)
    fresh = []
    for item in records:
        payload = item.as_dict()
        kind = payload.get("kind")
        delta_id = str(payload.get("delta_id"))
        if delta_id in seen.get(kind, set()):
            continue
        seen.setdefault(kind, set()).add(delta_id)
        fresh.append(payload)

    if not fresh:
        logger.info("deltas: nothing new among %d record(s)", len(records))
        return None
    if dry_run:
        logger.info("dry run: would record %d delta record(s)", len(fresh))
        return None

    path = path_for(predictions_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for payload in fresh:
            handle.write(json.dumps(payload, allow_nan=False) + "\n")
    logger.info("recorded %d delta record(s) -> %s", len(fresh), path)
    return path


def history(predictions_dir: Path) -> List[Dict[str, Any]]:
    """Every delta record, oldest first. Malformed lines are skipped, not fatal."""
    path = path_for(predictions_dir)
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def prune(
    records: Sequence[Mapping[str, Any]],
    current_gameweek: int,
    keep_gameweeks: int,
) -> List[Dict[str, Any]]:
    """
    Records worth publishing.

    The published copy is bounded; the private log is not. A delta about GW3 is of
    no use in GW12, and this is the difference between an artifact of fixed size
    and one that grows all season — the reason `forecast_ledger.json` is never
    published.
    """
    floor = current_gameweek - max(0, keep_gameweeks - 1)
    return [dict(r) for r in records if int(r.get("gameweek", 0)) >= floor]


def describe_move(plan: Optional[Mapping[str, Any]]) -> Optional[str]:
    """
    A plan's root move as one comparable string.

    Sorted, so an optimiser that emits the same swap in a different order does not
    read as a flip. "hold" for no transfers is a real answer and must be
    distinguishable from "we do not know", which is None.
    """
    if not plan:
        return None
    out = sorted(int(p) for p in plan.get("transfers_out") or [])
    into = sorted(int(p) for p in plan.get("transfers_in") or [])
    if not out and not into:
        return "hold"
    return f"{out} -> {into}"


def assess_impact(
    changes: Sequence[Mapping[str, Any]],
    previous_plan: Optional[Mapping[str, Any]],
    new_plan: Optional[Mapping[str, Any]],
    xp_before: Mapping[int, float],
    xp_after: Mapping[int, float],
    observed_at: str,
    gameweek: int,
    entry_label: str,
    new_ev: Optional[float] = None,
    previous_plan_rescored_ev: Optional[float] = None,
    note: str = "",
) -> List[DecisionImpact]:
    """
    Stage 2: what the availability changes did to the plan.

    Pure, so it is testable without numpy or scipy — the caller supplies the two
    plans and the two xp maps, having done the solving. That separation is not
    cosmetic: the MILP needs scipy at run time, and keeping the arithmetic here
    means the thresholds can be tested at all.

    One impact per change, all carrying the same plan diff. The plan moved once;
    attributing that single move to each contributing piece of news is honest
    precisely because it does not pretend to apportion it — a reader sees "these
    three things happened and the plan went from A to B", not a fabricated split.

    ``ev_cost_of_inaction`` is ``new_ev - previous_plan_rescored_ev``: the new best
    move against the OLD recommendation re-scored under the NEW information. Both
    must be present or it stays None; deriving it from one of them would produce a
    number that looks like a cost and is not.
    """
    before_move = describe_move(previous_plan)
    after_move = describe_move(new_plan)
    captain_before = (
        int(previous_plan["captain"])
        if previous_plan and previous_plan.get("captain") is not None else None
    )
    captain_after = (
        int(new_plan["captain"])
        if new_plan and new_plan.get("captain") is not None else None
    )

    cost: Optional[float] = None
    if new_ev is not None and previous_plan_rescored_ev is not None:
        cost = float(new_ev) - float(previous_plan_rescored_ev)

    impacts: List[DecisionImpact] = []
    for change in changes:
        element_id = int(change.get("element_id", 0))
        moved: List[Dict[str, Any]] = []
        if element_id > 0:
            before = xp_before.get(element_id)
            after = xp_after.get(element_id)
            if before is not None or after is not None:
                moved.append({
                    "element_id": element_id,
                    "before": round(float(before), 4) if before is not None else None,
                    "after": round(float(after), 4) if after is not None else None,
                })
        impacts.append(DecisionImpact(
            delta_id=str(change.get("delta_id")),
            observed_at=observed_at,
            gameweek=gameweek,
            entry_label=entry_label,
            xp_moved=tuple(moved),
            root_move_before=before_move,
            root_move_after=after_move,
            captain_before=captain_before,
            captain_after=captain_after,
            ev_cost_of_inaction=cost,
            note=note,
        ))
    return impacts


def publish(
    predictions_dir: Path,
    public_dir: Path,
    current_gameweek: int,
    keep_gameweeks: int,
    dry_run: bool = False,
) -> Optional[Path]:
    """
    Write the bounded public copy.

    The private log is append-only and unbounded; the published one is pruned to a
    few gameweeks. That asymmetry is the same reason `forecast_ledger.json` is never
    published at all: it is the audit record and it grows all season, whereas the
    app only ever needs the recent past.

    Written whole rather than appended, because the published file is a *view* of
    the log and a view that only ever grew would drift from the thing it views.
    """
    records = prune(history(predictions_dir), current_gameweek, keep_gameweeks)
    if dry_run:
        logger.info("dry run: would publish %d delta record(s)", len(records))
        return None

    target = Path(public_dir) / DELTAS_FILENAME
    target.parent.mkdir(parents=True, exist_ok=True)
    # An empty file, not a missing one. Absent means "nothing has ever run"; empty
    # means "nothing recent happened", and the app renders those differently.
    target.write_text(
        "".join(json.dumps(r, allow_nan=False) + "\n" for r in records),
        encoding="utf-8",
    )
    logger.info("published %d delta record(s) -> %s", len(records), target)
    return target


def unenriched(records: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """
    Stage-1 changes with no stage-2 impact yet.

    What the agent picks up on its next run. Ordered oldest first so the most
    overdue is assessed first if a run is cut short.
    """
    impacts = {
        str(r.get("delta_id")) for r in records if r.get("kind") == KIND_IMPACT
    }
    return [
        dict(r) for r in records
        if r.get("kind") == KIND_RESOLUTION
        and str(r.get("delta_id")) not in impacts
    ]
