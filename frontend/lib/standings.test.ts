import { describe, expect, it } from "vitest";
import { deriveZone, tableIsRanked } from "@/lib/standings";
import type { TeamStanding } from "@/lib/predictions";

function row(position: number, team: string, played = 0): TeamStanding {
  return {
    position, team, played,
    won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0, form: [],
  };
}

/**
 * The real pre-season artifact: 20 clubs, alphabetical, every counter zero, and
 * `position` already assigned 1-20 by `fpl_api.py`. This is a *correct* file,
 * which is what made the bug survive — there is nothing to detect upstream.
 */
const PRE_SEASON: TeamStanding[] = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Burnley", "Chelsea", "Crystal Palace", "Everton", "Fulham",
  "Leeds", "Liverpool", "Man City", "Man United", "Newcastle",
  "Nottingham Forest", "Sunderland", "Tottenham", "West Ham", "Wolves",
].map((team, i) => row(i + 1, team, 0));

describe("tableIsRanked", () => {
  it("is false for the all-zero pre-season table", () => {
    expect(tableIsRanked(PRE_SEASON)).toBe(false);
  });

  it("is true as soon as one club has played", () => {
    const afterOneGame = PRE_SEASON.map((r, i) =>
      i === 0 ? { ...r, played: 1 } : r,
    );
    expect(tableIsRanked(afterOneGame)).toBe(true);
  });

  it("is false for an empty table rather than throwing", () => {
    expect(tableIsRanked([])).toBe(false);
  });

  it("tolerates a row with played absent entirely", () => {
    const missing = [{ ...row(1, "Arsenal"), played: undefined as never }];
    expect(tableIsRanked(missing)).toBe(false);
  });
});

describe("deriveZone", () => {
  /**
   * The bug, stated as a test. Every club in the pre-season table must return
   * null — including the four at the top, which is what previously rendered as
   * "Arsenal, Aston Villa, Bournemouth and Brentford are in the Champions
   * League".
   */
  it("highlights no zone anywhere in an unranked table", () => {
    const zones = PRE_SEASON.map((club) => deriveZone(club, PRE_SEASON));
    expect(zones.every((z) => z === null)).toBe(true);
  });

  it("does not highlight the top four of an unranked table", () => {
    for (const club of PRE_SEASON.slice(0, 4)) {
      expect(deriveZone(club, PRE_SEASON)).toBeNull();
    }
  });

  it("does not highlight the bottom three of an unranked table", () => {
    for (const club of PRE_SEASON.slice(17)) {
      expect(deriveZone(club, PRE_SEASON)).toBeNull();
    }
  });

  describe("once the season has started", () => {
    const RANKED = PRE_SEASON.map((r) => ({ ...r, played: 10 }));

    it("assigns the four Champions League places", () => {
      for (const pos of [1, 2, 3, 4]) {
        expect(deriveZone(RANKED[pos - 1], RANKED)).toBe("champions");
      }
    });

    it("assigns 5th to Europa and 6th to Conference", () => {
      expect(deriveZone(RANKED[4], RANKED)).toBe("europa");
      expect(deriveZone(RANKED[5], RANKED)).toBe("conference");
    });

    it("assigns 18th to 20th to relegation", () => {
      for (const pos of [18, 19, 20]) {
        expect(deriveZone(RANKED[pos - 1], RANKED)).toBe("relegation");
      }
    });

    it("leaves mid-table unhighlighted", () => {
      for (const pos of [7, 10, 17]) {
        expect(deriveZone(RANKED[pos - 1], RANKED)).toBeNull();
      }
    });
  });

  /**
   * Mutation guard. `position !== 0` was the tempting alternative gate, and it
   * would pass every test above except this one: positions are never zero, so
   * that predicate is true for exactly the rows it needs to reject. Asserting
   * the *table* is what makes the distinction, not the row.
   */
  it("rejects on played, not on a non-zero position", () => {
    const club = row(1, "Arsenal", 0);
    expect(club.position).not.toBe(0); // the alternative gate would pass here
    expect(deriveZone(club, [club])).toBeNull();
  });

  /**
   * A club with a game in hand must not un-rank the table for everyone else.
   * This is why `tableIsRanked` sums rather than requiring every row.
   */
  it("stays ranked when one club has played no games mid-season", () => {
    const uneven = PRE_SEASON.map((r, i) => ({ ...r, played: i === 3 ? 0 : 10 }));
    expect(deriveZone(uneven[0], uneven)).toBe("champions");
    expect(deriveZone(uneven[3], uneven)).toBe("champions");
  });
});
