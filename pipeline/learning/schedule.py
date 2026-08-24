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
import time
import urllib.error
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
#
# Was 48 hours, which left the dashboard with nothing for roughly 4.5 days of
# every 7: the phase resolver reports the NEXT deadline's gameweek, the frontend
# turns that number into `fpl/xp_public_gw{NN}.json`, and outside the window that
# file had never been written. Eight days covers a normal inter-deadline gap so a
# projection for the next gameweek always exists.
#
# Widening the WINDOW is not widening the CADENCE. Every run inside 48 hours
# still refreshes, because late team news dominates projection error there; a run
# further out refreshes only if the published projection has aged past
# PROJECTION_MAX_AGE. The gate lives in run_agent, not here, so this module stays
# a pure function of the schedule. IDLE_HORIZON is 45 days and does not shadow
# this.
REFRESH_WINDOW = timedelta(days=8)
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


#: Retried once per second-ish, three times total. Deliberately small: the whole
#: fetch has to finish well inside a cron tick, and the point is to survive a blip,
#: not to outlast an outage.
FETCH_ATTEMPTS = 3
FETCH_BACKOFF_SECONDS = 1.0

#: Status codes worth trying again. A 4xx other than 429 is deterministic — the
#: same request will fail the same way, so retrying only burns the tick's time.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


def fetch_events(
    url: str = BOOTSTRAP_URL,
    timeout: int = 30,
    attempts: int = FETCH_ATTEMPTS,
) -> List[Dict[str, Any]]:
    """
    Fetch the gameweek calendar using only the standard library.

    Retries, and deliberately does NOT cache. This is the CI gate's only
    dependency: `resolve` calls it unguarded, the `decide` job's exit code is the
    step's exit code, and the `work` job is gated on outputs that a failed decide
    never emits — so a single failure costs one seal attempt. GW1 has seven
    (the hourly cron plus `'0,30 13-16 * * 5'`), and because the phase is derived
    from disk state rather than the clock, a later tick re-issues SEAL from
    identical state. But those seven were seven identical unguarded calls against
    one host: an outage spanning the 3.5-hour band fails all of them the same way.
    Retrying turns a blip into a few seconds' delay instead of a lost attempt.

    No on-disk fallback, on purpose. The only local copy of the calendar lives
    under `data/raw/`, which is gitignored and therefore absent on a fresh runner
    anyway — but the deeper reason is that a stale calendar is more dangerous than
    no calendar. Every phase decision is derived from these deadlines, so a cached
    one that has since moved could seal the wrong gameweek or believe itself
    locked out. A failed tick is recoverable by the next tick; a seal against the
    wrong deadline is not.

    Raises on final failure rather than returning []. An empty calendar would look
    to `determine_phase` like a season with no gameweeks — needs_work false, exit
    zero, a green run and a silently skipped seal. Failing loudly is the whole
    contract of this function.
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": "pl-prediction-engine/1.0"}
    )

    for attempt in range(1, max(1, attempts) + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return payload.get("events", [])
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE_STATUS:
                raise
            failure: Exception = exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            # A truncated body raises JSONDecodeError, which is as transient as
            # the socket error that caused it, so it retries too.
            failure = exc

        if attempt == max(1, attempts):
            raise failure

        time.sleep(FETCH_BACKOFF_SECONDS * attempt)

    # Unreachable: the loop either returns or raises.
    raise AssertionError("fetch_events exhausted its loop without returning")


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


#: Published so a screen can explain an ABSENT agent artifact instead of
#: rendering a shrug.
#:
#: ## Why this exists
#:
#: The agent self-gates: `needs_work` is false in IDLE and LOCKED, and the CI job
#: that runs it is skipped accordingly. Measured on 2026-08-11, that is every run —
#: the GW1 deadline was 247 hours away and the phase resolver correctly said
#: "nothing due yet". Working as designed.
#:
#: The cost is on the screens. `evidence_view.json`, `messages.json` and `xp_gw*`
#: are written by the agent, so all three are absent for the ten days before a
#: deadline, and `/evidence` renders `absent` with no way to say whether the agent
#: is idle or broken. Those are very different facts and they looked identical.
#:
#: **Written by the phase-resolution job, not the agent job.** That is the whole
#: point: the agent job is skipped exactly when this file is most needed, so
#: publishing it there would reproduce the problem it exists to solve.
STATUS_FILENAME = "agent_status.json"

STATUS_SCHEMA_VERSION = 1


def publish_status(state: "ScheduleState", public_dir: Path) -> Path:
    """
    Write the phase state where the frontend can read it.

    Deliberately tiny and free of anything the agent computes: this must be
    writable when the agent has not run, which is its only reason to exist.
    """
    payload = {
        "schema_version": STATUS_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc)
        .isoformat().replace("+00:00", "Z"),
        **state.as_dict(),
        # Spelled out rather than left for a reader to infer from `phase`. The
        # frontend should not have to know which phases are idle.
        "agent_ran": state.needs_work,
        "explains_absence": (
            "The agent computes projections, the evidence view and the message "
            "feed. It self-gates on phase, so those artifacts are absent — not "
            "broken — whenever nothing is due."
        ),
    }

    directory = Path(public_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / STATUS_FILENAME
    # Atomic: the frontend may fetch this at any moment, and a half-written file
    # would narrow as unreadable rather than fail to fetch.
    scratch = target.with_suffix(".json.tmp")
    scratch.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    scratch.replace(target)
    return target


if __name__ == "__main__":
    from pipeline.config import PREDICTIONS_DIR  # noqa: E402  (CLI use only)

    from pipeline.config import FPL_PUBLIC_DIR  # noqa: E402  (CLI use only)

    resolved = resolve(PREDICTIONS_DIR)
    print(json.dumps(resolved.as_dict(), indent=2))
    _emit_github_output(resolved)

    # Publish unconditionally. A status file that only appears when the agent runs
    # would be absent precisely when a screen needs to explain an absence.
    published = publish_status(resolved, Path(FPL_PUBLIC_DIR))
    print(f"published {published}")
