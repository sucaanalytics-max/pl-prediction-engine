/**
 * The grid's arithmetic, and the three places it could quietly lie.
 *
 *   1. A missing horizon week summed as zero.
 *   2. A heat scale derived from the rows on screen, so the colour measures the
 *      filter rather than the player.
 *   3. A "run" that survives a week the player was never projected for.
 *
 * Each has its own test below, because each produces a screen that looks right.
 */
import { describe, expect, it } from "vitest";

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import type { Horizon, Projection } from "@/lib/data/projections";
import {
  ABSOLUTE_CEILING, bandOf, buildGridRows, findRuns, fixtureIndex, gridSummary,
  gridWeeks,
} from "@/lib/projections/grid";

function projection(over: Partial<Projection> & { elementId: number }): Projection {
  return {
    name: "Player", team: "Liverpool", position: "MID", xp: 5, xpSd: null, mode: null,
    pAppears: null, p60: null, eMinutes: null, pGoal: null, pCleanSheet: null,
    pGe5: null, pGe10: null, q10: null, q25: null, q50: null, q75: null, q90: null,
    nFixtures: 1, blank: false, decomposition: null, ...over,
  };
}

function horizon(weeks: ReadonlyArray<[number, Array<[number, number]>]>): Horizon {
  return {
    nDraws: 5000,
    weeks: weeks.map(([gameweek, pairs]) => ({ gameweek, xp: new Map(pairs) })),
  };
}

const LIVERPOOL: FixtureMatrixRow = {
  teamId: 10, team: "Liverpool", shortName: "LIV",
  fixtures: [
    { gameweek: 2, label: "NFO (H)", difficulty: 2 },
    { gameweek: 3, label: "IPS (A)", difficulty: 2 },
    { gameweek: 4, label: "FUL (H)", difficulty: 3 },
  ],
  meanDifficulty: 2.33, totalDifficulty: 7,
};

describe("the weeks the grid covers", () => {
  it("puts the current gameweek first and the horizon after it", () => {
    expect(gridWeeks(2, horizon([[3, []], [4, []]]))).toEqual([2, 3, 4]);
  });

  it("is the current week alone when no horizon was solved", () => {
    // A normal state, not an error: run_decide sets horizon to null explicitly.
    expect(gridWeeks(2, null)).toEqual([2]);
  });

  it("ignores a horizon week at or before the current one", () => {
    // The producer's contract is that the current week is absent from the
    // horizon; two cells for one week would be indistinguishable on screen.
    expect(gridWeeks(3, horizon([[2, []], [3, []], [4, []]]))).toEqual([3, 4]);
  });

  it("never exceeds the eight the fixture matrix publishes", () => {
    const weeks = horizon(Array.from({ length: 20 }, (_, i) => [i + 3, []] as [number, []]));
    expect(gridWeeks(2, weeks)).toHaveLength(8);
  });
});

describe("a total over a span", () => {
  const rows = (span: 2 | 3 | 4) => buildGridRows({
    players: [projection({ elementId: 1, xp: 6 })],
    horizon: horizon([[3, [[1, 4]]], [4, [[1, 3]]]]),
    currentGameweek: 2, fixtures: [LIVERPOOL], ownedIds: new Set(), span,
  });

  it("sums exactly the weeks inside the span", () => {
    expect(rows(2)[0].total).toBe(10);
    expect(rows(3)[0].total).toBe(13);
  });

  it("counts the weeks it summed", () => {
    expect(rows(3)[0].weeksCounted).toBe(3);
    expect(rows(3)[0].partial).toBe(false);
  });

  it("does NOT treat a missing horizon week as a zero", () => {
    // The failure this row exists for. Player 2 has no view in GW4. Summing it
    // as zero prices him below a rival who was merely not projected, and the
    // grid would rank a data gap as a bad week.
    const out = buildGridRows({
      players: [projection({ elementId: 2, xp: 6 })],
      horizon: horizon([[3, [[2, 4]]], [4, []]]),
      currentGameweek: 2, fixtures: [LIVERPOOL], ownedIds: new Set(), span: 4,
    });
    expect(out[0].cells[2].xp).toBeNull();
    expect(out[0].total).toBe(10);
    expect(out[0].weeksCounted).toBe(2);
    expect(out[0].partial).toBe(true);
  });

  it("has no total at all when nothing in the span was projected", () => {
    // Null, not zero. "We did not price him" and "we priced him at nothing"
    // are different claims and the screen renders them differently.
    const out = buildGridRows({
      players: [projection({ elementId: 3, xp: null })],
      horizon: horizon([[3, []]]),
      currentGameweek: 2, fixtures: [LIVERPOOL], ownedIds: new Set(), span: 2,
    });
    expect(out[0].total).toBeNull();
    expect(out[0].weeksCounted).toBe(0);
  });
});

describe("the fixture join", () => {
  it("labels a cell with the club's own fixture and FPL's difficulty", () => {
    const out = buildGridRows({
      players: [projection({ elementId: 1, team: "Liverpool" })],
      horizon: horizon([[3, [[1, 4]]]]),
      currentGameweek: 2, fixtures: [LIVERPOOL], ownedIds: new Set(), span: 2,
    });
    expect(out[0].cells[0].fixture).toBe("NFO (H)");
    expect(out[0].cells[0].difficulty).toBe(2);
  });

  it("joins on the short name too", () => {
    // xp_public and the fixture matrix do not always spell a club the same way,
    // and a silent miss blanks a whole club's row — which reads as "no fixture".
    const index = fixtureIndex([LIVERPOOL]);
    expect(index.has("liverpool")).toBe(true);
    expect(index.has("liv")).toBe(true);
  });

  it("marks a blank rather than inventing a fixture", () => {
    const out = buildGridRows({
      players: [projection({ elementId: 1 })],
      horizon: horizon([[3, [[1, 4]]], [4, [[1, 4]]], [5, [[1, 4]]]]),
      currentGameweek: 2, fixtures: [LIVERPOOL], ownedIds: new Set(), span: 4,
    });
    // The matrix stops at GW4, so GW5 is unknown to it.
    expect(out[0].cells[3].blank).toBe(true);
    expect(out[0].cells[3].fixture).toBeNull();
  });

  it("reports a double gameweek without averaging two difficulties", () => {
    // FPL rates each fixture; it never publishes a rating for a pair, and a mean
    // of two ratings is a number nobody assigned.
    const doubled: FixtureMatrixRow = {
      ...LIVERPOOL,
      fixtures: [
        { gameweek: 2, label: "NFO (H)", difficulty: 2 },
        { gameweek: 2, label: "EVE (A)", difficulty: 4 },
      ],
    };
    const out = buildGridRows({
      players: [projection({ elementId: 1 })],
      horizon: null, currentGameweek: 2, fixtures: [doubled],
      ownedIds: new Set(), span: 2,
    });
    expect(out[0].cells[0].doubleGameweek).toBe(true);
    expect(out[0].cells[0].fixture).toBe("NFO (H) · EVE (A)");
    expect(out[0].cells[0].difficulty).toBeNull();
  });

  it("leaves a club the matrix does not carry blank rather than guessing", () => {
    const out = buildGridRows({
      players: [projection({ elementId: 1, team: "Real Madrid" })],
      horizon: null, currentGameweek: 2, fixtures: [LIVERPOOL],
      ownedIds: new Set(), span: 2,
    });
    expect(out[0].cells[0].fixture).toBeNull();
  });
});

describe("the heat band", () => {
  it("measures against a stated ceiling, not the rows on screen", () => {
    // Same value, two ceilings, two bands. A page-derived maximum would make a
    // list of defenders glow exactly as brightly as a list of strikers.
    expect(bandOf(3.5, ABSOLUTE_CEILING, 5)).toBe(2);
    expect(bandOf(3.5, 3.5, 5)).toBe(4);
  });

  it("has no band for a week with no view", () => {
    expect(bandOf(null, ABSOLUTE_CEILING, 5)).toBeNull();
  });

  it("clamps rather than running off the ramp", () => {
    expect(bandOf(99, ABSOLUTE_CEILING, 5)).toBe(4);
    expect(bandOf(-5, ABSOLUTE_CEILING, 5)).toBe(0);
  });
});

describe("a run of good weeks", () => {
  it("needs three consecutive strong weeks", () => {
    expect(findRuns([4, 4, 4, 0, 0], 5)).toEqual([[0, 2]]);
    expect(findRuns([4, 4, 0, 0, 0], 5)).toEqual([]);
  });

  it("counts the top two bands as strong", () => {
    expect(findRuns([3, 4, 3, 0], 5)).toEqual([[0, 2]]);
    expect(findRuns([2, 2, 2, 0], 5)).toEqual([]);
  });

  it("finds more than one run", () => {
    expect(findRuns([4, 4, 4, 0, 4, 4, 4], 5)).toEqual([[0, 2], [4, 6]]);
  });

  it("is BROKEN by a week with no view, not bridged by it", () => {
    // The third failure this file guards. A player not projected for GW4 has not
    // been shown to be strong in GW4, and a bar drawn straight through the gap
    // claims a five-week run nobody forecast.
    expect(findRuns([4, 4, null, 4, 4], 5)).toEqual([]);
  });
});

describe("the provenance line", () => {
  it("names both draw counts, because the total mixes them", () => {
    const line = gridSummary(22, 609, 10000, 5000, 2, [2, 3, 4, 5, 6, 7, 8, 9]);
    expect(line).toContain("22 of 609");
    expect(line).toContain("GW2 on 10,000 draws");
    expect(line).toContain("GW3–9 on 5,000");
  });

  it("says so rather than implying a count it was not given", () => {
    expect(gridSummary(1, 2, null, null, 2, [2])).toContain("an unstated number of");
  });

  it("does not describe a horizon it does not have", () => {
    expect(gridSummary(1, 2, 10000, null, 2, [2])).not.toContain("–");
  });
});
