import { describe, it, expect } from "vitest";
import { kellyFraction, simulateBankroll, currentDrawdown } from "./kelly";

describe("kellyFraction", () => {
  describe("edge calculation", () => {
    it("calculates edge as prob minus implied prob", () => {
      // edge = 0.60 - 1/2.0 = 0.10
      const result = kellyFraction(0.6, 2.0);
      expect(result.edge).toBeCloseTo(0.1, 5);
    });

    it("calculates EV as p*(odds-1) - q", () => {
      // ev = 0.6 * 1.0 - 0.4 = 0.2
      const result = kellyFraction(0.6, 2.0);
      expect(result.ev).toBeCloseTo(0.2, 5);
    });

    it("returns negative edge for below-market probability", () => {
      // edge = 0.3 - 0.5 = -0.2
      const result = kellyFraction(0.3, 2.0);
      expect(result.edge).toBeCloseTo(-0.2, 5);
    });
  });

  describe("stake sizing", () => {
    it("returns positive full_kelly for a value bet (edge > minEdge)", () => {
      const result = kellyFraction(0.6, 2.0);
      expect(result.full_kelly).toBeGreaterThan(0);
    });

    it("half_kelly is exactly half of full_kelly", () => {
      const result = kellyFraction(0.65, 2.5);
      expect(result.half_kelly).toBeCloseTo(result.full_kelly / 2, 10);
    });

    it("quarter_kelly is exactly one quarter of full_kelly", () => {
      const result = kellyFraction(0.65, 2.5);
      expect(result.quarter_kelly).toBeCloseTo(result.full_kelly / 4, 10);
    });

    it("caps full_kelly at maxStake", () => {
      const result = kellyFraction(0.99, 1.05, 0.05);
      expect(result.full_kelly).toBeLessThanOrEqual(0.05);
    });

    it("caps at custom maxStake", () => {
      const result = kellyFraction(0.9, 2.0, 0.02);
      expect(result.full_kelly).toBeLessThanOrEqual(0.02);
    });
  });

  describe("zero-stake conditions", () => {
    it("returns zero stakes when edge is below default minEdge (0.03)", () => {
      // edge = 0.52 - 0.50 = 0.02 < 0.03
      const result = kellyFraction(0.52, 2.0);
      expect(result.full_kelly).toBe(0);
      expect(result.half_kelly).toBe(0);
      expect(result.quarter_kelly).toBe(0);
    });

    it("returns zero stakes when edge is exactly at minEdge boundary (not above)", () => {
      // edge = 0.53 - 0.50 = 0.03, which is NOT < 0.03, so this should be positive
      const result = kellyFraction(0.53, 2.0);
      expect(result.full_kelly).toBeGreaterThan(0);
    });

    it("returns zero stakes for negative EV bet", () => {
      const result = kellyFraction(0.3, 2.0);
      expect(result.full_kelly).toBe(0);
    });

    it("returns zero stakes when model probability equals implied probability", () => {
      // exactly fair odds: no edge
      const result = kellyFraction(0.5, 2.0);
      expect(result.full_kelly).toBe(0);
    });

    it("does not return negative stakes", () => {
      const result = kellyFraction(0.1, 3.0);
      expect(result.full_kelly).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("simulateBankroll", () => {
  it("returns single-element array (initial bankroll) for empty bets", () => {
    const result = simulateBankroll(1000, []);
    expect(result).toEqual([1000]);
  });

  it("returns trajectory with length = bets.length + 1", () => {
    const bets = [
      { stake_pct: 0.05, decimal_odds: 2.0, won: true },
      { stake_pct: 0.05, decimal_odds: 2.0, won: false },
      { stake_pct: 0.05, decimal_odds: 2.5, won: true },
    ];
    expect(simulateBankroll(1000, bets)).toHaveLength(4);
  });

  it("grows bankroll on a winning bet at 2.0 odds", () => {
    // Stake 10% of 1000 at 2.0 → win: 1000 + 100 * 1 = 1100
    const result = simulateBankroll(1000, [{ stake_pct: 0.1, decimal_odds: 2.0, won: true }]);
    expect(result[1]).toBeCloseTo(1100);
  });

  it("grows bankroll at higher odds", () => {
    // Stake 5% of 1000 at 3.0 odds → win: 1000 + 50 * 2 = 1100
    const result = simulateBankroll(1000, [{ stake_pct: 0.05, decimal_odds: 3.0, won: true }]);
    expect(result[1]).toBeCloseTo(1100);
  });

  it("shrinks bankroll on a losing bet", () => {
    // Stake 10% of 1000 → lose: 1000 - 100 = 900
    const result = simulateBankroll(1000, [{ stake_pct: 0.1, decimal_odds: 2.0, won: false }]);
    expect(result[1]).toBeCloseTo(900);
  });

  it("clamps bankroll to 0 on catastrophic loss", () => {
    // Bet 200% (hypothetical) → floor at 0
    const result = simulateBankroll(100, [{ stake_pct: 2.0, decimal_odds: 2.0, won: false }]);
    expect(result[1]).toBe(0);
  });

  it("first element is always the initial bankroll", () => {
    const result = simulateBankroll(5000, [{ stake_pct: 0.1, decimal_odds: 2.0, won: true }]);
    expect(result[0]).toBe(5000);
  });

  it("bankroll compounds across multiple bets", () => {
    // Win: 1000 → 1100; then lose: 1100 - 110 = 990
    const bets = [
      { stake_pct: 0.1, decimal_odds: 2.0, won: true },
      { stake_pct: 0.1, decimal_odds: 2.0, won: false },
    ];
    const result = simulateBankroll(1000, bets);
    expect(result[1]).toBeCloseTo(1100);
    expect(result[2]).toBeCloseTo(990);
  });
});

describe("currentDrawdown", () => {
  it("returns 0 for empty trajectory", () => {
    expect(currentDrawdown([])).toBe(0);
  });

  it("returns 0 when current value equals peak", () => {
    expect(currentDrawdown([1000, 1100, 1200])).toBe(0);
  });

  it("returns 0 for single-element trajectory at peak", () => {
    expect(currentDrawdown([1000])).toBe(0);
  });

  it("calculates correct drawdown from peak", () => {
    // peak = 1200, current = 900 → (1200 - 900) / 1200 = 0.25
    expect(currentDrawdown([1000, 1200, 900])).toBeCloseTo(0.25);
  });

  it("calculates drawdown from initial high", () => {
    // peak = 1000, current = 800 → (1000 - 800) / 1000 = 0.2
    expect(currentDrawdown([1000, 900, 800])).toBeCloseTo(0.2);
  });

  it("returns 0 when peak is 0", () => {
    expect(currentDrawdown([0])).toBe(0);
  });

  it("handles full drawdown to 0", () => {
    expect(currentDrawdown([1000, 500, 0])).toBeCloseTo(1.0);
  });

  it("returns 0 when partially recovering from drawdown to new peak", () => {
    // Recovers to 1300, which is new peak
    expect(currentDrawdown([1000, 800, 1300])).toBe(0);
  });
});
