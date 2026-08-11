import { describe, expect, it } from "vitest";
import {
  CORE_METRICS, hasCoreMetrics, verdict, type Metrics,
} from "@/lib/health-metrics";

describe("verdict", () => {
  it("passes a metric under its target", () => {
    expect(verdict(0.19, 0.22)).toBe(true);
  });

  it("fails a metric over its target", () => {
    expect(verdict(0.25, 0.22)).toBe(false);
  });

  it("fails a metric exactly on its target", () => {
    // The targets are stated as strict "< 0.220", so equality is not a pass.
    expect(verdict(0.22, 0.22)).toBe(false);
  });

  /**
   * The bug, stated as a test. The old code was `(value ?? 1) < target`, which
   * returned `false` here — reporting an unmeasured model as a failing one.
   */
  it("returns null for an absent metric, not false", () => {
    expect(verdict(undefined, 0.22)).toBeNull();
  });

  it("returns null for NaN — a failed measurement is not a result", () => {
    expect(verdict(NaN, 0.22)).toBeNull();
  });

  /**
   * A measured zero is a real value and must be scored, not treated as absent.
   * `!value` or `value || null` would collapse it into the unmeasured state,
   * which would hide a Brier of exactly 0 — almost certainly a bug worth seeing.
   */
  it("scores a measured zero as a pass rather than as absent", () => {
    expect(verdict(0, 0.22)).toBe(true);
  });
});

describe("hasCoreMetrics", () => {
  it("is false for the artifact an older producer writes", () => {
    // pipeline_version 4.0.0 emitted no model_metrics at all.
    expect(hasCoreMetrics({})).toBe(false);
  });

  it("is false when every core key is explicitly undefined", () => {
    const metrics: Metrics = Object.fromEntries(
      CORE_METRICS.map((m) => [m.key, undefined]),
    );
    expect(hasCoreMetrics(metrics)).toBe(false);
  });

  it("is true when a single core metric is present", () => {
    expect(hasCoreMetrics({ ece: 0.04 })).toBe(true);
  });

  /**
   * Zeros are measurements. A producer that emitted all-zero metrics has scored
   * the model — implausibly well, which is exactly the case a user needs to see
   * rather than have suppressed as "not measured".
   */
  it("is true for all-zero metrics", () => {
    const metrics: Metrics = Object.fromEntries(
      CORE_METRICS.map((m) => [m.key, 0]),
    );
    expect(hasCoreMetrics(metrics)).toBe(true);
  });

  it("ignores non-core keys", () => {
    expect(hasCoreMetrics({ n_evaluated_matches: 412 })).toBe(false);
  });
});

describe("CORE_METRICS", () => {
  it("has no duplicate keys", () => {
    const keys = CORE_METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("states every target as a positive upper bound", () => {
    for (const m of CORE_METRICS) {
      expect(m.target).toBeGreaterThan(0);
    }
  });
});
