/**
 * The two tabs, and what each one is allowed to say.
 *
 * Ports the assertions that lived in ManagerHistory.test.tsx before its content
 * split across the two panels — the bench leading, the em-dash never reading as
 * a zero, names rather than element ids, and the withheld transfer rate.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const LEDGER = {
  generatedAt: "2026-09-09T00:00:00+00:00", entryId: 20945, settledThrough: 3,
  names: new Map([
    [445, "Thiaw"], [418, "Maguire"], [426, "B.Fernandes"],
    [173, "Thomas"], [152, "Palestra"],
  ]),
  gameweeks: [
    {
      event: 1, points: 44, grossPoints: 44, transferCost: 0, transfersMade: 0,
      benchPoints: 2, averageEntryScore: 50, highestScore: 131, rank: 1,
      overallRank: 6124832, value: 1000, bank: 0, chip: null,
      captain: { element: 426, multiplier: 2, points: 2 },
      autoSubs: [{ elementIn: 173, elementOut: 152, pointsGained: 3 }],
      picks: [{ element: 426, multiplier: 2, points: 2, minutes: 90 }],
    },
    {
      event: 2, points: 109, grossPoints: 109, transferCost: 0, transfersMade: 0,
      benchPoints: 13, averageEntryScore: 81, highestScore: 161, rank: 1,
      overallRank: 1667220, value: 1001, bank: 0, chip: null,
      captain: { element: 426, multiplier: 2, points: 23 },
      autoSubs: [],
      picks: [{ element: 426, multiplier: 2, points: 23, minutes: 90 }],
    },
    {
      event: 3, points: 38, grossPoints: 38, transferCost: 0, transfersMade: 1,
      benchPoints: 12, averageEntryScore: 51, highestScore: 119, rank: 1,
      overallRank: 3427838, value: 999, bank: 0, chip: null,
      captain: { element: 426, multiplier: 2, points: 2 },
      autoSubs: [],
      picks: [{ element: 445, multiplier: 1, points: -1, minutes: 90 }],
    },
  ],
  transfers: [{
    event: 3, time: null, elementIn: 445, elementInCost: 50,
    elementOut: 418, elementOutCost: 50,
    inPointsByGw: new Map([[3, -1]]), outPointsByGw: new Map([[3, 2]]),
    inMultiplierByGw: new Map([[3, 1]]),
  }],
};

/**
 * `proven` reads its value off a private Symbol, so a hand-built artifact
 * cannot carry one — mocking it is how every artifact consumer is mounted in
 * this repo. `useArtifact` branches on the descriptor key because the Detail
 * panel also mounts DecisionReview, which reads a different artifact.
 */
async function mount(ledger: unknown = LEDGER) {
  vi.resetModules();
  const ok = (value: unknown) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { path: "fpl/manager_history.json", source: "local", producedAt: null, ageMs: null },
      reason: value === null ? "nothing is published at this path" : null,
      value,
    },
  });
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) =>
      (d?.key === "managerHistory" ? ok(ledger) : ok(null)),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: ReviewTabs } = await import("@/components/review/ReviewTabs");
  return render(<ReviewTabs />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("the tabs", () => {
  it("opens on Summary", async () => {
    await mount();
    expect(screen.getByTestId("review-tab-summary")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("review-tab-detail")).toHaveAttribute("aria-selected", "false");
  });

  it("shows the season's shape on Summary and no row tables", async () => {
    await mount();
    expect(screen.getByTestId("chart-rank")).toBeInTheDocument();
    expect(screen.getByTestId("chart-margin")).toBeInTheDocument();
    expect(screen.getByTestId("chart-bench")).toBeInTheDocument();
    // The detail rows belong to the other tab.
    expect(screen.queryByTestId("detail-week-3")).not.toBeInTheDocument();
  });

  it("switches to the detailed tables and drops the charts", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    expect(screen.getByTestId("detail-week-3")).toBeInTheDocument();
    expect(screen.getByTestId("detail-transfer-3")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-rank")).not.toBeInTheDocument();
  });

  it("switches back", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    await userEvent.click(screen.getByTestId("review-tab-summary"));
    expect(screen.getByTestId("chart-rank")).toBeInTheDocument();
  });
});

describe("Summary", () => {
  it("leads with the bench, which is the largest cost", async () => {
    await mount();
    expect(screen.getByTestId("summary-bench").textContent).toContain("27");
  });

  it("reports the season points and the margin over the field", async () => {
    await mount();
    expect(screen.getByTestId("summary-points").textContent).toContain("191");
    expect(screen.getByTestId("summary-points").textContent).toContain("9");
  });

  it("shows the latest rank and where it came from", async () => {
    await mount();
    const rank = screen.getByTestId("summary-rank").textContent ?? "";
    expect(rank).toContain("3.43m");
    expect(rank).toContain("6.12m");
  });

  it("prices the armband against the best of the fifteen", async () => {
    await mount();
    expect(screen.getByTestId("summary-armband").textContent).toContain("54");
  });

  it("says its own figures are settled, not projected", async () => {
    await mount();
    expect(screen.getByTestId("summary-caveat").textContent).toMatch(/settled record/i);
  });

  it("states its absence in one line when nothing is published", async () => {
    await mount(null);
    expect(screen.getByText(/manager history/i)).toBeInTheDocument();
  });
});

describe("Detailed data", () => {
  it("names the players rather than printing element ids", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    const row = screen.getByTestId("detail-transfer-3");
    expect(row.textContent).toContain("Thiaw");
    expect(row.textContent).toContain("Maguire");
    expect(row.textContent).not.toContain("445");
  });

  it("falls back to the id rather than inventing a name", async () => {
    await mount({ ...LEDGER, names: new Map() });
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    expect(screen.getByTestId("detail-transfer-3").textContent).toContain("445");
  });

  it("renders an unfinished window as a dash, never a zero", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    const row = screen.getByTestId("detail-transfer-3");
    // Same-gameweek is −3; +1, +2 and +3 cannot have settled at GW3.
    expect(row.textContent).toContain("−3");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("withholds the transfer rate and counts the clean windows", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    expect(screen.getByTestId("detail-aggregate").textContent).toMatch(/clean window/i);
  });

  it("totals the season in its own row", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    const all = screen.getByTestId("detail-all").textContent ?? "";
    expect(all).toContain("191");
    expect(all).toContain("27");
    expect(all).toContain("54");
  });

  it("carries a row per settled gameweek", async () => {
    await mount();
    await userEvent.click(screen.getByTestId("review-tab-detail"));
    expect(screen.getByTestId("detail-week-1")).toBeInTheDocument();
    expect(screen.getByTestId("detail-week-2")).toBeInTheDocument();
    expect(screen.getByTestId("detail-week-3")).toBeInTheDocument();
  });
});
