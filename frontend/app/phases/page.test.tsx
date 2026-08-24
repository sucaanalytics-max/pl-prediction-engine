/**
 * Phases — page level only.
 *
 * The matrix's arithmetic is covered in `lib/projections/phases.test.ts`. What is
 * left here is what a page owns: that it draws the matrix from the live fixture
 * list, and that when the fixture list cannot be read it says so in one line
 * rather than rendering an empty twenty-row grid — which is the failure mode that
 * matters, because an all-blank matrix looks like a season with no fixtures rather
 * than like a fetch that failed.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function club(name: string, short: string, fdr: number[], teamId: number) {
  return {
    teamId, team: name, shortName: short,
    fixtures: fdr.map((difficulty, index) => ({
      gameweek: index + 2, label: `OPP (H)`, difficulty,
    })),
    meanDifficulty: 0, totalDifficulty: 0,
  };
}

const FIXTURES = [
  club("Liverpool", "LIV", [2, 2, 2, 5], 1),
  club("Arsenal", "ARS", [5, 5, 5, 5], 2),
];

async function mountPhases({
  fixtureMatrix = FIXTURES as unknown[] | null,
  reason = null as string | null,
} = {}) {
  vi.resetModules();
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({
      artifact: {
        state: fixtureMatrix === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason,
        value: fixtureMatrix === null ? null : { fixtureMatrix },
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/phases/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/artifact");
});

describe("the page draws the matrix", () => {
  it("renders a row per club and finds the run", async () => {
    await mountPhases();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Phases");
    expect(screen.getAllByTestId("phase-row")).toHaveLength(2);
    expect(screen.getAllByTestId("phase-entry")).toHaveLength(1);
    expect(screen.getByTestId("phase-count").textContent).toBe("1 run in 2 clubs");
  });

  it("offers the run-length and threshold controls", async () => {
    await mountPhases();
    expect(screen.getByLabelText("A run is 4 or more gameweeks")).toBeInTheDocument();
    expect(screen.getByText("kind (FDR 1–2)")).toBeInTheDocument();
  });

  it("says so when nothing qualifies, rather than showing an empty list", async () => {
    await mountPhases({ fixtureMatrix: [club("Arsenal", "ARS", [5, 5, 5, 5], 2)] });
    expect(screen.getByText(/that is an answer, not/i)).toBeInTheDocument();
  });
});

describe("the page states its own absence", () => {
  it("gives the artifact's own reason in one line, not an empty grid", async () => {
    await mountPhases({
      fixtureMatrix: null,
      reason: "nothing is published at this path",
    });
    expect(screen.queryAllByTestId("phase-row")).toHaveLength(0);
    expect(screen.getByText("nothing is published at this path")).toBeInTheDocument();
  });

  it("falls back to its own sentence when the envelope gives no reason", async () => {
    await mountPhases({ fixtureMatrix: null });
    expect(screen.getByText(/fixture list could not be read/i)).toBeInTheDocument();
  });
});
