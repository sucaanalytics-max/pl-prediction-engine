/**
 * The comparison panel, and the marks it refuses to make.
 *
 * `lib/margin/compare.test.ts` proves the arithmetic and the leader rule. This
 * proves the two things only rendering can get wrong: that a number the producer
 * does not have renders as absent rather than as zero, and that "leading" is
 * legible in the DOM rather than only in colour.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Compare } from "@/components/margin/Compare";
import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";

function stats(over: Partial<PlayerRow> = {}): PlayerRow {
  return {
    elementId: 1, name: "Haaland", team: "MCI", position: "FWD",
    minutes: 900, goals: 10, assists: 2, xg: 8.5, xa: 1.5,
    fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 73.4, fpl_price: 15.5, form: 6.2,
    available: true, ratesAreMeaningful: true, ...over,
  };
}

function projection(over: Partial<Projection> = {}): Projection {
  return {
    elementId: 1, name: "Haaland", team: "Man City", position: "FWD",
    xp: 6.83, xpSd: 3.1, mode: 2, pAppears: .95, p60: .9, eMinutes: 89,
    pGoal: .6, pCleanSheet: .3, pGe5: .4, pGe10: .15,
    q10: 1, q25: 2, q50: 5, q75: 9, q90: 13,
    nFixtures: 1, blank: false, decomposition: null, ...over,
  };
}

/** Two players: Haaland leads on xP, the other is cheaper. */
function pair() {
  return {
    ids: [1, 2],
    projections: [projection(), projection({ elementId: 2, name: "Wood", xp: 1.47 })],
    stats: [stats(), stats({ elementId: 2, name: "Wood", fpl_price: 6.0, xg: 1.1, xa: 0.4 })],
  };
}

function draw(over: Partial<ReturnType<typeof pair>> = {}) {
  const props = { ...pair(), ...over };
  return render(
    <Compare {...props} onRemove={vi.fn()} onClear={vi.fn()} />,
  );
}

afterEach(cleanup);

describe("what it marks", () => {
  it("marks the leader on a metric where one player is ahead", () => {
    draw();
    const marked = document.querySelectorAll("[data-leads='yes']");
    expect(marked.length).toBeGreaterThan(0);
  });

  it("marks the cheaper player on price, not the dearer one", () => {
    draw();
    const row = [...screen.getAllByTestId("compare-row")]
      .find((r) => r.textContent?.startsWith("price"))!;
    const cells = within(row).getAllByTestId("compare-cell");
    // Haaland £15.5 first, Wood £6.0 second — cheaper wins.
    expect(cells[0]).toHaveAttribute("data-leads", "no");
    expect(cells[1]).toHaveAttribute("data-leads", "yes");
  });

  it("marks nobody on a metric neither player has", () => {
    // Both projections without a ceiling: a tie of absences is not a win.
    draw({
      projections: [projection({ q90: null }),
                    projection({ elementId: 2, name: "Wood", q90: null })],
    });
    const row = [...screen.getAllByTestId("compare-row")]
      .find((r) => r.textContent?.includes("ceiling"))!;
    for (const cell of within(row).getAllByTestId("compare-cell")) {
      expect(cell).toHaveAttribute("data-leads", "no");
    }
  });
});

describe("what it refuses to draw", () => {
  it("leaves a rate blank when the minutes cannot carry one", () => {
    // Four minutes would read as ten times the season's xA under the producer's
    // own per-90 floor.
    draw({
      ids: [1],
      stats: [stats({ minutes: 4, xa: 0.4, ratesAreMeaningful: false })],
      projections: [projection()],
    });
    const row = [...screen.getAllByTestId("compare-row")]
      .find((r) => r.textContent?.startsWith("xA per 90"))!;
    // The absence mark, which says in its own title that it is not a zero.
    expect(within(row).getByTitle(/not a zero/)).toBeInTheDocument();
  });

  it("shows no underlying numbers for a player the stats file lacks", () => {
    draw({ ids: [1], projections: [projection()], stats: [] });
    const row = [...screen.getAllByTestId("compare-row")]
      .find((r) => r.textContent?.startsWith("xGI"))!;
    expect(within(row).getByTitle(/not a zero/)).toBeInTheDocument();
  });

  it("renders nothing at all when no player is pinned", () => {
    const { container } = draw({ ids: [] });
    expect(container.firstChild).toBeNull();
  });
});

describe("the controls", () => {
  it("removes the player whose cross was clicked", () => {
    const onRemove = vi.fn();
    render(<Compare {...pair()} onRemove={onRemove} onClear={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId("compare-remove")[1]);
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it("says a single pick is not yet a comparison", () => {
    draw({ ids: [1] });
    expect(screen.getByText(/pick another/)).toBeInTheDocument();
  });
});
