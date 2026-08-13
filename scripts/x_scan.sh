#!/bin/bash
#
# The twice-daily X scan, end to end. Invoked by launchd; safe to run by hand.
#
# ## Why this is a shell script and not a Claude session
#
# Every step is deterministic: navigate, run fixed JavaScript, hand the JSON to a
# CLI, run the poller, commit. A language model in that loop would cost tokens per
# run to do nothing a script cannot, and would need a live session to exist.
#
# ## Why it runs here and not in GitHub Actions
#
# The logged-out X profile is a JavaScript app shell — `curl` returns 204KB with
# no post text — so a browser is required. A browser in CI is possible, but it
# would request from a datacenter IP, which X serves differently and which has
# never been tested. This runs from the machine already known to work.
#
# The COMMITTED INBOX is what bridges the two: this writes it, and the 15-minute
# CI poller reads it. Neither needs what the other has.

set -o pipefail

# Derived from this script's own location, not hardcoded.
#
# It WAS an absolute path, and the repo has now moved — out of `~/Documents`,
# because iCloud's Desktop & Documents sync was confirmed as the source of the
# duplicated files and had begun corrupting `.git` refs (see CLAUDE.md). A
# hardcoded path fails that move silently in the worst way: launchd fires the job,
# `cd` fails, and "repo not found" goes to a log nobody reads while the scan
# quietly stops running.
#
# `${BASH_SOURCE[0]}` rather than `$0` so it is still correct if sourced, and
# `pwd -P` to resolve symlinks, since launchd may invoke this through one.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PYTHON="$REPO/.venv/bin/python"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$REPO" || { echo "x_scan: repo not found at $REPO"; exit 1; }

# launchd starts with a near-empty PATH; node and git both need finding.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

command -v node >/dev/null || { log "node not on PATH; aborting"; exit 1; }
[ -x "$PYTHON" ] || { log "repo venv missing at $PYTHON; aborting"; exit 1; }

# Accounts come from config, so adding one is a reviewable code change rather than
# an edit to a script that runs unattended.
ACCOUNTS=$(PYTHONPATH=. "$PYTHON" scripts/list_accounts.py)

[ -z "$ACCOUNTS" ] && { log "no accounts configured; nothing to do"; exit 0; }

scanned=0
failed=0
while IFS=$'\t' read -r handle source club; do
    [ -z "$handle" ] && continue
    raw="$SCRATCH/$handle.json"
    log "scanning @$handle"

    if ! node scripts/x_scan.mjs "$handle" "$raw"; then
        # A refused or restructured page must not look like a quiet success, and
        # must not stop the other accounts.
        log "FAILED to scan @$handle — see the error above"
        failed=$((failed + 1))
        continue
    fi

    args=(--raw "$raw" --source "$source")
    [ -n "$club" ] && args+=(--club "$club")
    if PYTHONPATH=. "$PYTHON" -m pipeline.data.x_scan "${args[@]}"; then
        scanned=$((scanned + 1))
    else
        log "FAILED to merge @$handle into the inbox"
        failed=$((failed + 1))
    fi
done <<< "$ACCOUNTS"

if [ "$scanned" -eq 0 ]; then
    log "nothing scanned successfully; not touching git"
    exit 1
fi

# File the claims. --force because the scan runs on its own schedule rather than
# inside the news window, and a post read now should be filed now.
log "running the poller"
PYTHONPATH=. "$PYTHON" -m pipeline.learning.run_news --force || log "poller returned non-zero"

# Only the paths this job owns. The daily pipeline and the agent write elsewhere,
# and staging everything would turn a scan into a surprise commit of whatever else
# happened to be dirty.
PATHS=(
    predictions/fpl/x_inbox.csv
    predictions/fpl/availability_evidence.jsonl
    predictions/news_feed_state.json
    frontend/public/predictions/fpl/news_view.json
)

if git diff --quiet -- "${PATHS[@]}" && git diff --cached --quiet -- "${PATHS[@]}"; then
    log "no change to commit — the same posts are still the most recent"
    exit 0
fi

git add -- "${PATHS[@]}"
git commit -q -m "X scan — $(date -u +%Y-%m-%dT%H:%MZ)" || { log "nothing to commit"; exit 0; }

# Rebase before pushing: three writers push to main (daily pipeline, agent, this),
# and they own disjoint paths precisely so a rebase is safe.
#
# --autostash because this job stages only the four paths it owns, so anything
# else in progress stays unstaged — and a plain `pull --rebase` refuses outright
# on a dirty tree. Measured on the first real run: the scan, the merge, the poll
# and the commit all succeeded and the push failed with "cannot pull with rebase:
# You have unstaged changes", leaving the claims committed locally and invisible
# to CI.
if git pull --rebase --autostash --quiet origin main && git push --quiet origin main; then
    log "pushed"
else
    log "push failed — the commit is local; resolve by hand"
    exit 1
fi

log "done: $scanned account(s) scanned, $failed failed"
