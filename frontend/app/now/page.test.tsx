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

/**
 * ONE captain on the front page.
 *
 * Measured on the live app: `/now` recommended two different captains at once.
 * `GameweekCall` took the argmax of `xp` over `xp_public_gw01.json` and named
 * B.Fernandes at 6.66; `SquadBoard`'s HEURISTIC card named Mbeumo and printed
 * "8.8 proj" — already doubled, since `fpl-ranking-engine.ts` returns
 * `projectedPoints * 2`. So the two numbers on screen were not comparable and the
 * larger one belonged to the weaker player. Undoubled it reads 6.66 against 4.4.
 *
 * The deadline is a hard clock and this is the single highest-leverage choice of
 * the week, so the count is asserted on the assembled page rather than on either
 * component alone: only a page-level test can catch a second answer arriving from
 * a different component.
 */
describe("one captain, not two", () => {
  const SQUAD = {
    players: [
      { elementId: 1, name: "Verbruggen", position: "GKP", team: "BHA", price: 4.5, bench: false },
      { elementId: 2, name: "Gvardiol", position: "DEF", team: "MCI", price: 5.5, bench: false },
      { elementId: 3, name: "Calafiori", position: "DEF", team: "ARS", price: 5.5, bench: false },
      { elementId: 4, name: "Shaw", position: "DEF", team: "MUN", price: 4.5, bench: false },
      { elementId: 5, name: "B.Fernandes", position: "MID", team: "MUN", price: 12.0, bench: false },
      { elementId: 6, name: "Szoboszlai", position: "MID", team: "LIV", price: 7.0, bench: false },
      { elementId: 7, name: "Semenyo", position: "MID", team: "MCI", price: 8.5, bench: false },
      { elementId: 8, name: "Mbeumo", position: "MID", team: "MUN", price: 8.0, bench: false },
      { elementId: 9, name: "E.Le Fée", position: "MID", team: "SUN", price: 6.0, bench: false },
      { elementId: 10, name: "João Pedro", position: "FWD", team: "CHE", price: 7.5, bench: false },
      { elementId: 11, name: "Thiago", position: "FWD", team: "BRE", price: 8.0, bench: false },
      { elementId: 12, name: "Kinsky", position: "GKP", team: "TOT", price: 4.5, bench: true },
      { elementId: 13, name: "Mateta", position: "FWD", team: "CRY", price: 6.5, bench: true },
      { elementId: 14, name: "Thomas", position: "DEF", team: "COV", price: 4.0, bench: true },
      { elementId: 15, name: "F.Kadıoğlu", position: "DEF", team: "BHA", price: 4.5, bench: true },
    ],
    value: 96.5, bank: 3.5, formation: "3-5-2", source: "captured_authenticated_draft",
  };

  /** Real values from `xp_public_gw01.json`. */
  const XP: Record<number, number> = {
    1: 3.63, 2: 0.78, 3: 2.40, 4: 3.07, 5: 5.77, 6: 4.04, 7: 3.07, 8: 3.91,
    9: 5.06, 10: 2.68, 11: 5.12, 12: 2.23, 13: 1.32, 14: 1.17, 15: 3.85,
  };

  const PROJECTIONS = SQUAD.players.map((p) => ({
    elementId: p.elementId, name: p.name, team: null, position: p.position,
    xp: XP[p.elementId] ?? null, xpSd: null, mode: 2, pAppears: null, p60: null,
    eMinutes: null, pGoal: null, pCleanSheet: null, pGe5: null, pGe10: null,
    q10: null, q90: null, decomposition: null, blank: false,
  }));

  /**
   * The engine's captaincy and transfer output, present throughout.
   *
   * Passing it is the whole point: the page must hold one answer even when the
   * heuristic has one of its own to offer. A fixture that omitted it would pass
   * against the bug.
   */
  const VIEW = {
    squad: SQUAD,
    event: { id: 1, deadlineTime: null },
    transfers: [{
      playerOut: { name: "F.Kadıoğlu" }, playerIn: { name: "Gabriel" },
      delta4: 3.8, confidence: 73, rationale: ["0.1% elite ownership adds differential upside"],
    }],
    captaincy: [{
      captain: { name: "Mbeumo" }, viceCaptain: { name: "Semenyo" },
      captainFixture: "HUL (A)", projectedCaptainPoints: 8.8,
    }],
  };

  async function renderWithSquad() {
    vi.resetModules();
    const ok = (value: unknown) => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: null, value,
      },
      initialising: false,
      reload: () => {},
    });
    vi.doMock("@/lib/data/useHeuristics", () => ({ useHeuristics: () => ok(VIEW) }));
    vi.doMock("@/lib/data/useArtifact", () => ({
      // Only the projection is served. Every other section renders its absent
      // line, which is Rule 2 and is asserted elsewhere in this file.
      useArtifact: (d: { key?: string }) =>
        String(d?.key).startsWith("projections")
          ? ok({ players: PROJECTIONS })
          : ok(null),
    }));
    vi.doMock("@/lib/data/artifact", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
      return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
    });
    const { default: Page } = await import("@/app/now/page");
    return render(<Page />);
  }

  it("recommends exactly one captain", async () => {
    const { container } = await renderWithSquad();
    // Both cards labelled their recommendation with a bold `Captain`, so counting
    // that label counts recommendations — as opposed to counting the word, which
    // also appears in the section's own subtitle.
    const labels = [...container.querySelectorAll("strong")]
      .filter((node) => (node.textContent ?? "").trim() === "Captain");
    expect(labels).toHaveLength(1);
    // The deleted card was the only thing that printed a vice-captain, and a
    // second armband arriving under any label would bring one back.
    expect(container.textContent).not.toMatch(/vice/i);
  });

  it("names the model's captain and not the heuristic's", async () => {
    const { container } = await renderWithSquad();
    const text = container.textContent ?? "";
    expect(text).toContain("B.Fernandes");
    // Mbeumo is still one of the fifteen, so the assertion is about the armband
    // rather than about the name appearing at all.
    expect(text).not.toMatch(/Captain\s*Mbeumo/);
  });

  it("shows no doubled figure standing beside an undoubled one", async () => {
    const { container } = await renderWithSquad();
    const text = container.textContent ?? "";
    // "8.8 proj" was `projectedPoints * 2`. Printed next to the model's undoubled
    // number it made the weaker player look like the stronger pick.
    expect(text).not.toContain("8.8 proj");
    // The model's own doubling is still shown, and still labelled as doubled.
    expect(text).toMatch(/doubled\s*11\.54/);
  });

  it("suggests no transfer anywhere on the page", async () => {
    const { container } = await renderWithSquad();
    const text = container.textContent ?? "";
    expect(text).toMatch(/No transfer is suggested/);
    expect(text).not.toContain("over 4 GW");
    expect(text).not.toContain("elite ownership");
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
