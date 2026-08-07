/**
 * Decide — the proposal, and the honesty around it.
 *
 * Three things are asserted that the old `/decisions` could not do at all:
 *
 * 1. **The expired branch fires.** Before `deadline` was added to
 *    `Decision.as_dict()`, the consumer read `String(source.deadline ?? "")`, so
 *    `Date.parse("")` was NaN and every proposal classified "ready". "Do not act
 *    on this" was unreachable code.
 * 2. **The path is real.** The old page fetched `decision_latest.json`, which is
 *    staged by one workflow, excluded by another, and written by nothing.
 * 3. **The heuristic is labelled.** `fpl-ranking-engine.ts` has no accuracy tests
 *    and projects minutes as `minutes ÷ points × 4.5`. Showing it unlabelled would
 *    be the FPLReview problem in our own code.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DecidePage from "@/app/decide/page";
import { REGISTRY, decisionDescriptor } from "@/lib/data/narrow";

const MATCHES = {
  gameweek: 7, season: "2026-27", generated_at: "2026-08-06T06:00:00Z",
  matches: [{
    match_id: "m1", date: "2026-08-15", home_team: "Arsenal",
    away_team: "Chelsea", model_prediction: "away", confidence_pct: 51,
  }],
};

function decision(over: Record<string, unknown> = {}) {
  return {
    gameweek: 7,
    entry_label: "season",
    objective: "season",
    generated_at: "2026-08-06T06:00:00Z",
    deadline: "2099-08-14T17:30:00Z",
    decision: {
      plan: {
        squad: [1, 2, 3], xi: [1, 2, 3], captain: 100, vice: 9,
        transfers_in: [9], transfers_out: [521], hits: 0, bank_after: 5,
      },
      mean_points: 62.4,
    },
    optimism_gap: 1.2,
    credible_margin: true,
    warnings: [],
    xp_snapshot: { "521": 5.4 },
    ...over,
  };
}

function mockFetch(bodies: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    const path = String(url).replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200 });
  });
}

async function renderDecide(bodies: Record<string, unknown>) {
  vi.stubGlobal("fetch", mockFetch(bodies));
  render(<DecidePage />);
  await screen.findByText("Decide");
  await new Promise((r) => setTimeout(r, 30));
}

const SEASON = decisionDescriptor(7, "season").path;
const WEEKLY = decisionDescriptor(7, "weekly").path;

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the path is the one the agent writes", () => {
  it("builds decision_public_gwNN_label.json with a padded gameweek", () => {
    expect(decisionDescriptor(7, "season").path)
      .toBe("fpl/decision_public_gw07_season.json");
    expect(decisionDescriptor(12, "weekly").path)
      .toBe("fpl/decision_public_gw12_weekly.json");
  });

  it("never asks for the phantom decision_latest.json", () => {
    for (const gw of [1, 7, 38]) {
      for (const label of ["season", "weekly"] as const) {
        expect(decisionDescriptor(gw, label).path).not.toContain("latest");
      }
    }
  });
});

describe("a live proposal", () => {
  it("renders the move for both entries", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision(),
      [WEEKLY]: decision({ entry_label: "weekly", objective: "weekly" }),
    });
    expect(screen.getByText("Season team")).toBeInTheDocument();
    expect(screen.getByText("Weekly team")).toBeInTheDocument();
    expect(screen.getAllByText(/521 → 9/).length).toBe(2);
  });

  it("shows the optimism gap, not just the headline number", async () => {
    await renderDecide({ [REGISTRY.matches.path]: MATCHES, [SEASON]: decision() });
    // The winner's-curse correction. A large gap means the shortlist was chosen
    // by simulation noise.
    expect(screen.getAllByText("1.20").length).toBeGreaterThan(0);
    expect(screen.getAllByText("credible").length).toBeGreaterThan(0);
  });

  it("renders a hold as a hold, not as a blank", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision({
        decision: {
          plan: {
            squad: [1], xi: [1], captain: 100, vice: 9,
            transfers_in: [], transfers_out: [], hits: 0, bank_after: 0,
          },
          mean_points: 60,
        },
      }),
    });
    expect(screen.getByText(/Hold — no transfer/)).toBeInTheDocument();
  });

  it("surfaces warnings rather than styling them away", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision({ warnings: ["price uncertain for 3 held players"] }),
    });
    expect(screen.getByText(/price uncertain/)).toBeInTheDocument();
  });
});

describe("the deadline branch that used to be unreachable", () => {
  it("says DO NOT ACT once the deadline has passed", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision({ deadline: "2020-08-14T17:30:00Z" }),
    });
    const badge = document.querySelector('[data-freshness="expired"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/DO NOT ACT/);
  });

  it("shows time remaining while the deadline is ahead", async () => {
    await renderDecide({ [REGISTRY.matches.path]: MATCHES, [SEASON]: decision() });
    expect(document.querySelector('[data-freshness="ready"]')).not.toBeNull();
  });

  it("an absent deadline is 'unknown', NOT 'ready'", async () => {
    // The exact old bug: `Date.parse("")` is NaN, `NaN <= 0` is false, so a
    // decision with no deadline read as actionable.
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision({ deadline: undefined }),
    });
    expect(document.querySelector('[data-freshness="unknown"]')).not.toBeNull();
    expect(document.querySelector('[data-freshness="ready"]')).toBeNull();
  });

  it("an unparseable deadline is unknown, not ready", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision({ deadline: "next tuesday" }),
    });
    expect(document.querySelector('[data-freshness="unknown"]')).not.toBeNull();
  });
});

describe("the heuristic is never presented as a model", () => {
  it("is labelled even when real decisions are present", async () => {
    await renderDecide({
      [REGISTRY.matches.path]: MATCHES,
      [SEASON]: decision(),
      [WEEKLY]: decision({ entry_label: "weekly" }),
    });
    const notice = screen.getByTestId("heuristic-notice");
    expect(within(notice).getByText(/HEURISTIC — NOT A MODEL/)).toBeInTheDocument();
  });

  it("names the specific arithmetic that makes it a heuristic", async () => {
    await renderDecide({ [REGISTRY.matches.path]: MATCHES });
    const notice = screen.getByTestId("heuristic-notice");
    // minutes ÷ points is dimensionally meaningless and rewards low scorers.
    expect(notice.textContent).toMatch(/minutes ÷ total points/);
    expect(notice.textContent).toMatch(/no accuracy assertions/);
  });
});

describe("absence is stated, not blank", () => {
  it("says no proposal has been published when none has", async () => {
    // The real state today: no gameweek has ever sealed.
    await renderDecide({ [REGISTRY.matches.path]: MATCHES });
    const cards = screen.getAllByRole("status");
    expect(cards.some((c) => c.textContent?.includes("none has sealed yet"))).toBe(true);
  });

  it("explains itself when the gameweek cannot be determined", async () => {
    await renderDecide({});
    expect(screen.getByText(/current gameweek is unknown/)).toBeInTheDocument();
  });

  it("one entry's absence does not blank the other", async () => {
    await renderDecide({ [REGISTRY.matches.path]: MATCHES, [SEASON]: decision() });
    expect(screen.getByText("Season team")).toBeInTheDocument();
    expect(screen.getByText("Weekly team")).toBeInTheDocument();
    expect(screen.getByText(/521 → 9/)).toBeInTheDocument();
  });
});
