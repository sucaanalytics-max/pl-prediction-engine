---
name: rehearse-phase
description: Use before shipping any change to the agent's phase machine, ledger, or seal path — executes the real REFRESH or SEAL code against a scratch directory so "it works" is an observation rather than an inference. Invoke whenever pipeline/learning/{schedule,ledger,outcomes}.py or run_agent.py's _seal changes.
---

# Rehearsing an agent phase

The agent's work job is `skipped` on most ticks, which is the phase machine behaving correctly — and also means REFRESH and SEAL can go a long time without executing. Reading the code is not the same as running it.

## Run it

```bash
cd /Users/tusk-jvb/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python scripts/rehearse_agent_phase.py refresh --gameweek 1
PYTHONPATH=. .venv/bin/python scripts/rehearse_agent_phase.py seal
```

Exit 0 means the phase completed; 1 means it raised, and the traceback is what would happen on the day.

## What it does and does not protect

`seal` forces `dry_run=True` and there is no flag to disable it. Under that flag `seal_forecast` writes to `ledger/dryrun/gwNN/` rather than the real path, `_decide_for_entries` returns before `write_decision`, and `publish` returns without writing. So a rehearsal cannot consume the real seal.

It **does** write the published tree. `FPL_PUBLIC_DIR` is built from `ROOT_DIR` in `pipeline/config.py` and is therefore absolute — a phase writes there regardless of the directory it is handed. The script refuses to start on a dirty `frontend/public/predictions` (its restore is a `git checkout`, which would destroy uncommitted work there) and restores what it overwrote afterwards.

It also snapshots the **real** ledger and reports loudly if a dry run wrote there, without deleting it. A ledger file is not a script's to remove, and an auto-delete racing a genuine run would destroy the seal it was meant to protect. If that warning fires, inspect by hand before the next deadline or the real seal raises `AlreadySealedError`.

## Then confirm the tree is clean

```bash
git status --porcelain
```

Only your own edits should appear. Anything under `frontend/public/predictions/` means the restore did not fire — investigate before committing.

## After a seal rehearsal

Use the `verify-seal` skill on the quarantined file to check it carries what it should, rather than trusting the exit code alone.
