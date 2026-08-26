/**
 * The eleven's column headers must sit above the values they name.
 *
 * ## Why this test exists
 *
 * The header and each row are separate 9-column grids sharing one `TEMPLATE`, and
 * two header cells are static labels spliced in beside a sortable button using
 * `display: contents`. Splice one in at the wrong index and every label after it
 * shifts a column right, silently.
 *
 * That shipped. `q25–q75` was emitted after `COLUMNS[1]` (`xP`) instead of after
 * `COLUMNS[3]` (`Mins`), so the live call screen read `q25–q75` over the haul
 * chance, `P10` over the expected minutes, and `Mins` over the interval bar.
 * Measured on production: Raya rendered "70" beneath a header labelled `P10`,
 * which is his expected minutes against a real haul chance of 1% — a probability
 * misreported by about seventy times, on the screen a team is picked from.
 *
 * Nothing caught it because nothing was broken in the usual sense. The sort keys
 * were always correct, every value was correct, and there was no test at all over
 * `components/call`. The defect lived entirely in the relationship between two
 * lists, which is the one thing a snapshot of either list cannot see.
 *
 * So this asserts the ORDER of the header labels, and separately that each
 * sortable header still carries the tooltip for the quantity it names. A future
 * splice at the wrong index fails here rather than on a screenshot.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Eleven } from "@/components/call/Eleven";
import type { SquadPlayer } from "@/lib/data/heuristics";

function player(name: string, position: string, elementId: number): SquadPlayer {
  return {
    name,
    position,
    team: "Arsenal",
    price: 5.0,
    elementId,
    ownership: 38,
    bench: false,
  } as SquadPlayer;
}

/** One starter, with every column populated so no cell collapses to a dash. */
const ROW = {
  player: player("Raya", "GKP", 1),
  projection: {
    xp: 2.84,
    q25: 1,
    q75: 6,
    pGe10: 0.0149,
    eMinutes: 70,
    pAppears: 0.78,
    p60: 0.78,
  },
  fixtures: [{ opponent: "COV", home: true, difficulty: 2 }],
} as never;

function mount() {
  return render(
    <Eleven
      starters={[ROW]}
      bench={[]}
      captainId={1}
      bringIn={[]}
      sitDown={[]}
      onToggle={vi.fn()}
    />,
  );
}

/**
 * The header's labels in document order.
 *
 * Leaves only: the two spliced labels live inside `display: contents` wrappers
 * whose own `textContent` concatenates their children ("Minsq25–q75"), so a
 * wrapper would appear as a phantom column between the real ones.
 */
function headerLabels(): string[] {
  const row = screen.getAllByRole("row")[0];
  return [...row.querySelectorAll("button, span")]
    .filter((el) => el.querySelector("button, span") === null)
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

describe("the header sits above the values it names", () => {
  it("orders the labels to match TEMPLATE's nine slots", () => {
    mount();
    // blank · Pos · Player · xP · P10 · Mins · q25–q75 · Fix · Own.
    // The interval bar is the 116px seventh slot, so its label comes AFTER Mins.
    expect(headerLabels()).toEqual([
      "Pos",
      "Player",
      "xP",
      "P10",
      "Mins",
      "q25–q75",
      "Fix",
      "Own",
    ]);
  });

  it("puts q25–q75 after Mins, not after xP", () => {
    mount();
    const labels = headerLabels();
    expect(labels.indexOf("q25–q75")).toBeGreaterThan(labels.indexOf("Mins"));
    expect(labels.indexOf("q25–q75")).toBeGreaterThan(labels.indexOf("P10"));
  });

  it("keeps P10 immediately after xP", () => {
    mount();
    const labels = headerLabels();
    expect(labels.indexOf("P10")).toBe(labels.indexOf("xP") + 1);
  });
});

describe("each sortable header still names its own quantity", () => {
  it.each([
    ["xP", "Projected points this gameweek"],
    ["P10", "Chance of ten or more points"],
    ["Mins", "Expected minutes"],
    ["Own", "Percent of managers who own him"],
  ])("%s carries the tooltip for %s", (label, tooltip) => {
    mount();
    // getByTitle rather than getByText: the label and the tooltip drifting apart
    // is the class of bug this file is about.
    expect(screen.getByTitle(tooltip).textContent?.trim()).toBe(label);
  });
});
