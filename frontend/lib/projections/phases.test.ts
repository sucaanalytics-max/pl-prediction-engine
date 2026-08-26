/**
 * Phases, and the four ways a fixture run can be claimed that does not exist.
 *
 *   1. A blank gameweek read as the softest week available.
 *   2. A double gameweek judged by its kinder half.
 *   3. Rows misaligned, so a club's fixtures sit under other clubs' gameweeks.
 *   4. An idle club averaging out as having the kindest month in the league.
 *
 * All four produce a matrix that looks entirely reasonable, which is why each has
 * its own test rather than a shared one.
 */
import { describe, expect, it } from "vitest";

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import {
  DEFAULT_MAX_DIFFICULTY, THRESHOLDS,
  allPhases, bestPhase, buildClubRows, clubWeeks, difficultyBand, findPhases,
  matrixGameweeks, orderClubs, type PhaseOptions,
} from "@/lib/projections/phases";

/** `fdr` by gameweek, starting at GW2. A null is a blank. */
function club(
  name: string, short: string, fdr: ReadonlyArray<number | null>, teamId = 1,
): FixtureMatrixRow {
  const fixtures = fdr.flatMap((difficulty, index) =>
    difficulty === null
      ? []
      : [{ gameweek: index + 2, label: `X${index} (H)`, difficulty }]);
  return {
    teamId, team: name, shortName: short, fixtures,
    meanDifficulty: 0, totalDifficulty: 0,
  };
}

const OPTIONS: PhaseOptions = { minLength: 3, maxDifficulty: 2 };

function phasesOf(row: FixtureMatrixRow, options = OPTIONS) {
  return findPhases(row, clubWeeks(row, matrixGameweeks([row])), options);
}

describe("finding a phase", () => {
  it("finds three consecutive kind weeks", () => {
    const found = phasesOf(club("Liverpool", "LIV", [2, 2, 2, 5]));
    expect(found).toHaveLength(1);
    expect(found[0].fromGameweek).toBe(2);
    expect(found[0].toGameweek).toBe(4);
    expect(found[0].length).toBe(3);
  });

  it("does not call two weeks a run", () => {
    expect(phasesOf(club("Liverpool", "LIV", [2, 2, 5, 5]))).toEqual([]);
  });

  it("finds two separate phases in one season", () => {
    const found = phasesOf(club("Liverpool", "LIV", [1, 1, 1, 5, 2, 2, 2]));
    expect(found.map((p) => [p.fromGameweek, p.toGameweek]))
      .toEqual([[2, 4], [6, 8]]);
  });

  it("reports the phase's mean difficulty, so two runs can be compared", () => {
    const found = phasesOf(club("Liverpool", "LIV", [1, 1, 2]));
    expect(found[0].meanDifficulty).toBeCloseTo(4 / 3);
  });

  it("respects a longer minimum", () => {
    const row = club("Liverpool", "LIV", [2, 2, 2, 5]);
    expect(phasesOf(row, { minLength: 4, maxDifficulty: 2 })).toEqual([]);
  });

  it("respects a looser threshold", () => {
    const row = club("Liverpool", "LIV", [3, 3, 3]);
    expect(phasesOf(row)).toEqual([]);
    expect(phasesOf(row, { minLength: 3, maxDifficulty: 3 })).toHaveLength(1);
  });
});

describe("a blank gameweek", () => {
  it("BREAKS a phase rather than counting as the kindest week possible", () => {
    // Failure 1. A blank has no difficulty, so a check written as "not above the
    // threshold" passes — inventing a soft week out of a week with no football.
    // The second club supplies the GW3 column, which is how a blank appears in a
    // real matrix: the league plays, this club does not.
    const rows = [
      club("Liverpool", "LIV", [2, null, 2, 2], 1),
      club("Filler", "FIL", [5, 5, 5, 5], 2),
    ];
    const [liverpool] = buildClubRows(rows, OPTIONS);
    expect(liverpool.weeks[1].blank).toBe(true);
    expect(liverpool.phases).toEqual([]);
  });

  it("breaks it even when the blank week has no column at all", () => {
    // The same claim one level deeper. With GW3 absent from every club, the
    // array's neighbours are GW2 and GW4, and a run counted over array positions
    // would span a week the fixture list does not contain.
    expect(phasesOf(club("Liverpool", "LIV", [2, null, 2, 2]))).toEqual([]);
  });

  it("still occupies its column, so later weeks do not shift left", () => {
    // Failure 3. Without a cell for the blank, GW4's fixture would be drawn under
    // GW3, and every club with a different blank week would disagree with the
    // header row.
    const weeks = clubWeeks(club("Liverpool", "LIV", [2, null, 3]), [2, 3, 4]);
    expect(weeks.map((w) => w.gameweek)).toEqual([2, 3, 4]);
    expect(weeks[1].blank).toBe(true);
    expect(weeks[1].difficulty).toBeNull();
    expect(weeks[2].difficulty).toBe(3);
  });

  it("is excluded from a club's mean rather than averaged as zero", () => {
    // Failure 4. A zero for an idle week would make a blank-heavy club the
    // kindest-looking run in the league.
    const [row] = buildClubRows([club("Liverpool", "LIV", [4, null, 4])], OPTIONS);
    expect(row.meanDifficulty).toBe(4);
  });

  it("leaves a club that plays nothing with no mean at all", () => {
    const [row] = buildClubRows([club("Liverpool", "LIV", [null])], OPTIONS);
    expect(row.meanDifficulty).toBeNull();
  });
});

describe("a double gameweek", () => {
  const doubled: FixtureMatrixRow = {
    teamId: 1, team: "Liverpool", shortName: "LIV",
    fixtures: [
      { gameweek: 2, label: "COV (H)", difficulty: 2 },
      { gameweek: 2, label: "MCI (A)", difficulty: 5 },
      { gameweek: 3, label: "IPS (H)", difficulty: 2 },
      { gameweek: 4, label: "FUL (A)", difficulty: 2 },
    ],
    meanDifficulty: 0, totalDifficulty: 0,
  };

  it("takes the WORST of the week's fixtures, not the kinder one", () => {
    // Failure 2. Taking the minimum turns the hardest week of a season into the
    // softest, because every double contains something easy.
    const weeks = clubWeeks(doubled, [2, 3, 4]);
    expect(weeks[0].difficulty).toBe(5);
    expect(weeks[0].doubleGameweek).toBe(true);
  });

  it("so a mixed double cannot open a phase", () => {
    expect(findPhases(doubled, clubWeeks(doubled, [2, 3, 4]), OPTIONS)).toEqual([]);
  });

  it("but a kind double can be part of one", () => {
    const kind: FixtureMatrixRow = {
      ...doubled,
      fixtures: [
        { gameweek: 2, label: "COV (H)", difficulty: 2 },
        { gameweek: 2, label: "IPS (A)", difficulty: 2 },
        { gameweek: 3, label: "SUN (H)", difficulty: 2 },
        { gameweek: 4, label: "FUL (A)", difficulty: 1 },
      ],
    };
    const found = findPhases(kind, clubWeeks(kind, [2, 3, 4]), OPTIONS);
    expect(found).toHaveLength(1);
    expect(found[0].weeks[0].labels).toEqual(["COV (H)", "IPS (A)"]);
  });
});

describe("the matrix's columns", () => {
  it("span every gameweek any club plays in", () => {
    const rows = [
      club("A", "A", [2, 2], 1),
      { ...club("B", "B", [], 2), fixtures: [{ gameweek: 9, label: "z", difficulty: 3 }] },
    ];
    expect(matrixGameweeks(rows)).toEqual([2, 3, 9]);
  });

  it("give every club the same columns", () => {
    const rows = buildClubRows([club("A", "A", [2, 2], 1), club("B", "B", [3], 2)], OPTIONS);
    expect(rows[0].weeks.map((w) => w.gameweek))
      .toEqual(rows[1].weeks.map((w) => w.gameweek));
  });
});

describe("ordering", () => {
  const clubs = () => buildClubRows([
    club("Alpha", "ALP", [5, 5, 5, 5], 1),
    club("Bravo", "BRA", [2, 2, 2, 5], 2),
    club("Cielo", "CIE", [1, 1, 1, 1], 3),
  ], OPTIONS);

  it("puts the longest phase first, then the kindest", () => {
    expect(orderClubs(clubs(), "phase").map((c) => c.shortName))
      .toEqual(["CIE", "BRA", "ALP"]);
  });

  it("sorts a club with no phase last rather than first", () => {
    // A missing phase is not a short one; ascending on a null would top the list.
    expect(orderClubs(clubs(), "phase")[2].phases).toEqual([]);
  });

  it("can order by the whole run instead of the best phase in it", () => {
    expect(orderClubs(clubs(), "kindest").map((c) => c.shortName))
      .toEqual(["CIE", "BRA", "ALP"]);
  });

  it("can order alphabetically, for looking a club up", () => {
    expect(orderClubs(clubs(), "name").map((c) => c.shortName))
      .toEqual(["ALP", "BRA", "CIE"]);
  });

  it("prefers the phase that buys more relief, not the longer one", () => {
    // This used to assert the opposite. Length alone ranked runs wrongly: measured
    // on the published 2026/27 list at the screen's defaults, nineteen pairs had a
    // longer run outranking one kinder by more than half a point of FDR, the worst
    // being Man United's `[3,3,3,3]` above Fulham's `[2,2,2]`.
    //
    // Here: three weeks at FDR 1 against four at FDR 2. Against the league's own
    // 3.05 the short run buys 6.15 points of relief and the long one 4.20, so the
    // short run wins — three weeks of the kindest fixtures in the league beats four
    // weeks of merely good ones. Reference passed explicitly so the case does not
    // depend on this fixture's own mean.
    const row = club("Liverpool", "LIV", [1, 1, 1, 5, 2, 2, 2, 2]);
    const [c] = buildClubRows([row], { ...OPTIONS, reference: 3.05 });
    const best = bestPhase(c);
    expect(best?.length).toBe(3);
    expect(best?.meanDifficulty).toBe(1);
    expect(best?.relief).toBeCloseTo(6.15, 2);
  });

  it("still prefers the longer run when both buy the same relief", () => {
    // Relief is a sum, so it already contains length; the tiebreak only settles
    // runs that are equally kind in total. Against a reference of 2, a week at
    // FDR 2 adds nothing — so `[2,2,2]` and `[1,2,2,2]` both buy exactly 1.0 and
    // the longer one wins. OPTIONS has minLength 3, so both runs must clear it.
    const row = club("Brentford", "BRE", [2, 2, 2, 5, 1, 2, 2, 2]);
    const [c] = buildClubRows([row], { ...OPTIONS, reference: 2 });
    const best = bestPhase(c);
    expect(best?.relief).toBeCloseTo(1, 6);
    expect(best?.length).toBe(4);
  });

  it("lists every club's phases together, most relief first", () => {
    const list = allPhases(clubs());
    expect(list).toHaveLength(2);
    expect(list[0].shortName).toBe("CIE");
  });
});

describe("the difficulty ramp", () => {
  it("is inverted against the projection grid, because this is a cost", () => {
    // Bright means a KIND fixture here and a HIGH projection there. Both screens
    // label their scale; this test pins the direction.
    expect(difficultyBand(1, 5)).toBe(4);
    expect(difficultyBand(5, 5)).toBe(0);
  });

  it("has no band for a blank", () => {
    expect(difficultyBand(null, 5)).toBeNull();
  });

  it("clamps a rating outside FPL's own scale", () => {
    expect(difficultyBand(0, 5)).toBe(4);
    expect(difficultyBand(9, 5)).toBe(0);
  });
});

/**
 * The screen has to open on something a reader can use.
 *
 * These run against the real published 2026/27 difficulties over the eight-week
 * horizon, read from `/api/fpl/state`'s fixture matrix on 2026-08-26, rather than
 * a synthetic ladder — the whole point is what THIS league's distribution does to
 * a threshold, and a made-up matrix cannot show that.
 */
describe("the default threshold, against the real fixture list", () => {
  const REAL: Readonly<Record<string, readonly number[]>> = {
    LIV: [3, 3, 2, 2, 3, 4, 3, 2], CRY: [3, 4, 3, 2, 3, 3, 3, 2],
    MUN: [2, 2, 3, 4, 3, 3, 3, 3], NEW: [4, 3, 3, 3, 2, 2, 3, 3],
    SUN: [2, 2, 3, 4, 5, 2, 3, 2], ARS: [2, 4, 4, 3, 3, 2, 3, 3],
    CHE: [3, 2, 5, 2, 3, 3, 3, 3], COV: [5, 2, 5, 2, 3, 2, 3, 2],
    FUL: [4, 3, 3, 4, 4, 2, 2, 2], MCI: [3, 3, 2, 4, 2, 4, 2, 4],
    NFO: [2, 4, 3, 4, 2, 3, 4, 2], TOT: [3, 2, 3, 3, 3, 4, 2, 4],
    AVL: [3, 4, 2, 3, 3, 3, 3, 4], BRE: [3, 3, 2, 3, 4, 4, 4, 2],
    BHA: [3, 4, 2, 2, 4, 3, 3, 4], HUL: [4, 2, 3, 4, 3, 3, 3, 3],
    EVE: [3, 3, 4, 3, 2, 2, 4, 5], IPS: [2, 4, 4, 3, 3, 2, 5, 3],
    LEE: [3, 3, 3, 2, 3, 5, 4, 3], BOU: [5, 3, 3, 3, 4, 4, 2, 4],
  };

  const league = () =>
    Object.entries(REAL).map(([code, ds], i) =>
      club(code, code, [...ds], i + 1));

  const runsAt = (max: number) =>
    allPhases(buildClubRows(league(), { minLength: 3, maxDifficulty: max }));

  it("opens on a board with something on it", () => {
    expect(runsAt(DEFAULT_MAX_DIFFICULTY).length).toBeGreaterThan(10);
  });

  it("would have opened on an all-but-empty one at the strictest setting", () => {
    // One run in twenty clubs. The reader arrives at a matrix that looks broken,
    // and the cause is the fixture list rather than the code: FPL never assigns a
    // 1 and FDR 3 is 45% of all fixtures.
    expect(runsAt(2)).toHaveLength(1);
  });

  it("does not just take the first threshold on offer", () => {
    // THRESHOLDS is ordered kindest-first, which is right for a toggle and wrong
    // for a default. This is what stops the two being conflated again.
    expect(DEFAULT_MAX_DIFFICULTY).not.toBe(THRESHOLDS[0].max);
    expect(THRESHOLDS.some((t) => t.max === DEFAULT_MAX_DIFFICULTY)).toBe(true);
  });

  it("still separates good runs from ordinary ones at the wider gate", () => {
    // The wider threshold does not cost discrimination, because relief does that
    // work now: a run of flat 3s buys almost nothing and sorts to the bottom.
    const ordered = runsAt(DEFAULT_MAX_DIFFICULTY);
    expect(ordered[0].relief).toBeGreaterThan(3);
    expect(ordered[ordered.length - 1].relief).toBeLessThan(0.5);
  });

  it("no longer ranks four flat threes above three straight twos", () => {
    const ordered = runsAt(DEFAULT_MAX_DIFFICULTY);
    const at = (code: string) => ordered.findIndex((p) => p.shortName === code);
    // Man United's [3,3,3,3] against Fulham's [2,2,2] — the pair that made the
    // case for ranking on relief.
    expect(at("FUL")).toBeLessThan(at("MUN"));
  });
});
