#!/bin/bash
#
# The browser the X scan attaches to, and nothing else.
#
# ## Why a separate profile
#
# The scan needs a SIGNED-IN X session: measured 2026-09-04, a logged-out browser
# gets `net::ERR_HTTP_RESPONSE_CODE_FAILURE` from x.com immediately, so the
# anonymous route this job used for its whole life returns nothing at all.
#
# The obvious shortcut — attach to the everyday Chrome — was rejected on two
# grounds, one practical and one security:
#
#   * `chrome://inspect/#remote-debugging` is scoped to a DEBUGGING SESSION. The
#     port keeps listening after the session ends, so the endpoint looks alive and
#     returns 404 for the browser id. A job that fires at 07:17 cannot depend on a
#     tab someone left open, and the failure is silent — which is exactly how this
#     lane lost three weeks already.
#   * Running the daily-driver browser with `--remote-debugging-port` opens a
#     control channel onto a signed-in profile. Any local process could then drive
#     it as the owner, on every logged-in site, not just X.
#
# So: a profile used by nothing else, signed into X once, carrying no other
# credentials. If it leaks, it leaks one account's read access to a public
# timeline.
#
# ## Verbs
#
#   signin   Open it visibly so a human can log into X. One time.
#   start    Bring it up for a scan and wait for the debug port. Idempotent.
#   stop     Shut it down.
#   status   Say whether it is up and signed in.
#
# `x_scan.sh` calls `start`, so a scheduled run needs no human present.

set -o pipefail

CHROME="${X_SCAN_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="${X_SCAN_PROFILE_DIR:-$HOME/Library/Application Support/pl-prediction-x-scan}"
PORTFILE="$PROFILE/DevToolsActivePort"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scan_browser: $*"; }

running() {
  # Match on the profile path, so this never reports the everyday Chrome as ours.
  pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1
}

# Port 0 lets Chrome choose and record it, so two runs cannot collide on 9222 and
# we never fight the everyday browser for a port.
launch() {
  local extra=("$@")
  [ -x "$CHROME" ] || { log "no Chrome at $CHROME"; return 1; }
  mkdir -p "$PROFILE"
  rm -f "$PORTFILE"
  "$CHROME" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port=0 \
    --no-first-run --no-default-browser-check \
    --disable-background-networking \
    "${extra[@]}" >/dev/null 2>&1 &
  for _ in $(seq 1 40); do
    [ -s "$PORTFILE" ] && return 0
    sleep 0.25
  done
  log "Chrome started but never wrote $PORTFILE"
  return 1
}

case "${1:-status}" in
  signin)
    running && { log "already up; bring its window forward and sign in"; exit 0; }
    launch "https://x.com/login" || exit 1
    log "signed-out window open. Log into X, then leave it — 'stop' when done."
    ;;
  start)
    if running; then
      # Up already, but the port file may predate a restart.
      [ -s "$PORTFILE" ] || { log "up without a port file; restarting"; pkill -f -- "--user-data-dir=$PROFILE"; sleep 1; launch --headless=new || exit 1; }
      log "already up"
    else
      launch --headless=new || exit 1
      log "started headless"
    fi
    log "port file: $(head -1 "$PORTFILE" 2>/dev/null)"
    ;;
  stop)
    pkill -f -- "--user-data-dir=$PROFILE" && log "stopped" || log "was not running"
    ;;
  status)
    running && log "running" || log "not running"
    [ -s "$PORTFILE" ] && log "port $(head -1 "$PORTFILE")" || log "no port file"
    # Cookies file is the only cheap signal that a login ever happened. Presence
    # is not proof the session is still valid — only a scan can show that.
    if [ -f "$PROFILE/Default/Cookies" ]; then
      log "profile has a cookie store (last written $(stat -f '%Sm' "$PROFILE/Default/Cookies"))"
    else
      log "no cookie store yet — run: $0 signin"
    fi
    ;;
  *)
    echo "usage: $0 {signin|start|stop|status}" >&2; exit 2 ;;
esac
