/**
 * The Now screen, in every state its artifacts can reach.
 *
 * **Rule 2 is the point of this file.** The homepage this replaces fetched five
 * artifacts through one context with one `loading` and one `error`, so a single
 * failed fetch blanked all five sections. Intent will not prevent a repeat, so it
 * is asserted: each artifact is made absent in turn and the other sections must
 * still render.
 *
 * There were **zero page tests** in this repo before this one.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NowPage from "@/app/now/page";
import { REGISTRY } from "@/lib/data/narrow";

const DELTA_CHANGE = {
  kind: "resolution_change",
  delta_id: "d1",
  observed_at: "2026-08-06T11:45:00Z",
  gameweek: 1,
  element_id: 521,
  player_name: "Kulusevski",
  club: "Spurs",
  claim_type: "chance_of_playing",
  before: 75,
  after: 25,
  why_material: "75% -> 25%",
  rule_applied: "asymmetric_override",
  trigger: {
    source: "manual:De Zerbi presser",
    source_tier: 2,
    claimed_at: "2026-08-06T11:00:00Z",
    quote: "He is a couple of weeks away",
    url: "https://hayters.com/x",
  },
};

const DELTA_IMPACT = {
  kind: "decision_impact",
  delta_id: "d1",
  observed_at: "2026-08-06T12:00:00Z",
  gameweek: 1,
  entry_label: "season",
  xp_moved: [{ element_id: 521, before: 5.4, after: 1.2 }],
  root_move: { before: "hold", after: "[521] -> [9]", flipped: true },
  captain: { before: 100, after: 200 },
  ev_cost_of_inaction: 1.8,
};

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
      match_id: "m2", date: "2026-08-15", home_team: "Everton",
      away_team: "Fulham", model_prediction: "away", confidence_pct: 41.0,
      referee: "M Oliver", is_derby: null, n_value_bets: null,
    },
  ],
};

const MESSAGES = {
  generated_at: "2026-08-06T09:00:00Z",
  messages: [{
    id: "msg1", gameweek: 1, kind: "warning", severity: "critical",
    title: "Two Silvas at one club", body: "Ambiguous surname; resolve by hand.",
    created_at: "2026-08-06T09:00:00Z",
  }],
};

const HEALTH = {
  last_updated: "2026-08-06T06:00:00Z",
  gameweek: 1,
  n_predictions: 10,
  status: "healthy",
  pipeline_version: "4.1.0",
  model_metrics: { ece: 0.04, rps_mean: 0.19 },
};

/** Routes every registry path to a canned body. Absent unless listed. */
function mockFetch(bodies: Partial<Record<string, unknown>>) {
  return vi.fn(async (url: unknown) => {
    const path = String(url).replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    const body = bodies[path];
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status: 200 });
  });
}

const ALL_PRESENT = {
  [REGISTRY.deltas.path]:
    `${JSON.stringify(DELTA_CHANGE)}\n${JSON.stringify(DELTA_IMPACT)}\n`,
  [REGISTRY.matches.path]: MATCHES,
  [REGISTRY.messages.path]: MESSAGES,
  [REGISTRY.health.path]: HEALTH,
};

async function renderNow(bodies: Partial<Record<string, unknown>>) {
  vi.stubGlobal("fetch", mockFetch(bodies));
  render(<NowPage />);
  // Every section resolves independently; wait for the last one.
  await screen.findByText(/Model status/);
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the happy path", () => {
  it("renders all four sections", async () => {
    await renderNow(ALL_PRESENT);
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(screen.getByText("From the agent")).toBeInTheDocument();
    expect(screen.getByText("This gameweek")).toBeInTheDocument();
    expect(screen.getByText("Model status")).toBeInTheDocument();
  });

  it("shows the changed player and the direction of the change", async () => {
    await renderNow(ALL_PRESENT);
    const delta = screen.getByTestId("delta");
    expect(within(delta).getByText(/Kulusevski/)).toBeInTheDocument();
    expect(within(delta).getByText(/75% → 25%/)).toBeInTheDocument();
  });

  it("shows the quote, the source and when it was SAID", async () => {
    await renderNow(ALL_PRESENT);
    const delta = screen.getByTestId("delta");
    expect(within(delta).getByText(/a couple of weeks away/)).toBeInTheDocument();
    expect(within(delta).getByText(/De Zerbi presser/)).toBeInTheDocument();
    // claimed_at, not the time we read it.
    expect(within(delta).getByText(/said 2026-08-06T11:00:00Z/)).toBeInTheDocument();
  });

  it("explains the rule in words rather than showing a symbol", async () => {
    await renderNow(ALL_PRESENT);
    // R4: a tier-2 source may push availability down but never up. No competitor
    // shows why a number is what it is.
    expect(
      screen.getByText(/may push availability down but never up/),
    ).toBeInTheDocument();
  });

  it("reports the flip and the cost of inaction", async () => {
    await renderNow(ALL_PRESENT);
    const impact = screen.getByTestId("impact");
    expect(impact.dataset.flipped).toBe("true");
    expect(within(impact).getByText(/changes the recommended move/)).toBeInTheDocument();
    expect(within(impact).getByText(/1\.80/)).toBeInTheDocument();
  });

  it("renders the fixtures", async () => {
    await renderNow(ALL_PRESENT);
    expect(screen.getByText(/Arsenal v Chelsea/)).toBeInTheDocument();
  });
});

describe("impact not yet assessed", () => {
  it("is a stated state, not a hidden row", async () => {
    // The poller emits within 15 minutes; the agent adds the impact on its next
    // run. Withholding the news until then would throw away the latency that is
    // the entire point of a 15-minute poller.
    await renderNow({
      ...ALL_PRESENT,
      [REGISTRY.deltas.path]: `${JSON.stringify(DELTA_CHANGE)}\n`,
    });
    expect(screen.getByTestId("delta")).toBeInTheDocument();
    expect(screen.getByTestId("awaiting-impact")).toBeInTheDocument();
    expect(screen.queryByTestId("impact")).toBeNull();
  });
});

describe("Rule 2 — one absent artifact must not blank the page", () => {
  const sections = ["What changed", "From the agent", "This gameweek", "Model status"];

  for (const key of ["deltas", "matches", "messages", "health"] as const) {
    it(`survives ${key} being absent`, async () => {
      const without = { ...ALL_PRESENT };
      delete (without as Record<string, unknown>)[REGISTRY[key].path];
      await renderNow(without);

      // Every heading still present. This is the assertion the old homepage
      // would have failed: it returned early and rendered nothing at all.
      for (const heading of sections) {
        expect(
          screen.getByText(heading),
          `${heading} vanished when ${key} was absent`,
        ).toBeInTheDocument();
      }
    });
  }

  it("survives every artifact being absent at once", async () => {
    await renderNow({});
    for (const heading of sections) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    // And says why, four times over, rather than showing four blanks.
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(4);
  });

  it("names a reason in every state card", async () => {
    await renderNow({});
    for (const card of screen.getAllByRole("status")) {
      expect(card.textContent?.trim().length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe("degenerate and malformed data", () => {
  it("an empty delta feed reads as nothing-changed, not as broken", async () => {
    await renderNow({ ...ALL_PRESENT, [REGISTRY.deltas.path]: "" });
    const card = screen.getAllByRole("status").find((n) =>
      n.textContent?.includes("No availability has changed"),
    );
    expect(card).toBeDefined();
    expect(card?.dataset.state).toBe("empty");
  });

  it("an unreadable artifact says so and names the problem", async () => {
    await renderNow({ ...ALL_PRESENT, [REGISTRY.matches.path]: { nonsense: true } });
    const card = screen.getAllByRole("status").find(
      (n) => n.dataset.state === "unreadable",
    );
    expect(card).toBeDefined();
    expect(card?.textContent).toMatch(/does not match the expected shape/);
  });

  it("a matches file where every call is 'home' is empty, not confident", async () => {
    // The flat-prior fingerprint: before strengths are fitted, home advantage is
    // the only surviving signal, so ten identical calls means no information.
    const flat = {
      ...MATCHES,
      matches: MATCHES.matches.map((m) => ({ ...m, model_prediction: "home" })),
    };
    await renderNow({ ...ALL_PRESENT, [REGISTRY.matches.path]: flat });
    const card = screen.getAllByRole("status").find(
      (n) => n.dataset.state === "empty" && n.textContent?.includes("No fixtures"),
    );
    expect(card).toBeDefined();
  });
});

describe("provenance", () => {
  it("is shown for every section", async () => {
    await renderNow(ALL_PRESENT);
    expect(screen.getAllByTestId("provenance").length).toBe(4);
  });

  it("names the producing version rather than implying it is current", async () => {
    await renderNow({
      ...ALL_PRESENT,
      [REGISTRY.health.path]: { ...HEALTH, pipeline_version: "4.0.0" },
    });
    // The real drift: a complete, fresh file from a producer that emits no
    // metrics. Invisible unless the version sits beside the numbers.
    expect(screen.getAllByTestId("provenance").some(
      (n) => n.textContent?.includes("4.0.0"),
    )).toBe(true);
  });

  it("says 'version unknown' when the writer emits none", async () => {
    await renderNow({
      ...ALL_PRESENT,
      [REGISTRY.health.path]: { ...HEALTH, pipeline_version: undefined },
    });
    expect(screen.getAllByTestId("provenance").some(
      (n) => n.textContent?.includes("version unknown"),
    )).toBe(true);
  });
});
