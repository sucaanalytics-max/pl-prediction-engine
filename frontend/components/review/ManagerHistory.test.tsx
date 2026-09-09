/**
 * The outcome ledger on /review.
 *
 * It sits under DecisionReview, which judges FORESEEABILITY against the sealed
 * forecast and is careful never to manufacture blame — `indistinguishable`
 * exists so arithmetic noise never becomes a lesson. This judges OUTCOME. The
 * two must not read as one verdict, so nothing here is coloured good or bad:
 * a -3 is a number, not a reproach.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const HISTORY = {
  generatedAt: "2026-09-09T00:00:00+00:00", entryId: 20945, settledThrough: 3,
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
      autoSubs: [], picks: [{ element: 426, multiplier: 2, points: 23, minutes: 90 }],
    },
    {
      event: 3, points: 38, grossPoints: 38, transferCost: 0, transfersMade: 1,
      benchPoints: 12, averageEntryScore: 51, highestScore: 119, rank: 1,
      overallRank: 3427838, value: 999, bank: 0, chip: null,
      captain: { element: 426, multiplier: 2, points: 2 },
      autoSubs: [], picks: [{ element: 445, multiplier: 1, points: -1, minutes: 90 }],
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
 * `proven` reads the value off a private Symbol key, so a hand-built artifact
 * cannot carry one. Mocking `proven` is how every other suite in this repo
 * mounts an artifact consumer — see `app/players/page.test.tsx`. Without it
 * this renders the absence card and passes for the wrong reason.
 */
async function mount(value: unknown = HISTORY) {
  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: {
          path: "fpl/manager_history.json", source: "local",
          producedAt: null, ageMs: null,
        },
        reason: value === null ? "nothing is published at this path" : null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: ManagerHistory } =
    await import("@/components/review/ManagerHistory");
  return render(<ManagerHistory />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("ManagerHistory", () => {
  it("leads with the largest cost, which is the bench", async () => {
    await mount();
    expect(screen.getByTestId("bench-waste").textContent).toContain("27");
  });

  it("reports the margin over the field", async () => {
    await mount();
    expect(screen.getByTestId("vs-average").textContent).toContain("9");
  });

  it("shows the one transfer with its settled window", async () => {
    await mount();
    expect(screen.getByTestId("transfer-row-3").textContent).toContain("-3");
  });

  it("says a window is not yet measurable rather than showing zero", async () => {
    await mount();
    // Spans 2, 3 and 4 cannot have settled with settledThrough = 3.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("withholds the season rate and states why", async () => {
    await mount();
    expect(screen.getByTestId("transfer-aggregate").textContent)
      .toMatch(/clean window/i);
  });

  it("prices the armband against the best of the fifteen", async () => {
    await mount();
    expect(screen.getByTestId("captaincy-cost")).toBeInTheDocument();
  });

  it("draws a row per settled gameweek", async () => {
    await mount();
    expect(screen.getByTestId("manager-week-1")).toBeInTheDocument();
    expect(screen.getByTestId("manager-week-3")).toBeInTheDocument();
  });

  it("states its own absence in one line when nothing is published", async () => {
    await mount(null);
    // StateCard composes its own sentence around `what`; assert on the subject
    // rather than on copy this component does not own.
    expect(screen.getByText(/manager history/i)).toBeInTheDocument();
  });
});
