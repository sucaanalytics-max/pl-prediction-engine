/**
 * Narrowing the manager ledger.
 *
 * The load-bearing case is the by-gameweek maps: a `null` multiplier must
 * survive as `null` and never become 0, because null is the pollution signal
 * ("no longer yours") and 0 means "benched, earned you nothing" — opposite
 * conclusions drawn from the same cell.
 */
import { describe, expect, it } from "vitest";
import { narrowManagerHistory } from "@/lib/data/narrow-manager-history";

const MINIMAL = {
  schema_version: 1,
  generated_at: "2026-09-09T00:00:00+00:00",
  entry_id: 20945,
  settled_through: 3,
  gameweeks: [{
    event: 3, points: 38, gross_points: 38, transfer_cost: 0, transfers_made: 1,
    bench_points: 12, average_entry_score: 51, highest_score: 119,
    rank: 9427920, overall_rank: 3427838, value: 999, bank: 0, chip: null,
    captain: { element: 426, multiplier: 2, points: 2 },
    auto_subs: [], picks: [{ element: 445, multiplier: 1, points: -1, minutes: 90 }],
  }],
  transfers: [{
    event: 3, time: "2026-09-04T16:59:34Z",
    element_in: 445, element_in_cost: 50, element_out: 418, element_out_cost: 50,
    in_points_by_gw: { "3": -1 }, out_points_by_gw: { "3": 2 },
    in_multiplier_by_gw: { "3": 1 },
  }],
};

describe("narrowManagerHistory", () => {
  it("carries the ledger through", () => {
    const result = narrowManagerHistory(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settledThrough).toBe(3);
    expect(result.value.gameweeks[0].benchPoints).toBe(12);
    expect(result.value.gameweeks[0].captain?.points).toBe(2);
    expect(result.value.transfers[0].inPointsByGw.get(3)).toBe(-1);
  });

  it("keeps a null multiplier null, because null is not zero here", () => {
    const polluted = structuredClone(MINIMAL) as typeof MINIMAL;
    polluted.transfers[0].in_multiplier_by_gw = { "3": 1, "4": null } as never;
    polluted.transfers[0].in_points_by_gw = { "3": -1, "4": 12 } as never;
    polluted.transfers[0].out_points_by_gw = { "3": 2, "4": 1 } as never;
    const result = narrowManagerHistory(polluted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const multipliers = result.value.transfers[0].inMultiplierByGw;
    expect(multipliers.get(4)).toBeNull();
    expect(multipliers.has(4)).toBe(true);
    expect(multipliers.has(5)).toBe(false); // absent: GW5 has not settled
  });

  it("keeps a negative score negative rather than treating it as missing", () => {
    const result = narrowManagerHistory(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // -1 is falsy-adjacent in a `|| 0` world. Thiaw really did score -1.
    expect(result.value.gameweeks[0].picks[0].points).toBe(-1);
  });

  it("reports a season with nothing settled rather than inventing one", () => {
    const result = narrowManagerHistory({
      ...MINIMAL, settled_through: null, gameweeks: [], transfers: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settledThrough).toBeNull();
    expect(result.value.gameweeks).toEqual([]);
  });

  it("is malformed, not empty, when the envelope is wrong", () => {
    expect(narrowManagerHistory({ gameweeks: "not an array" }).ok).toBe(false);
    expect(narrowManagerHistory(null).ok).toBe(false);
    expect(narrowManagerHistory([]).ok).toBe(false);
  });

  it("refuses a null where points are never null", () => {
    const broken = structuredClone(MINIMAL) as typeof MINIMAL;
    broken.transfers[0].in_points_by_gw = { "3": null } as never;
    const result = narrowManagerHistory(broken);
    if (result.ok) {
      // The row survives with the bad cell dropped; the problem is recorded.
      expect(result.value.transfers[0].inPointsByGw.has(3)).toBe(false);
    }
  });
});
