/**
 * Coverage is derived or withheld — it is never inferred from a neighbour.
 *
 * This module exists because the sheet puts two providers' expected goals on one
 * row, and without a denominator beside each they read as two models disagreeing.
 * The tests below are mostly about the ADMISSIONS: a coverage nobody published
 * must come back null so the strip can print ∅, exactly as a cell does.
 */
import { describe, expect, it } from "vitest";

import { coverageDiffers, coverageFor, understatMatches } from "@/lib/projections/stat-coverage";
import type { PlayerEvent } from "@/lib/data/player-events";

const event = (matches: number | null): PlayerEvent =>
  ({ elementId: 1, matches } as unknown as PlayerEvent);

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
    expect(coverageFor("playerStats", { gameweek: 4, events }).reach).toBe("3 matches");
    expect(coverageFor("playerStats", { gameweek: 2, events }).reach).toBe("1 match");
  });

  it("says nothing has been played rather than going negative", () => {
    expect(coverageFor("playerStats", { gameweek: 1, events }).reach).toBe("0 matches");
  });

  it("withholds FPL's reach when no gameweek resolved, and says why", () => {
    const cover = coverageFor("playerStats", { gameweek: null, events });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("gameweek");
  });

  it("withholds the simulation's week for the same reason", () => {
    const cover = coverageFor("projections", { gameweek: null, events });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("gameweek");
  });

  it("points the simulation at exactly the week it was generated for", () => {
    expect(coverageFor("projections", { gameweek: 4, events }).reach).toBe("GW4");
  });

  it("gives the market no denominator, because it has none", () => {
    const cover = coverageFor("market", { gameweek: null, events: null });
    expect(cover.reach).toBe("live");
    expect(cover.unknownBecause).toBeNull();
  });

  it("never borrows one source's reach for another", () => {
    // The failure this module was written to prevent: a known gameweek must not
    // make Understat's silence look like an answer.
    const cover = coverageFor("playerEvents", { gameweek: 4, events: [event(null)] });
    expect(cover.reach).toBeNull();
    expect(cover.unknownBecause).toContain("did not say");
  });
});

describe("the warning the strip raises", () => {
  it("fires when two records of different depth are on one sheet", () => {
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(1)] }),
      coverageFor("playerEvents", { gameweek: 4, events: [event(1)] }),
    ];
    // Three matches against one — the exact case that made two xG figures look
    // like an argument.
    expect(coverageDiffers(covers)).toBe(true);
  });

  it("stays quiet when both records are the same depth", () => {
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(3)] }),
      coverageFor("playerEvents", { gameweek: 4, events: [event(3)] }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });

  it("does not count a week or a market as a disagreement", () => {
    // A simulation's GW4 and a market's "live" have no denominator, so they can
    // differ from everything without anything being wrong.
    const covers = [
      coverageFor("playerStats", { gameweek: 4, events: [event(3)] }),
      coverageFor("projections", { gameweek: 4, events: [event(3)] }),
      coverageFor("market", { gameweek: 4, events: [event(3)] }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });

  it("stays quiet when one of the two is withheld", () => {
    // Two things cannot be shown to differ when one of them was never stated.
    const covers = [
      coverageFor("playerStats", { gameweek: null, events: [event(1)] }),
      coverageFor("playerEvents", { gameweek: null, events: [event(1)] }),
    ];
    expect(coverageDiffers(covers)).toBe(false);
  });
});
