/**
 * Every built route is reachable, or explicitly not.
 *
 * ## The measured defect
 *
 * **Thirteen of twenty-two routes were unreachable from the sidebar.**
 * `/transfers`, `/optimizer`, `/captaincy`, `/rankings`, `/planner`, `/projections`,
 * `/intelligence`, `/table`, `/matches`, `/value-bets`, `/decisions`, `/accuracy`
 * and `/h2h` were all built, tested, deployed — and linked from nowhere.
 *
 * The consequence was not a broken link, which someone would have reported. It was
 * that the app looked far emptier than it was, and the pages carrying the most FPL
 * value were the ones you could not get to. That is invisible to every kind of test
 * this repo had: each page passed its own suite while being unreachable.
 *
 * ## Why an allow-list rather than "every route must be linked"
 *
 * Some routes legitimately are not nav destinations — `/offline` is served by the
 * service worker, and a dynamic segment is reached from its index. Those are named
 * with a reason, so the list of exceptions is short, visible, and has to be argued
 * for rather than accumulated.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP = join(process.cwd(), "app");
const NAV = join(process.cwd(), "components", "Navigation.tsx");
const BET_INDEX = join(APP, "bet", "page.tsx");

/** Routes that exist but are deliberately not in the sidebar. */
const NOT_IN_NAV: Record<string, string> = {
  offline: "served by the service worker when a fetch fails; not a destination",
  api: "route handlers, not pages",
};

/**
 * The betting screens, which are destinations but not FPL ones.
 *
 * These are NOT in `NOT_IN_NAV`, and the difference matters. That list means
 * "not a destination" — a service-worker fallback, a route handler. These four
 * are real pages a reader visits; they simply reach them through `/bet` rather
 * than the FPL sidebar, because they answer what to stake rather than who to
 * pick and they were crowding out the screens this app is for.
 *
 * Excusing them with a sentence would recreate the exact defect this file
 * exists for — thirteen routes linked from nowhere, invisible to every test —
 * so the excuse comes with an obligation, asserted below: the betting index
 * must actually link every route that claims it.
 */
const BEHIND_BETTING_INDEX = new Set(["markets", "bankroll", "matches", "h2h"]);

/**
 * Whether a route is a redirect stub rather than a real destination.
 *
 * Eight of this app's routes exist only to keep bookmarks and the service worker
 * working after a page was superseded: /transfers, /captaincy, /optimizer and
 * /planner all redirect to /decide; /rankings and /projections to /players.
 *
 * The first version of this test only asked whether a route EXISTED, so listing all
 * of them passed — and produced a sidebar with four "Decide" entries that landed on
 * the same page. A nav that promises variety and delivers one screen is its own kind
 * of empty.
 */
function isRedirect(route: string): boolean {
  const file = join(APP, route, "page.tsx");
  if (!existsSync(file)) return false;
  return /\bredirect\(/.test(readFileSync(file, "utf8"));
}

/** Top-level route segments that have a page. */
function builtRoutes(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("_") && !entry.name.startsWith("("))
    .filter((entry) => {
      // A directory is a route only if it renders something. A folder holding a
      // dynamic child (`matches/[id]`) still counts via its own page when present.
      const dir = join(APP, entry.name);
      return ["page.tsx", "page.ts", "route.ts"].some((f) => existsSync(join(dir, f)))
        || entry.name === "api";
    })
    .map((entry) => entry.name);
}

function navHrefs(): string[] {
  const source = readFileSync(NAV, "utf8");
  return [...source.matchAll(/href:\s*"(\/[a-z0-9-]*)"/g)].map((m) => m[1]);
}

describe("navigation covers what is built", () => {
  const routes = builtRoutes();
  const linked = new Set(navHrefs());

  it("finds routes to check at all", () => {
    // Guards against the directory read silently returning nothing, which would
    // make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(10);
  });

  it("finds nav links to check at all", () => {
    /**
     * Guards against the regex silently matching nothing, which would make every
     * assertion below vacuous.
     *
     * Was `> 10`, chosen when the sidebar carried thirteen links. Splitting the
     * betting screens behind `/bet` took it to ten and turned this sanity check
     * into a failure about a change it was never watching for. Five keeps it
     * catching the real fault — a broken read returning nothing — without
     * pinning a count that moves whenever the nav is edited.
     */
    expect(linked.size).toBeGreaterThan(5);
  });

  for (const route of builtRoutes()) {
    it(`/${route} is reachable or explained`, () => {
      if (route in NOT_IN_NAV) {
        expect(NOT_IN_NAV[route].length).toBeGreaterThan(10);
        return;
      }
      if (isRedirect(route)) {
        // A stub kept for bookmarks. It must NOT be in the nav — see below.
        return;
      }
      if (BEHIND_BETTING_INDEX.has(route)) {
        // Reachability is still required, just from the other door.
        expect(
          readFileSync(BET_INDEX, "utf8"),
          `/${route} is excused from the sidebar as a betting screen but the ` +
            `betting index does not link it, so it is reachable from nowhere.`,
        ).toContain(`"/${route}"`);
        return;
      }
      expect(
        linked.has(`/${route}`),
        `/${route} is a real page linked from nowhere. Add it to NAV_GROUPS, or to ` +
          `NOT_IN_NAV with a reason. Thirteen routes were unreachable this way and ` +
          `no test could see it.`,
      ).toBe(true);
    });
  }

  it("links no redirect stub", () => {
    /**
     * The over-correction, pinned.
     *
     * Restoring every built route to the sidebar put eight redirect stubs in it:
     * four entries under "Decide" that all landed on /decide, and two under
     * "Research" that both landed on /players. The routes still exist so bookmarks
     * and the service worker keep working; they are not destinations.
     */
    const stubs = [...linked]
      .map((href) => href.slice(1))
      .filter((route) => route && isRedirect(route));
    expect(
      stubs,
      "these nav entries redirect elsewhere, so the sidebar promises pages it does " +
        "not have",
    ).toEqual([]);
  });

  it("links no route that does not exist", () => {
    // The other direction: a nav entry pointing at a deleted page is a 404 the
    // reader finds before we do.
    const built = new Set(routes.map((r) => `/${r}`));
    const dangling = [...linked].filter((href) => href !== "/" && !built.has(href));
    expect(dangling, "nav links with no page behind them").toEqual([]);
  });
});

describe("the sidebar stays in scope", () => {
  it("does not link the other-sports dashboard", () => {
    /**
     * CLAUDE.md rule 7: the F1, darts and other-sport providers are out of scope for
     * this repo. A prominent sidebar card pointing at them made a single-purpose FPL
     * tool look like a sports portal, on a page whose own content was empty.
     */
    const source = readFileSync(NAV, "utf8");
    expect(source).not.toContain("Other sports");
    expect(source).not.toContain("F1 · Darts · Cricket");
  });

  it("keeps the betting screens out of the FPL sidebar", () => {
    /**
     * The other direction of the split. Re-adding one of these is a one-line
     * change that would look harmless in review and would quietly undo it, so
     * the boundary is pinned rather than left to memory.
     */
    const linked = new Set(navHrefs());
    const leaked = [...BEHIND_BETTING_INDEX].filter((r) => linked.has(`/${r}`));
    expect(
      leaked,
      "these answer what to stake, not who to pick, and belong behind /bet",
    ).toEqual([]);
  });

  it("still offers a way into the betting screens", () => {
    // Splitting them out must not strand them: one door, and it has to be here.
    expect(navHrefs()).toContain("/bet");
  });

  it("labels destinations by the question, not the subsystem", () => {
    // "Player Lab" and "Match Models" named our architecture. A reader looking for
    // players does not know they want a lab.
    const source = readFileSync(NAV, "utf8");
    expect(source).not.toContain('label: "Player Lab"');
    expect(source).not.toContain('label: "Match Models"');
  });
});
