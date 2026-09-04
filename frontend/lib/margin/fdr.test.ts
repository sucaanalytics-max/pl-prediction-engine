/**
 * Joining a player to his club's fixture for a week.
 *
 * This is deliberately a JOIN and nothing else. `lib/projections/phases.ts`
 * already folds a club's fixtures into weeks — doubles collapsed to their worst
 * rating, blanks kept as aligned cells — and `difficultyBand` already maps a
 * rating onto the `TRAFFIC` ramp, with a measured reason for having four stops
 * rather than five. Both are tested there. Re-deriving either here would be a
 * second answer to a question this repo has already answered once, and the two
 * would drift.
 *
 * What is new is the join, and its failure mode is specific: a player whose club
 * cannot be found must read as UNKNOWN, never as a blank. `PhaseWeek` already
 * distinguishes a blank (`blank: true`, `difficulty: null`) from anything else,
 * so the only state this module has to add is the absence of a club — `null`.
 */
import { describe, expect, it } from "vitest";

import { indexClubWeeks, weekFor } from "@/lib/margin/fdr";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";

function row(team: string, fixtures: FixtureMatrixRow["fixtures"]): FixtureMatrixRow {
  return {
    teamId: 1, team, shortName: team.slice(0, 3).toUpperCase(),
    fixtures, meanDifficulty: 0, totalDifficulty: 0,
  };
}

const MATRIX: readonly FixtureMatrixRow[] = [
  row("Coventry City", [
    { gameweek: 4, label: "BHA (H)", difficulty: 2 },
    { gameweek: 5, label: "NFO (A)", difficulty: 3 },
    // GW6 absent: a real blank.
  ]),
  row("Man Utd", [
    { gameweek: 4, label: "MCI (H)", difficulty: 4 },
    { gameweek: 5, label: "LEE (A)", difficulty: 2 },
    { gameweek: 5, label: "ARS (H)", difficulty: 5 },
  ]),
];

const WEEKS = [4, 5, 6];

describe("the club-week join", () => {
  it("finds a club's week by team name", () => {
    const week = weekFor(indexClubWeeks(MATRIX, WEEKS), "Coventry City", 4);
    expect(week?.labels).toEqual(["BHA (H)"]);
    expect(week?.difficulty).toBe(2);
  });

  it("carries a double as one week at its worst rating", () => {
    /**
     * Not re-implemented here — `clubWeeks` does it — but asserted through the
     * join, because a join that reached past it and read `row.fixtures` directly
     * would silently take whichever leg came first. GW5 is LEE (A) at 2 and
     * ARS (H) at 5, so the week is a 5.
     */
    const week = weekFor(indexClubWeeks(MATRIX, WEEKS), "Man Utd", 5);
    expect(week?.doubleGameweek).toBe(true);
    expect(week?.difficulty).toBe(5);
    expect(week?.labels).toEqual(["LEE (A)", "ARS (H)"]);
  });

  it("returns a blank week as a blank, and an unknown club as null", () => {
    /**
     * The load-bearing distinction. Both are falsy-ish to a careless caller, and
     * conflating them puts a fixture chip's kindest colour under a week that
     * either does not exist or was never read.
     */
    const index = indexClubWeeks(MATRIX, WEEKS);

    const blank = weekFor(index, "Coventry City", 6);
    expect(blank?.blank).toBe(true);
    expect(blank?.difficulty).toBeNull();

    expect(weekFor(index, "Wrexham", 4)).toBeNull();
  });

  it("returns null for a club with no name", () => {
    /** `Projection.team` is nullable, and null must not match a real club. */
    expect(weekFor(indexClubWeeks(MATRIX, WEEKS), null, 4)).toBeNull();
  });

  it("does not match a club by a different spelling", () => {
    /**
     * `xp_public` and `/api/fpl/state` agree on all twenty names today — both
     * take FPL's own, verified against the live route. `player_stats.json` does
     * NOT: it says "Man United" and "Tottenham" where these say "Man Utd" and
     * "Spurs". A consumer pointed at that artifact must get null and render
     * "unknown", rather than a silent colour on a fifth of the squad.
     */
    expect(weekFor(indexClubWeeks(MATRIX, WEEKS), "Man United", 4)).toBeNull();
  });

  it("spans every requested week, so columns cannot shift", () => {
    /**
     * The reason `clubWeeks` takes its gameweeks as an argument. A club blank in
     * GW6 still needs a GW6 cell, or its GW7 fixture renders under the GW6
     * heading — which is the grid lying about which fixture a number belongs to.
     */
    const index = indexClubWeeks(MATRIX, WEEKS);
    for (const gameweek of WEEKS) {
      expect(weekFor(index, "Coventry City", gameweek)?.gameweek).toBe(gameweek);
    }
  });

  it("is empty rather than throwing when the matrix could not be read", () => {
    /**
     * `/api/fpl/state` is a live route that has 503'd in production inside the
     * last day. The grid's xP comes from a published artifact and must still
     * draw; every club then reads as unknown, which is true.
     */
    const index = indexClubWeeks([], WEEKS);
    expect(weekFor(index, "Coventry City", 4)).toBeNull();
  });
});
