/**
 * Stats at phone width — tabs split by SOURCE.
 *
 * The rule under test is the one the page's docstring states: a column is never
 * read against another source's. So each tab holds only its own source's columns,
 * says how old that source is, and nothing from one tab appears in another.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOURCE_TABS, columnsFor } from "@/components/stats/StatsPhone";
import { stubPhone, unstubPhone } from "@/test/support/phone";

function statRow(id: number, over: Record<string, unknown> = {}) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", position: "MID",
    minutes: 180, goals: 2, assists: 1, xg: 1.4, xa: 0.6,
    fouls_committed: null, fouls_per_90: null, fpl_ownership: 12.5,
    fpl_price: 7.5, form: 4.2, available: true, status: "a",
    chanceOfPlaying: null, ratesAreMeaningful: true,
    ...over,
  };
}

function projection(id: number, over: Record<string, unknown> = {}) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", position: "MID",
    xp: 5.5, xpSd: 3.1, mode: 2, pAppears: 0.9, p60: 0.9, eMinutes: 80,
    pGoal: 0.3, pCleanSheet: 0.3, pGe5: 0.5, pGe10: 0.15,
    q10: 1, q25: 2, q50: 5, q75: 8, q90: 12, nFixtures: 1,
    decomposition: null, blank: false, ...over,
  };
}

function eventRow(id: number) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", minutes: 90, shots: 4, keyPasses: 2,
    goals: 1, assists: 0, xg: 0.9, xa: 0.2, npXg: 0.7, matches: 1, xgChain: 1.1,
    xgBuildup: 0.3, shotsPer90: 4, xgPer90: null, xaPer90: null,
  };
}

async function mountStats({
  squad = [{ elementId: 1 }] as unknown[],
  projections = { players: [projection(1), projection(2)], nDraws: 10000, gameweek: 7,
    generatedAt: "2026-10-23T19:46:00Z" } as unknown,
  events = { players: [eventRow(1), eventRow(2)], generatedAt: "2026-10-24T05:00:00Z",
    coverage: {}, notAvailable: [] } as unknown,
} = {}) {
  vi.resetModules();
  const ok = (value: unknown, producedAt: string | null = null) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { source: "local", producedAt, ageMs: null, freshnessBudgetMs: null },
      reason: value === null ? "nothing is published at this path" : null,
      value,
    },
  });
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ok({ squad: { players: squad } }),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) => {
      const key = String(d?.key ?? "");
      if (key === "agentStatus") return ok({ gameweek: 7 });
      if (key === "playerStats") return ok([statRow(1), statRow(2)], "2026-10-23T10:41:00Z");
      if (key.startsWith("projections:")) return ok(projections);
      if (key === "playerEvents") return ok(events, "2026-10-24T05:00:00Z");
      return ok(null);
    },
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/stats/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  unstubPhone();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

const headers = () =>
  within(screen.getByRole("tabpanel")).getAllByRole("columnheader").map((h) =>
    h.textContent?.replace(/ [▲▼]$/, ""));

describe("the tabs", () => {
  it("is an ARIA tablist of the three sources, opening on FPL's record", async () => {
    stubPhone();
    await mountStats();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Stats");
    const tabs = within(screen.getByRole("tablist", { name: "Source" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["FPL record", "Our model", "Understat"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("FPL record");
  });

  it("moves between tabs by arrow key, the way a tablist should", async () => {
    stubPhone();
    await mountStats();
    const [fpl, model, understat] = screen.getAllByRole("tab");
    fireEvent.keyDown(fpl, { key: "ArrowRight" });
    expect(model).toHaveAttribute("aria-selected", "true");
    expect(model).toHaveFocus();
    fireEvent.keyDown(model, { key: "End" });
    expect(understat).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(understat, { key: "ArrowRight" });
    expect(fpl).toHaveAttribute("aria-selected", "true");
  });
});

describe("a tab holds one source", () => {
  it("gives each tab only its own columns, and no column appears in two", async () => {
    stubPhone();
    await mountStats();
    const seen: Record<string, string[]> = {};
    for (const tab of screen.getAllByRole("tab")) {
      fireEvent.click(tab);
      seen[tab.textContent as string] = headers();
    }
    expect(seen["FPL record"]).toEqual(
      ["Player", "Mins", "G", "A", "xG", "xA", "G − xG", "Form"]);
    expect(seen["Our model"]).toEqual(
      ["Player", "xP", "±", "P(60)", "E[min]", "P(goal)", "P(10+)"]);
    expect(seen["Understat"]).toEqual(
      ["Player", "Mins", "Sh", "Sh/90", "npxG", "xA", "KP", "xGChain"]);
    // The model's columns are not FPL's, and FPL's xG is not Understat's npxG.
    expect(seen["FPL record"]).not.toContain("xP");
    expect(seen["Understat"]).not.toContain("xG");
    expect(seen["Our model"]).not.toContain("Form");
  });

  it("resolves every column from the desktop sheet's own definitions", () => {
    for (const tab of SOURCE_TABS) {
      expect(columnsFor(tab)).toHaveLength(tab.columns.length);
    }
  });

  it("states the source and its timestamp on a card above the table", async () => {
    stubPhone();
    await mountStats();
    const card = () => screen.getByTestId("stats-source-card").textContent;
    expect(card()).toContain("What FPL has recorded");
    expect(card()).toContain("Official FPL data");
    expect(card()).toContain("updated 23 Oct, 10:41 UTC");

    fireEvent.click(screen.getByRole("tab", { name: "Our model" }));
    expect(card()).toContain("Our simulation, not a record");
    expect(card()).toContain("10,000 draws");
    expect(card()).toContain("run 23 Oct, 19:46 UTC");

    fireEvent.click(screen.getByRole("tab", { name: "Understat" }));
    expect(card()).toContain("Third-party model, its own definitions");
    expect(card()).toContain("updated 24 Oct, 05:00 UTC");
  });

  it("says plainly when a source could not be read, and shows no table for it", async () => {
    stubPhone();
    await mountStats({ events: null });
    fireEvent.click(screen.getByRole("tab", { name: "Understat" }));
    expect(screen.getByText("nothing is published at this path")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("the table", () => {
  it("scrolls inside its own labelled, focusable box", async () => {
    stubPhone();
    await mountStats();
    const box = screen.getByRole("region", { name: /scrolls sideways/ });
    expect(box).toHaveAttribute("tabindex", "0");
    expect(box.style.overflowX).toBe("auto");
    expect(within(box).getByRole("table")).toBeInTheDocument();
  });

  it("opens on the squad when one is on file, and the filter can widen it", async () => {
    stubPhone();
    await mountStats();
    expect(screen.getAllByTestId("stats-phone-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "My squad" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    expect(screen.getAllByTestId("stats-phone-row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Not owned" }));
    expect(screen.getAllByTestId("stats-phone-row")[0].textContent).toContain("P2");
  });

  it("opens on everyone when no squad is on file", async () => {
    stubPhone();
    await mountStats({ squad: [] });
    expect(screen.getAllByTestId("stats-phone-row")).toHaveLength(2);
  });

  it("renders a withheld figure as the empty mark, never as zero", async () => {
    stubPhone();
    await mountStats({
      projections: { players: [projection(1, { pGoal: null })], nDraws: 100, gameweek: 7,
        generatedAt: null },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Our model" }));
    const row = screen.getByTestId("stats-phone-row");
    expect(row.textContent).toContain("∅");
    expect(screen.getByTestId("stats-source-card").textContent).toContain("run time unstated");
  });

  it("sorts on a header, marking the live column through aria-sort", async () => {
    stubPhone();
    await mountStats({ squad: [] });
    fireEvent.click(screen.getByRole("tab", { name: "Our model" }));
    const xp = screen.getByRole("columnheader", { name: /xP/ });
    expect(xp).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(within(xp).getByRole("button"));
    expect(xp).toHaveAttribute("aria-sort", "ascending");
  });

  it("keeps every tab target at least 44px tall", async () => {
    stubPhone();
    await mountStats();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.style.minHeight).toBe("44px");
    }
  });
});

describe("desktop is untouched", () => {
  it("renders the question sheet when the viewport is not a phone", async () => {
    stubPhone(false);
    await mountStats();
    expect(screen.queryByTestId("stats-phone")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Is he playing?" })).toBeInTheDocument();
  });
});
