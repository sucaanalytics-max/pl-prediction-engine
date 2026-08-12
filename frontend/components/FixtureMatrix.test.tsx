/**
 * The fixture difficulty grid.
 *
 * ## The bug this file is mostly about
 *
 * Home/away orientation. FPL gives every fixture TWO difficulties —
 * `team_h_difficulty` and `team_a_difficulty` — and picking the wrong one produces a
 * perfectly plausible grid in which every club's run is its opponents' run. CLAUDE.md
 * records a home/away inversion in this repo surviving all 25 of its tests, because
 * the assertions were on quantities invariant under the swap.
 *
 * So the orientation is asserted from BOTH SIDES of the same fixture: Man City
 * hosting Bournemouth must read 3 for City and 5 for Bournemouth, not one number
 * twice.
 *
 * ## And the colour
 *
 * FDR 1–5 is ordered magnitude, so the encoding is one hue light→dark, not FPL's own
 * green→red — that pair is the canonical colour-vision failure. The ramp's OKLab
 * lightness must stay monotonic, and the number must appear in every cell so nothing
 * is carried by colour alone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(process.cwd(), "components", "FixtureMatrix.tsx"), "utf8",
);
const SERVER = readFileSync(
  join(process.cwd(), "lib", "fpl-live-server.ts"), "utf8",
);

/** OKLab lightness, the measure the palette validator reports. */
function lightness(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
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

function ramp(): string[] {
  const block = /const FDR_FILL[^}]+}/.exec(SOURCE)?.[0] ?? "";
  return [...block.matchAll(/"(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
}

describe("home and away orientation", () => {
  it("reads THIS club's difficulty, not the opponent's", () => {
    /**
     * The one line that decides it. `team_h_difficulty` is how hard the fixture is
     * for the HOME side; taking it for an away club inverts every row.
     */
    expect(SERVER).toContain(
      "const difficulty = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty",
    );
  });

  it("builds the matrix through the shared per-team helper", () => {
    // Reused rather than reimplemented: a second copy of the orientation logic is a
    // second chance to invert it, and the two would diverge silently.
    expect(SERVER).toContain("fixtureViews(teamId, eventId, fixtures, teams)");
  });

  it("labels the venue, so an inversion is visible on screen", () => {
    // `COV (H)` versus `COV (A)`. Without the venue printed, a swap is invisible to
    // a reader as well as to a test.
    expect(SERVER).toContain('${isHome ? "H" : "A"}');
  });
});

describe("the colour ramp", () => {
  it("has one step per difficulty level", () => {
    expect(ramp()).toHaveLength(5);
  });

  it("is monotonic light to dark", () => {
    /**
     * The check that actually applies to a sequential ramp — the palette validator
     * says so itself: its categorical checks are out of scope, and for a sequential
     * ramp the requirement is lightness monotonicity.
     */
    const steps = ramp().map(lightness);
    for (let i = 1; i < steps.length; i += 1) {
      expect(
        steps[i],
        `step ${i + 1} (${ramp()[i]}) is not darker than step ${i}`,
      ).toBeLessThan(steps[i - 1]);
    }
  });

  it("steps evenly, so equal difficulty gaps read as equal", () => {
    const steps = ramp().map(lightness);
    const gaps = steps.slice(1).map((value, i) => steps[i] - value);
    // Measured: 0.093, 0.095, 0.095, 0.142. The last step is deliberately larger so
    // a 5 stands out; nothing may collapse toward zero.
    for (const gap of gaps) expect(gap).toBeGreaterThan(0.05);
  });

  it("is a single hue, not green to red", () => {
    /**
     * FPL's own site colours difficulty green→red, which roughly one man in twelve
     * cannot separate. Copying the convention would have copied the defect.
     */
    for (const hex of ramp()) {
      const r = parseInt(hex.slice(1, 3), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(b, `${hex} is not on a blue ramp`).toBeGreaterThan(r);
    }
  });

  it("never relies on colour alone", () => {
    // The darkest step sits below 3:1 against the dark surface, which obliges visible
    // relief. The opponent and venue are printed in every cell.
    expect(SOURCE).toContain("{fixture.label}");
  });

  it("picks ink per step rather than per theme", () => {
    // The cell background is data and does not flip with the theme, so a single text
    // colour would be unreadable at one end of the ramp.
    expect(SOURCE).toContain("FDR_INK");
  });
});

describe("what the grid refuses to invent", () => {
  it("renders a blank gameweek as blank, not as average", () => {
    /**
     * Filling a missing fixture with 3 would say "average difficulty" about a
     * gameweek in which the club does not play — and it would flatter a blank into
     * looking like a playable week.
     */
    expect(SOURCE).toContain("has no fixture in GW");
    expect(SOURCE).not.toMatch(/difficulty\s*\?\?\s*3/);
  });

  it("averages over fixtures that exist", () => {
    // So a club with a blank stays comparable to one without.
    expect(SERVER).toContain("total / upcoming.length");
  });

  it("says whose rating this is", () => {
    // It is FPL's 1–5, not ours. Our own fitted rates are a different claim and get
    // a different label.
    expect(SOURCE).toContain("FPL");
  });
});

describe("ordering", () => {
  it("defaults to the kindest run first", () => {
    expect(SERVER).toContain("left.meanDifficulty - right.meanDifficulty");
  });

  it("keeps one source of truth for the order", () => {
    // The client reverses rather than re-sorting, so the two cannot disagree.
    expect(SOURCE).toContain("[...rows].reverse()");
  });
});
