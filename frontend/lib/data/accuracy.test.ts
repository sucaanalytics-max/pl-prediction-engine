/**
 * The accuracy rollup as the page reads it.
 *
 * Two properties carry this file:
 *
 * * **An unmeasured rollup is still worth rendering.** It carries the
 *   perfect-model ceiling, which needs no settled gameweek. `empty` here means
 *   "no accuracy yet", not "nothing to show" — and the page renders it anyway.
 * * **Beating the ceiling is a defect, not an achievement.** No forecaster can,
 *   so a negative excess means outcomes were joined to forecasts that had
 *   already seen them. It must surface as an alarm.
 */
import { describe, expect, it } from "vitest";
import { classify, proven } from "@/lib/data/artifact";
import {
  ACCURACY, accuracyIsEmpty, beatsTheCeiling, narrowAccuracy, type Accuracy,
} from "@/lib/data/accuracy";

const DAY_ONE = {
  schema_version: 1,
  generated_at: "2026-08-08T06:00:00Z",
  season: "2627",
  gameweeks_sealed: 0,
  observations: 0,
  perfect_model_rmse: 2.806,
  perfect_model_basis: "Root-mean-square of the simulated spreads.",
  measured: null,
  excess_over_ceiling: null,
  predicted_xi: {
    ours: null, benchmark: 0.84, benchmark_source: "SportMonks",
  },
  reason: "0 gameweek(s) sealed; at least 50 observations are needed.",
};

const MEASURED = {
  ...DAY_ONE,
  gameweeks_sealed: 9,
  observations: 5400,
  measured: {
    overall: { n: 5400, rmse: 2.91, bias: -0.12, bias_radius: 0.04 },
    by_position: { MID: { n: 2100, rmse: 3.1, bias: -0.2, bias_radius: 0.06 } },
    by_band: {
      blank: { n: 3000, rmse: 1.4, bias: 0.1, bias_radius: 0.03 },
      haul: { n: 400, rmse: 7.2, bias: -3.1, bias_radius: 0.4 },
    },
    by_horizon: { "1": { n: 900, rmse: 2.7, bias: 0, bias_radius: 0.1 } },
  },
  excess_over_ceiling: 0.104,
  reason: null,
};

function ok(raw: unknown): Accuracy {
  const result = narrowAccuracy(raw);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.value;
}

describe("the day-one rollup", () => {
  it("narrows, and keeps the one number that is real", () => {
    const report = ok(DAY_ONE);
    expect(report.perfectModelRmse).toBeCloseTo(2.806);
    expect(report.measured).toBeNull();
  });

  it("counts as empty, so the page shows a reason", () => {
    expect(accuracyIsEmpty(ok(DAY_ONE))).toBe(true);
  });

  it("is rejected when it explains nothing", () => {
    const { reason, ...silent } = DAY_ONE;
    void reason;
    expect(narrowAccuracy(silent).ok).toBe(false);
  });

  it("names the predicted-XI bar without claiming it", () => {
    const report = ok(DAY_ONE);
    expect(report.predictedXi.ours).toBeNull();
    expect(report.predictedXi.benchmark).toBeCloseTo(0.84);
  });

  it("still renders through the envelope while empty", () => {
    const artifact = classify({
      path: ACCURACY.path, source: "local", raw: DAY_ONE,
      narrow: ACCURACY.narrow, isEmpty: ACCURACY.isEmpty,
      now: new Date("2026-08-08T07:00:00Z"),
    });
    expect(artifact.state).toBe("empty");
    // The ceiling has to survive the empty state or the page has nothing.
    expect(proven(artifact)?.perfectModelRmse).toBeCloseTo(2.806);
  });
});

describe("a measured rollup", () => {
  it("keeps every slice the page renders", () => {
    const report = ok(MEASURED);
    expect(report.measured?.overall?.rmse).toBeCloseTo(2.91);
    expect(report.measured?.byBand.haul.rmse).toBeCloseTo(7.2);
    expect(report.measured?.byHorizon["1"].n).toBe(900);
  });

  it("keeps bias separately from error", () => {
    // A model 3.1 points pessimistic on hauls is biased, not merely noisy, and
    // the two have different fixes.
    expect(ok(MEASURED).measured?.byBand.haul.bias).toBeCloseTo(-3.1);
  });

  it("drops a slice with no sample size", () => {
    const report = ok({
      ...MEASURED,
      measured: { ...MEASURED.measured, by_position: { MID: { rmse: 3.1 } } },
    });
    // An RMSE with no n is a number with no weight behind it.
    expect(report.measured?.byPosition.MID).toBeUndefined();
  });

  it("is not empty", () => {
    expect(accuracyIsEmpty(ok(MEASURED))).toBe(false);
  });
});

describe("beating the ceiling is a defect", () => {
  it("is detected", () => {
    expect(beatsTheCeiling(ok({ ...MEASURED, excess_over_ceiling: -0.4 }))).toBe(true);
  });

  it("a normal excess is not flagged", () => {
    expect(beatsTheCeiling(ok(MEASURED))).toBe(false);
  });

  it("an absent excess is not flagged", () => {
    // Unmeasured is not impossible.
    expect(beatsTheCeiling(ok(DAY_ONE))).toBe(false);
  });
});

describe("the descriptor", () => {
  it("points at what the agent writes", () => {
    expect(ACCURACY.path).toBe("fpl/accuracy.json");
    expect(ACCURACY.owner).toBe("agent");
  });
});
