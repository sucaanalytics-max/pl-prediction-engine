/**
 * Coverage is derived or withheld — it is never inferred from a neighbour.
 *
 * This module exists because the sheet puts two providers' expected goals on one
 * row, and without a denominator beside each they read as two models disagreeing.
 * The tests below are mostly about the ADMISSIONS: a coverage nobody published
 * must come back null so the strip can print ∅, exactly as a cell does.
 */
import { describe, expect, it } from "vitest";

import {
  coverageDiffers, coverageFor, fplMatches, understatMatches,
} from "@/lib/projections/stat-coverage";
import type { PlayerEvent } from "@/lib/data/player-events";
import type { PlayerRow } from "@/lib/data/narrow";

const event = (matches: number | null): PlayerEvent =>
  ({ elementId: 1, matches } as unknown as PlayerEvent);
/** A record whose deepest player has played `minutes`. */
const record = (minutes: number): readonly PlayerRow[] =>
  [{ elementId: 1, minutes: 0 }, { elementId: 2, minutes }] as unknown as readonly PlayerRow[];
/** Three gameweeks played, which is where the season stands in most of these. */
const played3 = record(270);

describe("Understat states its own reach, per row", () => {
  it("takes the deepest row, because the claim is about the feed", () => {
    // A player who missed a game carries fewer; the band's coverage is what the
    // feed has ingested, not what the shallowest player played.
    expect(understatMatches([event(1), event(3), event(2)])).toBe(3);
  });

  it("withholds when no row says, rather than guessing one", () => {
    expect(understatMatches([event(null), event(null)])).toBeNull();
    expect(understatMatches([])).toBeNull();
    expect(understatMatches(null)).toBeNull();
  });

  it("ignores rows that omit it without discarding the ones that do not", () => {
    expect(understatMatches([event(null), event(2)])).toBe(2);
  });
});

describe("each band's reach, or an admission", () => {
  const events = [event(1)];

  it("reads FPL's record from the gameweek, minus the week not yet played", () => {
    expect(coverageFor("playerStats", { gameweek: 4, events, stats: played3 }).reach)
      .toBe("3 matches");
    expect(coverageFor("playerStats", { gameweek: 2, events, stats: record(90) }).reach)
      .toBe("1 match");
  });

  it("says nothing has been played rather than going negative", () => {
    expect(coverageFor("playerStats", { gameweek: 1, events, stats: record(0) }).reach)
      .toBe("0 matches");
  });

  it("floors, so a player short of ninety minutes does not add a match", () => {
    // 260 minutes is two full matches and most of a third. Rounding up would
    // claim a match nobody completed.
    expect(coverageFor("playerStats", { gameweek: 4, events, stats: record(260) }).reach)
      .toBe("2 matches");
  });

  it("counts the FILE, not the calendar, once a deadline has passed", () => {
    /* The case the calendar version got wrong and this one does not. After a
       deadline the resolved gameweek advances while no minute of it has been
       played: `gameweek - 1` claimed four matches off a record holding three.
       A file that says 270 minutes has three matches in it whatever the
       calendar thinks. */
    expect(coverageFor("playerStats", { gameweek: 5, events, stats: played3 }).reach)
      .toBe("3 matches");
  });

  it("withholds FPL's reach when the record is not published, and says why", () => {
    // No longer a question about the gameweek: the record measures itself, so
    // the only way its depth is unknown is that there is no record.
    const cover = coverageFor("playerStats", { gameweek: 4, events, stats: null });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("not published");
  });

  it("still states the record's depth with no gameweek at all", () => {
    // The simulation needs a week; the record does not, and used to be withheld
    // alongside it for a number it never read.
    expect(coverageFor("playerStats", { gameweek: null, events, stats: played3 }).reach)
      .toBe("3 matches");
  });

  it("withholds the simulation's week for the same reason", () => {
    const cover = coverageFor("projections", { gameweek: null, events, stats: played3 });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("gameweek");
  });

  it("points the simulation at exactly the week it was generated for", () => {
    expect(coverageFor("projections", { gameweek: 4, events, stats: played3 }).reach).toBe("GW4");
  });

  it("gives the market no denominator, because it has none", () => {
    const cover = coverageFor("market", { gameweek: null, events: null, stats: null });
    expect(cover.reach).toBe("live");
    expect(cover.unknownBecause).toBeNull();
  });

  it("never borrows one source's reach for another", () => {
    // The failure this module was written to prevent: a known gameweek must not
    // make Understat's silence look like an answer.
    const cover = coverageFor("playerEvents", { gameweek: 4, events: [event(null)], stats: played3 });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("did not say");
  });
});

describe("the warning the strip raises", () => {
  it("fires when two records of different depth are on one sheet", () => {
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(1)], stats: played3 }),
      coverageFor("playerEvents", { gameweek: 4, events: [event(1)], stats: played3 }),
    ];
    // Three matches against one — the exact case that made two xG figures look
    // like an argument.
    expect(coverageDiffers(covers)).toBe(true);
  });

  it("stays quiet when both records are the same depth", () => {
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(3)], stats: played3 }),
      coverageFor("playerEvents", { gameweek: 4, events: [event(3)], stats: played3 }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });

  it("does not count a week or a market as a disagreement", () => {
    // A simulation's GW4 and a market's "live" have no denominator, so they can
    // differ from everything without anything being wrong.
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(3)], stats: played3 }),
      coverageFor("projections", { gameweek: 4, events: [event(3)], stats: played3 }),
      coverageFor("market", { gameweek: 4, events: [event(3)], stats: played3 }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });

  it("stays quiet when one of the two is withheld", () => {
    // Two things cannot be shown to differ when one of them was never stated.
    const covers = [
      coverageFor("playerStats", { gameweek: null, events: [event(1)], stats: null }),
      coverageFor("playerEvents", { gameweek: null, events: [event(1)], stats: null }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });
});

describe("the record measures its own depth", () => {
  it("takes the deepest player, because a benched one says nothing about the file", () => {
    expect(fplMatches(record(270))).toBe(3);
  });

  it("withholds when there is no record at all", () => {
    expect(fplMatches(null)).toBeNull();
    expect(fplMatches([])).toBeNull();
  });

  it("reads a season not yet started as zero, which is a real state", () => {
    expect(fplMatches(record(0))).toBe(0);
  });
});
