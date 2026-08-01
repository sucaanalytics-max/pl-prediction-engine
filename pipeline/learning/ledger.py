"""
The sealed forecast ledger: what we predicted, recorded before the deadline.

This is the artifact the whole project is measured by. Without it every accuracy
claim is unfalsifiable, which is why the repo's own CLAUDE.md forbids sourcing
one from `latest.json` — that file is rewritten daily and cannot distinguish a
forecast from a hindsight.

Three properties, each enforced rather than intended:

**Write-once.** A sealed gameweek is never rewritten. `seal_forecast` raises if
the file exists. Re-running is safe and idempotent by refusal, not by overwrite.

**Provably pre-deadline.** The seal refuses to write once `now` is past the
deadline, and records `sealed_at` alongside `deadline_time` so any later reader
can check. A forecast produced afterwards is worthless however good it is, so
there is no repair path and none should be added — git history is the external
timestamp anchor, and `github_run_id` ties a row to the run that produced it.

**Self-contained.** The header carries the frozen inputs' digest, the parameter
values, the rules provenance and the sealed universe. Re-projecting later must
not need the network: a re-projection that quietly refetches is measuring
today's data against yesterday's forecast.

The sealed universe is an explicit element-id list, resolved from
model-independent inputs. Deriving it from the model's own output would let a
candidate win a paired comparison by shrinking its own benchmark.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger(__name__)

LEDGER_SCHEMA_VERSION = 1
RECORD_HEADER = "header"
RECORD_FORECAST = "forecast"

# A dry run must never be mistaken for a real seal.
DRYRUN_DIRNAME = "dryrun"
# Written before a multi-file seal and removed after, so a crash mid-write is
# distinguishable from a seal that never started.
IN_PROGRESS_MARKER = "PHASE_IN_PROGRESS"


class LedgerError(RuntimeError):
    """A ledger invariant was violated. Never swallow this."""


class AlreadySealedError(LedgerError):
    """This gameweek is already sealed. Sealing twice is never correct."""


class TooLateToSealError(LedgerError):
    """The deadline has passed. A forecast recorded now would be a lie."""


def gameweek_dir(predictions_dir: Path, gameweek: int, dry_run: bool = False) -> Path:
    """Directory for one gameweek's ledger. Dry runs are quarantined."""
    root = Path(predictions_dir) / "fpl" / "ledger"
    if dry_run:
        root = root / DRYRUN_DIRNAME
    return root / f"gw{int(gameweek):02d}"


def digest_bytes(payload: bytes) -> str:
    """Stable content digest, used to tie a seal to its exact inputs."""
    return hashlib.sha256(payload).hexdigest()


def _parse_iso(value: str) -> datetime:
    stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


@dataclass(frozen=True)
class SealedUniverse:
    """
    The exact set of players a gameweek is scored over.

    Resolved once, from model-independent inputs only, and stored in the header.
    If the universe were derived from the model's own output — say "players it
    projected above some threshold" — a candidate model could win a paired
    comparison simply by projecting fewer players.
    """

    element_ids: Sequence[int]
    criteria: str

    @property
    def digest(self) -> str:
        joined = ",".join(str(i) for i in sorted(self.element_ids))
        return digest_bytes(joined.encode("utf-8"))


def resolve_universe(
    bootstrap: Dict[str, Any], min_selected_percent: float = 0.5
) -> SealedUniverse:
    """
    Choose who to score, from availability and ownership only.

    Deliberately model-independent: a player is in because FPL says he is
    available or because managers own him, never because we projected him well.
    """
    element_ids: List[int] = []
    for element in bootstrap.get("elements", []):
        status = str(element.get("status", "a"))
        chance = element.get("chance_of_playing_next_round")
        selected = float(element.get("selected_by_percent") or 0.0)
        available = status == "a" and (chance is None or float(chance) >= 50)
        if available or selected >= min_selected_percent:
            element_ids.append(int(element["id"]))
    return SealedUniverse(
        element_ids=element_ids,
        criteria=(
            "status == 'a' and (chance_of_playing is null or >= 50), "
            f"OR selected_by_percent >= {min_selected_percent}"
        ),
    )


def freeze_inputs(bootstrap: Dict[str, Any], directory: Path) -> Dict[str, Any]:
    """
    Store the inputs a re-projection would need, gzipped, beside the seal.

    Re-projection must be reproducible without the network. A re-projection that
    refetches is comparing today's data against yesterday's forecast and will
    quietly disagree with the sealed numbers.
    """
    directory.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(bootstrap, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(payload)
    path = directory / "bootstrap.json.gz"
    path.write_bytes(compressed)
    return {
        "path": path.name,
        "digest": digest_bytes(compressed),
        "uncompressed_bytes": len(payload),
    }


def seal_forecast(
    gameweek: int,
    deadline: str,
    projections: Iterable[Dict[str, Any]],
    universe: SealedUniverse,
    bootstrap: Dict[str, Any],
    predictions_dir: Path,
    metadata: Optional[Dict[str, Any]] = None,
    now: Optional[datetime] = None,
    dry_run: bool = False,
) -> Path:
    """
    Write the pre-deadline forecast. Once. Raises rather than overwriting.

    ``projections`` are the per-player rows from the expected-points artifact.
    Only players in ``universe`` are written; the rest are irrelevant to every
    later comparison and would only inflate the file.
    """
    now = now or datetime.now(timezone.utc)
    deadline_at = _parse_iso(deadline)

    if now >= deadline_at:
        raise TooLateToSealError(
            f"GW{gameweek} deadline was {deadline_at.isoformat()} and it is now "
            f"{now.isoformat()}. A forecast sealed after the deadline proves "
            "nothing, and backfilling one would make every later accuracy claim "
            "false. This observation is lost."
        )

    directory = gameweek_dir(predictions_dir, gameweek, dry_run=dry_run)
    forecast_path = directory / "forecast.jsonl"
    if forecast_path.exists():
        raise AlreadySealedError(
            f"{forecast_path} already exists. A sealed gameweek is never "
            "rewritten — that is what makes it evidence."
        )

    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / IN_PROGRESS_MARKER
    marker.write_text(
        json.dumps(
            {
                "started_at": now.isoformat(),
                "github_run_id": os.environ.get("GITHUB_RUN_ID"),
            }
        )
        + "\n"
    )

    allowed = set(int(i) for i in universe.element_ids)
    rows = [row for row in projections if int(row.get("element_id", -1)) in allowed]

    header = {
        "record": RECORD_HEADER,
        "schema_version": LEDGER_SCHEMA_VERSION,
        "gameweek": int(gameweek),
        "deadline_time": deadline_at.isoformat(),
        "sealed_at": now.isoformat(),
        "seconds_before_deadline": (deadline_at - now).total_seconds(),
        "dry_run": bool(dry_run),
        "universe_size": len(allowed),
        "universe_digest": universe.digest,
        "universe_criteria": universe.criteria,
        "rows_written": len(rows),
        "frozen_inputs": freeze_inputs(bootstrap, directory / "inputs"),
        # Ties a row to the run that produced it. Git history is the external
        # timestamp anchor; these make the provenance checkable inside CI too.
        "github_run_id": os.environ.get("GITHUB_RUN_ID"),
        "github_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    }
    header.update(metadata or {})

    with forecast_path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(header, sort_keys=True) + "\n")
        for row in rows:
            handle.write(
                json.dumps(
                    {"record": RECORD_FORECAST, **row}, sort_keys=True
                )
                + "\n"
            )

    marker.unlink(missing_ok=True)
    logger.info(
        "sealed GW%d: %d rows, %.1f hours before the deadline",
        gameweek,
        len(rows),
        header["seconds_before_deadline"] / 3600,
    )
    return forecast_path


def read_forecast(path: Path) -> Dict[str, Any]:
    """Read a sealed forecast back as ``{"header": ..., "rows": [...]}``."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"{path} does not exist")

    header: Optional[Dict[str, Any]] = None
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("record") == RECORD_HEADER:
                header = record
            else:
                rows.append(record)

    if header is None:
        raise LedgerError(f"{path} has no header record")
    if header.get("rows_written") != len(rows):
        raise LedgerError(
            f"{path} claims {header.get('rows_written')} rows but holds {len(rows)}; "
            "the file is truncated or was appended to after sealing"
        )
    return {"header": header, "rows": rows}


def load_frozen_bootstrap(directory: Path, header: Dict[str, Any]) -> Dict[str, Any]:
    """
    Load the frozen inputs and verify they are the ones that were sealed.

    A digest mismatch makes the gameweek unscoreable rather than silently
    re-projected against different data.
    """
    frozen = header.get("frozen_inputs") or {}
    path = Path(directory) / "inputs" / frozen.get("path", "bootstrap.json.gz")
    if not path.exists():
        raise LedgerError(
            f"frozen inputs missing at {path}; this gameweek cannot be "
            "re-projected and must be treated as unscoreable rather than "
            "reconstructed from live data"
        )
    raw = path.read_bytes()
    actual = digest_bytes(raw)
    if frozen.get("digest") and actual != frozen["digest"]:
        raise LedgerError(
            f"frozen input digest mismatch at {path}: header says "
            f"{frozen['digest']}, file is {actual}"
        )
    return json.loads(gzip.decompress(raw).decode("utf-8"))
