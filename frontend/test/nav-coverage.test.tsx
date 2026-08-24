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
    const nav = readFileSync(NAV, "utf8");
    const linked = [...nav.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
    expect([...new Set(linked)].sort()).toEqual([...IN_NAV].sort());
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
