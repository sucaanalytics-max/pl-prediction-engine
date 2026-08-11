"""
Recording what the field actually scored, week by week.

The weekly team maximises the probability of beating the field's right tail, and
the only direct observable of that tail is ``highest_score`` — the best score any
entrant managed. Together with ``average_entry_score`` it is what the field
model's calibration band is checked against, and without it the weekly team can
never leave its EV-optimal fallback.

**This is on a fuse.** Both figures live on ``bootstrap-static``'s ``events``
array for the CURRENT season only. They are not in the public archive, they are
not recoverable afterwards, and a gameweek that goes unrecorded is gone. That is
the same shape as the prior-season snapshot problem: cheap to do now, impossible
to do later.

Append-only, one line per observation, so a provisional reading and its final
correction both survive. Bonus points settle a day or two after a gameweek and
``average_entry_score`` moves with them, so overwriting in place would silently
replace a real observation with a later one and leave no trace that it changed.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

OBSERVATIONS_FILENAME = "field_observations.jsonl"


@dataclass(frozen=True)
class FieldObservation:
    """What the field scored in one gameweek."""

    gameweek: int
    average_entry_score: Optional[float]
    highest_score: Optional[float]
    most_captained: Optional[int]
    most_vice_captained: Optional[int]
    provisional: bool
    captured_at: str

    @property
    def usable(self) -> bool:
        """
        Whether this can feed the calibration band.

        A provisional reading is recorded but never used: bonus points settle a
        day or two later and the average moves with them, so calibrating against
        one would judge the field model on a number that was not yet true.
        """
        return (
            not self.provisional
            and self.average_entry_score is not None
            and self.highest_score is not None
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "gameweek": self.gameweek,
            "average_entry_score": self.average_entry_score,
            "highest_score": self.highest_score,
            "most_captained": self.most_captained,
            "most_vice_captained": self.most_vice_captained,
            "provisional": self.provisional,
            "captured_at": self.captured_at,
        }


def extract(
    bootstrap: Mapping[str, Any], gameweek: int, captured_at: str, provisional: bool
) -> Optional[FieldObservation]:
    """
    Pull one gameweek's field figures out of a bootstrap payload.

    Returns None when the gameweek is absent or has not been scored — an
    unfinished gameweek reports zero or null, and recording that as an
    observation would poison the calibration with a field that scored nothing.
    """
    events = bootstrap.get("events") or []
    row = next((e for e in events if int(e.get("id", -1)) == int(gameweek)), None)
    if row is None:
        logger.warning("GW%s is not in the bootstrap events array", gameweek)
        return None

    average = row.get("average_entry_score")
    highest = row.get("highest_score")
    if not row.get("finished") and not row.get("data_checked"):
        logger.info("GW%s is not finished; no field observation to record", gameweek)
        return None
    if not average and not highest:
        # Both empty on a gameweek marked finished means the API has not
        # populated them yet. Silence is the right response; a zero is not.
        logger.info("GW%s carries no field figures yet", gameweek)
        return None

    def _captain(key: str) -> Optional[int]:
        value = row.get(key)
        return int(value) if value not in (None, "") else None

    return FieldObservation(
        gameweek=int(gameweek),
        average_entry_score=float(average) if average else None,
        highest_score=float(highest) if highest else None,
        most_captained=_captain("most_captained"),
        most_vice_captained=_captain("most_vice_captained"),
        provisional=bool(provisional),
        captured_at=captured_at,
    )


def record(
    observation: FieldObservation, predictions_dir: Path, dry_run: bool = False
) -> Optional[Path]:
    """Append one observation. Never rewrites an earlier line."""
    if dry_run:
        logger.info("dry run: would record %s", observation.as_dict())
        return None
    directory = Path(predictions_dir) / "fpl"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / OBSERVATIONS_FILENAME
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(observation.as_dict(), allow_nan=False) + "\n")
    logger.info(
        "recorded field observation for GW%s: average %.1f, highest %.0f%s",
        observation.gameweek, observation.average_entry_score or 0.0,
        observation.highest_score or 0.0,
        " (provisional)" if observation.provisional else "",
    )
    return path


def history(predictions_dir: Path) -> List[FieldObservation]:
    """Every observation ever recorded, oldest first."""
    path = Path(predictions_dir) / "fpl" / OBSERVATIONS_FILENAME
    if not path.exists():
        return []
    rows: List[FieldObservation] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        payload = json.loads(line)
        rows.append(FieldObservation(**payload))
    return sorted(rows, key=lambda o: (o.gameweek, o.captured_at))


def latest_per_gameweek(predictions_dir: Path) -> Dict[int, FieldObservation]:
    """
    The best reading for each gameweek: the final one where it exists.

    A gameweek may hold a provisional reading and a later final one. The final
    supersedes it for calibration, while the provisional stays on disk as the
    record of what was known at the time.
    """
    best: Dict[int, FieldObservation] = {}
    for observation in history(predictions_dir):
        current = best.get(observation.gameweek)
        if current is None or (observation.usable and not current.usable):
            best[observation.gameweek] = observation
        elif observation.usable and current.usable:
            best[observation.gameweek] = observation
    return best


def consecutive_calibrated(
    predictions_dir: Path, passes: Mapping[int, bool]
) -> int:
    """
    Length of the current unbroken run of gameweeks inside the calibration band.

    Counted backwards from the most recent scored gameweek and reset by any
    failure, because the gate asks whether the field model is working NOW. A
    total count would let six scattered successes across a season open the gate
    while the model was failing every recent week.
    """
    observations = latest_per_gameweek(predictions_dir)
    run = 0
    for gameweek in sorted(observations, reverse=True):
        if not observations[gameweek].usable:
            continue
        if passes.get(gameweek):
            run += 1
        else:
            break
    return run
