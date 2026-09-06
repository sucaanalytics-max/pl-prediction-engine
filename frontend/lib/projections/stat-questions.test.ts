/**
 * The manifest's structural claims, after the sheet went from tabs-by-source to
 * questions-with-bands.
 *
 * The rule the old tabs enforced by NAVIGATION — two sources are never read
 * against each other — is now enforced by a header a reader has to look at. Most
 * of that is typographic and cannot be tested. One part of it is structural and is
 * tested here: a derived column may not read across a band, because the two
 * providers cover different numbers of matches and the subtraction would be
 * arithmetic on two different denominators.
 */
import { describe, expect, it } from "vitest";

import {
  BLOCKED_FEEDS, STAT_QUESTIONS, columnsOf, questionByKey, sourcesOf,
  type StatRow,
} from "@/lib/projections/stat-questions";

/** A row that answers everything, so a column's reach can be observed. */
function probe(patch: Partial<StatRow> = {}): StatRow {
  return {
    elementId: 1, name: "Probe", team: "PRB", position: "MID", owned: false,
    stats: {
      elementId: 1, name: "Probe", team: "PRB", position: "MID",
      minutes: 270, goals: 3, assists: 2, xg: 2.2, xa: 1.1,
      ratesAreMeaningful: true, form: 5, fpl_price: 8, fpl_ownership: 12,
    } as unknown as StatRow["stats"],
    projection: {
      elementId: 1, xp: 5, xpSd: 4, p60: 0.9, eMinutes: 80, pGoal: 0.3, pGe10: 0.12,
    } as unknown as StatRow["projection"],
    event: {
      elementId: 1, minutes: 90, matches: 1, shots: 4, keyPasses: 3,
      npXg: 1.4, xa: 0.2, xgChain: 0.5, shotsPer90: 4,
    } as unknown as StatRow["event"],
    ...patch,
  };
}

describe("every question is answerable and says what it asks", () => {
  it("gives every question a unique key", () => {
    const keys = STAT_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every question a note, so no sheet is unexplained", () => {
    for (const q of STAT_QUESTIONS) {
      expect(q.note.length, q.key).toBeGreaterThan(40);
      expect(q.label.endsWith("?"), `${q.key} is not phrased as a question`).toBe(true);
    }
  });

  it("gives every question at least two sources, which is why it is a question", () => {
    // A question answerable from one artifact did not need this structure — it was
    // already a tab. The point of moving the boundary was to let a question pull
    // from more than one warranty, so a single-source question is a smell.
    for (const q of STAT_QUESTIONS) {
      expect(new Set(sourcesOf(q)).size, `${q.key} reads one source`).toBeGreaterThan(1);
    }
  });

  it("opens sorted by a column it actually has", () => {
    for (const q of STAT_QUESTIONS) {
      const keys = columnsOf(q).map((c) => c.key);
      expect(keys, `${q.key} sorts by a column it does not carry`).toContain(q.sortKey);
    }
  });

  it("names every column uniquely within a question", () => {
    for (const q of STAT_QUESTIONS) {
      const keys = columnsOf(q).map((c) => c.key);
      expect(new Set(keys).size, `${q.key} repeats a column key`).toBe(keys.length);
    }
  });

  it("falls back to the first question rather than throwing on an unknown key", () => {
    expect(questionByKey("no-such-question")).toBe(STAT_QUESTIONS[0]);
  });
});

describe("a band is a warranty, and a derived column may not cross one", () => {
  /**
   * The one part of the old tab rule that survives as structure rather than as
   * typography.
   *
   * A derived column is fed a row in which exactly one source is present at a
   * time. If it can still produce a figure with its OWN band's source removed, it
   * is reading across a band — and the two providers on this sheet cover
   * different numbers of matches, so that subtraction is arithmetic on two
   * different denominators.
   */
  const blanks: Record<string, Partial<StatRow>> = {
    playerStats: { stats: null },
    projections: { projection: null },
    playerEvents: { event: null },
    market: { stats: null },
  };

  for (const question of STAT_QUESTIONS) {
    for (const band of question.bands) {
      for (const column of band.columns) {
        if (!column.derived) continue;
        it(`${question.key}/${column.key} reads only the ${band.name} band`, () => {
          // With its own band's source gone it must withhold.
          expect(column.of(probe(blanks[band.source])),
            `${column.key} still answers without its own source`).toBeNull();

          // The exception, stated rather than left looking like an oversight: a
          // price has no denominator, so xP per £m may span the simulation and the
          // market. Any OTHER cross-band derivation is the defect.
          const spansOthers = Object.entries(blanks)
            .filter(([source]) => source !== band.source && source !== "market")
            .some(([, patch]) => column.of(probe(patch)) === null);
          if (column.key !== "perMillion") {
            expect(spansOthers,
              `${column.key} depends on a source outside its band`).toBe(false);
          }
        });
      }
    }
  }

  it("has at least one derived column, or the rule above guards nothing", () => {
    const derived = STAT_QUESTIONS.flatMap((q) => columnsOf(q)).filter((c) => c.derived);
    expect(derived.length).toBeGreaterThan(0);
  });

  it("puts G − xG inside the FPL band, where both halves come from", () => {
    // The worked example. Both goals and xG are FPL's own, so the subtraction is
    // over one denominator — which is the whole reason it is allowed to exist.
    const finishing = questionByKey("finishing");
    const band = finishing.bands.find((b) => b.columns.some((c) => c.key === "overExpected"));
    expect(band?.source).toBe("playerStats");
    expect(band?.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(["goals", "xg", "overExpected"]),
    );
  });
});

describe("two providers' expected goals are never one column", () => {
  it("keeps FPL's xG and Understat's npxG in different bands", () => {
    const finishing = questionByKey("finishing");
    const fplBand = finishing.bands.find((b) => b.columns.some((c) => c.key === "xg"));
    const understatBand = finishing.bands.find((b) => b.columns.some((c) => c.key === "npxg"));
    expect(fplBand?.source).toBe("playerStats");
    expect(understatBand?.source).toBe("playerEvents");
    expect(fplBand).not.toBe(understatBand);
  });

  it("withholds a per-90 the producer refused, rather than computing one", () => {
    const finishing = questionByKey("finishing");
    const rate = columnsOf(finishing).find((c) => c.key === "xg90");
    const unmeaningful = probe({
      stats: { minutes: 8, xg: 0.4, ratesAreMeaningful: false } as unknown as StatRow["stats"],
    });
    expect(rate?.of(unmeaningful)).toBeNull();
  });
});

describe("what this pipeline cannot carry", () => {
  it("names every blocked feed with what is missing", () => {
    expect(BLOCKED_FEEDS.length).toBeGreaterThan(0);
    for (const feed of BLOCKED_FEEDS) {
      expect(feed.blockedBy.length, feed.key).toBeGreaterThan(30);
      expect(feed.note.length, feed.key).toBeGreaterThan(10);
    }
  });

  it("gives every blocked feed a unique key", () => {
    const keys = BLOCKED_FEEDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("a comparison only marks a figure where there is something to win", () => {
  it("gives every column an explicit direction, or none at all", () => {
    // Explicit, because the default was the bug: `Math.max` over every column put
    // a rule under the more expensive player's price and the more owned player's
    // ownership, which are facts about a purchase and not merits.
    for (const question of STAT_QUESTIONS) {
      for (const column of columnsOf(question)) {
        expect(Object.prototype.hasOwnProperty.call(column, "better"),
          `${question.key}/${column.key} does not say which end is better`).toBe(true);
      }
    }
  });

  it("makes price and ownership no contest at all", () => {
    for (const question of STAT_QUESTIONS) {
      for (const column of columnsOf(question)) {
        if (column.key === "price" || column.key === "own") {
          expect(column.better, `${column.key} is being scored`).toBeNull();
        }
      }
    }
  });

  it("inverts the spread, because a wider one is a worse buy at the same mean", () => {
    const priced = questionByKey("priced");
    expect(columnsOf(priced).find((c) => c.key === "sd")?.better).toBe("low");
    expect(columnsOf(priced).find((c) => c.key === "xp")?.better).toBe("high");
  });
});
