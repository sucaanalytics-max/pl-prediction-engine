/**
 * Headless X profile scan.
 *
 * ## Why a browser, and why not Claude
 *
 * The logged-out profile is a JavaScript app shell: `curl` returns 204KB with no
 * status ids and no post text, so a plain HTTP fetch — the thing the poller could
 * have done from CI — cannot work. Measured, not assumed.
 *
 * A Claude Code session CAN read it through the Chrome MCP, and that is how the
 * route was proven. But the scan is fully deterministic — navigate, run fixed
 * JavaScript, hand the JSON to a Python CLI — so putting a language model in the
 * loop would burn tokens on every run to do nothing a script cannot.
 *
 * ## Why the system Chrome
 *
 * `channel: "chrome"` drives the Chrome already installed rather than downloading
 * Playwright's own Chromium, which saves ~400MB. It also means the scan runs from
 * the same residential IP that was verified to work; X serves datacenter ranges
 * differently, and this has never been tested from one.
 *
 * ## Output
 *
 * Raw JSON to the path given, in exactly the shape `pipeline/data/x_scan.py`
 * expects. It derives nothing — no timestamps, no tier, no text cleaning. All of
 * that happens in Python, where it is tested.
 *
 * ## Attaching to a logged-in browser
 *
 * Everything above describes the logged-OUT route, which is all this script could
 * do at first. That route is capped hard: the profile page serves five posts and
 * `x.com/home` redirects to a login wall, so "read my feed" was not expressible.
 *
 * `X_SCAN_BROWSER_URL` changes that. Point it at a Chrome already running with
 * remote debugging on (`http://127.0.0.1:9222`) and this connects over CDP and
 * reuses **that browser's existing context**, cookies included — so it reads the
 * feed as the signed-in user. Two things about this are easy to get wrong:
 *
 *   * It reuses `browser.contexts()[0]`, NOT `newContext()`. A fresh context in an
 *     attached browser has an empty cookie jar, so it would silently be logged out
 *     and this whole path would achieve nothing while appearing to work.
 *   * It opens its own tab, closes only that tab, and never calls
 *     `browser.close()`. Playwright's types make `close()` on a connected browser
 *     sound safe; measured against a live endpoint it left **0 targets**, having
 *     closed a tab that existed before the scan. On the user's own Chrome that is
 *     their session. No tab they were reading is ever navigated either.
 *
 * Usage:
 *   node scripts/x_scan.mjs robtFPL /tmp/scan.json
 *   X_SCAN_BROWSER_URL=http://127.0.0.1:9222 node scripts/x_scan.mjs home /tmp/feed.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACT_PATH = resolve(HERE, "..", "pipeline", "data", "x_extract.js");

/** How long to let the app shell hydrate before reading the DOM. */
const RENDER_WAIT_MS = 4000;
const NAV_TIMEOUT_MS = 45000;

const [handle, outPath] = process.argv.slice(2);
if (!handle || !outPath) {
  console.error("usage: node scripts/x_scan.mjs <handle> <output.json>");
  process.exit(2);
}

// The one copy, shared with x_scan.py. Loading it rather than inlining it is what
// stops the two callers drifting apart silently.
const source = readFileSync(EXTRACT_PATH, "utf8");
const extractSource = source.slice(source.indexOf("() =>")).trim();

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed. Run: npm --prefix scripts install playwright",
  );
  process.exit(3);
}

// Locally: drive the installed Chrome, so nothing is downloaded and the request
// comes from the same residential IP that was verified to work.
//
// In CI there is no system Chrome, so `X_SCAN_CHANNEL=chromium` selects
// Playwright's own build. Whether X serves a GitHub runner's datacenter IP at all
// is a separate question, and the reason that path is measured before it is used.
const browserUrl = process.env.X_SCAN_BROWSER_URL || "";
const attached = Boolean(browserUrl);

const channel = process.env.X_SCAN_CHANNEL || "chrome";
const browser = attached
  ? await chromium.connectOverCDP(browserUrl)
  : await chromium.launch({
      ...(channel === "chromium" ? {} : { channel }),
      headless: true,
    });

let posts = [];
let page;
let signedOut = false;
try {
  let context;
  if (attached) {
    // The signed-in context, which is the entire point of attaching. `newContext`
    // here would be a fresh, empty cookie jar — logged out, and silently so.
    context = browser.contexts()[0];
    if (!context) {
      throw new Error(
        `connected to ${browserUrl} but it exposes no browser context — ` +
          `nothing to read`,
      );
    }
  } else {
    context = await browser.newContext({
      // A real viewport and locale: the logged-out view is what we want, but a
      // headless default fingerprint gets served differently often enough to matter.
      viewport: { width: 1280, height: 1600 },
      locale: "en-GB",
    });
  }
  page = await context.newPage();

  // `home` is the signed-in timeline; anything else is a profile. Logged out,
  // `/home` is a login wall, which is why this only makes sense when attached.
  const target = handle === "home"
    ? "https://x.com/home"
    : `https://x.com/${handle}`;
  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });

  // Wait for at least one article rather than a fixed sleep where possible; fall
  // back to the sleep, because a profile with no posts legitimately has none and
  // must not fail the run.
  await page
    .waitForSelector("article", { timeout: RENDER_WAIT_MS })
    .catch(() => {});

  // Wrapped as an immediately-invoked expression. Passing the bare arrow-function
  // source made `evaluate` treat it as an expression whose VALUE is the function,
  // so it returned undefined and the write crashed on it — the function was never
  // called. The MCP path takes a function directly, which is why this only
  // surfaced here.
  const result = await page.evaluate(`(${extractSource})()`);
  if (!result || !Array.isArray(result.posts)) {
    throw new Error(
      `extractor returned ${JSON.stringify(result)} — expected { handle, posts }`,
    );
  }
  posts = result.posts;

  // Did we actually land on a signed-in page? Recorded before teardown, so the
  // zero-post message below can name the real cause instead of guessing.
  //
  // Measured: logged out, `x.com/home` does not error — it serves the marketing
  // page, which has zero `article` elements. That is indistinguishable from "the
  // markup changed" unless the login wall is detected explicitly, and the two
  // send you to completely different places.
  signedOut = await page
    .evaluate(() => !document.cookie.includes("auth_token")
      && /Continue with|Sign in to X|Happening now/.test(document.body.innerText))
    .catch(() => false);

  writeFileSync(outPath, JSON.stringify(result, null, 2));
} finally {
  if (attached) {
    // Close ONLY the tab this script opened, and never call `browser.close()`.
    //
    // Playwright's types say `close()` on a connected browser "clears all created
    // contexts belonging to this browser and disconnects from the browser server",
    // which reads as safe — the borrowed context was not created by us. MEASURED,
    // it is not: after a run that called it, the debug endpoint reported **0
    // targets**, meaning the tab that existed before the scan had been closed too.
    // Against a real browser that is the user's session gone.
    //
    // The first check for this was too weak to catch it — it curled
    // `/json/version` and saw Chrome still running, which tests the process and
    // not the tabs. `/json/list` is the check that shows the damage.
    //
    // Dropping the websocket by letting the process exit is sufficient teardown,
    // and it cannot touch anything the user had open.
    await page?.close().catch(() => {});
  } else {
    // A browser we launched, so this really does quit it.
    await browser.close();
  }
}

// Zero posts means X changed its markup or refused this client. Say so loudly and
// exit non-zero: a scraper that silently returns nothing while reporting success
// is the failure mode this whole route was built to avoid.
//
// The signed-out case is called out separately because the generic message points
// at the wrong fix. Logged out, `x.com/home` returns the marketing page — no error,
// no articles — so "investigate the selectors" is exactly the wrong instruction
// when the actual answer is one login.
if (posts.length === 0) {
  if (signedOut) {
    console.error(
      `x_scan: read 0 posts from @${handle} because the browser is NOT SIGNED IN ` +
        `to X. The selectors are fine.\n` +
        (attached
          ? `The Chrome at ${browserUrl} has no X session. Sign in there once — ` +
            `its profile persists, so later scans will see the feed.`
          : `A launched browser is always signed out, and the home timeline needs ` +
            `a session. Set X_SCAN_BROWSER_URL to a signed-in Chrome running with ` +
            `remote debugging, or scan a profile handle instead of "home".`),
    );
    process.exit(5);
  }
  console.error(
    `x_scan: read 0 posts from @${handle}. Either the markup changed or the ` +
      `request was refused. NOT writing an empty inbox — investigate before ` +
      `changing selectors.`,
  );
  process.exit(4);
}

console.log(`x_scan: read ${posts.length} post(s) from @${handle}`);

// An attached run must exit explicitly.
//
// `browser.close()` is what normally lets node's event loop drain, and this path
// deliberately does not call it (see the teardown above — measured, it closes tabs
// the user already had open). The live CDP websocket then holds the loop open and
// the script hangs forever instead of finishing: the first version of this did
// exactly that, and a five-minute timeout was the only thing that surfaced it.
//
// Everything observable is already done — the JSON was written before teardown and
// the count is printed above — so forcing the exit drops the socket and loses
// nothing. The failure paths above already exit explicitly for the same reason.
if (attached) process.exit(0);
