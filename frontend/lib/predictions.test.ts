import { describe, it, expect, vi, afterEach } from "vitest";

import { getHalfKellyPct, effectiveEdge, type ValueBet } from "./predictions";

/**
 * These helpers sit on the real-money path: `getHalfKellyPct` feeds the
 * displayed stake percentages and the CSV export on /value-bets, and
 * `effectiveEdge` drives the confidence tiers. The suite in kelly.test.ts
 * covers lib/kelly.ts, which is a different module.
 */

function bet(overrides: Partial<ValueBet> = {}): ValueBet {
  return {
    market: "Over 2.5",
    model_prob: 0.6,
    implied_prob: 0.5,
    edge: 0.1,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getHalfKellyPct", () => {
  it("prefers the explicit half_kelly_pct", () => {
    expect(getHalfKellyPct(bet({ half_kelly_pct: 0.025 }))).toBe(0.025);
  });

  it("ignores other kelly fields when half_kelly_pct is present", () => {
    const b = bet({ half_kelly_pct: 0.02, full_kelly_pct: 0.09, kelly_pct: 0.5 });
    expect(getHalfKellyPct(b)).toBe(0.02);
  });

  it("halves full_kelly_pct when only the full fraction is given", () => {
    expect(getHalfKellyPct(bet({ full_kelly_pct: 0.08 }))).toBe(0.04);
  });

  it("returns 0 when no kelly field is present", () => {
    expect(getHalfKellyPct(bet())).toBe(0);
  });

  it("preserves an explicit zero rather than falling through", () => {
    const b = bet({ half_kelly_pct: 0, full_kelly_pct: 0.08, kelly_pct: 0.5 });
    expect(getHalfKellyPct(b)).toBe(0);
  });

  describe("legacy kelly_pct is treated as full Kelly", () => {
    it("halves it, so an ambiguous field can never over-stake", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(getHalfKellyPct(bet({ kelly_pct: 0.06 }))).toBe(0.03);
    });

    it("warns, so the stale data contract is visible", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getHalfKellyPct(bet({ kelly_pct: 0.06 }));
      expect(warn).toHaveBeenCalledOnce();
    });

    it("never exceeds the equivalent explicit half-Kelly stake", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const legacy = getHalfKellyPct(bet({ kelly_pct: 0.1 }));
      const explicit = getHalfKellyPct(bet({ half_kelly_pct: 0.05 }));
      expect(legacy).toBeLessThanOrEqual(explicit);
    });
  });
});

describe("effectiveEdge", () => {
  it("prefers the devigged edge when present", () => {
    expect(effectiveEdge(bet({ edge: 0.12, devigged_edge: 0.07 }))).toBe(0.07);
  });

  it("falls back to the raw edge", () => {
    expect(effectiveEdge(bet({ edge: 0.12 }))).toBe(0.12);
  });

  it("preserves a devigged edge of zero", () => {
    expect(effectiveEdge(bet({ edge: 0.12, devigged_edge: 0 }))).toBe(0);
  });

  it("passes through a negative edge rather than clamping", () => {
    expect(effectiveEdge(bet({ edge: -0.03 }))).toBe(-0.03);
  });
});
