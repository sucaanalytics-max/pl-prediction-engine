/**
 * The planner's controls, and where they live.
 *
 * `lib/margin/planner.test.ts` proves the arithmetic. This proves the thing the
 * arithmetic cannot: that a control's *position* says what it governs.
 *
 * The XI switch used to sit in its own column at the left of the row, level
 * with the player's name and spanning six gameweek columns visually. It only
 * ever applied to the first of them — the only week the projection can solve an
 * eleven for — so its placement made a claim the code did not. It is inside the
 * GW1 cell now, and absent from every other week, which is a statement no
 * tooltip has to make.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Planner } from "@/components/margin/Planner";
import type { FixtureMatrixRow, SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

let nextId = 1;
function player(position: string, name: string, price = 5): SquadPlayer {
  const id = nextId++;
  return {
    name, position, team: "ARS", price, elementId: id,
    bench: undefined, role: undefined, fixture: undefined,
    fixtures: [1, 2, 3].map((gw) => ({ gameweek: gw, label: `OPP${gw}`, difficulty: 3 })),
  };
}

function projection(elementId: number, xp: number, over: Partial<Projection> = {}): Projection {
  return {
    elementId, name: `Cand${elementId}`, team: "Chelsea", position: "MID",
    xp, xpSd: 2, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.4, pGe10: 0.1,
    q10: 1, q25: 2, q50: 4, q75: 7, q90: 10,
    nFixtures: 1, blank: false, decomposition: null, ...over,
  };
}

/** A legal fifteen, so the optimiser has a lineup to find. */
function squad(): SquadPlayer[] {
  nextId = 1;
  return [
    ...Array.from({ length: 2 }, (_, i) => player("GKP", `Keeper${i}`)),
    ...Array.from({ length: 5 }, (_, i) => player("DEF", `Def${i}`)),
    ...Array.from({ length: 5 }, (_, i) => player("MID", `Mid${i}`)),
    ...Array.from({ length: 3 }, (_, i) => player("FWD", `Fwd${i}`)),
  ];
}

const MATRIX: FixtureMatrixRow[] = [{
  teamId: 6, team: "Chelsea", shortName: "CHE", meanDifficulty: 3, totalDifficulty: 9,
  fixtures: [2, 3].map((gw) => ({ gameweek: gw, label: `CHE${gw}`, difficulty: 2 })),
}];

/** Later weeks projected, so each column can solve its own eleven. */
const HORIZON = {
  nDraws: 5000,
  weeks: [2, 3].map((gameweek) => ({
    gameweek,
    // Reverse the ranking each later week, so the best eleven MUST differ from
    // GW1's if it is being solved per week rather than copied.
    xp: new Map(Array.from({ length: 15 }, (_, i) => [i + 1, i * 0.5])),
  })),
};

function draw(weeks = 3, horizon: typeof HORIZON | null = null) {
  const fifteen = squad();
  const projections = [
    ...fifteen.map((p, i) => projection(p.elementId!, 6 - i * 0.1, { position: p.position })),
    projection(900, 9, { position: "MID", name: "Newcomer", team: "Chelsea" }),
  ];
  return {
    fifteen,
    ...render(
      <Planner
        squad={fifteen}
        projections={projections}
        horizon={horizon}
        decisionDraws={10000}
        prices={new Map([[900, 7.5]])}
        fixtureMatrix={MATRIX}
        bank={2}
        gameweek={1}
        weeks={weeks}
      />,
    ),
  };
}

afterEach(cleanup);

/**
 * The headline number, which used to mean something other than its label.
 *
 * `projected GW1` was computed as the XI sum PLUS the captain's projection again,
 * so this screen printed 54.9 where `/now` printed 48.20 for the same squad and
 * the same artifact. Both were defensible; neither screen said which it was. The
 * label says "projected", so the number is now the projection — `projectedTotal`,
 * shared with `/now`. The doubling still decides which formation wins inside
 * `optimiseXi` and is never rendered.
 */
describe("the projected total", () => {
  it("is the sum of the eleven, not the sum plus the armband", () => {
    const { container } = draw();
    // Numeric, not string: the surrounding text puts a digit immediately before
    // the total, so the capture can pick up a leading character.
    const shown = Number(container.textContent?.match(/([\d.]+)\s*projected/)?.[1]);
    // xp runs 6.0 down to 4.6 over ids 1–15, so the best legal shape is 5-4-1:
    // 6.0 + (5.8+5.7+5.6+5.5+5.4) + (5.3+5.2+5.1+5.0) + 4.8 = 59.4.
    expect(shown).toBeCloseTo(59.4, 5);
    // 65.4 is that total with the 6.0 captain counted twice — `optimiseXi.total`,
    // which is a comparison key and must never reach the screen.
    expect(shown).not.toBeCloseTo(65.4, 5);
    expect(container.textContent).toMatch(/projected GW1/);
  });
});

describe("the XI switch says what it governs by where it is", () => {
  it("gives every row exactly one, in the first gameweek", () => {
    const { container } = draw();
    const rows = container.querySelectorAll("[data-testid='planner-row']");
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(within(row as HTMLElement).getAllByTestId("planner-xi-toggle"))
        .toHaveLength(1);
    }
  });

  it("names the week it applies to", () => {
    // The label carries the gameweek, so a screen reader gets the scope the
    // layout gives everyone else.
    draw();
    expect(screen.getAllByLabelText(/starting in GW1|benched in GW1/).length)
      .toBeGreaterThan(0);
  });

  it("benches a player and takes them out of the total", () => {
    const { container } = draw();
    const before = container.textContent?.match(/([\d.]+)\s*projected/)?.[1];
    const starting = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.getAttribute("data-starting") === "true")!;
    fireEvent.click(within(starting as HTMLElement).getByTestId("planner-xi-toggle"));
    const after = container.textContent?.match(/([\d.]+)\s*projected/)?.[1];
    expect(Number(after)).toBeLessThan(Number(before));
  });

  it("reports the illegal shape it just made", () => {
    // Ten players is not a team, and the reader is mid-edit: the message has to
    // say which line to fix.
    const { container } = draw();
    const starting = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.getAttribute("data-starting") === "true")!;
    fireEvent.click(within(starting as HTMLElement).getByTestId("planner-xi-toggle"));
    expect(screen.getByText(/need/)).toBeInTheDocument();
  });
});

describe("a transfer is scoped to its week", () => {
  it("opens the picker for the week that was clicked", () => {
    const { container } = draw();
    const row = container.querySelector("[data-testid='planner-row']")!;
    const cells = within(row as HTMLElement).getAllByTestId("planner-cell");
    fireEvent.click(cells[1]);
    expect(screen.getByTestId("planner-replace").textContent).toContain("GW2");
  });

  it("gives the arrival his club's fixtures and hatches the weeks before", () => {
    // The defect that started this: an incoming player had an empty run, so
    // every one of his columns read as a blank gameweek.
    const { container } = draw();
    const midRow = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.textContent?.includes("Mid0"))!;
    fireEvent.click(within(midRow as HTMLElement).getAllByTestId("planner-cell")[1]);
    fireEvent.click(screen.getByText(/Newcomer/));

    const arrival = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.getAttribute("data-side") === "in")!;
    // GW1 hatched — not owned yet — and real fixtures after it.
    expect(within(arrival as HTMLElement).getAllByTitle(/not in the squad this week/))
      .toHaveLength(1);
    expect(within(arrival as HTMLElement).getAllByTestId("planner-cell").length)
      .toBeGreaterThan(0);
  });

  it("puts the arrival directly beneath the departure", () => {
    const { container } = draw();
    const midRow = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.textContent?.includes("Mid0"))!;
    fireEvent.click(within(midRow as HTMLElement).getAllByTestId("planner-cell")[1]);
    fireEvent.click(screen.getByText(/Newcomer/));

    const rows = [...container.querySelectorAll("[data-testid='planner-row']")];
    const out = rows.findIndex((r) => r.getAttribute("data-side") === "out");
    expect(out).toBeGreaterThanOrEqual(0);
    expect(rows[out + 1].getAttribute("data-side")).toBe("in");
  });

  it("withholds a projection the arrival cannot score for you", () => {
    // He joins in GW2, so this gameweek's number is not his to give.
    const { container } = draw();
    const midRow = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.textContent?.includes("Mid0"))!;
    fireEvent.click(within(midRow as HTMLElement).getAllByTestId("planner-cell")[1]);
    fireEvent.click(screen.getByText(/Newcomer/));

    const arrival = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((r) => r.getAttribute("data-side") === "in")!;
    expect(within(arrival as HTMLElement).getAllByTitle(/not a zero/).length)
      .toBeGreaterThan(0);
  });
});


describe("every week solves its own eleven", () => {
  it("marks a different XI in a later week when the projection differs", () => {
    /**
     * The whole point of publishing a horizon. GW1's ranking and GW2's are
     * deliberately opposite in the fixture, so a planner that copied week one
     * across the row would mark the same players every week and this fails.
     */
    const { container } = draw(3, HORIZON);
    const rows = [...container.querySelectorAll("[data-testid='planner-row']")];
    const opacities = rows.map((row) => {
      const cells = within(row as HTMLElement).queryAllByTestId("planner-cell");
      return [cells[0], cells[1]].map((c) => (c as HTMLElement)?.style.opacity);
    });
    // At least one player starts in one of the two weeks and not the other.
    expect(opacities.some(([a, b]) => a !== b)).toBe(true);
  });

  it("says which weeks are the weaker estimate", () => {
    // 5,000 draws and 10,000 are different statements about precision, and the
    // screen shows both in adjacent columns.
    draw(3, HORIZON);
    expect(screen.getByText(/10,000 draws and the rest on 5,000/)).toBeInTheDocument();
  });

  it("keeps saying no eleven is chosen when there is no horizon", () => {
    draw(3, null);
    expect(screen.getByText(/no eleven is chosen for them/)).toBeInTheDocument();
  });
});
