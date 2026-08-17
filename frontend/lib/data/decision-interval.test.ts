/**
 * The squad total's published interval, and the ways a producer can get it wrong.
 *
 * `PublicDecision` gained eight optional fields so `DecideView` can draw the
 * total as a distribution rather than as a mean. Every one is optional, so a
 * file written before the producer shipped the block still narrows cleanly and
 * renders the absence — that is asserted here rather than assumed, because it is
 * the property that lets the frontend ship first.
 *
 * The interesting cases are all producer mistakes:
 *
 * - a percentage where a fraction belongs (`47.9` for 47.9%), which would render
 *   as **4790%** if it were let through;
 * - a threshold key that is not an integer;
 * - one end of an interval without the other.
 *
 * In each case the value is DROPPED, not repaired. A screen that rescales a
 * suspicious number is guessing which mistake the producer made, and it will
 * eventually guess wrong on a number someone acts on.
 */

import { describe, expect, it } from "vitest";
import { proven } from "@/lib/data/artifact";
import { classify } from "@/lib/data/artifact";
import { narrowPublicDecision, narrowThresholds } from "@/lib/data/narrow";

function decision(over: Record<string, unknown> = {}) {
  const result = narrowPublicDecision({
    gameweek: 3,
    entry_label: "season",
    decision: { mean_points: 59.6, ...over },
  });
  expect(result.ok, "fixture should narrow").toBe(true);
  return result.ok ? result.value : null;
}

/**
 * The producer's real block, generated from `PlanEvaluation.as_dict()`.
 *
 * This fixture used to read `points_sd`, `points_q10`, `prob_at_least` and
 * `autosub_prob` — the same names the narrower read, and names nothing in the
 * pipeline has ever written. Fixture and code agreed with each other, the file
 * passed, and both were describing a producer that does not exist.
 *
 * `plan_eval.py:190-202` emits `sd_points`, a `quantiles` map keyed `q10…q99`,
 * a `tails` map keyed `p_ge_40…p_ge_90`, and `autosub_rate`. Note `p_ge_60:
 * 0.479` — the design's headline "P(≥60) 47.9%" was backed by a published
 * number the whole time, while the screen rendered its absence.
 */
const FULL = {
  sd_points: 15.6,
  quantiles: { q10: 38.1, q25: 48.0, q50: 59.0, q75: 70.2, q90: 80.4, q99: 99.1 },
  tails: {
    p_ge_40: 0.91, p_ge_50: 0.78, p_ge_60: 0.479,
    p_ge_70: 0.24, p_ge_80: 0.09, p_ge_90: 0.02,
  },
  autosub_rate: 0.137,
  n_draws: 10000,
};

describe("the published interval", () => {
  it("reads every field when the producer ships the block", () => {
    const value = decision(FULL);
    expect(value?.points_sd).toBe(15.6);
    expect(value?.points_q10).toBe(38.1);
    expect(value?.points_q90).toBe(80.4);
    // No mode. The simulation publishes quantiles for the squad total and never
    // a mode, so this is permanently null and the screen must not draw one.
    expect(value?.points_mode).toBeNull();
    expect(value?.nDraws).toBe(10000);
    expect(value?.autosubProb).toBeCloseTo(0.137);
  });

  it("narrows to nulls when the producer has not shipped it", () => {
    // The property that lets this ship before the producer does.
    const value = decision();
    expect(value?.mean_points).toBe(59.6);
    expect(value?.points_sd).toBeNull();
    expect(value?.points_q10).toBeNull();
    expect(value?.points_mode).toBeNull();
    expect(value?.probAtLeast).toEqual([]);
    expect(value?.autosubProb).toBeNull();
  });

  it("reads a quantile map carrying only one end", () => {
    // The glyph refuses the whisker itself; the narrower's job is only to pass
    // through what was published without inventing the other end.
    const value = decision({ quantiles: { q10: 40.0 } });
    expect(value?.points_q10).toBe(40);
    expect(value?.points_q90).toBeNull();
  });
});

describe("thresholds are fractions, never percentages", () => {
  it("sorts ascending so no view has to", () => {
    expect(narrowThresholds({ "90": 0.038, "40": 0.891, "60": 0.479 })
      .map((t) => t.points)).toEqual([40, 60, 90]);
  });

  it("drops a percentage rather than rescaling it", () => {
    /**
     * The failure this guards.
     *
     * A producer writing `47.9` for "47.9%" is a plausible mistake. Dividing by
     * 100 here would repair that one and silently corrupt a genuine `0.479`
     * that some future writer emits as a percentage of something else. Dropping
     * it renders `∅` — a stated absence, which is checkable.
     */
    expect(narrowThresholds({ "60": 47.9 })).toEqual([]);
    expect(narrowThresholds({ "60": -0.1 })).toEqual([]);
    expect(narrowThresholds({ "60": 1.0 })).toHaveLength(1);
  });

  it("drops a key that is not an integer number of points", () => {
    expect(narrowThresholds({ "sixty": 0.5, "60.5": 0.5, "": 0.5 })).toEqual([]);
  });

  it("survives a producer sending the wrong shape entirely", () => {
    expect(narrowThresholds(null)).toEqual([]);
    expect(narrowThresholds([0.5])).toEqual([]);
    expect(narrowThresholds("0.5")).toEqual([]);
  });
});

describe("the artifact envelope still classifies it", () => {
  it("stays ok with the block present and empty without a plan", () => {
    // `isEmpty` on the descriptor is `plan === null`, and the interval must not
    // change that: a decision carrying a distribution but no plan is still a
    // decision with nothing to act on.
    const artifact = classify({
      path: "fpl/decision_public_gw03_season.json",
      source: "local",
      raw: { gameweek: 3, entry_label: "season", decision: { mean_points: 59.6, ...FULL } },
      narrow: narrowPublicDecision,
      isEmpty: (v) => v.plan === null,
      now: new Date("2026-08-14T00:00:00Z"),
    });
    expect(artifact.state).toBe("empty");
    expect(proven(artifact)?.points_sd).toBe(15.6);
  });
});

describe("the plan's free-transfer count", () => {
  /**
   * `narrowPlan` dropped `free_transfers_after` while `milp.py:214` published it
   * on every plan, so week 0 of the horizon grid showed a gap where the producer
   * had supplied a number. The fix went in untested: `PlanGrid.test.tsx` builds
   * its weeks already-narrowed, so it never exercises the narrower at all.
   */
  it("reads what milp.py publishes", () => {
    const value = decision({ plan: { squad: [1], xi: [1], free_transfers_after: 2 } });
    expect(value?.plan?.free_transfers_after).toBe(2);
  });

  it("is null rather than zero when the producer omits it", () => {
    // Zero free transfers and an unknown count are different facts, and the
    // grid renders them differently.
    const value = decision({ plan: { squad: [1], xi: [1] } });
    expect(value?.plan?.free_transfers_after).toBeNull();
  });

  it("keeps a genuine zero", () => {
    const value = decision({ plan: { squad: [1], xi: [1], free_transfers_after: 0 } });
    expect(value?.plan?.free_transfers_after).toBe(0);
  });
});
