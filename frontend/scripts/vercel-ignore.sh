#!/usr/bin/env bash
#
# Vercel ignoreCommand: decide whether this commit needs a build.
#
#   exit 0  → Vercel SKIPS the build
#   exit 1  → Vercel BUILDS
#
# Vercel runs this from the project root (frontend/) against the pushed commit.
# Five GitHub Actions writers push data to main up to every 15 minutes, and
# before this script every one of those pushes was a full production build.
#
# Rules, first match wins:
#   1. subject or body contains [deploy]        → build. The bots add it at most
#      every 3 hours and always on seal/settle_final (.github/scripts/deploy_marker.sh).
#   2. subject matches a bot pattern            → skip.
#   3. every path changed vs HEAD^ is bot data  → skip.
#   4. anything else                            → build.
#
# Skipping is safe only because rule 1 comes back round: the site serves
# frontend/public/predictions/ as static files baked into each deployment, so a
# skipped data commit is invisible until the next build.
#
# Every failure path builds. A wasted build costs minutes; a wrongly skipped one
# leaves real code undeployed with nothing in the log to say why. That is also
# why there is no `set -e`: Vercel treats exit 0 as "skip", and a crash must not
# be able to land there.
#
# Local test:
#   VERCEL_GIT_COMMIT_MESSAGE="Availability news — 2026-10-18T16:42Z" bash scripts/vercel-ignore.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bot-commits.sh
if ! . "${here}/bot-commits.sh"; then
    echo "vercel-ignore: BUILD — could not load bot-commits.sh"
    exit 1
fi

message="${VERCEL_GIT_COMMIT_MESSAGE:-}"
if [ -z "${message}" ]; then
    message="$(git log -1 --format=%B HEAD 2>/dev/null || true)"
fi
subject="$(printf '%s\n' "${message}" | head -n 1)"

echo "vercel-ignore: commit ${VERCEL_GIT_COMMIT_SHA:-HEAD}: ${subject}"

if has_deploy_token "${message}"; then
    echo "vercel-ignore: BUILD — message contains ${DEPLOY_TOKEN}"
    exit 1
fi

if is_bot_subject "${subject}"; then
    echo "vercel-ignore: SKIP — bot data commit (subject matches bot pattern)"
    exit 0
fi

if ! changed="$(git diff --name-only --no-renames HEAD^ HEAD 2>/dev/null)"; then
    echo "vercel-ignore: BUILD — cannot diff against HEAD^ (shallow clone or root commit)"
    exit 1
fi

if [ -z "${changed}" ]; then
    echo "vercel-ignore: BUILD — no paths changed vs HEAD^ (empty or merge commit)"
    exit 1
fi

non_data="$(printf '%s\n' "${changed}" | grep -vE "${DATA_PATH_RE}" || true)"
if [ -z "${non_data}" ]; then
    echo "vercel-ignore: SKIP — only bot-written data paths changed vs HEAD^"
    exit 0
fi

echo "vercel-ignore: BUILD — non-data paths changed, e.g. $(printf '%s\n' "${non_data}" | head -n 3 | paste -sd ',' -)"
exit 1
