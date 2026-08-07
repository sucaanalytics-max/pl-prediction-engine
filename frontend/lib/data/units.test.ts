import { describe, expect, it } from "vitest";
import {
  asFraction, formatStake, NO_STAKE, stakeFor, toFraction, UnitError,
  type Fraction,
} from "@/lib/data/units";

/**
 * The values that actually appear in `predictions/latest.json`, per value bet.
 * Two units, four fields, and `ValueBet` typed all four as bare `number`.
 */
const REAL = {
  full_kelly: 50.0,      // currency, = 0.05 * 1000.0 bankroll
  half_kelly: 25.0,      // currency
  full_kelly_pct: 0.05,  // fraction
  half_kelly_pct: 0.025, // fraction
};

describe("asFraction", () => {
  it("accepts a real half-Kelly fraction", () => {
    expect(asFraction(REAL.half_kelly_pct)).toBe(0.025);
  });

  it("accepts the boundaries", () => {
    expect(asFraction(0)).toBe(0);
    expect(asFraction(1)).toBe(1);
  });

  /**
   * The core guard. A currency stake can never become a Fraction, so it can never
   * reach a percentage formatter.
   */
  it("rejects the currency-unit stake that shares the field name", () => {
    expect(() => asFraction(REAL.full_kelly)).toThrow(UnitError);
    expect(() => asFraction(REAL.half_kelly)).toThrow(UnitError);
  });

  it("names the likely cause in the error, because the fix is not obvious", () => {
    expect(() => asFraction(50.0, "half_kelly")).toThrow(/currency/i);
    expect(() => asFraction(50.0, "half_kelly")).toThrow(/half_kelly/);
  });

  it("rejects rather than clamping", () => {
    // Clamping 50.0 to 1.0 would stake the ENTIRE bankroll — the worst available
    // outcome on this path. Under-staking is recoverable; over-staking is not.
    let clamped: number | null = null;
    try {
      clamped = asFraction(50.0);
    } catch {
      clamped = null;
    }
    expect(clamped).toBeNull();
  });

  it("rejects negatives", () => {
    expect(() => asFraction(-0.01)).toThrow(UnitError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => asFraction(NaN)).toThrow(UnitError);
    expect(() => asFraction(Infinity)).toThrow(UnitError);
  });
});

describe("toFraction — the narrowing path", () => {
  it("returns the fraction for a good value", () => {
    expect(toFraction(0.025)).toBe(0.025);
  });

  it("returns null rather than throwing, so one bad bet does not blank a page", () => {
    expect(toFraction(50.0)).toBeNull();
    expect(toFraction(-1)).toBeNull();
    expect(toFraction(NaN)).toBeNull();
  });

  it("returns null for non-numbers", () => {
    expect(toFraction("0.025")).toBeNull();
    expect(toFraction(null)).toBeNull();
    expect(toFraction(undefined)).toBeNull();
    expect(toFraction({})).toBeNull();
  });

  it("accepts a measured zero — no stake is a real answer", () => {
    expect(toFraction(0)).toBe(0);
    // Distinguishable from null, which means "could not be determined".
    expect(toFraction(0)).not.toBeNull();
  });
});

describe("formatStake", () => {
  it("renders a fraction as a percentage", () => {
    expect(formatStake(asFraction(0.025))).toBe("2.50%");
    expect(formatStake(asFraction(0.05))).toBe("5.00%");
  });

  it("renders no stake as 0.00%", () => {
    expect(formatStake(NO_STAKE)).toBe("0.00%");
  });

  it("honours the decimal count", () => {
    expect(formatStake(asFraction(0.025), 1)).toBe("2.5%");
  });

  /**
   * The regression this whole module exists to prevent. Had `pct()` been handed
   * the currency field, /value-bets would have recommended staking 5000% of
   * bankroll. It cannot be expressed now, because there is no way to obtain a
   * Fraction of 50.
   */
  it("cannot be reached with a currency amount", () => {
    // @ts-expect-error a bare number is not assignable to Fraction
    const bad: Fraction = REAL.full_kelly;
    // The only route in throws, so the 5000% render is unreachable.
    expect(() => asFraction(bad)).toThrow(UnitError);
  });
});

describe("stakeFor", () => {
  it("multiplies by a bankroll the caller supplied", () => {
    expect(stakeFor(asFraction(0.025), 400)).toBeCloseTo(10, 10);
  });

  /**
   * The bankroll is a required parameter with no default. The pipeline's
   * `bankroll: float = 1000.0` is precisely the silent default that produced two
   * incompatible units in one artifact.
   */
  it("cannot default the bankroll", () => {
    // @ts-expect-error bankroll is required
    expect(() => stakeFor(asFraction(0.025))).toThrow();
  });

  it("rejects a nonsensical bankroll rather than returning NaN", () => {
    expect(() => stakeFor(asFraction(0.025), NaN)).toThrow(UnitError);
    expect(() => stakeFor(asFraction(0.025), -100)).toThrow(UnitError);
  });

  it("reproduces the pipeline's own arithmetic at its assumed bankroll", () => {
    // Confirms the units claim rather than asserting it: 0.05 * 1000 = 50.0,
    // which is exactly the `full_kelly` in the committed file.
    expect(stakeFor(asFraction(REAL.full_kelly_pct), 1000)).toBeCloseTo(
      REAL.full_kelly, 10,
    );
    expect(stakeFor(asFraction(REAL.half_kelly_pct), 1000)).toBeCloseTo(
      REAL.half_kelly, 10,
    );
  });
});

describe("the half-Kelly relationship the risk model depends on", () => {
  it("half is exactly half of full", () => {
    expect(REAL.half_kelly_pct).toBeCloseTo(REAL.full_kelly_pct / 2, 12);
  });

  it("halving a fraction stays a valid fraction", () => {
    const full = asFraction(REAL.full_kelly_pct);
    expect(toFraction(full / 2)).toBeCloseTo(REAL.half_kelly_pct, 12);
  });
});
