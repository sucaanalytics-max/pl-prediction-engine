/**
 * The nine paths the new front page is meant to absorb still work.
 *
 * ## Why this file exists before the deletion, not after
 *
 * `/` now renders the call directly. The design it implements retires nine paths
 * into it — `/now`, `/margin?view=plan`, `/decide`, `/decisions`, `/optimizer`,
 * `/captaincy`, `/planner`, `/transfers`, `/intelligence` — but retiring them is a
 * later commit, deliberately separate, so the owner can compare the two surfaces
 * and equivalence can be argued from something other than intent.
 *
 * That separation only means anything if it is enforced. This repo has already
 * been bitten by the other order: two table components that no route rendered
 * held the only links to a 612-line match page, and deleting the components
 * stranded the page. Rescue precedes deletion, and "still reachable" is a claim a
 * test should make rather than a commit message.
 *
 * ## What each assertion is worth
 *
 * - **Every one of the nine imports and exports a component.** Cheap, and it is
 *   the failure mode a refactor of shared components actually produces: a prop
 *   made required, an export renamed, a module that now throws on load. Nine
 *   routes' worth of that, caught at once.
 * - **The five redirect stubs still point somewhere that exists.** A stub whose
 *   target has gone is a bookmark that 404s, and the service worker precaches
 *   several of these.
 * - **`/now` still renders its headline content**, for real, against a stubbed
 *   fetch. `/now` is the route the new page most nearly duplicates, so it is the
 *   one worth a render rather than a smoke test.
 * - **The route tests for `/now`, `/margin` and `/decide` still exist.** All three
 *   have their own suites that render them and assert their headlines; this pins
 *   that those suites have not quietly been deleted along the way, which is the
 *   only way their guarantee could evaporate while this file stayed green.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REGISTRY } from "@/lib/data/narrow";

/**
 * Static imports, one per path, rather than a template-literal `import()`.
 *
 * A dynamic specifier would make the set of routes under test invisible to a
 * reader and to the bundler, and this file's entire job is to name them.
 */
const ABSORBED: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  "/now": () => import("@/app/now/page"),
  "/margin": () => import("@/app/margin/page"),
  "/decide": () => import("@/app/decide/page"),
  "/decisions": () => import("@/app/decisions/page"),
  "/optimizer": () => import("@/app/optimizer/page"),
  "/captaincy": () => import("@/app/captaincy/page"),
  "/planner": () => import("@/app/planner/page"),
  "/transfers": () => import("@/app/transfers/page"),
  "/intelligence": () => import("@/app/intelligence/page"),
};

const APP = join(process.cwd(), "app");

describe("the nine paths the front page absorbs are all still built", () => {
  it("names all nine, so the list cannot shrink unnoticed", () => {
    expect(Object.keys(ABSORBED)).toHaveLength(9);
  });

  for (const [path, load] of Object.entries(ABSORBED)) {
    it(`${path} loads and exports a component`, async () => {
      const module = await load();
      expect(typeof module.default, `${path} has no callable default export`)
        .toBe("function");
    });
  }
});

describe("the redirect stubs still land somewhere", () => {
  /** The four `/decide` aliases and the one `/now` alias. */
  const STUBS: Readonly<Record<string, string>> = {
    optimizer: "/decide",
    captaincy: "/decide",
    planner: "/decide",
    transfers: "/decide",
    intelligence: "/now",
  };

  for (const [stub, target] of Object.entries(STUBS)) {
    it(`/${stub} still redirects to ${target}, and ${target} still exists`, () => {
      const source = readFileSync(join(APP, stub, "page.tsx"), "utf8");
      expect(source).toContain(`redirect("${target}")`);
      expect(existsSync(join(APP, target.slice(1), "page.tsx"))).toBe(true);
    });
  }
});

describe("the three real surfaces keep their own suites", () => {
  /**
   * `/now`, `/margin` and `/decide` each render and assert their headline content
   * in a suite of their own. Those suites are the guarantee; this asserts they are
   * still there to give it.
   */
  for (const route of ["now", "margin", "decide"]) {
    it(`/${route} still has a page test`, () => {
      expect(existsSync(join(APP, route, "page.test.tsx"))).toBe(true);
    });
  }
});

/**
 * `/now` rendered, because it is the route the new front page most nearly
 * duplicates.
 *
 * The fetch stub and fixtures are the shape `app/now/page.test.tsx` uses; kept
 * minimal here because that file already covers `/now` in every artifact state.
 * What this adds is a second, independent caller — so a shared component changed
 * for the new surface cannot break `/now` while only `/now`'s own suite watches.
 */
describe("/now still renders its headline content", () => {
  const MATCHES = {
    gameweek: 1,
    season: "2026-27",
    generated_at: "2026-08-06T06:00:00Z",
    matches: [
      {
        match_id: "m1", date: "2026-08-15", home_team: "Arsenal",
        away_team: "Chelsea", model_prediction: "home", confidence_pct: 54.2,
        referee: null, is_derby: null, n_value_bets: null,
      },
      {
        // Not every call "home". A matches file where they all agree is the
        // flat-prior fingerprint, and the narrower reads it as `empty` rather
        // than as ten confident predictions — so a one-row fixture would render
        // an absence line and this test would be asserting the wrong state.
        match_id: "m2", date: "2026-08-15", home_team: "Everton",
        away_team: "Fulham", model_prediction: "away", confidence_pct: 41.0,
        referee: "M Oliver", is_derby: null, n_value_bets: null,
      },
    ],
  };

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const path = String(url).replace(/^\/predictions\//, "");
      if (path === REGISTRY.matches.path) {
        return new Response(JSON.stringify(MATCHES), { status: 200 });
      }
      // Everything else absent. Rule 2: that costs one line per section, and
      // every heading must survive it.
      return new Response("", { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("still shows its four sections and its own call", async () => {
    const { default: NowPage } = await import("@/app/now/page");
    render(<NowPage />);
    await screen.findByText(/Model status/);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Now");
    for (const heading of [
      "Your GW1 call", "Your squad", "What changed", "From the agent",
      "This gameweek", "Model status",
    ]) {
      expect(screen.getByText(heading), `${heading} is gone from /now`)
        .toBeInTheDocument();
    }
    expect(screen.getByText(/Arsenal v Chelsea/)).toBeInTheDocument();
  });
});
