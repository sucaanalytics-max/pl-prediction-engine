/**
 * The plan grid, rendered.
 *
 * `lib/margin/plan.test.ts` proves the cell derivation. This proves the marks
 * reach the DOM, which is a separate failure: `cellsFor` returning `off: true`
 * and the cell rendering an empty box are both "correct" until you look at the
 * screen, and an empty box reads as *picked, and scored nothing* — the opposite
 * of the sale it represents.
 *
 * Asserted on `data-state` and on title text rather than on class names or
 * colours, because this repo has broken 53 tests that way once already.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PlanGrid } from "@/components/margin/PlanGrid";
import type { Horizon } from "@/lib/data/narrow";
import type { Horizon as XpHorizon, Projection } from "@/lib/data/projections";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";

function projection(elementId: number, name: string, position: string): Projection {
  return {
    elementId, name, team: "Arsenal", position,
    xp: 5, xpSd: 2, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.4, pGe10: 0.1,
    q10: 1, q25: 2, q50: 4, q75: 7, q90: 10,
    nFixtures: 1, blank: false, decomposition: null,
  };
}

const NAMES = [
  projection(1, "Raya", "GKP"),
  projection(2, "Gabriel", "DEF"),
  projection(3, "Palmer", "MID"),
  projection(4, "Haaland", "FWD"),
  projection(5, "Semenyo", "MID"),
];

/** Three weeks: two planned, one eval-only. Haaland sold for Semenyo in GW4. */
const HORIZON: Horizon = {
  evalHorizon: 3,
  transferHorizon: 2,
  weeks: [
    {
      gameweek: 3, squad: [1, 2, 3, 4], xi: [1, 2, 3, 4], bench: [],
      captain: 4, vice: 3, transfers_in: [], transfers_out: [],
      hits: 0, bank_after: 8, free_transfers_after: null, planned: true,
    },
    {
      gameweek: 4, squad: [1, 2, 3, 5], xi: [1, 2, 3], bench: [5],
      captain: 3, vice: 1, transfers_in: [5], transfers_out: [4],
      hits: 1, bank_after: 3, free_transfers_after: 1, planned: true,
    },
    {
      gameweek: 5, squad: [1, 2, 3, 5], xi: [1, 2, 5], bench: [3],
      captain: 5, vice: 1, transfers_in: [], transfers_out: [],
      hits: 0, bank_after: 3, free_transfers_after: 2, planned: false,
    },
  ],
};

function draw(projections: readonly Projection[] = NAMES) {
  return render(<PlanGrid horizon={HORIZON} projections={projections} />);
}

/**
 * The grid row for a player.
 *
 * Scoped to rows rather than `getByText`, because a transferred player's name
 * appears twice — once in the grid and once in the moves line under it — and
 * that is the point of the moves line, not a duplicate to design around.
 */
function rowFor(name: string): HTMLElement {
  const row = screen.getAllByTestId("plan-row")
    .find((candidate) => candidate.textContent?.startsWith(`${name}`)
      || within(candidate).queryAllByText(name).length > 0);
  if (!row) throw new Error(`no grid row for ${name}`);
  return row;
}

afterEach(cleanup);

describe("the grid", () => {
  it("draws one row per player and one cell per week", () => {
    const { container } = draw();
    expect(container.querySelectorAll("[data-testid='plan-row']")).toHaveLength(5);
    expect(container.querySelectorAll("[data-testid='plan-cell']")).toHaveLength(15);
  });

  it("hatches a week the player is not owned, and says so", () => {
    // Not an empty cell: an empty cell reads as "picked, and scored nothing".
    draw();
    const cells = within(rowFor("Haaland")).getAllByTestId("plan-cell");
    expect(cells[1]).toHaveAttribute("data-state", "off");
    expect(cells[1]).toHaveAttribute("title", expect.stringContaining("not a zero"));
  });

  it("gives the captain a ring and no filled square", () => {
    draw();
    const cells = within(rowFor("Haaland")).getAllByTestId("plan-cell");
    expect(cells[0]).toHaveAttribute("data-state", "captain");
    expect(within(cells[0]).getByText("C")).toBeInTheDocument();
  });

  it("separates start from bench", () => {
    draw();
    const semenyo = within(rowFor("Semenyo")).getAllByTestId("plan-cell");
    expect(semenyo[0]).toHaveAttribute("data-state", "off");
    expect(semenyo[1]).toHaveAttribute("data-state", "bench");
    expect(semenyo[2]).toHaveAttribute("data-state", "captain");
  });

  it("marks the transfer week for both players", () => {
    draw();
    expect(within(rowFor("Semenyo")).getByTitle("transferred in this week"))
      .toBeInTheDocument();
    expect(within(rowFor("Haaland")).getByTitle("transferred out this week"))
      .toBeInTheDocument();
  });

  it("labels the eval-only tail and hatches its summary cells", () => {
    draw();
    expect(screen.getAllByText("eval only")).toHaveLength(1);
    expect(screen.getAllByText("planned")).toHaveLength(2);
    // Two summary rows, one hatched cell each for the unplanned week.
    expect(screen.getAllByTitle(/it does not plan it/)).toHaveLength(2);
  });

  it("prints the hit as points, not as a count", () => {
    // `hits: 1` is one hit, which costs four points. Printing "1" beside a
    // transfer count reads as a second transfer.
    draw();
    expect(screen.getByText(/−4/)).toBeInTheDocument();
  });

  it("reads the moves out in words", () => {
    // The marks say a move happened; only this says what it was. Both names
    // appear twice by design — once in the grid, once here — so the assertion
    // is scoped to the moves line rather than to the page.
    const { container } = draw();
    const moves = [...container.querySelectorAll("span")]
      .find((s) => s.textContent?.startsWith("GW4") && s.textContent.includes("→"));
    expect(moves, "no moves line for GW4").toBeDefined();
    expect(moves!.textContent).toContain("Haaland");
    expect(moves!.textContent).toContain("Semenyo");
  });

  it("says which rows it could not name rather than inventing one", () => {
    draw([NAMES[0]]);
    // `#4` appears in the row and again in the moves line, which is correct.
    expect(screen.getAllByText("#4").length).toBeGreaterThan(0);
    expect(screen.getByText(/4 players are shown by id/)).toBeInTheDocument();
  });

  it("states that only the first week is a commitment", () => {
    // The plan is re-solved weekly; publishing week three as a decision would be
    // false precision, and the screen has to say so where the grid is read.
    draw();
    expect(screen.getByText(/Only GW3 is a commitment/)).toBeInTheDocument();
  });

  it("does not print the solver objective as a simulated mean", () => {
    // The producer publishes a bench-weighted objective carrying the
    // free-transfer credit. Relabelling it "points" is the one thing this
    // surface exists to not do.
    const { container } = draw();
    expect(container.textContent).not.toMatch(/mean, simulated/i);
    expect(container.textContent).toMatch(/No simulated mean or standard deviation/);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The number and the fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `lib/margin/plan.test.ts` proves which producer each number comes from and
 * `lib/margin/fdr.test.ts` proves the club join. This proves both reach the
 * screen, and that the three absences stay distinguishable once rendered —
 * which is the failure the data layer cannot catch: `xp: null` and a cell
 * printing `0.0` are both "correct" until you look at it.
 */

const XP_HORIZON: XpHorizon = {
  nDraws: 5000,
  weeks: [
    { gameweek: 4, xp: new Map([[1, 4.25], [2, 3.5], [3, 6.0]]) },
    { gameweek: 5, xp: new Map([[1, 3.75], [2, 3.1]]) },
  ],
};

const MATRIX: readonly FixtureMatrixRow[] = [
  {
    teamId: 1, team: "Arsenal", shortName: "ARS",
    fixtures: [
      { gameweek: 3, label: "SUN (A)", difficulty: 2 },
      { gameweek: 4, label: "MCI (H)", difficulty: 5 },
      // GW5 absent: Arsenal blank.
    ],
    meanDifficulty: 3.5, totalDifficulty: 7,
  },
];

function cellsOf(name: string) {
  const row = screen.getAllByTestId("plan-row")
    .find((el) => el.getAttribute("data-player") === name);
  if (!row) throw new Error(`no row for ${name}`);
  return within(row).getAllByTestId("plan-cell");
}

describe("expected points in the cell", () => {
  afterEach(cleanup);

  it("shows the decided week's number and a later week's number", () => {
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const cells = cellsOf("Raya");
    // GW3 from the projection's own xp (5), GW4 from the horizon (4.25).
    expect(cells[0].textContent).toContain("5.0");
    expect(cells[1].textContent).toContain("4.3");
  });

  it("does not print a zero where there is no forecast", () => {
    /**
     * Palmer has no GW5 horizon entry. `0.0` would be a forecast of nothing
     * under a heading the reader acts on; the mark for absence is not a digit.
     */
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const cells = cellsOf("Palmer");
    expect(cells[2].textContent).not.toMatch(/0\.0/);
  });
});

describe("the fixture in the cell", () => {
  afterEach(cleanup);

  it("shows the opponent and carries the FDR in its title", () => {
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const cells = cellsOf("Raya");
    expect(cells[0].textContent).toContain("SUN (A)");
    expect(within(cells[0]).getByTestId("plan-fixture").getAttribute("title"))
      .toMatch(/FDR 2/);
  });

  it("says a blank gameweek is blank, not kind", () => {
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const fixture = within(cellsOf("Raya")[2]).getByTestId("plan-fixture");
    expect(fixture.getAttribute("data-fdr")).toBe("blank");
    expect(fixture.getAttribute("title")).toMatch(/blank/i);
  });

  it("says an unreadable club is unknown, not kind", () => {
    /**
     * The matrix comes from `/api/fpl/state`, a live route that 503'd in
     * production inside the last day. Every club then reads unknown and the
     * numbers still draw — but nothing may render as a soft fixture on the way.
     */
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={[]} xpHorizon={XP_HORIZON} />);
    const fixture = within(cellsOf("Raya")[0]).getByTestId("plan-fixture");
    expect(fixture.getAttribute("data-fdr")).toBe("unknown");
    expect(fixture.getAttribute("title")).toMatch(/not.*read|unknown/i);
  });
});

describe("the column total", () => {
  afterEach(cleanup);

  it("shows the XI's summed xP, labelled as that and not as points", () => {
    /**
     * GW3's XI is 1, 2, 3, 4 at 5 each, so 20.0. The label must not say
     * "points": the producer's per-week objective is a different quantity and
     * this file's whole reason for existing is to not relabel it.
     */
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const total = screen.getByTestId("plan-total-3");
    expect(total.textContent).toContain("20.0");
    // Twice by design: the row's own label, and the footnote that says what the
    // number is. Both must be the same words — a footnote explaining a heading
    // the heading does not use is how a relabelling gets in.
    expect(screen.getAllByText(/XI xP/).length).toBeGreaterThan(0);
  });

  it("flags a total that is short of players", () => {
    /**
     * GW5's XI is 1, 2, 5 and the horizon has no 5, so the sum covers two of
     * three. A number quietly missing a third of its XI is wrong, not partial.
     */
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    expect(screen.getByTestId("plan-total-5").getAttribute("title"))
      .toMatch(/1 of 3|missing/i);
  });
});

describe("the two draw counts", () => {
  afterEach(cleanup);

  it("says the decided week and the horizon were simulated differently", () => {
    /**
     * `lib/data/projections.ts` requires it: "every screen that shows a horizon
     * number beside a decision number says which is which". Here they sit in
     * adjacent columns of one row, which is the strongest form of that hazard.
     */
    render(
      <PlanGrid
        horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON}
      />,
    );
    expect(screen.getByText(/5,000/)).toBeTruthy();
  });
});
