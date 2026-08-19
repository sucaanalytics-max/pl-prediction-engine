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

## What it will not do

It never commits, never dispatches a workflow, and cannot seal — `_seal` is deliberately
unreachable from here, because a forecast written outside the ledger's own path is a
forecast with no external timestamp anchor, which is worse than none. Use it to answer
"does this code run", not "is the gameweek sealed".

## Usage

    PYTHONPATH=. .venv/bin/python scripts/rehearse_agent_phase.py refresh --gameweek 1

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


def _seed(destination: Path) -> None:
    """Copy the committed inputs a phase reads, and nothing else."""
    (destination / "fpl").mkdir(parents=True, exist_ok=True)
    for source in PREDICTIONS.glob("*.json"):
        shutil.copy2(source, destination / source.name)
    for source in (PREDICTIONS / "fpl").glob("*"):
        if source.is_file():
            shutil.copy2(source, destination / "fpl" / source.name)


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("phase", choices=["refresh"],
                        help="only `refresh` is offered: seal is deliberately unreachable")
    parser.add_argument("--gameweek", type=int, default=None)
    parser.add_argument("--keep", action="store_true",
                        help="leave the scratch directory in place for inspection")
    args = parser.parse_args()

    logging.basicConfig(level=logging.ERROR, format="%(levelname)s %(name)s: %(message)s")

    # Imported here, not at module scope: this pulls in pandas, PyMC and the rest, and the
    # argument parsing above should fail fast without paying for them.
    from pipeline.learning.run_agent import refresh_expected_points

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

    try:
        outcome = refresh_expected_points(scratch, args.gameweek) or {}
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
            names = [line.split(maxsplit=1)[-1] for line in touched.split("\n")]
            print(f"   restoring {len(names)} published artifact(s) the phase overwrote:")
            for n in names:
                print(f"     {n}")
            _restore(str(PUBLISHED.relative_to(REPO_ROOT)))
        if args.keep:
            print(f"   scratch kept at {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
