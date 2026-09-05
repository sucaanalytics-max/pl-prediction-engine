#!/usr/bin/env python3
"""
Run an agent phase against a throwaway directory, to find out whether it works.

## Why this exists

The agent's `work` job had never executed once. Every scheduled run since the workflow was
written resolved to IDLE and skipped it, so the whole path — install the heavy dependency
set, fetch live FPL data, run the simulation, write the artifact — was unexercised code due
to run for the first time in the 3.5-hour window before a deadline, on the one operation
this repository cannot recover: the seal.

A dry-run flag already exists inside the agent (`FPL_AGENT_DRY_RUN`, quarantining output
into `ledger/dryrun/`), but it still writes into the real predictions tree and is wired to a
workflow input that defaults to true — which is a trap of its own, because a panicked
re-run with defaults produces a green build and no seal. This script is the other half:
it copies the committed inputs somewhere disposable and calls the phase function directly,
so a failure surfaces on a Tuesday instead of at T-2h.

## It DOES write the published tree, and that cannot be parameterised away

The first version of this script assumed that passing a temporary `predictions_dir` would
contain every write. It does not, and the run proved it by overwriting the live
`frontend/public/predictions/fpl/xp_public_gw01.json` that the deployed site reads — the
committed 5,000-draw artifact replaced with a fresh 10,000-draw one.

The reason is structural, not a bug: `run_agent.py:26` imports `FPL_PUBLIC_DIR` from
`pipeline/config.py:437`, which is `ROOT_DIR / "frontend/public/predictions/fpl"`, and
`ROOT_DIR` (`config.py:10`) is resolved from config.py's own location. The published views
are written to an absolute path by design — publishing is the agent's job — so the
`predictions_dir` argument governs the private artifacts only.

So this script guards instead of pretending. It refuses to start on a dirty tree, and it
restores the published directory with git afterwards. That is why the dirty check is not
optional politeness: without it there is no clean state to restore to.

## Sealing is rehearsable, because dry runs are quarantined

The seal is the phase worth rehearsing: it is irrecoverable (38 per season), it runs
unattended, and until now it had never executed. It is reachable here only because
`ledger.gameweek_dir` puts a dry run under `ledger/dryrun/gwNN/` instead of
`ledger/gwNN/`, so a rehearsal cannot consume the real seal, and the path honours the
directory it is given rather than resolving absolutely.

`dry_run` is forced True for `seal` and there is no flag to turn it off. Under it:

  * `seal_forecast` writes the quarantined ledger — the real GW is untouched
  * `_decide_for_entries` logs and `continue`s before `write_decision`, so no decision
    artifact is written and the returned dict is empty
  * `_deliver` reaches `publish`, which returns `{}` without writing — nothing notified

So this rehearses refresh → seal → decide-compute → deliver-compute. It does NOT
exercise `write_decision` or a real publish, because dry run is what makes it safe to
run at all. Read a green seal as "the seal itself works", not "the whole Friday path
wrote what it should".

Defence in depth: a dry run should never create a file in the real ledger, so the run
compares the real ledger before and after and reports loudly if one appeared. It does
not delete it — removing a ledger file is precisely the irreversible act that should
need a human, and an auto-delete racing a genuine run would destroy the seal it was
meant to protect.

It never commits and never dispatches a workflow.

## Usage

    PYTHONPATH=. .venv/bin/python scripts/rehearse_agent_phase.py refresh --gameweek 1
    PYTHONPATH=. .venv/bin/python scripts/rehearse_agent_phase.py seal

Exit status is 0 when the phase completed, 1 when it raised — so it can gate a pre-deadline
checklist.
"""
from __future__ import annotations

import argparse
import logging
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path(__file__).resolve().parents[1]
PREDICTIONS = REPO_ROOT / "predictions"

#: Values small enough to print. Everything else is a payload or a draw matrix, and dumping
#: one produced 1.7MB of numpy on the first run of this rehearsal.
SCALAR = (str, int, float, bool, type(None))


#: Written by absolute path regardless of the directory a phase is handed. See the module
#: docstring: `FPL_PUBLIC_DIR` is derived from `config.py`'s own location.
PUBLISHED = REPO_ROOT / "frontend" / "public" / "predictions"


def _dirty(paths: str) -> str:
    """`git status --porcelain` for a pathspec, empty when clean."""
    return subprocess.run(
        ["git", "-C", str(REPO_ROOT), "status", "--porcelain", "--", paths],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def _restore(paths: str) -> None:
    subprocess.run(["git", "-C", str(REPO_ROOT), "checkout", "--", paths], check=True)


#: The real ledger. A dry run must never add a file here; `_ledger_files` is snapshotted
#: before and after so an escape is reported rather than discovered on seal day.
REAL_LEDGER = REPO_ROOT / "predictions" / "fpl" / "ledger"


def _ledger_files() -> set:
    """Every file in the real ledger, excluding the quarantined dry-run subtree."""
    if not REAL_LEDGER.is_dir():
        return set()
    return {
        p for p in REAL_LEDGER.rglob("*")
        if p.is_file() and "dryrun" not in p.relative_to(REAL_LEDGER).parts
    }


def _seed(destination: Path) -> None:
    """
    Copy the committed inputs a phase reads, and nothing else.

    The ledger's sealed gameweeks are copied too, and that is not tidiness. The
    phase machine picks the first UNSEALED gameweek, so a scratch directory with
    no ledger claims GW1 still needs sealing — and `seal_forecast` checks the real
    wall clock, not the simulated one this script hands to `resolve`. Once GW1's
    deadline passed, that mismatch turned every rehearsal into a
    `TooLateToSealError` about a gameweek that was in fact sealed days ago.
    Seeding the seals makes the rehearsal target the NEXT deadline, which is the
    only one it was ever useful for.
    """
    (destination / "fpl").mkdir(parents=True, exist_ok=True)
    for source in PREDICTIONS.glob("*.json"):
        shutil.copy2(source, destination / source.name)
    for source in (PREDICTIONS / "fpl").glob("*"):
        if source.is_file():
            shutil.copy2(source, destination / "fpl" / source.name)

    real_ledger = PREDICTIONS / "fpl" / "ledger"
    if real_ledger.is_dir():
        for week in sorted(real_ledger.iterdir()):
            # Skip the quarantined dry-run subtree: copying it in would teach the
            # scratch machine that a rehearsal counts as a seal.
            if not week.is_dir() or week.name == "dryrun":
                continue
            shutil.copytree(week, destination / "fpl" / "ledger" / week.name)


def _report(outcome: Dict[str, Any], scratch: Path) -> None:
    print("PHASE COMPLETED")
    for key, value in sorted(outcome.items()):
        if key.startswith("_") or not isinstance(value, SCALAR):
            kind = type(value).__name__
            print(f"   {key}: <{kind}, not printed>")
            continue
        print(f"   {key}: {value}")
    written = sorted(
        p.relative_to(scratch).as_posix() for p in scratch.rglob("*") if p.is_file()
    )
    fresh = [w for w in written if "xp" in w or "ledger" in w]
    print(f"   artifacts of interest: {fresh or 'none'}")


def _forecast_rows(path: Path) -> int:
    """Forecast rows in a sealed ledger file, excluding its header line."""
    if not path.exists():
        return 0
    import json
    with path.open() as handle:
        return sum(1 for line in handle if json.loads(line).get("record") == "forecast")


def _rehearse_refresh(scratch: Path, gameweek: int | None) -> Dict[str, Any]:
    """
    Run the REFRESH phase against the scratch tree, as a dry run.

    Calls the phase HANDLER, not `refresh_expected_points`. This used to call the
    function directly, which meant the phase dispatch was never entered — so when
    REFRESH grew a provisional solve, this script kept passing without executing
    any of it and the description's promise to "execute the real REFRESH" was
    quietly false.

    The phase is resolved rather than hand-built, for the same reason as the seal:
    a hand-made ScheduleState rehearses my belief about the schedule instead of
    the code that runs on the day. Twenty-four hours out is inside REFRESH_WINDOW
    and well outside SEAL_WINDOW, which also puts the run past the projection-age
    gate — so the refresh and the solve both actually happen rather than being
    skipped as current.

    `dry_run=True`, so `_decide_for_entries` returns before `write_decision` and
    a rehearsal cannot publish a plan.
    """
    from datetime import timedelta

    from pipeline.learning.run_agent import _refresh
    from pipeline.learning.schedule import Phase, fetch_events, resolve

    events = fetch_events()
    live = resolve(scratch, events=events)
    if live.deadline is None:
        raise RuntimeError(f"no upcoming deadline in the calendar (phase {live.phase})")

    at = live.deadline - timedelta(hours=24)
    state = resolve(scratch, now=at, events=events)
    print(f"   calendar deadline  {live.deadline:%a %d %b %H:%MZ}")
    print(f"   rehearsing as at   {at:%a %d %b %H:%MZ}  -> phase {state.phase.value}")

    if state.phase is not Phase.REFRESH:
        raise RuntimeError(
            f"expected REFRESH a day before the deadline, got {state.phase.value}: "
            f"{state.reason}"
        )
    if gameweek is not None and state.gameweek != gameweek:
        raise RuntimeError(f"calendar says GW{state.gameweek}, you asked for GW{gameweek}")

    code = _refresh(scratch, state, dry_run=True)
    return {"exit_code": code, "gameweek": state.gameweek, "phase": state.phase.value}


def _rehearse_seal(scratch: Path, gameweek: int | None) -> Dict[str, Any]:
    """
    Run the seal against the scratch ledger, as a dry run.

    The phase is not hand-constructed. `resolve` is asked twice: once at the real now to
    learn the deadline from the live calendar, then again at two hours before it — inside
    SEAL_WINDOW, outside LOCKOUT — so the phase machine itself decides this is a seal.
    A hand-built ScheduleState would rehearse my belief about the schedule rather than
    the code that will actually run on Friday.
    """
    from datetime import timedelta

    from pipeline.learning.run_agent import _seal
    from pipeline.learning.schedule import Phase, fetch_events, resolve

    events = fetch_events()
    live = resolve(scratch, events=events)
    if live.deadline is None:
        raise RuntimeError(f"no upcoming deadline in the calendar (phase {live.phase})")

    at = live.deadline - timedelta(hours=2)
    state = resolve(scratch, now=at, events=events)
    print(f"   calendar deadline  {live.deadline:%a %d %b %H:%MZ}")
    print(f"   rehearsing as at   {at:%a %d %b %H:%MZ}  -> phase {state.phase.value}")

    if state.phase is not Phase.SEAL:
        raise RuntimeError(
            f"expected SEAL two hours before the deadline, got {state.phase.value}: "
            f"{state.reason}"
        )
    if gameweek is not None and state.gameweek != gameweek:
        raise RuntimeError(f"calendar says GW{state.gameweek}, you asked for GW{gameweek}")

    code = _seal(scratch, state, dry_run=True)
    sealed = scratch / "fpl" / "ledger" / "dryrun" / f"gw{state.gameweek:02d}" / "forecast.jsonl"
    return {
        "exit_code": code,
        "gameweek": state.gameweek,
        # Counting lines reported 496 against the header's own rows_written of 495: the
        # first line is the header, not a forecast. Count the record type instead.
        "sealed_rows": _forecast_rows(sealed),
        "quarantined_to": sealed.relative_to(scratch).as_posix() if sealed.exists() else "NOTHING WRITTEN",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("phase", choices=["refresh", "seal"],
                        help="`seal` always runs as a dry run; there is no way to disable that")
    parser.add_argument("--gameweek", type=int, default=None)
    parser.add_argument("--keep", action="store_true",
                        help="leave the scratch directory in place for inspection")
    args = parser.parse_args()

    # INFO, not ERROR. The point of a rehearsal is to OBSERVE the phase, and at
    # ERROR a run that solved and a run that skipped are both silent — `_refresh`
    # is deliberately non-fatal, so a solve that raised would log and the script
    # would still exit 0. The phase's own narration is the evidence.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    # Imported here, not at module scope: this pulls in pandas, PyMC and the rest, and the
    # argument parsing above should fail fast without paying for them.

    # Refuse on a dirty published tree: the restore below is a `git checkout`, so
    # uncommitted work there would be destroyed by the very step that protects it.
    if _dirty(str(PUBLISHED.relative_to(REPO_ROOT))):
        print("REFUSING: frontend/public/predictions has uncommitted changes.")
        print("  This rehearsal overwrites published artifacts and restores them with")
        print("  `git checkout`, which would discard whatever is currently there.")
        print("  Commit or stash first.")
        return 1

    scratch = Path(tempfile.mkdtemp(prefix=f"rehearse-{args.phase}-"))
    _seed(scratch)
    print(f"rehearsing `{args.phase}` in {scratch}")

    before = _ledger_files()

    try:
        if args.phase == "seal":
            outcome = _rehearse_seal(scratch, args.gameweek)
        else:
            outcome = _rehearse_refresh(scratch, args.gameweek)
    except Exception:
        print("PHASE FAILED — this is what would happen on the day:")
        traceback.print_exc()
        return 1
    else:
        _report(outcome, scratch)
        return 0
    finally:
        # The published tree is written by absolute path, so put it back.
        touched = _dirty(str(PUBLISHED.relative_to(REPO_ROOT)))
        if touched:
            # `XY path`, and the status field is not always the same width — slicing a
            # fixed 3 chars ate the first letter of the filename.
            rows = [(line[:2].strip(), line.split(maxsplit=1)[-1])
                    for line in touched.split("\n")]
            # `git checkout` restores a tracked file but will not remove an untracked
            # one, so a phase that CREATED an artifact left it behind in the live tree
            # — a projection this machine generated, sitting where the published ones
            # go. Safe to delete precisely because the run refuses to start on a dirty
            # tree: anything untracked here now was created by this run.
            created = [name for status, name in rows if status == "??"]
            modified = [name for status, name in rows if status != "??"]

            if modified:
                print(f"   restoring {len(modified)} published artifact(s) overwritten:")
                for name in modified:
                    print(f"     {name}")
                _restore(str(PUBLISHED.relative_to(REPO_ROOT)))
            if created:
                print(f"   removing {len(created)} published artifact(s) created:")
                for name in created:
                    print(f"     {name}")
                    (REPO_ROOT / name).unlink(missing_ok=True)
        escaped = sorted(_ledger_files() - before)
        if escaped:
            print()
            print("!! A DRY RUN WROTE TO THE REAL LEDGER. This can cost the seal:")
            for path in escaped:
                print(f"     {path.relative_to(REPO_ROOT)}")
            print("   Not deleting it — a ledger file is not mine to remove, and an")
            print("   auto-delete racing a genuine run would destroy the real seal.")
            print("   Inspect it, and if it is this rehearsal's, remove it by hand")
            print("   BEFORE the deadline or the real seal raises AlreadySealedError.")

        if args.keep:
            print(f"   scratch kept at {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
