/**
 * The service worker's precache list against the routes that actually exist.
 *
 * `sw.js` installs with `cache.addAll(SHELL_ROUTES)`, and **`addAll` is
 * all-or-nothing**: if any one entry 404s the returned promise rejects, the
 * `install` event fails, and the worker never activates. So a renamed or deleted
 * route does not degrade the offline experience — it disables it entirely, on
 * every visitor, silently.
 *
 * That makes this a guard for the screen rebuild rather than a nicety: the whole
 * point of the next step is renaming routes, and nothing else in the repo connects
 * `sw.js` to `app/`.
 *
 * Deliberately checked against the filesystem rather than against a hand-written
 * list. A second list would need the same maintenance as the first and would rot
 * the same way.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = join(__dirname, "..", "..");
const APP = join(FRONTEND, "app");
const PUBLIC = join(FRONTEND, "public");

const swSource = readFileSync(join(PUBLIC, "sw.js"), "utf8");

/** The literal array the worker precaches. */
function shellRoutes(): string[] {
  const match = swSource.match(/const SHELL_ROUTES = \[([\s\S]*?)\];/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every route the App Router actually serves, as URL paths. */
function realRoutes(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Route groups `(x)` do not appear in the URL; private `_x` are not routes.
      if (entry.name.startsWith("_")) continue;
      const segment = entry.name.startsWith("(") ? "" : `/${entry.name}`;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "page.tsx"))) {
        found.push(`${prefix}${segment}` || "/");
      }
      walk(child, `${prefix}${segment}`);
    }
  };
  if (existsSync(join(APP, "page.tsx"))) found.push("/");
  walk(APP, "");
  return found;
}

const SHELL = shellRoutes();
const ROUTES = realRoutes();

describe("the precache list parses", () => {
  it("finds SHELL_ROUTES", () => {
    // If the array is renamed or reformatted every assertion below goes vacuous,
    // so the parse itself is asserted.
    expect(SHELL.length).toBeGreaterThan(0);
    expect(SHELL).toContain("/");
  });

  it("finds the app's real routes", () => {
    // More than one, so the walker is proven to recurse rather than to have found
    // only `app/page.tsx`. The exact count is not asserted here — the allow-list in
    // `test/nav-coverage.test.tsx` owns it, and it is five.
    expect(ROUTES.length).toBeGreaterThan(1);
    expect(ROUTES).toContain("/");
  });
});

describe("every precached route exists", () => {
  const pageRoutes = SHELL.filter((r) => !r.includes("."));

  for (const route of pageRoutes) {
    it(`${route} is a real page`, () => {
      expect(
        ROUTES,
        `sw.js precaches ${route}, which app/ does not serve. cache.addAll is ` +
        `all-or-nothing: this one 404 makes the install event reject and the ` +
        `service worker never activates, disabling offline support entirely.`,
      ).toContain(route);
    });
  }

  it("precaches at least the home route", () => {
    expect(pageRoutes).toContain("/");
  });
});

describe("every precached asset exists on disk", () => {
  const assets = SHELL.filter((r) => r.includes("."));

  for (const asset of assets) {
    it(`${asset} is present in public/`, () => {
      const path = join(PUBLIC, asset.replace(/^\//, ""));
      expect(
        existsSync(path),
        `sw.js precaches ${asset}, which is not in public/. Same all-or-nothing ` +
        `failure as a missing route.`,
      ).toBe(true);
    });
  }

  it("checks a non-trivial number of assets", () => {
    expect(assets.length).toBeGreaterThan(0);
  });
});

describe("the offline fallback is reachable", () => {
  it("/offline is both a real page and precached", () => {
    // The one route whose absence is self-defeating: without it the worker has
    // nothing to serve when the network is gone.
    expect(ROUTES).toContain("/offline");
    expect(SHELL).toContain("/offline");
  });
});

describe("h2h-events stay out of the precache", () => {
  /**
   * 282 files, 4.6MB. They are correctly served as static CDN assets from
   * `public/` and fetched one ~17KB file at a time on demand.
   *
   * Precaching them would download the whole set on first visit, and — because
   * `addAll` is atomic — a single missing pair would break installation. This
   * asserts the current, correct behaviour so nobody "improves" it later.
   */
  it("the precache list names no h2h-event file", () => {
    expect(SHELL.some((r) => r.includes("h2h-events"))).toBe(false);
  });

  it("the precache list stays small enough to install on a phone", () => {
    // A shell, not a mirror of the site.
    expect(SHELL.length).toBeLessThan(40);
  });
});

describe("dynamic routes are not precached", () => {
  it("no precached route contains a route parameter", () => {
    // `/matches/[id]` is not a URL; precaching the literal string would 404.
    for (const route of SHELL) {
      expect(route).not.toContain("[");
      expect(route).not.toContain("]");
    }
  });
});

describe("the shell caches the app that exists now", () => {
  /**
   * The precache list decides what an installed app shows WHEN OFFLINE.
   *
   * Navigations are network-first (`sw.js` bottom: fetch, cache a copy, reach for
   * the cache only in the `.catch`), so this list is the offline fallback rather
   * than what an online visitor sees. It has been wrong in both directions: it
   * once listed `/markets` and `/matches` while omitting the page the root opens
   * on, so an offline PWA fell back to a previous shape of the app.
   *
   * The route surface is now five pages and the list is all five of them, so the
   * "which of many routes deserve the install budget" assertions that used to sit
   * here — `/margin` and `/bet` had to be present, both now deleted — have no
   * subject left. What remains is the direction that can still go wrong: naming a
   * route that does not exist, which `every precached route exists` above catches,
   * and shipping a stale list under an unchanged cache key, which is below.
   */
  const routes = shellRoutes();

  it("precaches every page the app serves", () => {
    // Five routes fit an install budget whole, so an offline visitor gets the
    // whole app rather than a chosen subset of it. This is only affordable
    // because the surface is small; see `stays small enough to install` above.
    for (const route of ROUTES) expect(routes).toContain(route);
  });

  it("names no route the app no longer serves", () => {
    // The 23 deleted routes are the failure mode this guards: `addAll` is atomic,
    // so one leftover entry precaches NOTHING on every installed app.
    for (const route of routes.filter((r) => !r.includes("."))) {
      expect(ROUTES, `sw.js precaches ${route}, which app/ does not serve`)
        .toContain(route);
    }
  });

  it("bumps the cache name when the list changes", () => {
    /**
     * The cache key is the only thing that evicts a stale precached copy, and the
     * activate handler deletes every cache whose key is not `CACHE_NAME`.
     *
     * This assertion is a tripwire, not a proof. Pinning the literal means a
     * bump cannot happen silently — you must come here and say why — but it
     * cannot tell whether a bump was NEEDED. That judgement stays human.
     *
     * v9 -> v10 is for the list: `/phases` and `/stats` are new. A v9 cache holds
     * an app whose nav links two pages it cannot open, which offline reads as the
     * app being broken rather than as pages missing.
     *
     * The earlier v8 -> v9 bump was for two pages ON the list changing in ways a
     * stale offline copy misleads with: `/` gained the app's only link to
     * `/capture`, so a v8 copy is the version of the front door with no route to
     * the write path; and `/capture` began capturing for entry 20945 instead of
     * offering the two entries that detached, so a v8 copy goes on posting
     * captures nothing reads.
     *
     * The earlier v7 -> v8 bump was for the list itself: `/margin`, `/bet`, `/now`,
     * `/decide` and `/accuracy` were deleted, so a v7 precache held five pages
     * that no longer exist.
     *
     * The earlier v6 -> v7 bump was for the same class of reason: `/` had stopped
     * being a 307 redirect to `/margin`, and a v6 precache still held the
     * redirect. Neither bump explains the once-reported stale `/` — the navigation
     * handler is and was network-first — and that report was never diagnosed.
     */
    expect(swSource).toContain("suca-fpl-shell-v10");
  });
});
