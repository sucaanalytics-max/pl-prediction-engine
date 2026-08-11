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

// ─────────────────────────────────────────────────────────────────────────────
// The lists ported off /transfers, /optimizer and /captaincy.
//
// Those three routes are not on `main` and return 404 in production, so nothing
// was lost by retiring them — but the shortlist itself is the only actionable
// content the app has until a gameweek seals, so it has to survive the move.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_STATE = {
  generatedAt: "2026-08-06T06:00:00Z",
  recommendations: {
    modelVersion: "heuristic-only",
    transfers4: [{
      rank: 1,
      playerOut: { elementId: 521, name: "Raya", team: "ARS", position: "GKP" },
      playerIn: { elementId: 9, name: "Sánchez", team: "CHE", position: "GKP" },
      delta4: 3.2, delta6: 4.9, bankAfter: 0.4, confidence: 0.61,
      rationale: ["Fixture swing", "Minutes secure"], flags: [],
    }],
    captaincyPlan: [{
      gameweek: 7,
      captain: { elementId: 427, name: "Salah", team: "LIV", position: "MID" },
      viceCaptain: { elementId: 2, name: "Haaland", team: "MCI", position: "FWD" },
      captainFixture: "LIV v BOU (H)", projectedCaptainPoints: 11.4, confidence: 0.55,
    }],
  },
  rankings: {
    overall: [], captaincy: [], value: [], differentials: [],
    goalkeepers: [], defenders: [], midfielders: [], forwards: [],
  },
  projections: { source: "fallback", sourceLabel: "No FPLReview export available" },
};

/** Serves `/api/fpl/state` alongside the published artifacts. */
async function renderWithLive(
  bodies: Record<string, unknown>, live: unknown,
) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const raw = String(url);
    if (raw.includes("/api/fpl/state")) {
      return live === undefined
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ data: live }), { status: 200 });
    }
    const path = raw.replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200 });
  }));
  render(<DecidePage />);
  await screen.findByText("Decide");
  await new Promise((r) => setTimeout(r, 30));
}

describe("the ported transfer shortlist", () => {
  it("renders the move out and the move in", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, LIVE_STATE);
    const rows = screen.getAllByTestId("transfer");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Raya")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Sánchez")).toBeInTheDocument();
  });

  it("carries the rationale across, which is the only checkable part", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, LIVE_STATE);
    expect(screen.getByText(/Fixture swing · Minutes secure/)).toBeInTheDocument();
  });

  it("renders the captaincy plan with its vice", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, LIVE_STATE);
    const week = screen.getByTestId("captain-week");
    expect(within(week).getByText("Salah")).toBeInTheDocument();
    expect(within(week).getByText("Haaland")).toBeInTheDocument();
  });
});

describe("the shortlist owns its own state", () => {
  it("a dead live route does not blank the published proposal", async () => {
    // Rule 2. The old context had one error for every consumer, so a single
    // failing fetch emptied unrelated sections.
    await renderWithLive(
      { [REGISTRY.matches.path]: MATCHES, [SEASON]: decision() }, undefined,
    );
    expect(screen.getByText(/521 → 9/)).toBeInTheDocument();
    expect(screen.queryAllByTestId("transfer")).toHaveLength(0);
  });

  it("an empty shortlist says so rather than showing an empty table", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, {
      ...LIVE_STATE,
      recommendations: { ...LIVE_STATE.recommendations, transfers4: [] },
    });
    expect(screen.getByText(/No move scored better than holding/)).toBeInTheDocument();
  });

  it("a malformed row is reported, not silently dropped", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, {
      ...LIVE_STATE,
      recommendations: {
        ...LIVE_STATE.recommendations,
        transfers4: [
          ...LIVE_STATE.recommendations.transfers4,
          { rank: 2, playerIn: { elementId: 5, name: "Half" } },
        ],
      },
    });
    // Showing 1 of 2 without saying so would overstate the shortlist's coverage.
    expect(screen.getByText(/1 row could not be read/)).toBeInTheDocument();
  });

  it("a broken payload reads as unreadable, not as no transfers", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, { nonsense: true });
    const cards = screen.getAllByRole("status");
    expect(cards.some((c) => /does not match the expected shape/.test(c.textContent ?? "")))
      .toBe(true);
  });
});

describe("the alternatives ported off /optimizer", () => {
  const PLANS = [
    {
      rank: 1, transferCount: 2, bankAfter: 0.2, delta4: 5.4, delta6: 7.1,
      confidence: 0.5, flags: [],
      moves: [
        { playerOut: { elementId: 1, name: "Raya" }, playerIn: { elementId: 2, name: "Sánchez" } },
        { playerOut: { elementId: 3, name: "Gvardiol" }, playerIn: { elementId: 4, name: "Kerkez" } },
      ],
    },
    {
      rank: 2, transferCount: 3, bankAfter: 0.0, delta4: 5.2, delta6: 7.4,
      confidence: 0.4, flags: ["takes a hit"],
      moves: [
        { playerOut: { elementId: 5, name: "Watkins" }, playerIn: { elementId: 6, name: "Isak" } },
      ],
    },
  ];

  const withPlans = {
    ...LIVE_STATE,
    recommendations: { ...LIVE_STATE.recommendations, multiTransferPlans4: PLANS },
  };

  it("shows more than one plan, so the runner-up is visible", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, withPlans);
    expect(screen.getAllByTestId("plan")).toHaveLength(2);
  });

  it("says how far behind the best each alternative is", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, withPlans);
    // 5.4 - 5.2 = 0.2. A gap that small means "either", not "this one", and
    // that is the whole reason for showing alternatives at all.
    expect(screen.getByText(/0\.2 behind the best/)).toBeInTheDocument();
    expect(screen.getByText(/Best by four-gameweek delta/)).toBeInTheDocument();
  });

  it("lists every leg of a multi-transfer plan", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, withPlans);
    const first = screen.getAllByTestId("plan")[0];
    expect(within(first).getByText("Gvardiol")).toBeInTheDocument();
    expect(within(first).getByText("Kerkez")).toBeInTheDocument();
  });

  it("drops a plan whose every leg is malformed rather than showing a bare number", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, {
      ...LIVE_STATE,
      recommendations: {
        ...LIVE_STATE.recommendations,
        multiTransferPlans4: [{ rank: 1, delta4: 9.9, moves: [{ playerIn: {} }] }],
      },
    });
    expect(screen.queryAllByTestId("plan")).toHaveLength(0);
    expect(screen.getByText(/No multi-transfer plan beat/)).toBeInTheDocument();
  });

  it("absent plans do not disturb the shortlist", async () => {
    await renderWithLive({ [REGISTRY.matches.path]: MATCHES }, LIVE_STATE);
    expect(screen.getAllByTestId("transfer")).toHaveLength(1);
    expect(screen.getByText(/No multi-transfer plan beat/)).toBeInTheDocument();
  });
});
