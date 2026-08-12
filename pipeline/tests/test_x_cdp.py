"""
Guards on `scripts/x_cdp.mjs`, which drives a browser the user is signed into.

## Why these are source assertions, and what that is worth

The behaviour needs a live Chrome with remote debugging enabled, which a unittest
run cannot have — so every property below was measured by hand against a real
browser first, and the measurement is recorded in the docstring that asserts it.
These stop a regression; they are not the original evidence. Where a check would be
satisfied by prose rather than code, comments are stripped first: an earlier version
of these guards asserted against the script's own commentary, which mentions the
very calls being forbidden.

## Why this file exists at all

This started as `AttachedScanTests` in `test_x_scan.py`, guarding a Playwright
implementation. That implementation was replaced wholesale — Chrome 144+'s
`chrome://inspect/#remote-debugging` toggle serves an endpoint Playwright cannot
use — so those guards were describing a design that no longer existed and two of
them failed. The properties survived the rewrite and got *stronger*; they just
belong with the module they now describe.

## The one that matters

Borrowing someone's live browser is the most invasive thing in this repo. The
Playwright version was one `browser.close()` from closing the user's tabs, and was
measured doing exactly that — leaving the browser with zero page targets. Raw CDP
cannot: it only ever closes a target id it minted itself.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

CDP_PATH = Path(__file__).resolve().parents[2] / "scripts" / "x_cdp.mjs"
SCAN_PATH = Path(__file__).resolve().parents[2] / "scripts" / "x_scan.mjs"


def code(path: Path) -> str:
    """
    A JavaScript file with its comments removed.

    The guards assert on what the code *does*, and these files discuss the calls
    being forbidden at length. Counting the raw text made the first version of
    these assertions pass against prose.
    """
    source = path.read_text(encoding="utf-8")
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return "\n".join(
        line for line in source.splitlines()
        if not line.strip().startswith("//")
    )


class TabSafetyTests(unittest.TestCase):
    """
    It may only close what it created.

    Measured before the rewrite: Playwright's `browser.close()` on a *connected*
    browser left the endpoint reporting **0 page targets** — a tab open before the
    scan had been closed. Playwright's own types describe that call as clearing only
    "created contexts", so reading the documentation was not enough. Measured after
    the rewrite, across three consecutive runs against a browser with 25 open tabs:
    25 before, 25 after, every time.
    """

    def test_it_creates_its_own_target(self):
        # Reusing an existing tab would mean navigating a page the user is reading.
        self.assertIn("Target.createTarget", code(CDP_PATH))

    def test_it_closes_only_the_target_it_created(self):
        source = code(CDP_PATH)
        self.assertIn("Target.closeTarget", source)
        # Exactly one close, and it takes the id this module minted.
        self.assertEqual(source.count("Target.closeTarget"), 1)
        self.assertIn('Target.closeTarget", { targetId }', source)

    def test_it_never_closes_the_browser(self):
        """
        `Browser.close` would quit the user's Chrome outright.

        There is no legitimate reason for a read-only scan to have it, so its
        absence is checked rather than its correct use.
        """
        self.assertNotIn("Browser.close", code(CDP_PATH))

    def test_it_never_closes_a_foreign_target(self):
        # `Target.getTargets` is fine to call; closing anything it returns is not.
        source = code(CDP_PATH)
        self.assertNotIn("targetInfos", source)


class ConnectionTests(unittest.TestCase):
    def test_it_reads_the_port_file_because_http_discovery_is_off(self):
        """
        Measured against Chrome 151.0.7922.137 with the `chrome://inspect` toggle on:
        `GET /json/version` and `/json/list` both return **404**, while the browser
        *is* listening and raw CDP works fully (66 targets enumerated). So every
        client that discovers its websocket over HTTP — Playwright's `--browserUrl`,
        chrome-devtools-mcp's `--autoConnect` — silently falls back to launching a
        fresh, signed-out browser. `DevToolsActivePort` is the only source that
        works, and it is also the only one that survives a restart changing the
        browser GUID, which it does every time.
        """
        source = code(CDP_PATH)
        self.assertIn("DevToolsActivePort", source)

    def test_it_closes_the_socket_when_the_handshake_fails(self):
        """
        A leaked connection is the next run's failure, not just untidiness.

        Chrome's browser-level endpoint accepts **one** client at a time and hangs
        the second rather than refusing it. The first version rejected on timeout
        without closing its socket, so each failed attempt consumed a slot: a scan
        that had worked began failing, and stayed failing, with `lsof` showing no
        connections and a raw probe succeeding — which reads as an unrelated,
        intermittent fault. After the fix, three consecutive runs succeeded.
        """
        source = code(CDP_PATH)
        opener = source[source.index("static async open"):]
        opener = opener[:opener.index("receive(")]
        self.assertIn("socket.close()", opener)

    def test_the_failure_cause_is_probed_not_guessed(self):
        """
        Two causes, opposite fixes, indistinguishable at the socket.

        The first version of this diagnosis asserted a single cause — "something
        else is holding it, run pkill" — and that was measured wrong. The common
        cause is a stale browser id, whose fix is to re-enable the toggle; telling
        someone to kill a process they do not have running is a confidently wrong
        instruction, which is worse than "timed out".

        Neither cause can be told apart from the websocket: a dead id produces no
        event at all (no open, no close, no error) and a busy endpoint hangs
        identically. A plain GET on the websocket's own path separates them — 404
        for an unknown id, 426 for a live path refusing a second client — so the
        message is derived from a probe rather than an assumption.
        """
        source = code(CDP_PATH)
        self.assertIn("async function diagnose", source)
        self.assertIn("=== 404", source)
        self.assertIn("=== 426", source)
        # And the probe must happen after the socket is released, or the probe is
        # itself the second client on a one-client endpoint.
        #
        # Anchored on the method DEFINITION (`\n  receive(event) {`), not on
        # `receive(` — the constructor's `this.receive(event)` comes first in the
        # file, and slicing to it produced an invalid range rather than a failure
        # that said so.
        opener = source[source.index("static async open"):source.index("\n  receive(event) {")]
        self.assertLess(
            opener.index("socket.close()"), opener.index("diagnose(ws)"),
            "the diagnosis probe runs before the socket is released",
        )

    def test_a_stale_browser_id_is_named_as_such(self):
        """
        Measured: a session enabled at 20:42 was dead by 21:19, with the port still
        bound and Chrome up 12 hours. Chrome 144+'s toggle is scoped to a debugging
        session, so `DevToolsActivePort` outlives the id it names — which presents
        as a live endpoint that silently ignores you.
        """
        source = code(CDP_PATH)
        self.assertIn("STALE", source)
        self.assertIn("chrome://inspect", source)

    def test_a_busy_endpoint_is_still_diagnosed(self):
        # Verified live by holding the socket deliberately: fails in 9s and names
        # chrome-devtools-mcp, which is started implicitly by any Chrome MCP call.
        source = code(CDP_PATH)
        self.assertIn("takes one at a time", source)
        self.assertIn("pkill -f chrome-devtools-mcp", source)


class ScrollTests(unittest.TestCase):
    """
    X virtualises the timeline, so one read is one screenful.

    Measured on the signed-in home feed: a single read returns 5 posts because that
    is what fits the viewport — articles scrolled out of view are removed from the
    DOM entirely. A single read of a long timeline therefore returns 5 and looks
    like a working scan. Accumulating across scrolls took the same signed-in
    `robtFPL` profile from 5 posts to 18.
    """

    def test_it_accumulates_across_scrolls(self):
        source = code(CDP_PATH)
        self.assertIn("scrollBy", source)
        self.assertIn("merged", source)

    def test_it_merges_by_status_id_not_by_index(self):
        # Overlapping reads return the same post repeatedly; positional merging
        # would duplicate some and drop others.
        self.assertIn("merged.has(post.status_id)", code(CDP_PATH))

    def test_the_scroll_count_is_bounded(self):
        """
        A timeline has no end.

        CLAUDE.md forbids an unbounded fetch loop against the odds API for exactly
        this reason, and the reasoning does not stop at that one provider. The bound
        also has a natural size: `to_items` discards anything older than
        `X_SCAN_MAX_AGE_DAYS`, so scrolling past that window reads posts the ingest
        throws away.
        """
        source = code(CDP_PATH)
        self.assertRegex(source, r"const SCROLLS = \d+")
        scrolls = int(re.search(r"const SCROLLS = (\d+)", source).group(1))
        self.assertGreater(scrolls, 0)
        self.assertLessEqual(scrolls, 50, "an effectively unbounded scroll loop")


class ScanWiringTests(unittest.TestCase):
    def test_the_attached_path_does_not_use_playwright(self):
        """
        Playwright cannot drive this mode.

        Measured: `connectOverCDP` on the port-file websocket connects and then
        times out after 30s, because its handshake needs browser-context management,
        which the toggle refuses — against another endpoint the same call reported
        `Protocol error (Browser.setDownloadBehavior): Browser context management is
        not supported`. The launched path still uses Playwright, which is correct:
        there it owns the browser.
        """
        source = code(SCAN_PATH)
        attached = source[source.index("if (attached) {"):source.index("} else {")]
        self.assertNotIn("playwright", attached)
        self.assertNotIn("connectOverCDP", attached)
        self.assertIn("x_cdp.mjs", attached)

    def test_the_launched_path_still_uses_playwright(self):
        source = code(SCAN_PATH)
        self.assertIn("chromium.launch", source)

    def test_it_exits_rather_than_hanging(self):
        """
        A live websocket holds node's event loop open.

        An earlier version finished its work and then hung until a five-minute
        timeout killed it, which in CI burns the whole job rather than failing it.
        """
        self.assertIn("if (attached) process.exit(0);", code(SCAN_PATH))

    def test_a_signed_out_read_says_so_instead_of_blaming_the_selectors(self):
        """
        Measured: signed out, `x.com/home` returns HTTP 200 with the marketing page
        and no `article` elements. Indistinguishable from "the markup changed"
        unless the login wall is detected, and the two point at opposite fixes.
        Exit 5 rather than 4 so a caller can tell them apart too.
        """
        source = code(SCAN_PATH)
        self.assertIn("NOT SIGNED IN", source)
        self.assertIn("process.exit(5)", source)

    def test_the_extractor_reports_the_sign_in_state(self):
        # Read in the extractor because both callers need it and that is the only
        # file which touches the DOM.
        extractor = code(
            Path(__file__).resolve().parents[1] / "data" / "x_extract.js"
        )
        self.assertIn("signedOut", extractor)
        self.assertIn("auth_token", extractor)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
