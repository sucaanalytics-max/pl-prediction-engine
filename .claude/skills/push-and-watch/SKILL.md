---
name: push-and-watch
description: Use to land a commit on main in this repo, where three automated writers push continuously and a naive push fails. Handles the rebase, the account check, and watching both CI gates. Invoke whenever committing and pushing here.
---

# Pushing to a branch three bots are also writing

`main` receives commits from the daily pipeline, the hourly agent, and a news job every 15 minutes. A push prepared even a minute earlier is usually already behind.

## The sequence

```bash
cd /Users/tusk-jvb/dev/pl-prediction-engine
git add <explicit paths>          # never `git add -A` blindly; see below
git commit -m "..."
git fetch -q origin main
git rebase origin/main
git push origin main
```

Rebase, never merge, and never force-push. Your commits touch source; the bots touch artifacts; conflicts are rare and a conflict means something genuinely overlaps and should be read rather than resolved mechanically.

## Two traps

**Staging.** `git add -A` once committed a zero-byte test file that a stray shell redirect had created, and vitest fails on a suite-less file — the suite went red for a push. Stage the paths you meant.

**The wrong account.** Three GitHub accounts are logged in via `gh`, and only `sucaanalytics-max` can push here. A 403 saying "Permission to ... denied to Research-Tusk" means the active account drifted:

```bash
gh auth status
gh auth switch --user sucaanalytics-max
```

## Watch both gates

Two workflows gate source changes, and they trigger on different paths:

```bash
gh run list --limit 6 --json workflowName,status,conclusion,headSha \
  -q '.[]|"\(.workflowName): \(.status)/\(.conclusion//"running") \(.headSha[:7])"'
```

- **Python CI** — `pipeline/**`, `scripts/**`
- **Frontend CI** — `frontend/**`, excluding `frontend/public/predictions/fpl/**`

A change to only one area legitimately triggers only one gate. `cancelled` on Frontend CI usually means a later push superseded it (`cancel-in-progress: true` on a per-ref group) — that is not a failure, and treating it as one produces false alarms.

## Run the suites first

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -q
cd frontend && npm test && npm run build
```

Use the repo venv; bare `python3` lacks scipy and reports import errors that read as a code regression. Do not pipe the Python suite to `tail` — that reports tail's exit code, so a failing suite looks like a pass.
