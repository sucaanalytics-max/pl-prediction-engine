#!/bin/bash
#
# Remove sync-conflict duplicates — safely, and only the ones that are provably
# redundant.
#
# ## Why this exists rather than a fix for the cause
#
# The cause was hunted and not found. Ruled out by measurement:
#
#   * iCloud Desktop & Documents sync is OFF (~/Documents is a real directory and
#     there is no CloudDocs/Documents).
#   * OneDrive is running and DOES back up a Documents folder, but not this one —
#     different inode, and its Documents holds unrelated files.
#   * Google Drive is running; its root has no Documents mirror.
#   * `npm run build` creates none, over both a clean and an existing `.next`.
#   * Files written by a shell redirect are not duplicated.
#   * Files written by an editor/tool are not duplicated either.
#
# The events are episodic — 743 appeared at once, then 3, then 9 — which looks like
# a bulk reconcile rather than a per-file watcher, and it did not reproduce during
# two canary tests. So this script addresses the IMPACT, which is what actually
# bites:
#
#   * `pipeline/risk/kelly 2.py` was a byte-identical copy of the real-money staking
#     module. Editing the wrong one is silent.
#   * A stale `real-artifacts.test 2.ts` shadowed a test file that had just been
#     rewritten.
#
# `frontend/test/no-untracked-imports.test.ts` is the detector and already fails on
# these. This is the remedy it points at.
#
# ## The safety rule
#
# A duplicate is deleted only if it is byte-identical to its original, or lives in a
# build/cache directory. Anything that DIFFERS is reported and kept, because a
# differing copy might be the only place some work exists.
#
# Usage:
#   scripts/clean_sync_duplicates.sh          # report only
#   scripts/clean_sync_duplicates.sh --apply  # delete the safe ones

set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Directories whose contents are regenerated, so a duplicate there is never work.
BUILD_DIRS='__pycache__|/\.next/|/\.open-next/|/\.wrangler/|node_modules|/\.venv/|/dist/|/\.sites-bundle/'

safe=0
unsafe=0
kept=()

# -print0 throughout: a sync-conflict name contains a space by construction, and
# splitting on whitespace would mangle every one of them.
while IFS= read -r -d '' dup; do
    # `foo 2.ts` -> `foo.ts`; `foo 2` -> `foo`
    original="$(printf '%s' "$dup" | sed -E 's/ [0-9]+(\.[^./]+)?$/\1/')"

    if printf '%s' "$dup" | grep -qE "$BUILD_DIRS"; then
        if [ "$APPLY" -eq 1 ]; then rm -rf -- "$dup"; fi
        safe=$((safe + 1))
        continue
    fi

    if [ -e "$original" ] && cmp -s -- "$dup" "$original" 2>/dev/null; then
        if [ "$APPLY" -eq 1 ]; then rm -rf -- "$dup"; fi
        safe=$((safe + 1))
        continue
    fi

    # Differs, or has no original. Either way it may hold the only copy of
    # something, so it is never deleted automatically.
    unsafe=$((unsafe + 1))
    kept+=("$dup")
done < <(find . \( -name '* [0-9]' -o -name '* [0-9].*' \) -not -path './.git/*' -print0 2>/dev/null)

if [ "$APPLY" -eq 1 ]; then
    # Empty directories left behind by removing their contents.
    find . \( -name '* [0-9]' -o -name '* [0-9].*' \) -not -path './.git/*' \
        -type d -empty -delete 2>/dev/null
    echo "removed $safe redundant duplicate(s)"
else
    echo "$safe duplicate(s) are redundant and can be removed with --apply"
fi

if [ "$unsafe" -gt 0 ]; then
    echo
    echo "KEPT $unsafe duplicate(s) that DIFFER from their original, or have none."
    echo "Diff each against its original before deleting — a differing copy may hold"
    echo "the only version of some work:"
    for k in "${kept[@]}"; do echo "  $k"; done
    exit 1
fi

exit 0
