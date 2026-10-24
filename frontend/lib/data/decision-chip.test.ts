/**
 * The pinned wildcard week, read out of the decision artifact.
 *
 * The producer writes `"chip": "wildcard"` on the week the owner pinned the
 * chip to — `decision.plan` when it is this week, a `horizon.provisional[]`
 * entry when it is later — and adds `horizon.wildcard_gameweek`. Every other
 * week omits the key entirely. That week publishes `hits: 0` beside ten-plus
 * transfers, which without a label reads as free routine moves.
 *
 * The absent case is asserted as carefully as the present ones: every artifact
 * already published omits both keys, and must narrow exactly as before.
 */
import { describe, expect, it } from "vitest";

import { chipLabel, narrowPublicDecision } from "@/lib/data/narrow";

const WEEK0 = {
  squad: [1, 2, 3, 4], xi: [1, 2, 3, 4], captain: 4, vice: 3,
  transfers_in: [], transfers_out: [], hits: 0, bank_after: 8,
  free_transfers_after: 1,
};
const LATER = {
  squad: [1, 2, 3, 5], xi: [1, 2, 3], captain: 3, vice: 1,
  transfers_in: [5], transfers_out: [4], hits: 0, bank_after: 3,
  free_transfers_after: 1,
};

function decide(
  plan: Record<string, unknown>,
  provisional: Record<string, unknown>[],
  horizonExtra: Record<string, unknown> = {},
) {
  const result = narrowPublicDecision({
    gameweek: 9,
    entry_label: "owner",
    decision: { mean_points: 60, plan },
    horizon: { eval_horizon: 3, transfer_horizon: 2, provisional, ...horizonExtra },
  });
  expect(result.ok, "fixture should narrow").toBe(true);
  return result.ok ? result.value : null;
}

describe("a pinned chip is read onto the week it is played in", () => {
  it("reads the chip on week 0, on both the plan and the horizon's first week", () => {
    const value = decide(
      { ...WEEK0, transfers_in: [5, 6, 7], transfers_out: [2, 3, 4], chip: "wildcard" },
      [LATER, LATER],
      { wildcard_gameweek: 9 },
    );
    expect(value?.plan?.chip).toBe("wildcard");
    expect(value?.horizon?.weeks.map((w) => w.chip)).toEqual(["wildcard", null, null]);
    expect(value?.horizon?.wildcardGameweek).toBe(9);
  });

  it("reads the chip on a provisional week, at its absolute gameweek", () => {
    const value = decide(
      WEEK0,
      [LATER, { ...LATER, chip: "wildcard" }],
      { wildcard_gameweek: 11 },
    );
    expect(value?.plan?.chip).toBeNull();
    const weeks = value?.horizon?.weeks ?? [];
    expect(weeks.map((w) => [w.gameweek, w.chip])).toEqual([
      [9, null], [10, null], [11, "wildcard"],
    ]);
    expect(value?.horizon?.wildcardGameweek).toBe(11);
  });

  it("narrows an absent key to null everywhere, as every published artifact has it", () => {
    const value = decide(WEEK0, [LATER, LATER]);
    expect(value?.plan?.chip).toBeNull();
    expect(value?.horizon?.weeks.every((w) => w.chip === null)).toBe(true);
    expect(value?.horizon?.wildcardGameweek).toBeNull();
    // Nothing else moved: the rest of the week reads as it did before the field.
    expect(value?.horizon?.weeks[1]).toMatchObject({
      gameweek: 10, hits: 0, transfers_in: [5], transfers_out: [4],
      free_transfers_after: 1, planned: true,
    });
  });

  it("does not read a non-string or empty chip as a chip", () => {
    for (const bad of [null, "", "  ", 1, true, {}]) {
      const value = decide({ ...WEEK0, chip: bad }, [{ ...LATER, chip: bad }], {
        wildcard_gameweek: "9",
      });
      expect(value?.plan?.chip, `chip ${JSON.stringify(bad)}`).toBeNull();
      expect(value?.horizon?.weeks[1].chip).toBeNull();
      // A string gameweek is not a gameweek.
      expect(value?.horizon?.wildcardGameweek).toBeNull();
    }
  });

  it("labels the wildcard by name and prints any other chip as published", () => {
    expect(chipLabel("wildcard")).toBe("Wildcard");
    expect(chipLabel("free_hit")).toBe("free hit");
  });
});
