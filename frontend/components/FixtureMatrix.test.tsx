/**
 * The fixture difficulty grid — rendered, not grepped.
 *
 * ## Why this file was rewritten
 *
 * Its first version had fourteen assertions and every one was a `readFileSync` plus
 * `toContain` over the component's own source text. An adversarial audit took it
 * apart, and it was right on four counts:
 *
 *  1. It never rendered the component and never called `fixtureViews`, so the
 *     home/away inversion its own header claimed was "asserted from BOTH SIDES of the
 *     same fixture" was not asserted at all. I had verified that by hand against live
 *     data and then written a docstring that said the test did it.
 *  2. `ramp()` scraped hex literals in TEXTUAL order and never bound a colour to the
 *     FDR key it is declared under, so all five colour tests would have passed with
 *     the mapping scrambled.
 *  3. "says whose rating this is" was `expect(SOURCE).toContain("FPL")` — satisfied by
 *     the component's own docstring, which says FPL five times.
 *  4. The ordering test checked only that `[...rows].reverse()` appeared somewhere,
 *     not which branch of the ternary it sat in.
 *
 * It also missed two real defects that a rendering test catches immediately: the cell
 * printed only the opponent-and-venue string, so the FDR value was carried by colour
 * alone; and step 4's white ink on `#3987e5` was 3.64:1, below AA for 11px text.
 *
 * So this renders the real component against a fixture and reads the DOM, and it
 * computes contrast rather than asserting a sentence about it.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { FixtureMatrixRow } from "@/lib/data/heuristics";

/** WCAG relative luminance and contrast, computed rather than asserted. */
function luminance(hex: string): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLab lightness, for the monotonicity constraint on a sequential ramp. */
function oklabL(hex: string): number {
  const lin = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin(parseInt(hex.slice(1, 3), 16));
  const g = lin(parseInt(hex.slice(3, 5), 16));
  const b = lin(parseInt(hex.slice(5, 7), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/**
 * The same fixture from both sides, plus a double gameweek and a blank.
 *
 * Man City host Bournemouth: FPL rates that 3 for City and 5 for Bournemouth. If the
 * component or the server ever swaps the orientation, these two rows stop disagreeing.
 */
const ROWS: FixtureMatrixRow[] = [
  {
    teamId: 13, team: "Man City", shortName: "MCI",
    fixtures: [
      { gameweek: 1, label: "BOU (H)", difficulty: 3 },
      { gameweek: 2, label: "CRY (A)", difficulty: 2 },
    ],
    meanDifficulty: 2.5, totalDifficulty: 5,
  },
  {
    teamId: 3, team: "Bournemouth", shortName: "BOU",
    fixtures: [
      { gameweek: 1, label: "MCI (A)", difficulty: 5 },
      // A blank gameweek 2 — no entry at all.
    ],
    meanDifficulty: 5, totalDifficulty: 5,
  },
];

function mountWith(rows: FixtureMatrixRow[]) {
  vi.resetModules();
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({
      artifact: {
        state: "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: null,
        // The payload lives behind a module-private symbol, so a fixture cannot
        // construct a real Artifact. `proven` reads it, so the component is given a
        // shape it accepts via the same accessor.
        value: { fixtureMatrix: rows },
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/FixtureMatrix");
}

describe("the grid renders the difficulty, not just the colour", () => {
  it("prints the FDR number in every cell", async () => {
    /**
     * The defect the grep-based tests could not see.
     *
     * The cell rendered `{fixture.label}` alone — "BOU (H)" — so the difficulty was
     * communicated by background colour only. That is unreadable to anyone who cannot
     * separate the ramp, and invisible to anyone not hovering a mouse.
     */
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);

    const cells = document.querySelectorAll("[data-difficulty]");
    expect(cells.length).toBe(3);
    for (const cell of cells) {
      const level = cell.getAttribute("data-difficulty");
      expect(
        cell.textContent,
        `cell ${cell.textContent} does not print its difficulty ${level}`,
      ).toContain(String(level));
    }
  });

  it("shows the opponent and venue too", async () => {
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);
    expect(screen.getByText(/BOU \(H\)/)).toBeTruthy();
    expect(screen.getByText(/MCI \(A\)/)).toBeTruthy();
  });
});

describe("home and away orientation, from both sides", () => {
  it("gives the two sides of one fixture different difficulties", async () => {
    /**
     * The assertion the old file's docstring claimed and did not make.
     *
     * FPL rates Man City hosting Bournemouth as 3 for City and 5 for Bournemouth. An
     * inversion in `fixtureViews` makes every club's run its opponents' run, which
     * produces a perfectly plausible grid — CLAUDE.md records exactly that inversion
     * surviving all 25 of its tests once.
     */
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);

    const city = screen.getByText(/BOU \(H\)/).closest("[data-difficulty]");
    const cherries = screen.getByText(/MCI \(A\)/).closest("[data-difficulty]");

    expect(city?.getAttribute("data-difficulty")).toBe("3");
    expect(cherries?.getAttribute("data-difficulty")).toBe("5");
    // The point: they must not be the same number.
    expect(city?.getAttribute("data-difficulty"))
      .not.toBe(cherries?.getAttribute("data-difficulty"));
  });

  it("keeps the venue on the side that is playing at home", async () => {
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);
    const rows = screen.getAllByTestId("fixture-row");
    const cityRow = rows.find((r) => r.textContent?.includes("Man City"));
    const bouRow = rows.find((r) => r.textContent?.includes("Bournemouth"));
    expect(cityRow?.textContent).toContain("BOU (H)");
    expect(bouRow?.textContent).toContain("MCI (A)");
  });
});

describe("a blank gameweek", () => {
  it("renders blank, never as an average", async () => {
    // Bournemouth has no GW2 fixture. Filling it with a neutral 3 would say
    // "average difficulty" about a week the club does not play.
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);
    const bouRow = screen.getAllByTestId("fixture-row")
      .find((r) => r.textContent?.includes("Bournemouth"));
    const coloured = bouRow?.querySelectorAll("[data-difficulty]") ?? [];
    expect(coloured.length, "the blank gameweek was given a colour").toBe(1);
    expect(bouRow?.textContent).toContain("—");
  });
});

describe("a double gameweek", () => {
  /**
   * The defect: `byGameweek` built a `Map<number, Fixture>` with
   * `map.set(fixture.gameweek, fixture)`, so a club playing twice in one week had
   * its first fixture silently overwritten by its second.
   *
   * This is the worst possible cell to be wrong. A double gameweek is what a
   * Bench Boost or Triple Captain is spent on, and the grid would have shown the
   * club playing once — a plausible-looking cell with a real fixture in it, which
   * is why nothing surfaced it.
   */
  const DOUBLE: FixtureMatrixRow[] = [
    {
      teamId: 1, team: "Arsenal", shortName: "ARS",
      fixtures: [
        { gameweek: 1, label: "LEE (H)", difficulty: 2 },
        { gameweek: 1, label: "BUR (A)", difficulty: 3 },
      ],
      meanDifficulty: 2.5, totalDifficulty: 5,
    },
  ];

  it("renders both fixtures, not just the last one", async () => {
    const { default: FixtureMatrix } = await mountWith(DOUBLE);
    const { container } = render(<FixtureMatrix />);
    expect(container.textContent).toContain("LEE (H)");
    expect(container.textContent).toContain("BUR (A)");
    expect(container.querySelectorAll("[data-difficulty]").length).toBe(2);
  });

  it("says it is a double rather than leaving it to be inferred", async () => {
    const { default: FixtureMatrix } = await mountWith(DOUBLE);
    const { container } = render(<FixtureMatrix />);
    expect(container.textContent).toMatch(/double/i);
  });

  it("does not label an ordinary single gameweek a double", async () => {
    const { default: FixtureMatrix } = await mountWith(ROWS);
    const { container } = render(<FixtureMatrix />);
    expect(container.textContent).not.toMatch(/double/i);
  });
});

describe("the colour ramp, keyed by difficulty", () => {
  /**
   * Read off the RENDERED cells, so each colour is bound to the FDR level it was
   * actually used for. The old `ramp()` scraped hex literals in source order and
   * would have passed with the mapping scrambled.
   */
  async function renderedRamp() {
    const { default: FixtureMatrix } = await mountWith([
      {
        teamId: 1, team: "Test", shortName: "TST",
        fixtures: [1, 2, 3, 4, 5].map((d, i) => ({
          gameweek: i + 1, label: `OPP (H)`, difficulty: d,
        })),
        meanDifficulty: 3, totalDifficulty: 15,
      },
    ]);
    render(<FixtureMatrix />);
    const byLevel = new Map<number, { fill: string; ink: string }>();
    for (const cell of document.querySelectorAll("[data-difficulty]")) {
      const level = Number(cell.getAttribute("data-difficulty"));
      const style = (cell as HTMLElement).style;
      byLevel.set(level, { fill: style.background || style.backgroundColor, ink: style.color });
    }
    return byLevel;
  }

  function toHex(colour: string): string {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(colour);
    if (!m) return colour;
    return "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("");
  }

  it("has one fill per difficulty level, all five distinct", async () => {
    const ramp = await renderedRamp();
    expect(ramp.size).toBe(5);
    const fills = new Set([...ramp.values()].map((v) => toHex(v.fill)));
    expect(fills.size, "two difficulty levels share a colour").toBe(5);
  });

  it("gets darker as difficulty rises", async () => {
    const ramp = await renderedRamp();
    const ls = [1, 2, 3, 4, 5].map((level) => oklabL(toHex(ramp.get(level)!.fill)));
    for (let i = 1; i < ls.length; i += 1) {
      expect(ls[i], `FDR ${i + 1} is not darker than FDR ${i}`).toBeLessThan(ls[i - 1]);
    }
  });

  it("clears WCAG AA for its own text at every level", async () => {
    /**
     * The defect the source-grep version missed entirely.
     *
     * Step 4 shipped as `#3987e5`, on which white computes to 3.64:1 — below the 4.5:1
     * AA requires for the 11px cell text. Monotonicity had been validated; ink
     * contrast had not.
     */
    const ramp = await renderedRamp();
    for (const [level, { fill, ink }] of ramp) {
      const value = contrast(toHex(ink), toHex(fill));
      expect(
        value,
        `FDR ${level}: ${toHex(ink)} on ${toHex(fill)} is ${value.toFixed(2)}:1, below AA 4.5`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is a single blue hue, not green to red", async () => {
    // Green-to-red is FPL's own convention and the canonical colour-vision failure.
    const ramp = await renderedRamp();
    for (const { fill } of ramp.values()) {
      const hex = toHex(fill);
      const r = parseInt(hex.slice(1, 3), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(b, `${hex} is not on a blue ramp`).toBeGreaterThan(r);
    }
  });
});

describe("ordering", () => {
  it("renders rows in the order given, kindest run first", async () => {
    const { default: FixtureMatrix } = await mountWith(ROWS);
    render(<FixtureMatrix />);
    const names = screen.getAllByTestId("fixture-row")
      .map((r) => r.querySelector("td")?.textContent);
    // The server sorts by mean ascending; Man City (2.5) precedes Bournemouth (5).
    expect(names[0]).toContain("Man City");
    expect(names[1]).toContain("Bournemouth");
  });

  it("reverses on demand without re-sorting", async () => {
    const { default: FixtureMatrix } = await mountWith(ROWS);
    const { getAllByTestId, getByRole } = render(<FixtureMatrix />);
    getByRole("button", { name: /hardest runs first/i }).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const names = getAllByTestId("fixture-row")
      .map((r) => r.querySelector("td")?.textContent);
    expect(names[0]).toContain("Bournemouth");
  });
});

describe("what it says about the numbers", () => {
  it("names FPL as the source in rendered text, not in a comment", async () => {
    // The old version's `expect(SOURCE).toContain("FPL")` was satisfied by the
    // component's own docstring, which says FPL five times.
    const { default: FixtureMatrix } = await mountWith(ROWS);
    const { container } = render(<FixtureMatrix />);
    expect(container.textContent).toMatch(/FPL/);
  });

  it("renders an empty grid as one line, not a broken table", async () => {
    const { default: FixtureMatrix } = await mountWith([]);
    const { container } = render(<FixtureMatrix />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toMatch(/\S{10,}/);
  });
});
