/**
 * Windows, pollution, and what must be withheld.
 *
 * The case that separates the two definitions is a good buy left on the bench:
 * raw says you picked well, effective says it earned you nothing, and both are
 * true. Their difference is the third metric.
 */
import { describe, expect, it } from "vitest";
import {
  MINIMUM_CLEAN_WINDOWS, basketFor, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";
import type {
  ManagerHistory, ManagerTransfer,
} from "@/lib/data/narrow-manager-history";

function transfer(over: Partial<ManagerTransfer> = {}): ManagerTransfer {
  return {
    event: 3, time: null, elementIn: 1, elementInCost: 50,
    elementOut: 2, elementOutCost: 50,
    inPointsByGw: new Map([[3, -1]]),
    outPointsByGw: new Map([[3, 2]]),
    inMultiplierByGw: new Map([[3, 1]]),
    ...over,
  } as ManagerTransfer;
}

const history = (transfers: ManagerTransfer[]): ManagerHistory => ({
  generatedAt: null, entryId: 20945, settledThrough: 3,
  names: new Map(), gameweeks: [], transfers,
});

describe("windowFor", () => {
  it("scores the gameweek the transfer was made", () => {
    const w = windowFor(transfer(), 1);
    expect(w.settled).toBe(true);
    expect(w.raw).toBe(-3);        // -1 - 2
    expect(w.effective).toBe(-3);  // x1, he started
    expect(w.polluted).toBe(false);
  });

  it("withholds a window whose gameweeks have not all settled", () => {
    const w = windowFor(transfer(), 2);
    expect(w.settled).toBe(false);
    expect(w.effective).toBeNull();
    expect(w.raw).toBeNull();
  });

  it("says a benched buy earned nothing while still crediting the pick", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 12]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, 0]]),   // benched
    }), 1);
    expect(w.raw).toBe(10);
    expect(w.effective).toBe(0);
    expect(w.gap).toBe(10);   // value given back by the lineup decision
  });

  it("doubles a captained buy", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 12]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, 2]]),
    }), 1);
    expect(w.effective).toBe(20);
  });

  it("marks a window polluted once the player leaves the squad", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 5], [4, 9]]),
      outPointsByGw: new Map([[3, 2], [4, 1]]),
      inMultiplierByGw: new Map([[3, 1], [4, null]]),
    }), 2);
    expect(w.settled).toBe(true);
    expect(w.polluted).toBe(true);
  });

  it("treats a null multiplier as earning nothing, not as a zero score", () => {
    // The distinction that matters: the GW4 delta is +8 raw, but he was not
    // yours, so it reached your score as 0 AND the window is flagged.
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 0], [4, 9]]),
      outPointsByGw: new Map([[3, 0], [4, 1]]),
      inMultiplierByGw: new Map([[3, 1], [4, null]]),
    }), 2);
    expect(w.raw).toBe(8);
    expect(w.effective).toBe(0);
    expect(w.polluted).toBe(true);
  });
});

describe("transferAggregate", () => {
  it("withholds until there are enough clean windows, and says why", () => {
    const a = transferAggregate(history([transfer()]), 1);
    expect(a.n).toBe(1);
    expect(a.effective).toBeNull();
    expect(a.withheldReason).toContain(String(MINIMUM_CLEAN_WINDOWS));
  });

  it("excludes polluted windows from the count rather than blending them", () => {
    const polluted = transfer({
      inPointsByGw: new Map([[3, 5]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, null]]),
    });
    const a = transferAggregate(history([transfer(), polluted]), 1);
    expect(a.n).toBe(1);
  });

  it("reports a rate once enough clean windows exist", () => {
    const many = Array.from({ length: MINIMUM_CLEAN_WINDOWS }, () => transfer());
    const a = transferAggregate(history(many), 1);
    expect(a.n).toBe(MINIMUM_CLEAN_WINDOWS);
    expect(a.effective).toBe(-3 * MINIMUM_CLEAN_WINDOWS);
    expect(a.withheldReason).toBeNull();
  });
});

describe("seasonTotals", () => {
  const week = (over: Record<string, unknown>) => ({
    benchPoints: 0, averageEntryScore: 50, transferCost: 0,
    autoSubs: [], captain: null, picks: [], ...over,
  });

  it("totals the bench and the margin over the field", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 3, transfers: [],
      names: new Map(),
      gameweeks: [
        week({ event: 1, points: 44, benchPoints: 2, averageEntryScore: 50 }),
        week({ event: 2, points: 109, benchPoints: 13, averageEntryScore: 81 }),
        week({ event: 3, points: 38, benchPoints: 12, averageEntryScore: 51 }),
      ] as never,
    });
    expect(totals.benchPoints).toBe(27);
    expect(totals.vsAverage).toBe(9);    // 191 - 182
    expect(totals.hitSpend).toBe(0);
  });

  it("prices the armband against the best player you already owned", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 1, transfers: [],
      names: new Map(),
      gameweeks: [week({
        event: 1, points: 15,
        captain: { element: 1, multiplier: 2, points: 2 },
        picks: [
          { element: 1, multiplier: 2, points: 2, minutes: 90 },
          { element: 2, multiplier: 1, points: 13, minutes: 90 },
        ],
      })] as never,
    });
    expect(totals.captainPoints).toBe(4);        // 2 x 2
    expect(totals.bestCaptainPoints).toBe(26);   // 13 x 2, hindsight, from the 15
    expect(totals.captaincyCost).toBe(22);
  });

  it("says the margin is unknown rather than wrong when an average is missing", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 1, transfers: [],
      names: new Map(),
      gameweeks: [week({ event: 1, points: 44, averageEntryScore: null })] as never,
    });
    expect(totals.vsAverage).toBeNull();
  });
});

describe("basketFor", () => {
  it("takes a gameweek's transfers together, because the pairing is arbitrary", () => {
    const second = transfer({
      elementIn: 3, elementOut: 4,
      inPointsByGw: new Map([[3, 8]]),
      outPointsByGw: new Map([[3, 1]]),
      inMultiplierByGw: new Map([[3, 1]]),
    });
    const basket = basketFor(history([transfer(), second]), 3);
    expect(basket.transfers).toBe(2);
    expect(basket.settled).toBe(true);
    expect(basket.effective).toBe(4);   // (-1 - 2) + (8 - 1)
  });

  it("is unsettled, not zero, when the gameweek has not finished", () => {
    const unsettled = transfer({
      event: 9, inPointsByGw: new Map(), outPointsByGw: new Map(),
      inMultiplierByGw: new Map(),
    });
    const basket = basketFor(history([unsettled]), 9);
    expect(basket.settled).toBe(false);
    expect(basket.effective).toBeNull();
  });
});
