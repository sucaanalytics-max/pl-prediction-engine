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
 * Usage:
 *   node scripts/x_scan.mjs robtFPL /tmp/scan.json
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

const browser = await chromium.launch({
  channel: "chrome",           // the installed Chrome, not a downloaded Chromium
  headless: true,
});

let posts = [];
try {
  const context = await browser.newContext({
    // A real viewport and locale: the logged-out view is what we want, but a
    // headless default fingerprint gets served differently often enough to matter.
    viewport: { width: 1280, height: 1600 },
    locale: "en-GB",
  });
  const page = await context.newPage();
  await page.goto(`https://x.com/${handle}`, {
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
  writeFileSync(outPath, JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

// Zero posts means X changed its markup or refused this client. Say so loudly and
// exit non-zero: a scraper that silently returns nothing while reporting success
// is the failure mode this whole route was built to avoid.
if (posts.length === 0) {
  console.error(
    `x_scan: read 0 posts from @${handle}. Either the markup changed or the ` +
      `request was refused. NOT writing an empty inbox — investigate before ` +
      `changing selectors.`,
  );
  process.exit(4);
}

console.log(`x_scan: read ${posts.length} post(s) from @${handle}`);
