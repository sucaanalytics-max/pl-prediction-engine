/**
 * The join, the two derived numbers, and who is allowed to win.
 *
 * The load-bearing assertions are the refusals: a per-90 that the minutes cannot
 * support, and a "leader" marked on a metric where nobody actually leads.
 */

import { describe, expect, it } from "vitest";

import { compare, leaders, METRICS, xaPer90, xgi } from "@/lib/margin/compare";
import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";

function stats(over: Partial<PlayerRow> = {}): PlayerRow {
  return {
    elementId: 1, name: "Haaland", team: "MCI", position: "FWD",
    minutes: 900, goals: 10, assists: 2, xg: 8.5, xa: 1.5,
    fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 73.4, fpl_price: 15.5, form: 6.2,
    available: true, ratesAreMeaningful: true, ...over,
  };
}

function projection(over: Partial<Projection> = {}): Projection {
  return {
    elementId: 1, name: "Haaland", team: "Man City", position: "FWD",
    xp: 6.83, xpSd: 3.1, mode: 2, pAppears: .95, p60: .9, eMinutes: 89,
    pGoal: .6, pCleanSheet: .3, pGe5: .4, pGe10: .15,
    q10: 1, q25: 2, q50: 5, q75: 9, q90: 13,
    nFixtures: 1, blank: false, decomposition: null, ...over,
  };
}

describe("the derived pair", () => {
  it("adds xG and xA into xGI", () => {
    expect(xgi(stats({ xg: 8.5, xa: 1.5 }))).toBeCloseTo(10);
  });

  it("has no xGI for a player with no stats row", () => {
    expect(xgi(null)).toBeNull();
  });

  it("scales xA by the minutes actually played", () => {
    // 1.8 xA in 900 minutes is 0.18 per ninety.
    expect(xaPer90(stats({ xa: 1.8, minutes: 900 }))).toBeCloseTo(0.18);
  });

  it("refuses a rate the minutes cannot support", () => {
    /**
     * The trap the narrower flags. The producer's own per-90 divides by
     * `max(minutes/90, .1)`, so four minutes reads as ten times the total — a
     * fabricated rate rendered in the same column as measured ones.
     */
    expect(xaPer90(stats({ minutes: 4, xa: 0.4, ratesAreMeaningful: false }))).toBeNull();
  });

  it("refuses a rate with no minutes at all rather than dividing by zero", () => {
    expect(xaPer90(stats({ minutes: 0, ratesAreMeaningful: true }))).toBeNull();
  });
});

describe("the join", () => {
  it("puts both artifacts' view of one player on one row", () => {
    const [row] = compare([1], [projection()], [stats()]);
    expect(row.projection?.xp).toBe(6.83);
    expect(row.stats?.goals).toBe(10);
    expect(row.xgi).toBeCloseTo(10);
  });

  it("keeps a player the projection has but the stats file does not", () => {
    const [row] = compare([1], [projection()], []);
    expect(row.projection).not.toBeNull();
    expect(row.stats).toBeNull();
    // No stats means no underlying numbers, not zeroed ones.
    expect(row.xgi).toBeNull();
  });

  it("keeps a player the stats file has but the projection does not", () => {
    const [row] = compare([1], [], [stats()]);
    expect(row.stats).not.toBeNull();
    expect(row.projection).toBeNull();
  });

  it("drops an id neither artifact knows rather than showing a blank column", () => {
    expect(compare([999], [projection()], [stats()])).toHaveLength(0);
  });

  it("follows the order the reader picked, not either artifact's", () => {
    const rows = compare(
      [2, 1],
      [projection(), projection({ elementId: 2, name: "Salah" })],
      [stats(), stats({ elementId: 2, name: "Salah" })],
    );
    expect(rows.map((r) => r.name)).toEqual(["Salah", "Haaland"]);
  });

  it("joins on the element id rather than the name", () => {
    // The two artifacts spell clubs differently ("MCI" against "Man City") and
    // used to be matched by accent-folded name. The id makes that unnecessary.
    const [row] = compare([1], [projection({ name: "Haaland" })],
                          [stats({ name: "Erling Haaland" })]);
    expect(row.stats?.name).toBe("Erling Haaland");
    expect(row.name).toBe("Haaland");
  });

  it("ignores a stats row with no element id", () => {
    const [row] = compare([1], [projection()], [stats({ elementId: null })]);
    expect(row.stats).toBeNull();
  });
});

describe("who is marked as leading", () => {
  const metric = METRICS.find((m) => m.key === "xp")!;
  const price = METRICS.find((m) => m.key === "price")!;

  it("marks the higher number when higher is better", () => {
    const rows = compare(
      [1, 2],
      [projection({ xp: 6.8 }), projection({ elementId: 2, xp: 4.1 })],
      [stats(), stats({ elementId: 2 })],
    );
    expect([...leaders(metric, rows)]).toEqual([1]);
  });

  it("marks the lower number for price, where cheaper wins", () => {
    const rows = compare(
      [1, 2],
      [projection(), projection({ elementId: 2 })],
      [stats({ fpl_price: 15.5 }), stats({ elementId: 2, fpl_price: 7.0 })],
    );
    expect([...leaders(price, rows)]).toEqual([2]);
  });

  it("marks nobody when everyone is level", () => {
    // A tie among all of them is not a win for whoever sorted first.
    const rows = compare(
      [1, 2],
      [projection({ xp: 5 }), projection({ elementId: 2, xp: 5 })],
      [stats(), stats({ elementId: 2 })],
    );
    expect(leaders(metric, rows).size).toBe(0);
  });

  it("marks both when two lead and a third trails", () => {
    const rows = compare(
      [1, 2, 3],
      [projection({ xp: 5 }), projection({ elementId: 2, xp: 5 }),
       projection({ elementId: 3, xp: 1 })],
      [stats(), stats({ elementId: 2 }), stats({ elementId: 3 })],
    );
    expect([...leaders(metric, rows)].sort()).toEqual([1, 2]);
  });

  it("never lets a missing number win", () => {
    /**
     * A player the producer has no view on has not beaten one it does.
     *
     * Three players, because with two this is indistinguishable from the case
     * below — the first version of this test asserted the opposite of that one
     * on identical input, and both passing was impossible.
     */
    const rows = compare(
      [1, 2, 3],
      [projection({ xp: null }), projection({ elementId: 2, xp: 2.0 }),
       projection({ elementId: 3, xp: 5.0 })],
      [stats(), stats({ elementId: 2 }), stats({ elementId: 3 })],
    );
    expect([...leaders(metric, rows)]).toEqual([3]);
  });

  it("marks nobody when only one player has the number", () => {
    // Leading a field of one is not information.
    const rows = compare(
      [1, 2],
      [projection({ xp: 6.8 }), projection({ elementId: 2, xp: null })],
      [stats(), stats({ elementId: 2 })],
    );
    expect(leaders(metric, rows).size).toBe(0);
  });
});
