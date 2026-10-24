/**
 * Players at phone width.
 *
 * The desktop page is covered by `page.test.tsx`; this file runs the same page with
 * `matchMedia` answering "phone" and checks the structure the approved design
 * specifies: one compact list, real toggle buttons for position, ownership and
 * plan tags only where a source states them, and a source line that says whose
 * number it is.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubPhone, unstubPhone } from "@/test/support/phone";

function projection(id: number, over: Record<string, unknown> = {}) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", position: "MID",
    xp: 5, xpSd: 3, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.5, pGe10: 0.1,
    q10: 1, q25: 2, q50: 5, q75: 8, q90: 12, nFixtures: 1,
    decomposition: null, blank: false,
    ...over,
  };
}

const PLAYERS = [
  projection(1, { name: "Haaland", team: "MCI", position: "FWD", xp: 5.9, pGe10: 0.18 }),
  projection(2, { name: "Palmer", team: "CHE", position: "MID", xp: 5.66, pGe10: 0.19 }),
  projection(3, { name: "Raya", team: "ARS", position: "GKP", xp: 3.06, pGe10: 0.01 }),
  projection(4, { name: "Tavernier", team: "BOU", position: "MID", xp: 5.12, pGe10: 0.16 }),
];

const FIXTURES = [
  { teamId: 1, team: "Man City", shortName: "MCI", meanDifficulty: 3, totalDifficulty: 3,
    fixtures: [{ gameweek: 7, label: "BHA (H)", difficulty: 3 }] },
  { teamId: 2, team: "Chelsea", shortName: "CHE", meanDifficulty: 4, totalDifficulty: 4,
    fixtures: [{ gameweek: 7, label: "MUN (H)", difficulty: 4 }] },
];

async function mountPlayers({
  squad = [{ elementId: 2 }] as unknown[] | null,
  decision = {
    horizon: { weeks: [{ planned: true, transfers_in: [4] }, { planned: false, transfers_in: [3] }] },
  } as unknown,
  nDraws = 10000 as number | null,
} = {}) {
  vi.resetModules();
  const ok = (value: unknown) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { source: "local", producedAt: null, ageMs: null },
      reason: value === null ? "nothing is published at this path" : null,
      value,
    },
  });
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ok(squad === null ? null : { squad: { players: squad }, fixtureMatrix: FIXTURES }),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) => {
      const key = String(d?.key ?? "");
      if (key === "agentStatus") return ok({ gameweek: 7 });
      if (key.startsWith("projections")) {
        return ok({ players: PLAYERS, horizon: null, nDraws, gameweek: 7,
          generatedAt: "2026-10-23T19:46:00Z" });
      }
      if (key.startsWith("decision")) return ok(decision);
      return ok(null);
    },
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/players/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  unstubPhone();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

const names = () =>
  screen.getAllByTestId("players-phone-row").map((row) =>
    row.querySelector("span span")?.textContent);

describe("the phone list", () => {
  it("replaces the wide table with a ranked list, and titles itself Players", async () => {
    stubPhone();
    await mountPlayers();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Players");
    expect(screen.getByText("GW7 projection")).toBeInTheDocument();
    expect(screen.queryByTestId("research-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grid-row")).not.toBeInTheDocument();
    expect(names()).toEqual(["Haaland", "Palmer", "Tavernier", "Raya"]);
  });

  it("states xP, P(10+) and the fixture joined from the live list", async () => {
    stubPhone();
    await mountPlayers();
    const haaland = screen.getAllByTestId("players-phone-row")[0];
    expect(haaland.textContent).toContain("FWD · MCI · BHA (H)");
    expect(haaland.textContent).toContain("5.90");
    expect(haaland.textContent).toContain("18%");
  });

  it("says whose number it is, with the draw count and the run time in UTC", async () => {
    stubPhone();
    await mountPlayers();
    expect(screen.getByTestId("players-phone-source").textContent)
      .toBe("Our simulation · 10,000 draws · run 23 Oct, 19:46 UTC");
  });

  it("admits an unstated draw count instead of inventing one", async () => {
    stubPhone();
    await mountPlayers({ nDraws: null });
    expect(screen.getByTestId("players-phone-source").textContent)
      .toContain("draw count unstated");
  });
});

describe("tags", () => {
  it("marks OWNED from the squad on file and PLANNED from the plan's transfers in", async () => {
    stubPhone();
    await mountPlayers();
    const rowOf = (name: string) =>
      screen.getAllByTestId("players-phone-row").find((r) => r.textContent?.startsWith(name))!;
    expect(within(rowOf("Palmer")).getByText("OWNED")).toBeInTheDocument();
    expect(within(rowOf("Tavernier")).getByText("PLANNED")).toBeInTheDocument();
    // Raya is a transfer-in only in an unplanned (evaluation-tail) week: not planned.
    expect(within(rowOf("Raya")).queryByText("PLANNED")).not.toBeInTheDocument();
    expect(within(rowOf("Haaland")).queryByText("OWNED")).not.toBeInTheDocument();
  });

  it("draws no tag when neither source can be read", async () => {
    stubPhone();
    await mountPlayers({ squad: null, decision: null });
    expect(screen.queryByTestId("tag-owned")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tag-planned")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("players-phone-row")).toHaveLength(4);
  });
});

describe("the controls", () => {
  it("offers position as real toggle buttons, and they filter", async () => {
    stubPhone();
    await mountPlayers();
    const group = screen.getByRole("group", { name: "Position" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["All", "GKP", "DEF", "MID", "FWD"]);
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(group).getByRole("button", { name: "MID" }));
    expect(within(group).getByRole("button", { name: "MID" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    expect(names()).toEqual(["Palmer", "Tavernier"]);
  });

  it("has a labelled search that matches name or club", async () => {
    stubPhone();
    await mountPlayers();
    const search = screen.getByLabelText("Search players");
    fireEvent.change(search, { target: { value: "che" } });
    expect(await screen.findByText("Palmer")).toBeInTheDocument();
    expect(names()).toEqual(["Palmer"]);
  });

  it("keeps the squad filter and the sort reachable", async () => {
    stubPhone();
    await mountPlayers();
    fireEvent.click(screen.getByRole("button", { name: "My squad" }));
    expect(names()).toEqual(["Palmer"]);
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));

    fireEvent.click(screen.getByRole("button", { name: "Sort by 10+ pts" }));
    expect(names()).toEqual(["Palmer", "Haaland", "Tavernier", "Raya"]);
  });

  it("never lets a list quietly end", async () => {
    stubPhone();
    await mountPlayers();
    expect(screen.getByTestId("players-phone-count").textContent).toBe("showing 4 of 4");
  });
});

describe("the eight-week grid and the research tools stay reachable", () => {
  it("offers both behind closed disclosures, unmounted until opened", async () => {
    stubPhone();
    await mountPlayers();
    expect(screen.getByText("Eight-week projection grid")).toBeInTheDocument();
    expect(screen.getByText("Distributions, scatter and compare")).toBeInTheDocument();
    expect(screen.queryByTestId("grid-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("margin-research")).not.toBeInTheDocument();
  });
});

describe("desktop is untouched", () => {
  it("renders the original page when the viewport is not a phone", async () => {
    stubPhone(false);
    await mountPlayers();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Projections");
    expect(screen.queryByTestId("players-phone")).not.toBeInTheDocument();
  });
});
