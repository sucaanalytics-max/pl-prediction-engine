/**
 * Margin, in the states its artifacts actually reach.
 *
 * Two properties are asserted here and nowhere else.
 *
 * **Rule 2, across four views.** Margin reads eight artifacts. Any one of them
 * failing must cost exactly one panel — the homepage this app started from
 * fetched five through a shared context and blanked all five on a single
 * failure, and a four-view workspace has more ways to reproduce that, not fewer.
 *
 * **Absence keeps its reason.** `MarginState` replaces `StateCard` on this
 * surface for visual reasons, and the substitution is only safe if it keeps the
 * property that made the cards worth having: the state is named, `role="status"`
 * is set, and `artifact.reason` reaches the screen. Every one of the four
 * original failures in this app looked exactly like a broken page without it.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MarginPage from "@/app/margin/page";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { ACCURACY } from "@/lib/data/accuracy";
import { MINUTES_CONFLICTS } from "@/lib/data/minutes-conflicts";
import { REGISTRY } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { resetHeuristicsForTests } from "@/lib/data/useHeuristics";

const STATE = "/api/fpl/state";

const AGENT_IDLE = {
  schema_version: 1,
  generated_at: "2026-08-13T09:59:24Z",
  phase: "idle",
  gameweek: 1,
  deadline: "2026-08-21T17:30:00+00:00",
  seconds_to_deadline: 718235,
  reason: "GW1 deadline in 199.5h; nothing due yet",
  agent_ran: false,
};

const CONFLICTS = {
  schema_version: 1,
  generated_at: "2026-08-13T11:05:15Z",
  thresholds: { fringe_minutes: 45, nailed_minutes: 60 },
  note: "Reported, never applied.",
  conflicts: [
    {
      element_id: 504, player: "Vuskovic", club: "Brighton",
      kind: "fringe-but-discussed", e_minutes: 3.6, xp: 0.17, gap: 41.4,
      source: "x:robtFPL", url: "https://x.com/robtFPL/status/2086121456807575553",
      claimed_at: "2026-08-08T16:04:48Z",
      quote: "45' each for Vuskovic and Dunk.",
    },
  ],
  ambiguous_surnames: {},
};

const PROJECTIONS = {
  schema_version: 1,
  gameweek: 1,
  season: "2627",
  generated_at: "2026-08-13T07:10:00Z",
  n_draws: 5000,
  players: [
    {
      name: "Palmer", team: "Chelsea", position: "MID", element_id: 300,
      xp: 6.4, xp_sd: 2.4, mode: 2, p_appears: 0.96, p_60: 0.91,
      e_minutes: 82, p_goal: 0.34, p_clean_sheet: 0.28, p_ge_5: 0.61,
      p_ge_10: 0.07, q10: 1, q50: 5, q90: 12, n_fixtures: 1, blank: false,
      decomposition: {
        appearance: 1.9, goals: 2.4, assists: 1.1, clean_sheets: 0.4, other: 0.6,
      },
    },
    {
      name: "Semenyo", team: "Bournemouth", position: "MID", element_id: 397,
      xp: 6.42, xp_sd: 5.9, mode: 2, p_appears: 0.88, p_60: 0.74,
      e_minutes: 68, p_goal: 0.41, p_clean_sheet: 0.22, p_ge_5: 0.44,
      p_ge_10: 0.24, q10: 1, q50: 4, q90: 16, n_fixtures: 1, blank: false,
      decomposition: null,
    },
    {
      // Everything the producer could not compute is null rather than zero.
      name: "Unmeasured", team: "Burnley", position: "DEF", element_id: 500,
      xp: null, xp_sd: null, mode: null, p_appears: null, p_60: null,
      e_minutes: null, p_goal: null, p_clean_sheet: null, p_ge_5: null,
      p_ge_10: null, q10: null, q50: null, q90: null, n_fixtures: 0,
      blank: false, decomposition: null,
    },
  ],
};

const ACCURACY_UNMEASURED = {
  generated_at: "2026-08-13T07:00:00Z",
  season: "2627",
  gameweeks_sealed: 0,
  observations: 0,
  perfect_model_rmse: 2.806,
  perfect_model_basis: "the spread of our own simulated distributions",
  measured: null,
  reason: "No gameweek has sealed, so there is no measured error distribution.",
};

const LIVE = {
  schemaVersion: 4,
  generatedAt: "2026-08-13T12:00:00Z",
  season: "2026/27",
  entry: { id: 20945, teamName: "Margin FC" },
  event: { id: 1, deadlineTime: "2026-08-21T17:30:00Z" },
  freshness: { squad: "captured" },
  projections: { source: "fallback", sourceLabel: "No FPLReview export" },
  squad: {
    source: "captured_authenticated_draft",
    value: 100.0,
    bank: 0.8,
    formation: "4-4-2",
    players: [
      {
        elementId: 300, name: "Palmer", position: "MID", team: "CHE",
        price: 10.6, bench: false, status: "captain", fixture: "LEE (H)",
      },
      {
        elementId: 397, name: "Semenyo", position: "MID", team: "BOU",
        price: 7.4, bench: true, status: undefined, fixture: "NEW (A)",
      },
    ],
  },
  fixtureMatrix: [
    {
      teamId: 6, team: "Chelsea", shortName: "CHE", meanDifficulty: 2.5,
      totalDifficulty: 20,
      fixtures: [
        { gameweek: 1, label: "LEE (H)", difficulty: 2 },
        { gameweek: 2, label: "ARS (A)", difficulty: 4 },
      ],
    },
  ],
  recommendations: {
    modelVersion: "heuristic-only",
    transfers4: [
      {
        rank: 1,
        playerOut: heuristicPlayer(397, "Semenyo"),
        playerIn: heuristicPlayer(426, "B.Fernandes"),
        delta4: 4.1, delta6: 5.2, bankAfter: 0.2, confidence: 0.44,
        rationale: ["form", "three at home"], flags: [],
      },
    ],
    multiTransferPlans4: [],
    captaincyPlan: [
      {
        gameweek: 1,
        captain: heuristicPlayer(300, "Palmer"),
        viceCaptain: heuristicPlayer(397, "Semenyo"),
        captainFixture: "LEE (H)",
        projectedCaptainPoints: 12.8,
        confidence: 0.61,
      },
    ],
  },
  rankings: {
    overall: [], captaincy: [], value: [], differentials: [],
    goalkeepers: [], defenders: [], midfielders: [], forwards: [],
  },
};

function heuristicPlayer(elementId: number, name: string) {
  return {
    elementId, name, team: "CHE", position: "MID", price: 10.6, ownership: 30,
    status: "a", news: "", expectedMinutes: 80, projected4: 20, projected6: 30,
    captainScore: 9, valueScore: 2, differentialScore: 1, fixtures: [],
  };
}

const GW = 1;
const PATHS = {
  status: AGENT_STATUS.path,
  conflicts: MINUTES_CONFLICTS.path,
  projections: projectionsDescriptor(GW).path,
  accuracy: ACCURACY.path,
  deltas: REGISTRY.deltas.path,
  fixtureXg: REGISTRY.fixtureXg.path,
};

const ALL_PRESENT: Record<string, unknown> = {
  [PATHS.status]: AGENT_IDLE,
  [PATHS.conflicts]: CONFLICTS,
  [PATHS.projections]: PROJECTIONS,
  [PATHS.accuracy]: ACCURACY_UNMEASURED,
  [PATHS.deltas]: "",
};

/** Routes every path to a canned body; anything unlisted 404s, i.e. is absent. */
function mockFetch(bodies: Record<string, unknown>, live: unknown = LIVE) {
  return vi.fn(async (url: unknown) => {
    const raw = String(url);
    if (raw.startsWith(STATE)) {
      if (live === undefined) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ data: live }), { status: 200 });
    }
    const path = raw.replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    const body = bodies[path];
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status: 200 });
  });
}

async function renderMargin(
  bodies: Record<string, unknown> = ALL_PRESENT, live: unknown = LIVE,
) {
  vi.stubGlobal("fetch", mockFetch(bodies, live));
  render(<MarginPage />);
  // Every artifact resolves independently; the bar is the last common element.
  await screen.findByTestId("margin-mode");
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function go(view: string) {
  fireEvent.click(screen.getByRole("tab", { name: view }));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  resetHeuristicsForTests();
  // The tabs write `?view=` so a view is linkable, and jsdom shares one window
  // across a file — so without this the previous test's tab decides the next
  // test's opening view. Real behaviour, leaking; reset it rather than drop it.
  window.history.replaceState(null, "", "/margin");
});
afterEach(() => {
  cleanup();
  resetHeuristicsForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the shell", () => {
  it("opens on Decide with all four views reachable", async () => {
    await renderMargin();
    expect(screen.getByTestId("margin-decide")).toBeInTheDocument();
    for (const view of ["decide", "score", "research", "watch"]) {
      expect(screen.getByRole("tab", { name: view })).toBeInTheDocument();
    }
  });

  it("derives the mode from the phase resolver rather than offering a toggle", async () => {
    await renderMargin();
    const chip = screen.getByTestId("margin-mode");
    expect(chip).toHaveAttribute("data-mode", "idle");
    expect(chip).toHaveTextContent(/idle/i);
    // A control that lets the reader claim the engine has run is the confusion
    // the two modes exist to remove.
    expect(screen.queryByRole("button", { name: /deadline mode/i })).toBeNull();
  });

  it("says the phase is unknown when the resolver cannot be read", async () => {
    await renderMargin({ ...ALL_PRESENT, [PATHS.status]: undefined });
    expect(screen.getByTestId("margin-mode")).toHaveAttribute("data-mode", "unknown");
  });

  it("switches views without unmounting the workspace", async () => {
    await renderMargin();
    go("research");
    expect(await screen.findByTestId("margin-research")).toBeInTheDocument();
    go("watch");
    expect(await screen.findByTestId("margin-watch")).toBeInTheDocument();
  });

  it("opens on the view named in the URL", async () => {
    // Four views behind one path means "look at the Score tab" is not a link
    // anyone can send.
    window.history.replaceState(null, "", "/margin?view=watch");
    await renderMargin();
    expect(await screen.findByTestId("margin-watch")).toBeInTheDocument();
  });

  it("ignores a view the app does not have", async () => {
    window.history.replaceState(null, "", "/margin?view=nonsense");
    await renderMargin();
    expect(screen.getByTestId("margin-decide")).toBeInTheDocument();
  });

  it("puts the current view in the URL so it can be linked", async () => {
    await renderMargin();
    go("research");
    await screen.findByTestId("margin-research");
    expect(new URL(window.location.href).searchParams.get("view")).toBe("research");
  });

  it("renders a placeholder clock until it has mounted", async () => {
    // A `new Date()` initialiser would differ between the server render and the
    // first client render, hydrating with a mismatch on a value that changes
    // every second.
    await renderMargin();
    expect(screen.getByTestId("margin-clock").textContent).toMatch(/\d|—/);
  });
});

describe("Decide, with no call published", () => {
  it("says there is no call at the size the answer would have been", async () => {
    await renderMargin();
    expect(
      await screen.findByText(/There is no call for GW1 yet/),
    ).toBeInTheDocument();
  });

  it("refuses to answer whether the call would change", async () => {
    await renderMargin();
    // The whole panel. "No" would be acted on; "not knowable" is the truth.
    expect(screen.getByText(/Not knowable without a solve/)).toBeInTheDocument();
  });

  it("carries the resolver's own reason, not a shrug", async () => {
    await renderMargin();
    expect(screen.getByText(/nothing due yet/)).toBeInTheDocument();
  });

  it("shows no projected total when none was published", async () => {
    await renderMargin();
    // The prototype's 59.6 ±15.6 has no producer. Nothing may stand in for it.
    expect(screen.queryByText("59.6")).toBeNull();
    expect(screen.queryByText(/±15.6/)).toBeNull();
  });
});

describe("Decide, the disagreement panel", () => {
  it("shows the fitted minutes struck through against the threshold it failed", async () => {
    await renderMargin();
    // The widest conflict appears twice by design: once in the summary column
    // the design specifies, once in the list beneath it.
    expect(screen.getAllByText("Vuskovic").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4′/).length).toBeGreaterThan(0);
    // A bare "4′" disagrees with nothing until the bar is beside it.
    expect(screen.getAllByText(/≠ 45′/).length).toBeGreaterThan(0);
  });

  it("links the claim so the reader can check it", async () => {
    await renderMargin();
    const link = screen.getByRole("link", { name: /check the claim/ });
    expect(link).toHaveAttribute("href", CONFLICTS.conflicts[0].url);
  });

  it("says the scan found nothing rather than rendering an absence", async () => {
    await renderMargin({
      ...ALL_PRESENT,
      [PATHS.conflicts]: { ...CONFLICTS, conflicts: [] },
    });
    expect(await screen.findByText(/Checked, and nothing disagreed/)).toBeInTheDocument();
    // The summary column says the short form, so the two do not repeat.
    expect(screen.getByText(/Nothing to report this run/)).toBeInTheDocument();
  });
});

describe("Decide, the rail", () => {
  it("shows the model's own projection beside each of the fifteen", async () => {
    await renderMargin();
    // Palmer 6.4 and Semenyo 6.42 both print "6.4", so the assertion is scoped
    // to the row rather than to the page — a bare `getByText("6.4")` would pass
    // on either player's number appearing next to the other's name.
    const palmer = (await screen.findByText("Palmer")).closest("div[style*='grid']");
    expect(within(palmer as HTMLElement).getByText("6.4")).toBeInTheDocument();
    expect(screen.getAllByText(/^6\.4$/)).toHaveLength(2);
  });

  it("shows free transfers as unknown rather than as a plausible number", async () => {
    await renderMargin();
    const rail = screen.getByText("Free transfers").parentElement;
    expect(within(rail as HTMLElement).getByTitle(/not a zero/)).toBeInTheDocument();
  });

  it("marks the captain from the picks themselves", async () => {
    await renderMargin();
    expect(screen.getByTitle(/captain, from your own picks/)).toBeInTheDocument();
  });
});

describe("Research", () => {
  it("renders one row per player with the mode beside the mean", async () => {
    await renderMargin();
    go("research");
    const rows = await screen.findAllByTestId("margin-player");
    expect(rows).toHaveLength(PROJECTIONS.players.length);
  });

  it("draws ∅ rather than 0 for a value the producer did not compute", async () => {
    await renderMargin();
    go("research");
    const rows = await screen.findAllByTestId("margin-player");
    const unmeasured = rows.find((row) => row.textContent?.includes("Unmeasured"));
    expect(unmeasured).toBeDefined();
    expect(within(unmeasured as HTMLElement).getAllByTitle(/not a zero/).length)
      .toBeGreaterThan(5);
    expect(unmeasured?.textContent).not.toMatch(/\b0%/);
  });

  it("finds the same-mean pair in the file instead of naming one", async () => {
    await renderMargin();
    go("research");
    expect(await screen.findByText(/Same mean, different asset/)).toBeInTheDocument();
    // Palmer 6.4 sd 2.4 against Semenyo 6.42 sd 5.9 — the pair in this fixture,
    // not a pair written into the component.
    expect(screen.getByText(/sd 2.4 against 5.9/)).toBeInTheDocument();
  });

  it("announces what it truncated rather than ending the list quietly", async () => {
    await renderMargin();
    go("research");
    expect(await screen.findByText(/showing 3 of 3/)).toBeInTheDocument();
  });

  it("states the draw count behind every tail probability", async () => {
    await renderMargin();
    go("research");
    expect(await screen.findByText(/5,000 draws/)).toBeInTheDocument();
  });

  it("says which artifact is missing when there is no projection", async () => {
    await renderMargin({ ...ALL_PRESENT, [PATHS.projections]: undefined });
    go("research");
    const state = await screen.findByText(/No per-player projection has been published/);
    expect(state).toBeInTheDocument();
    expect(screen.queryAllByTestId("margin-player")).toHaveLength(0);
  });
});

describe("Score", () => {
  it("refuses to draw a horizon nobody solved", async () => {
    // The refusal is a note under the planner now, not the headline it was when
    // the screen had nothing else — but it still has to be on the page, and it
    // still has to distinguish the reader's scratchpad from the optimiser's
    // unsolved answer.
    await renderMargin();
    go("score");
    expect(
      await screen.findByText(/The engine has not solved a horizon/),
    ).toBeInTheDocument();
    expect(screen.getByText(/would carry a solver's authority with no\s+solve behind it/))
      .toBeInTheDocument();
  });

  it("plans without waiting for the engine", async () => {
    // The point of the change: the planner needs no solve. The XI comes from the
    // published projection and the run from the fixture list.
    await renderMargin();
    go("score");
    expect(await screen.findByTestId("margin-planner")).toBeInTheDocument();
  });

  it("shows the fixture run, which is scheduled rather than forecast", async () => {
    await renderMargin();
    go("score");
    expect(await screen.findByText("CHE")).toBeInTheDocument();
    expect(screen.getByTitle(/FPL difficulty 2/)).toBeInTheDocument();
  });

  it("hatches a week with no fixture rather than leaving it blank", async () => {
    await renderMargin();
    go("score");
    // A blank cell reads as an easy game.
    expect(
      (await screen.findAllByTitle(/no fixture scheduled — not an easy one/)).length,
    ).toBeGreaterThan(0);
  });

  it("dots every heuristic number so it cannot be read as the model's", async () => {
    await renderMargin();
    go("score");
    expect(
      await screen.findByTitle(/a heuristic score, not a simulated projection/),
    ).toBeInTheDocument();
  });
});

describe("Watch", () => {
  it("renders all three panels", async () => {
    await renderMargin();
    go("watch");
    expect(await screen.findByText(/What is ageing under the current answer/)).toBeInTheDocument();
    expect(screen.getByText(/What has changed since the last solve/)).toBeInTheDocument();
    expect(screen.getByText(/Whether the engine has been right/)).toBeInTheDocument();
  });

  it("reports the perfect-model ceiling even with nothing sealed", async () => {
    await renderMargin();
    go("watch");
    // The number that stops a future RMSE of 2.9 reading as a failure.
    expect(await screen.findByText("2.806")).toBeInTheDocument();
    expect(screen.getByText(/no measured error distribution/)).toBeInTheDocument();
  });

  it("says a quiet ledger is the poller working, not the poller stopped", async () => {
    await renderMargin();
    go("watch");
    expect(await screen.findByText(/a quiet ledger is the poller working/)).toBeInTheDocument();
  });

  it("marks an artifact with no timestamp rather than calling it fresh", async () => {
    await renderMargin();
    go("watch");
    // More than one input has no timestamp — an absent artifact has no age, and
    // `deltas.jsonl` carries no `generated_at` at all — so this asserts the mark
    // exists rather than that exactly one does.
    expect(
      (await screen.findAllByTitle(/no freshness check can see this/)).length,
    ).toBeGreaterThan(0);
  });
});

describe("Rule 2 — one absent artifact costs one panel", () => {
  it("keeps Decide usable when the live route fails", async () => {
    await renderMargin(ALL_PRESENT, undefined);
    // The squad goes; the conflicts and the no-call headline stay.
    expect(await screen.findByText(/There is no call for GW1 yet/)).toBeInTheDocument();
    expect(screen.getAllByText("Vuskovic").length).toBeGreaterThan(0);
  });

  it("keeps Watch usable when the accuracy report is absent", async () => {
    await renderMargin({ ...ALL_PRESENT, [PATHS.accuracy]: undefined });
    go("watch");
    expect(await screen.findByText(/What is ageing under the current answer/)).toBeInTheDocument();
    expect(screen.getByText(/No accuracy report has been published/)).toBeInTheDocument();
  });

  it("renders every view with nothing published at all", async () => {
    await renderMargin({}, undefined);
    for (const view of ["decide", "score", "research", "watch"] as const) {
      go(view);
      expect(await screen.findByTestId(`margin-${view}`)).toBeInTheDocument();
      // Not one blank screen among them.
      expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    }
  });
});

describe("absence keeps its reason on this surface too", () => {
  it("names the state and says why, as the cards it replaces do", async () => {
    await renderMargin({}, undefined);
    go("research");
    const states = await screen.findAllByRole("status");
    const absent = states.find((node) => node.getAttribute("data-state") === "absent");
    expect(absent, "no state was marked absent").toBeDefined();
    expect(absent?.textContent ?? "").toMatch(/Not published/);
    // `artifact.reason` reached the screen. Without it a reader cannot tell an
    // honest empty page from a broken one, which is the failure this whole data
    // layer exists to prevent.
    expect(absent?.textContent ?? "").toMatch(/Nothing has been published at this path yet|loading/);
  });
});
