/**
 * The route surface is an allow-list, and the nav reaches all of it.
 *
 * ## Why this is a test and not a convention
 *
 * Three specs — 2026-08-11, 08-17, 08-18 — each prescribed deleting superseded
 * surfaces. None was executed; the 08-18 one specified the cut line by line and
 * two MORE routes were added after it was written. The tree's own docstrings named
 * the reason: "rescue precedes deletion… so the two surfaces can be compared
 * before anything is destroyed." The comparison never concluded.
 *
 * Intent has now lost three times, so this is the enforcer. A 24th route is a red
 * build, and the rescue half of that principle is preserved in
 * `test/rescued-mounts.test.tsx`, which runs before any deletion.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(process.cwd(), "app");
const NAV = join(process.cwd(), "components", "Navigation.tsx");
/**
 * The phone nav, held to the same allow-list as the sidebar.
 *
 * It is mounted app-wide in `app/layout.tsx` and was NOT covered when this file was
 * first rewritten, which is precisely the condition that let it rot: it listed five
 * tabs of which `/optimizer`, `/projections` and `/captaincy` were redirect stubs —
 * two of them landing on the same page — and the 2026-08-18 spec's stated reason for
 * deleting the component outright was that this was "guarded by no test". Two navs
 * that agree today and drift silently tomorrow is the same defect one level down.
 */
const BOTTOM_NAV = join(process.cwd(), "components", "MobileBottomNav.tsx");

/** Every page route this app is allowed to have, and why it exists. */
const ALLOWED: Record<string, string> = {
  ".": "the call: XI, captain, and the horizon",
  players: "the shortlist, with the spread on each candidate",
  evidence: "what moved, and whether to believe it",
  capture: "the position: squad, bank, purchase prices — reached from /, not the nav",
  offline: "served by the service worker when a fetch fails; not a destination",
};

/** Routes reached from the nav. `capture` and `offline` deliberately are not. */
const IN_NAV = ["/", "/players", "/evidence"];

/**
 * Destinations a nav component lists, read from its item array.
 *
 * Matches `href: "/x"` — the array literal — and not `href={item.href}` in the JSX,
 * so this asserts WHAT is linked and survives any restyle of the markup.
 */
function destinations(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const linked = [...source.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
  return [...new Set(linked)].sort();
}

/**
 * Pages whose source links a given href.
 *
 * Matches the JSX attribute — `href="/capture"` — rather than the `href: "/x"`
 * object form the navs use, because a page links directly.
 */
function pagesLinking(href: string): string[] {
  return Object.keys(ALLOWED)
    .map((route) => ({
      route,
      path: route === "." ? join(APP, "page.tsx") : join(APP, route, "page.tsx"),
    }))
    .filter(({ path }) => readFileSync(path, "utf8").includes(`href="${href}"`))
    .map(({ route }) => route);
}

function routeDirs(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "api")
    .map((e) => e.name);
}

describe("route allow-list", () => {
  it("has exactly the allowed routes and no others", () => {
    const found = routeDirs().sort();
    const allowed = Object.keys(ALLOWED).filter((r) => r !== ".").sort();
    expect(found).toEqual(allowed);
  });

  it("every allowed route is actually built", () => {
    for (const route of Object.keys(ALLOWED)) {
      const path = route === "."
        ? join(APP, "page.tsx")
        : join(APP, route, "page.tsx");
      expect(() => readFileSync(path, "utf8"), `${route} must exist`).not.toThrow();
    }
  });

  it("contains no redirect stubs", () => {
    // Nine of these existed, four pointing at the same page. A stub is how a
    // deleted surface comes back as a nav entry that promises variety.
    for (const route of routeDirs()) {
      const source = readFileSync(join(APP, route, "page.tsx"), "utf8");
      expect(source, `${route} must not be a redirect`).not.toContain(
        'from "next/navigation"',
      );
    }
  });

  it("the nav links exactly the three destinations", () => {
    expect(destinations(NAV)).toEqual([...IN_NAV].sort());
  });

  it("the phone nav lists the same destinations as the sidebar", () => {
    // Not "three items" — the same SET. Two navs over one route surface may differ
    // in order, icon and label; a destination one of them can reach and the other
    // cannot is a defect in whichever is wrong, and there is no way to tell which.
    expect(destinations(BOTTOM_NAV)).toEqual(destinations(NAV));
  });

  it("neither nav links a route outside the allow-list", () => {
    // The assertion that would have caught `/optimizer`, `/projections` and
    // `/captaincy` sitting in the phone nav after the routes behind them were
    // deleted. Checked per nav rather than through the set comparison above,
    // because two navs can agree with each other and both be wrong.
    for (const [label, file] of [["sidebar", NAV], ["phone nav", BOTTOM_NAV]] as const) {
      for (const href of destinations(file)) {
        const name = href === "/" ? "." : href.replace(/^\//, "");
        expect(ALLOWED, `the ${label} links ${href}, which is not an allowed route`)
          .toHaveProperty(name);
      }
    }
  });

  it("has a surviving page linking /capture, since the navs deliberately do not", () => {
    /**
     * The half of the rule that was missing, and the gap it left.
     *
     * Every assertion here was about what the navs must NOT link, and `/capture`
     * is excluded from them by design — so when its nav entry was removed, the
     * suite stayed green with the route reachable only by typing the URL. Both
     * `ALLOWED` above and `components/Navigation.tsx` claimed it was "reached
     * from /" while nothing in the tree linked it at all.
     *
     * "At least one page" rather than a named one: the spec puts the link on `/`,
     * beside the squad, and that is where it is — but a route that is reachable
     * from somewhere is the property worth enforcing, and pinning the page would
     * make moving the link a test edit rather than a design decision.
     */
    expect(pagesLinking("/capture")).not.toEqual([]);
  });

  it("mounts both navs, so neither guard above can pass vacuously", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(layout).toContain("<Navigation />");
    expect(layout).toContain("<MobileBottomNav />");
  });

  it("the nav has no groups", () => {
    // Four groups over twelve destinations is what pushed the FPL screens below
    // the fold. Three flat items need no grouping.
    expect(readFileSync(NAV, "utf8")).not.toContain("NAV_GROUPS");
  });

  it("the service worker precaches only routes that exist", () => {
    const sw = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
    const routes = [...sw.matchAll(/^\s*"(\/[a-z-]*)",/gm)].map((m) => m[1]);
    for (const route of routes) {
      const name = route === "/" ? "." : route.slice(1);
      expect(ALLOWED, `sw.js precaches ${route}`).toHaveProperty(name);
    }
  });
});
