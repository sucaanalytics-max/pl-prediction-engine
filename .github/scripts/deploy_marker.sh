#!/usr/bin/env bash
#
# Decide when a bot data commit should trigger a Vercel production build.
#
# Usage:
#   deploy_marker.sh tag "<commit message>" [--force]
#       Prints the message, with " [deploy]" appended when a build is due or
#       --force is given. Always exits 0 and always prints a message.
#   deploy_marker.sh flush
#       If the newest commit on the branch was a skipped bot commit and no build
#       has happened within the interval, pushes an empty "[deploy]" commit.
#       Always exits 0.
#
# Environment:
#   DEPLOY_INTERVAL_SECONDS  minimum gap between bot-triggered builds (default 10800)
#   TARGET_BRANCH            branch to inspect and push (default: main)
#   GITHUB_REPOSITORY, GH_TOKEN   for `gh api`; set by Actions
#   PUSH_ATTEMPTS, PUSH_RETRY_DELAY   flush push retries (defaults 3, 5)
#   DEPLOY_MARKER_FIXTURE_DIR     tests only: read head.tsv / recent.tsv from
#                                 here instead of calling the GitHub API
#
# Why this exists: frontend/scripts/vercel-ignore.sh skips every bot data commit,
# but the site serves the published artifacts as static files baked into each
# deployment. Without something that eventually asks for a build, skipping
# would mean a permanently stale site.
#
# "A build happened" means a commit that vercel-ignore.sh would build: one whose
# message carries [deploy], or whose subject is not a bot pattern. Both scripts
# read that definition from frontend/scripts/bot-commits.sh. (A human commit
# touching only data paths is counted as a build although Vercel skips it — rare,
# and it errs toward one late build, not none.)
#
# Why the GitHub API rather than `git log`: every bot workflow checks out with
# fetch-depth 1, so local history holds one commit. Deepening it would pull
# multi-megabyte versions of availability_evidence.jsonl every 15 minutes.
#
# Why `tag` cannot fail: it runs inside commit steps that publish seals. If the
# API is unreachable it errs toward building, never toward withholding a commit.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../frontend/scripts/bot-commits.sh
. "${here}/../../frontend/scripts/bot-commits.sh"

INTERVAL="${DEPLOY_INTERVAL_SECONDS:-10800}"
BRANCH="${TARGET_BRANCH:-main}"

log() { echo "deploy_marker: $*" >&2; }

iso_ago() {
    local then=$(( $(date +%s) - $1 ))
    date -u -d "@${then}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -r "${then}" +%Y-%m-%dT%H:%M:%SZ
}

# One line per commit, newest first: "<true|false>\t<subject>", where the flag
# says whether the full message contains [deploy].
#   commits head    → the single newest commit on the branch
#   commits recent  → every commit within the interval (up to 100)
commits() {
    if [ -n "${DEPLOY_MARKER_FIXTURE_DIR:-}" ]; then
        cat "${DEPLOY_MARKER_FIXTURE_DIR}/$1.tsv"
        return
    fi
    local query="sha=${BRANCH}&per_page=1"
    if [ "$1" = recent ]; then
        query="sha=${BRANCH}&per_page=100&since=$(iso_ago "${INTERVAL}")"
    fi
    # Bounded, because `tag` sits in front of the commit that publishes a seal:
    # a hung API call must cost seconds, not the deadline.
    local bound=()
    if command -v timeout >/dev/null 2>&1; then bound=(timeout 20); fi
    ${bound[@]+"${bound[@]}"} gh api "repos/${GITHUB_REPOSITORY:?}/commits?${query}" \
        --jq '.[] | "\(.commit.message | contains("[deploy]"))\t\(.commit.message | split("\n")[0])"'
}

# Exit 0 if the line describes a commit Vercel would build.
builds() {
    local flag="${1%%$'\t'*}" subject="${1#*$'\t'}"
    [ "${flag}" = true ] || ! is_bot_subject "${subject}"
}

# Exit 0 if a build happened within the interval, 1 if not, 2 if unknown.
built_recently() {
    local out line
    out="$(commits recent)" || return 2
    while IFS= read -r line; do
        [ -n "${line}" ] || continue
        if builds "${line}"; then return 0; fi
    done <<< "${out}"
    return 1
}

cmd_tag() {
    local message="$1" force="${2:-}"
    if has_deploy_token "${message}"; then
        printf '%s\n' "${message}"
        return
    fi
    if [ "${force}" = --force ]; then
        log "forced: build requested regardless of interval"
        printf '%s %s\n' "${message}" "${DEPLOY_TOKEN}"
        return
    fi
    built_recently
    case $? in
        0) log "a build happened within ${INTERVAL}s; not tagging"
           printf '%s\n' "${message}" ;;
        1) log "no build within ${INTERVAL}s; tagging ${DEPLOY_TOKEN}"
           printf '%s %s\n' "${message}" "${DEPLOY_TOKEN}" ;;
        *) log "::warning::could not read recent commits; tagging ${DEPLOY_TOKEN} to stay fresh"
           printf '%s %s\n' "${message}" "${DEPLOY_TOKEN}" ;;
    esac
}

cmd_flush() {
    local head
    if ! head="$(commits head)" || [ -z "${head}" ]; then
        log "::warning::could not read the newest commit; not flushing (next run retries)"
        return 0
    fi
    if builds "${head}"; then
        log "newest commit already builds; nothing pending"
        return 0
    fi
    built_recently
    case $? in
        0) log "data pending, but a build happened within ${INTERVAL}s; waiting"
           return 0 ;;
        2) log "::warning::could not read recent commits; not flushing (next run retries)"
           return 0 ;;
    esac

    log "data pending and no build within ${INTERVAL}s; pushing an empty ${DEPLOY_TOKEN} commit"
    # --only with no paths commits HEAD's tree and ignores the index. The flush
    # runs `if: always()`, so after commit_and_push.sh refuses a FORBID_PATHS
    # violation the forbidden paths are still staged — a plain commit would
    # publish exactly what the ownership guard just refused.
    git commit -q --only --allow-empty -m "Deploy pending data — $(date -u +%Y-%m-%dT%H:%MZ) ${DEPLOY_TOKEN}" || {
        log "::warning::could not create the flush commit"
        return 0
    }
    local attempt attempts="${PUSH_ATTEMPTS:-3}"
    for attempt in $(seq 1 "${attempts}"); do
        git rebase --abort 2>/dev/null || true
        if git pull -q --rebase --autostash origin "${BRANCH}" && git push -q origin "HEAD:${BRANCH}"; then
            log "pushed $(git rev-parse --short HEAD)"
            return 0
        fi
        log "push attempt ${attempt}/${attempts} failed"
        [ "${attempt}" -lt "${attempts}" ] && sleep "${PUSH_RETRY_DELAY:-5}"
    done
    log "::warning::flush commit not pushed; the next run retries"
    return 0
}

case "${1:-}" in
    tag)
        if [ "$#" -lt 2 ]; then
            echo "usage: $0 tag \"<message>\" [--force]" >&2
            exit 2
        fi
        cmd_tag "$2" "${3:-}"
        ;;
    flush)
        cmd_flush
        ;;
    *)
        echo "usage: $0 tag \"<message>\" [--force] | flush" >&2
        exit 2
        ;;
esac
exit 0
