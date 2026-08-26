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

function player(
  name: string, position: string, elementId: number, team = "ARS",
): SquadPlayer {
  return {
    name,
    position,
    // FPL's `short_name`, which is what the live route emits and what `kitFor`
    // looks up — `lib/margin/kits.ts` says so in the `Kit.code` docstring. This
    // said "Arsenal", so `kitFor` returned null for every row in this file and the
    // club rule could not have been observed here even by a test that looked.
    team,
    // On the PLAYER, which is where `FixtureCell` reads them — `row.player.fixture`
    // then `row.player.fixtures[0].label`. The first version put them on the row,
    // where nothing looks, so the fixture chip rendered an em dash in every test.
    //
    // AVL (A) 4, which is what Raya actually had. It said `COV (H) 2` — the GW1
    // fixture the planning-week bug was making the screen show for GW2 — so the
    // fixture encoded the very defect the app was being fixed for.
    fixture: "AVL (A)",
    fixtures: [{ gameweek: 2, label: "AVL (A)", difficulty: 4 }],
    difficulty: 4,
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
} as never;

/** The distinctive rendering of each value, so a cell can be identified by content. */
const RENDERED = {
  xp: "2.84",
  haul: "1",       // round(0.0149 * 100)
  minutes: "70",
  fdr: "AVL",
  ownership: "38",
} as const;

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

/**
 * The DATA ROW, which is what the header is a header for.
 *
 * The assertions above pin the header's own order and nothing else, so the exact
 * defect this file was written about — a label sitting over the wrong column — can
 * be reintroduced with the whole suite green: move a splice and the header list
 * changes, but nothing here compares it to where the values actually land.
 *
 * These read the row's cells by `data-cell` and require the nth header label to sit
 * over the nth value. That is the relationship, and it is the only thing that
 * catches "70 rendered under a header labelled P10".
 */
describe("the values land under the labels", () => {
  /** The value cells in document order, as `[name, text]`. */
  function cells(): ReadonlyArray<readonly [string, string]> {
    const row = screen.getAllByTestId("eleven-row")[0];
    return [...row.querySelectorAll("[data-cell]")].map(
      (el) => [el.getAttribute("data-cell")!, (el.textContent ?? "").trim()] as const,
    );
  }

  it("puts every value cell in the same order as its header", () => {
    mount();
    // The header's nine slots are: blank · Pos · Player · xP · P10 · Mins ·
    // q25–q75 · Fix · Own. Pos and Player are not `data-cell` (a position chip and
    // a name), so the six that carry figures must follow the last six labels.
    expect(cells().map(([name]) => name)).toEqual([
      "xp", "haul", "minutes", "interval", "fdr", "ownership",
    ]);
  });

  it("renders Raya's real numbers in those cells", () => {
    mount();
    const byName = new Map(cells());
    for (const [name, text] of Object.entries(RENDERED)) {
      expect(byName.get(name), `${name} cell`).toContain(text);
    }
  });

  it("does NOT render the expected minutes under the haul header", () => {
    mount();
    // The shipped defect, stated as an assertion. Raya's 70 expected minutes
    // appeared beneath `P10` against a real haul chance of 1% — a probability
    // misreported by about seventy times, on the screen a team is picked from.
    const byName = new Map(cells());
    expect(byName.get("haul")).not.toContain("70");
    expect(byName.get("haul")).toContain("1");
    expect(byName.get("minutes")).toContain("70");
  });

  it("keeps the header and the row on one grid template", () => {
    mount();
    // Two separate 9-column grids sharing one TEMPLATE constant. If they ever stop
    // sharing it, no ordering assertion in this file means anything: the labels and
    // the values would be laid out on different tracks.
    const header = screen.getAllByRole("row")[0] as HTMLElement;
    const row = screen.getAllByTestId("eleven-row")[0] as HTMLElement;
    expect(row.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
    expect(header.style.gridTemplateColumns).not.toBe("");
  });
});

describe("the club rule is painted, for every club", () => {
  it("gives the row a background-image, not a bare colour", () => {
    mount();
    // `background-image` silently DROPS a bare hex. `kitStripe` returned one for the
    // eleven plain clubs, so the rule rendered for four of fifteen rows and the
    // feature looked absent — and `kits.test.ts` pinned the bug by asserting the
    // flat colour. jsdom does not paint, but it does keep the declaration, which is
    // the half that was wrong.
    const row = screen.getAllByTestId("eleven-row")[0] as HTMLElement;
    expect(row.style.backgroundImage).toContain("gradient");
    expect(row.style.backgroundSize).toBe("3px 100%");
  });

  it("does not paint a rule for a club it has no kit for", () => {
    // An invented colour would say "this is the club" about a club it cannot name.
    render(
      <Eleven
        starters={[{
          ...(ROW as object),
          player: player("Nobody", "MID", 2, "ZZZ"),
        } as never]}
        bench={[]} captainId={2} bringIn={[]} sitDown={[]} onToggle={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId("eleven-row");
    const unknown = rows[rows.length - 1] as HTMLElement;
    expect(unknown.style.backgroundImage).toBe("");
  });
});
