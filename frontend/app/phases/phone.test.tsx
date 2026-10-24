/**
 * Fixture runs at phone width.
 *
 * The properties that make the grid honest rather than merely small: case carries
 * venue and the digit carries difficulty (so colour is never the only channel), the
 * average excludes blanks instead of counting them as zero, easiest run sorts first,
 * and the measured team-strength section stays separate and labelled.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPhoneClubs, parseLabel } from "@/components/phases/FixtureRunsPhone";
import { stubPhone, unstubPhone } from "@/test/support/phone";

function club(
  teamId: number, short: string,
  entries: ReadonlyArray<readonly [number, string, number]>,
) {
  return {
    teamId, team: short, shortName: short, meanDifficulty: 0, totalDifficulty: 0,
    fixtures: entries.map(([gameweek, label, difficulty]) => ({ gameweek, label, difficulty })),
  };
}

/** Seven published weeks, so the six-column cut is visible. */
const weeks = [9, 10, 11, 12, 13, 14, 15];
const EASY = club(1, "AVL", weeks.map((w) => [w, w % 2 ? "FUL (H)" : "MUN (A)", 2] as const));
const HARD = club(2, "BRE", weeks.map((w) => [w, w % 2 ? "NFO (H)" : "MCI (A)", 4] as const));
const BLANKY = club(3, "TOT", [
  [9, "CRY (H)", 2], [10, "LEE (A)", 3], [12, "SUN (A)", 3], [13, "FUL (H)", 2], [14, "ARS (H)", 4],
]);
const DOUBLE = club(4, "LIV", [
  [9, "ARS (H)", 4], [10, "CRY (A)", 3], [10, "MUN (H)", 5], [11, "MUN (A)", 4],
  [12, "EVE (A)", 3], [13, "SUN (H)", 3], [14, "CHE (A)", 4],
]);

async function mountPhases(fixtureMatrix: unknown[] | null) {
  vi.resetModules();
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({
      artifact: {
        state: fixtureMatrix === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: fixtureMatrix === null ? "nothing is published at this path" : null,
        value: fixtureMatrix === null ? null : { fixtureMatrix },
      },
    }),
  }));
  vi.doMock("@/components/phases/TeamStrength", () => ({
    TeamStrength: () => <div data-testid="team-strength">strength</div>,
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
  unstubPhone();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/artifact");
  vi.doUnmock("@/components/phases/TeamStrength");
});

describe("buildPhoneClubs", () => {
  it("takes six gameweeks, whatever the list publishes", () => {
    const { weeks: shown } = buildPhoneClubs([EASY, HARD]);
    expect(shown).toEqual([9, 10, 11, 12, 13, 14]);
  });

  it("sorts the easiest run first and breaks ties by code", () => {
    const { clubs } = buildPhoneClubs([HARD, EASY, club(5, "AAA", weeks.map((w) => [w, "XXX (H)", 2] as const))]);
    expect(clubs.map((c) => c.code)).toEqual(["AAA", "AVL", "BRE"]);
  });

  it("averages over the weeks a club plays, never counting a blank as zero", () => {
    // Beside a club that plays every week, so GW11 is still a column.
    const { clubs } = buildPhoneClubs([EASY, BLANKY]);
    const tot = clubs.find((c) => c.code === "TOT")!;
    // GW9..14 with GW11 blank: (2+3+3+2+4)/5, not /6.
    expect(tot.average).toBeCloseTo(2.8, 5);
    expect(tot.weeks[2].legs).toHaveLength(0);
    expect(tot.weeks[2].difficulty).toBeNull();
  });

  it("rates a double by its harder fixture, the convention phases.ts applies", () => {
    const { clubs } = buildPhoneClubs([DOUBLE]);
    expect(clubs[0].weeks[1].legs).toHaveLength(2);
    expect(clubs[0].weeks[1].difficulty).toBe(5);
  });

  it("parses a label, and keeps one it does not recognise rather than dropping it", () => {
    expect(parseLabel("COV (H)")).toEqual({ code: "COV", home: true });
    expect(parseLabel("MCI (A)")).toEqual({ code: "MCI", home: false });
    expect(parseLabel("???")).toEqual({ code: "???", home: null });
  });
});

describe("the phone grid", () => {
  it("is a real table with a row per club and a cell per week, without a horizontal box", async () => {
    stubPhone();
    await mountPhases([EASY, HARD, BLANKY, DOUBLE]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Fixture runs");
    const table = screen.getByRole("table", { name: /gameweeks 9 to 14/i });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
    const rows = screen.getAllByTestId("fixture-runs-row");
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(within(row).getAllByRole("cell")).toHaveLength(7);
    expect(within(rows[0]).getByRole("rowheader").textContent).toBe("AVL");
  });

  it("writes lowercase for home and UPPERCASE for away, as desktop PhaseMatrix does", async () => {
    stubPhone();
    await mountPhases([EASY]);
    const cells = screen.getAllByTestId("fixture-runs-cell");
    // GW9 is odd: home against FUL.
    expect(cells[0].textContent).toBe("ful2");
    expect(cells[0]).toHaveAccessibleName("Gameweek 9: home against FUL, difficulty 2");
    // GW10: away at MUN.
    expect(cells[1].textContent).toBe("MUN2");
    expect(cells[1]).toHaveAccessibleName("Gameweek 10: away against MUN, difficulty 2");
  });

  it("shows a blank as a dash and spells it out", async () => {
    stubPhone();
    await mountPhases([EASY, BLANKY]);
    const totRow = screen.getAllByTestId("fixture-runs-row")
      .find((r) => within(r).getByRole("rowheader").textContent === "TOT")!;
    const blank = within(totRow).getAllByTestId("fixture-runs-cell")[2];
    expect(blank.textContent).toBe("—");
    expect(blank).toHaveAccessibleName("Gameweek 11: no fixture");
  });

  it("stacks both legs of a double inside the one cell", async () => {
    stubPhone();
    await mountPhases([DOUBLE]);
    const cell = screen.getAllByTestId("fixture-runs-cell")[1];
    expect(cell.textContent).toBe("CRY3mun5");
  });

  it("carries the legend: difficulty 1 to 5 and which case is home", async () => {
    stubPhone();
    await mountPhases([EASY]);
    const legend = screen.getByRole("group", { name: "Legend" });
    expect(legend.textContent).toContain("12345");
    expect(legend.textContent).toContain("lower home · CAPS away");
  });

  it("labels the grid as the published list, and keeps the measured section apart", async () => {
    stubPhone();
    await mountPhases([EASY]);
    expect(screen.getByText(/Published fixture list · FPL difficulty/)).toBeInTheDocument();
    const grid = screen.getByTestId("fixture-runs-phone");
    const measured = screen.getByText("Who has actually been good");
    expect(grid.contains(measured)).toBe(false);
    expect(screen.getByTestId("team-strength")).toBeInTheDocument();
  });

  it("falls back to one line and a heading when the fixture list cannot be read", async () => {
    stubPhone();
    await mountPhases(null);
    expect(screen.queryByTestId("fixture-runs-phone")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText("nothing is published at this path")).toBeInTheDocument();
  });
});
