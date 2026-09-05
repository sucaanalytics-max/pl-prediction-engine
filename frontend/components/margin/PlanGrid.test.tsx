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
    //
    // `getAllByText` because −4 now appears twice on purpose: once in the
    // summary row and once in the transfer section's cost column. The claim is
    // that a hit is priced in POINTS wherever it is shown, so more than one
    // occurrence satisfies it — a single-match query would fail on a second
    // correct rendering.
    draw();
    expect(screen.getAllByText(/−4/).length).toBeGreaterThan(0);
  });

  it("reads the moves out in words", () => {
    // The marks say a move happened; only this says what it was. Both names
    // appear twice by design — once in the grid, once here — so the assertion is
    // scoped to the move's own row rather than to the page.
    //
    // It used to find that row by looking for a `<span>` starting "GW4" and
    // containing an arrow, which was the old one-line rendering. The moves are a
    // section now, so the query addresses it by test id; the claim is unchanged.
    draw();
    const moves = screen.getAllByTestId("plan-move")
      .find((el) => el.textContent?.includes("GW4"));
    expect(moves, "no move row for GW4").toBeDefined();
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


describe("provisional versus sealed", () => {
  afterEach(cleanup);

  /**
   * The grid is populated all week now, because the agent solves on every
   * refresh rather than only at the seal. Most of what it draws is therefore a
   * re-solve that will disagree with itself as team news lands, and the reader
   * has no way to tell that from the committed plan by looking at the cells.
   *
   * So the header carries which it is and how old it is. Age comes from
   * `ageLine`, the same helper every other provenance line here uses — a second
   * relative-time formatter would drift from it and disagree on the awkward
   * cases it already handles.
   */

  const SOLVED_AT = "2026-09-05T09:00:00Z";

  it("says a midweek plan is provisional, and how old it is", () => {
    render(
      <PlanGrid
        horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} sealed={false} solvedAt={SOLVED_AT}
      />,
    );
    expect(screen.getByTestId("plan-provenance").textContent)
      .toMatch(/provisional/i);
    expect(screen.getByTestId("plan-provenance").textContent)
      .toMatch(/old|Sep|Sat|Sun|Mon|Tue|Wed|Thu|Fri/);
  });

  it("does not caveat the sealed plan as provisional", () => {
    /**
     * The committed one has been notified on and the forecast was sealed against
     * it. Putting "will be re-solved" on that would understate the only decision
     * of the week that is actually a commitment.
     */
    render(
      <PlanGrid
        horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} sealed={true} solvedAt={SOLVED_AT}
      />,
    );
    expect(screen.getByTestId("plan-provenance").textContent)
      .not.toMatch(/provisional/i);
  });

  it("still says which it is when the timestamp is unreadable", () => {
    /**
     * Age and status are two facts, and losing the stamp must not lose both.
     * `ageLine` returns null for an absent or unparseable date by design.
     */
    render(
      <PlanGrid
        horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} sealed={false} solvedAt={null}
      />,
    );
    expect(screen.getByTestId("plan-provenance").textContent)
      .toMatch(/provisional/i);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Reading twenty-one rows
// ─────────────────────────────────────────────────────────────────────────────

describe("the lines are banded", () => {
  afterEach(cleanup);

  /**
   * Twenty-one rows in four lines were an undifferentiated stack. The band is
   * the structural half of the fix; `positionHue` is the chromatic half and is
   * confined to the name column, never the cell field.
   */

  it("heads each line that is present, in reading order", () => {
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const bands = screen.getAllByTestId("plan-band").map((el) => el.textContent);
    expect(bands).toEqual(["Goalkeepers", "Defenders", "Midfielders", "Forwards"]);
  });

  it("does not head a line nobody is picked in", () => {
    // An empty "Forwards" heading claims a line the squad does not field.
    const noForwards = NAMES.filter((p) => p.position !== "FWD");
    const horizon = {
      ...HORIZON,
      weeks: HORIZON.weeks.map((w) => ({
        ...w, squad: w.squad.filter((i) => i !== 4), xi: w.xi.filter((i) => i !== 4),
        captain: w.captain === 4 ? null : w.captain,
      })),
    };
    render(<PlanGrid horizon={horizon} projections={noForwards} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    expect(screen.getAllByTestId("plan-band").map((el) => el.textContent))
      .not.toContain("Forwards");
  });

  it("puts every player under their own line", () => {
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const order = screen.getAllByTestId(/^plan-(band|row)$/)
      .map((el) => el.getAttribute("data-player") ?? el.textContent);
    expect(order).toEqual([
      "Goalkeepers", "Raya",
      "Defenders", "Gabriel",
      "Midfielders", "Palmer", "Semenyo",
      "Forwards", "Haaland",
    ]);
  });
});

describe("the transfer section", () => {
  afterEach(cleanup);

  /**
   * The moves used to be one run-on line under the grid — every week's transfers
   * concatenated, with no cost, no bank and no prices. It is the half of the plan
   * a human actually executes, so it gets a section.
   */

  const PRICES = new Map([[4, 15.5], [5, 6.9]]);

  it("gives each week that moves its own row, out then in", () => {
    render(
      <PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} prices={PRICES} />,
    );
    const rows = screen.getAllByTestId("plan-move");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("GW4");
    expect(rows[0].textContent).toContain("Haaland");
    expect(rows[0].textContent).toContain("Semenyo");
  });

  it("prices a move when the price is known", () => {
    render(
      <PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} prices={PRICES} />,
    );
    expect(screen.getByTestId("plan-move").textContent).toMatch(/15\.5/);
    expect(screen.getByTestId("plan-move").textContent).toMatch(/6\.9/);
  });

  it("still renders the move when no price is known", () => {
    /**
     * Prices come from `playerStats`, a THIRD artifact — the plan and the
     * projection are the other two. A move whose price could not be looked up is
     * still a move the human has to make; dropping the row, or printing £0.0,
     * would both be worse than saying nothing about the price.
     */
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    const row = screen.getByTestId("plan-move");
    expect(row.textContent).toContain("Haaland");
    expect(row.textContent).not.toMatch(/£0\.0/);
  });

  it("names the weeks it plans no move for", () => {
    // Silence would read as "no plan for GW5", when the solve did price it.
    render(<PlanGrid horizon={HORIZON} projections={NAMES} fixtures={MATRIX} xpHorizon={XP_HORIZON} />);
    expect(screen.getByTestId("plan-quiet-weeks").textContent).toMatch(/GW3/);
    expect(screen.getByTestId("plan-quiet-weeks").textContent).toMatch(/GW5/);
  });
});


describe("naming a player who was sold", () => {
  afterEach(cleanup);

  it("names a transfer-out that no week's squad contains", () => {
    /**
     * Caught by looking at the real board, not by a test: GW4's row read
     * "#152 → Tavernier". A player sold in the FIRST planned week is in no
     * week's `squad` — week 0's squad is already post-transfer — so he has no
     * grid row, and the section was taking names from the rows.
     *
     * The projection has all 652 players and is already loaded here, so a sold
     * player has a name available; falling back to an id when one is in hand is
     * the grid's rule for a player the PROJECTION cannot see, not for one the
     * row list happens to exclude.
     */
    const horizon = {
      ...HORIZON,
      weeks: HORIZON.weeks.map((w, i) =>
        i === 0 ? { ...w, transfers_out: [99], transfers_in: [] } : w),
    };
    const sold = { ...projection(99, "Palestra", "DEF"), team: "Chelsea" };
    render(
      <PlanGrid horizon={horizon} projections={[...NAMES, sold]} fixtures={MATRIX}
        xpHorizon={XP_HORIZON} />,
    );
    const row = screen.getAllByTestId("plan-move")
      .find((el) => el.textContent?.includes("GW3"));
    expect(row?.textContent).toContain("Palestra");
    expect(row?.textContent).not.toContain("#99");
  });
});
