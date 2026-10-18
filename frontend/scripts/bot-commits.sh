# shellcheck shell=bash
#
# What counts as a bot data commit. Sourced, never executed.
#
# Two readers, one definition:
#   frontend/scripts/vercel-ignore.sh   — Vercel's ignoreCommand: skip the build?
#   .github/scripts/deploy_marker.sh    — the bots: is a [deploy] build due?
# If they disagreed, the bots would think the site was fresh while Vercel had
# skipped every build since, which is the staleness this whole scheme exists to
# bound.
#
# Matched against the commit SUBJECT only, so a human commit whose body quotes a
# bot message still builds. Every alternative is anchored and enumerated: an
# unknown subject — a new phase name, a new writer — falls through to "build",
# which costs a build rather than a stale site.
#
# The em dash is matched as its literal UTF-8 bytes under LC_ALL=C, so the result
# does not depend on the runner's locale.

# shellcheck disable=SC2034  # read by the scripts that source this file
BOT_SUBJECT_RE='^(Availability news — [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z|FPL agent — (refresh|seal|refit|settle_provisional|settle_final) GW[0-9]+|Agent status — (refresh|idle|seal|refit|settle_provisional|settle_final) GW[0-9]+|Update predictions — [0-9]{4}-[0-9]{2}-[0-9]{2}|Update model health — [0-9]{4}-[0-9]{2}-[0-9]{2}|X scan — [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z)'

# Paths only the bots write. `predictions/` is outside the Vercel root
# (frontend/) and never reaches a build; `frontend/public/predictions/` is the
# published copy, which does — that is why a build is eventually needed, and why
# deploy_marker.sh exists.
# shellcheck disable=SC2034
DATA_PATH_RE='^(predictions/|frontend/public/predictions/)'

# shellcheck disable=SC2034
DEPLOY_TOKEN='[deploy]'

is_bot_subject() {
    printf '%s\n' "$1" | LC_ALL=C grep -qE "${BOT_SUBJECT_RE}"
}

has_deploy_token() {
    printf '%s' "$1" | grep -qF "${DEPLOY_TOKEN}"
}
