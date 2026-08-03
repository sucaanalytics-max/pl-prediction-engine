"""
Deadline-aware scheduling for the FPL agent. Standard library only.

STDLIB ONLY IS A HARD CONSTRAINT. This module gates a CI job that runs several
times a day all year. If it needed `pip install -r requirements.txt` — pandas,
numpy, PyMC, xgboost — the gate would cost more than the work it guards. It
imports nothing outside the standard library, and a test enforces that.

**Phases are derived from state, not from the clock.** A cron that fails, or a
runner that is queued for an hour, must not lose a gameweek: the next invocation
looks at what exists on disk against what the fixture calendar says should
exist, and does whatever is still outstanding. A schedule that assumes "this
cron fires therefore it is time to seal" silently drops work every time GitHub
has a bad morning, and at 38 observations a season each loss is permanent.

One asymmetry matters. A **seal is not repairable**. Its whole value is that it
provably predated the deadline, so a forecast produced afterwards is worthless
however good it is. Settlement and scoring *are* repairable, because outcomes do
not change. The phase logic reflects that: a missed seal is recorded as
permanently lost rather than quietly reconstructed.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"

# Refuse to write a forecast inside this window. A seal racing the deadline is
# the one case where being slightly late makes the record a lie.
LOCKOUT_BEFORE_DEADLINE = timedelta(minutes=30)
# Produce and publish the decision here, leaving the human time to act.
SEAL_WINDOW = timedelta(hours=4)
# Refresh projections from this far out.
REFRESH_WINDOW = timedelta(hours=48)
# Beyond this the season is not close enough to be worth waking for.
IDLE_HORIZON = timedelta(days=45)
# FPL locks points at 09:00 UK the day after a gameweek's final match. Before
# that, bonus and defensive contributions can still move.
FINAL_SETTLEMENT_DELAY = timedelta(hours=12)
# How long a missed seal keeps being reported. Must stay SHORTER than the gap
# between deadlines, or the report outlives the miss and starves the next one.
MISSED_SEAL_REPORT_WINDOW = timedelta(days=3)


class Phase(str, Enum):
    """What the agent should do right now."""

    IDLE = "idle"
    REFRESH = "refresh"
    SEAL = "seal"
    LOCKED = "locked"
    SETTLE_PROVISIONAL = "settle_provisional"
    SETTLE_FINAL = "settle_final"
    REFIT = "refit"
    MISSED_SEAL = "missed_seal"


@dataclass
class ScheduleState:
    """The decision, and enough context to explain it."""

    phase: Phase
    gameweek: Optional[int] = None
    deadline: Optional[datetime] = None
    seconds_to_deadline: Optional[float] = None
    reason: str = ""
    outstanding: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def needs_work(self) -> bool:
        """Whether the expensive job should run at all."""
        return self.phase not in (Phase.IDLE, Phase.LOCKED)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "phase": self.phase.value,
            "gameweek": self.gameweek,
            "deadline": self.deadline.isoformat() if self.deadline else None,
            "seconds_to_deadline": self.seconds_to_deadline,
            "reason": self.reason,
            "needs_work": self.needs_work,
            "outstanding": self.outstanding,
        }


def parse_deadline(value: str) -> datetime:
    """Parse an FPL deadline into an aware UTC datetime."""
    text = value.replace("Z", "+00:00")
    stamp = datetime.fromisoformat(text)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


def fetch_events(url: str = BOOTSTRAP_URL, timeout: int = 30) -> List[Dict[str, Any]]:
    """Fetch the gameweek calendar using only the standard library."""
    request = urllib.request.Request(
        url, headers={"User-Agent": "pl-prediction-engine/1.0"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload.get("events", [])


def _gameweeks_with(directory: Path, filename: str) -> Set[int]:
    """Gameweek numbers whose ledger directory contains ``filename``."""
    found: Set[int] = set()
    if not directory.exists():
        return found
    for child in directory.iterdir():
        match = re.fullmatch(r"gw(\d{2})", child.name)
        if match and (child / filename).exists():
            found.add(int(match.group(1)))
    return found


def _finally_settled(directory: Path) -> Set[int]:
    """
    Gameweeks whose outcome record is FINAL, not provisional.

    Existence of ``outcome.jsonl`` is not enough. A Sunday-night settle runs
    before bonus points are confirmed and writes a provisional record; treating
    that as settled means the Tuesday final settle never fires, so bonus is
    never captured and — because the field observation is written alongside it —
    ``FieldObservation.usable`` stays False for every gameweek of the season and
    the weekly team's calibration gate can never open.

    ``settle_gameweek`` already records the distinction in the header and already
    refuses to overwrite a final with a provisional. This is the reader catching
    up with the writer.
    """
    found: Set[int] = set()
    if not directory.exists():
        return found
    for child in directory.iterdir():
        match = re.fullmatch(r"gw(\d{2})", child.name)
        if not match:
            continue
        path = child / "outcome.jsonl"
        if not path.exists():
            continue
        try:
            with path.open(encoding="utf-8") as handle:
                header = json.loads(handle.readline() or "{}")
        except (json.JSONDecodeError, OSError):
            # Unreadable header: treat as NOT finally settled, so the final
            # settle is retried. The alternative silently abandons the gameweek.
            continue
        if not header.get("provisional", True):
            found.add(int(match.group(1)))
    return found


def ledger_state(ledger_dir: Path) -> Dict[str, Set[int]]:
    """What the ledger already holds, by gameweek."""
    ledger_dir = Path(ledger_dir)
    return {
        "sealed": _gameweeks_with(ledger_dir, "forecast.jsonl"),
        # Only FINAL settlements count. See _finally_settled: a provisional
        # record that counted here would permanently block the final one.
        "settled": _finally_settled(ledger_dir),
        # Kept separate so a caller can still ask "has anything been recorded",
        # which is what MISSED_SEAL-style reasoning wants.
        "settled_any": _gameweeks_with(ledger_dir, "outcome.jsonl"),
        "scored": _gameweeks_with(ledger_dir, "score.json"),
    }


def determine_phase(
    now: datetime,
    events: Sequence[Dict[str, Any]],
    sealed: Optional[Set[int]] = None,
    settled: Optional[Set[int]] = None,
    scored: Optional[Set[int]] = None,
) -> ScheduleState:
    """
    Decide what is outstanding, from state rather than from the clock.

    Priority is deliberate: settle and score finished gameweeks before preparing
    the next one. Outcome data is only complete for a short while before the next
    round of fixtures muddies the picture, and a missed settlement compounds —
    an unscored gameweek blocks every later refit.
    """
    sealed = set(sealed or ())
    settled = set(settled or ())
    scored = set(scored or ())

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    parsed = []
    for event in events:
        deadline_text = event.get("deadline_time")
        if not deadline_text:
            continue
        parsed.append(
            {
                "id": int(event["id"]),
                "deadline": parse_deadline(deadline_text),
                "finished": bool(event.get("finished")),
                "data_checked": bool(event.get("data_checked")),
            }
        )
    parsed.sort(key=lambda item: item["deadline"])

    outstanding: List[Dict[str, Any]] = []

    # 1. Finished and confirmed, sealed, not yet settled — settle it.
    for event in parsed:
        gameweek = event["id"]
        if not event["data_checked"]:
            continue
        if gameweek in sealed and gameweek not in settled:
            outstanding.append({"gameweek": gameweek, "action": "settle_final"})

    if outstanding:
        first = outstanding[0]
        return ScheduleState(
            phase=Phase.SETTLE_FINAL,
            gameweek=first["gameweek"],
            reason=(
                f"GW{first['gameweek']} is confirmed by FPL and sealed but not "
                "settled"
            ),
            outstanding=outstanding,
        )

    # 2. Settled but not scored — score it, which is what feeds the refit.
    unscored = sorted(settled - scored)
    if unscored:
        return ScheduleState(
            phase=Phase.REFIT,
            gameweek=unscored[0],
            reason=f"GW{unscored[0]} is settled but not scored",
            outstanding=[{"gameweek": g, "action": "score"} for g in unscored],
        )

    # 3. All fixtures played but FPL has not confirmed the data — take a
    #    provisional reading. Bonus and defensive contributions can still move,
    #    so this is recorded as provisional and superseded later.
    for event in parsed:
        gameweek = event["id"]
        if (
            event["finished"]
            and not event["data_checked"]
            and gameweek in sealed
            and gameweek not in settled
        ):
            return ScheduleState(
                phase=Phase.SETTLE_PROVISIONAL,
                gameweek=gameweek,
                reason=(
                    f"GW{gameweek} fixtures are complete but FPL has not marked "
                    "the data final"
                ),
            )

    # 4. Look forward to the next deadline.
    upcoming = [event for event in parsed if event["deadline"] > now]
    if not upcoming:
        return ScheduleState(
            phase=Phase.IDLE, reason="no upcoming gameweek deadline"
        )

    nxt = upcoming[0]
    gameweek = nxt["id"]
    deadline = nxt["deadline"]
    remaining = deadline - now
    seconds = remaining.total_seconds()

    if remaining > IDLE_HORIZON:
        return ScheduleState(
            phase=Phase.IDLE,
            gameweek=gameweek,
            deadline=deadline,
            seconds_to_deadline=seconds,
            reason=f"GW{gameweek} deadline is {remaining.days} days away",
        )

    if remaining <= LOCKOUT_BEFORE_DEADLINE:
        return ScheduleState(
            phase=Phase.LOCKED,
            gameweek=gameweek,
            deadline=deadline,
            seconds_to_deadline=seconds,
            reason=(
                f"within {int(LOCKOUT_BEFORE_DEADLINE.total_seconds() // 60)} "
                "minutes of the deadline; refusing to write a forecast"
            ),
        )

    if gameweek in sealed:
        return ScheduleState(
            phase=Phase.IDLE,
            gameweek=gameweek,
            deadline=deadline,
            seconds_to_deadline=seconds,
            reason=f"GW{gameweek} is already sealed",
        )

    if remaining <= SEAL_WINDOW:
        return ScheduleState(
            phase=Phase.SEAL,
            gameweek=gameweek,
            deadline=deadline,
            seconds_to_deadline=seconds,
            reason=f"GW{gameweek} deadline in {seconds / 3600:.1f}h",
        )

    if remaining <= REFRESH_WINDOW:
        return ScheduleState(
            phase=Phase.REFRESH,
            gameweek=gameweek,
            deadline=deadline,
            seconds_to_deadline=seconds,
            reason=f"GW{gameweek} deadline in {seconds / 3600:.1f}h",
        )

    # A deadline that passed without a seal is a permanent loss, reported so it
    # is visible rather than silent. It is checked LAST, and deliberately so.
    #
    # Placed before the forward-looking checks it starved the agent completely:
    # the report window is longer than the interval between deadlines minus the
    # seal window, so one miss preempted SEAL and REFRESH for every subsequent
    # gameweek — a livelock, not a warning. Reproduced: at three hours before
    # GW2's deadline the phase was still `missed_seal gw=1`. And because nothing
    # writes forecast.jsonl yet, `sealed` is always empty, so the agent would
    # have gone red every three hours forever without ever doing any work.
    #
    # The window is also shortened to three days: long enough to be noticed,
    # short enough not to shout about the same loss for a week.
    for event in parsed:
        if (
            event["deadline"] < now
            and event["id"] not in sealed
            and (now - event["deadline"]) < MISSED_SEAL_REPORT_WINDOW
        ):
            return ScheduleState(
                phase=Phase.MISSED_SEAL,
                gameweek=event["id"],
                deadline=event["deadline"],
                reason=(
                    f"GW{event['id']} deadline passed with no sealed forecast. "
                    "This observation cannot be recovered: a seal is only "
                    "meaningful if it provably predated the deadline."
                ),
            )

    return ScheduleState(
        phase=Phase.IDLE,
        gameweek=gameweek,
        deadline=deadline,
        seconds_to_deadline=seconds,
        reason=f"GW{gameweek} deadline in {seconds / 3600:.1f}h; nothing due yet",
    )


def resolve(
    predictions_dir: Path,
    now: Optional[datetime] = None,
    events: Optional[Sequence[Dict[str, Any]]] = None,
) -> ScheduleState:
    """Fetch what is needed and decide. The entry point for the CI gate."""
    now = now or datetime.now(timezone.utc)
    events = events if events is not None else fetch_events()
    state = ledger_state(Path(predictions_dir) / "fpl" / "ledger")
    return determine_phase(
        now, events, state["sealed"], state["settled"], state["scored"]
    )


def _emit_github_output(state: ScheduleState) -> None:
    """Write step outputs so a later job can be gated on them."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"phase={state.phase.value}\n")
        handle.write(f"needs_work={'true' if state.needs_work else 'false'}\n")
        handle.write(f"gameweek={state.gameweek or ''}\n")


if __name__ == "__main__":
    from pipeline.config import PREDICTIONS_DIR  # noqa: E402  (CLI use only)

    resolved = resolve(PREDICTIONS_DIR)
    print(json.dumps(resolved.as_dict(), indent=2))
    _emit_github_output(resolved)
