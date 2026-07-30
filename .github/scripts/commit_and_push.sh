#!/usr/bin/env bash
#
# Stage, commit and push generated artifacts, failing loudly if anything is lost.
#
# Usage:
#   commit_and_push.sh "<commit message>" <pathspec>...
#
# Environment:
#   TARGET_BRANCH     branch to rebase onto and push (default: main)
#   PUSH_ATTEMPTS     push attempts before giving up (default: 3)
#   PUSH_RETRY_DELAY  seconds between attempts (default: 5)
#   FORBID_PATHS      extended regex; staging any matching path is a hard error.
#                     Used to enforce path ownership between concurrent writers.
#
# Exit codes:
#   0  pushed, or nothing to commit
#   1  a commit existed but could not be published
#   2  usage error
#
# Why this is a script and not inline YAML: the original inline loop ended on
# `sleep 5`, so when every attempt failed the step still exited 0 and the commit
# was silently dropped. Two workflows had their own copy. One implementation with
# one test is harder to regress.
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: $0 \"<commit message>\" <pathspec>..." >&2
    exit 2
fi

MESSAGE="$1"
shift

BRANCH="${TARGET_BRANCH:-main}"
ATTEMPTS="${PUSH_ATTEMPTS:-3}"
RETRY_DELAY="${PUSH_RETRY_DELAY:-5}"

git add -- "$@"

if git diff --staged --quiet; then
    echo "Nothing to commit."
    exit 0
fi

# Enforce path ownership before committing. Disjoint paths are what let the
# daily pipeline and the FPL agent both write to the same branch safely: git
# rebases at file granularity, so writers that never touch the same file cannot
# conflict. A stray path silently breaks that guarantee.
if [ -n "${FORBID_PATHS:-}" ]; then
    if git diff --staged --name-only | grep -qE "${FORBID_PATHS}"; then
        echo "::error::staged a path matching forbidden pattern ${FORBID_PATHS}" >&2
        git diff --staged --name-only | grep -E "${FORBID_PATHS}" >&2
        exit 1
    fi
fi

git commit -m "${MESSAGE}"
echo "Committed $(git rev-parse --short HEAD)"

pushed=0
for attempt in $(seq 1 "${ATTEMPTS}"); do
    # Clear a rebase left half-finished by a previous failure, otherwise the
    # next attempt fails for an unrelated reason and the real cause is masked.
    git rebase --abort 2>/dev/null || true

    if git pull --rebase origin "${BRANCH}" && git push; then
        pushed=1
        break
    fi

    echo "Push attempt ${attempt}/${ATTEMPTS} failed."
    if [ "${attempt}" -lt "${ATTEMPTS}" ]; then
        sleep "${RETRY_DELAY}"
    fi
done

if [ "${pushed}" -ne 1 ]; then
    echo "::error::push failed after ${ATTEMPTS} attempts — nothing was published" >&2
    exit 1
fi

# Do not trust the push exit code alone: confirm the commit is actually
# reachable from the remote branch.
git fetch origin "${BRANCH}"
if ! git merge-base --is-ancestor HEAD "origin/${BRANCH}"; then
    echo "::error::HEAD is not an ancestor of origin/${BRANCH} after a reportedly successful push" >&2
    exit 1
fi

echo "Published $(git rev-parse --short HEAD) to origin/${BRANCH}"
