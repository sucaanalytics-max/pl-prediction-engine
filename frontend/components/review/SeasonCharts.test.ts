/**
 * The chart geometry, which is where a chart ships upside down.
 *
 * These are pure and tested separately from the SVG because "up is better" on
 * a rank axis is an inversion, and an inversion that is wrong still renders a
 * perfectly plausible chart.
 */
import { describe, expect, it } from "vitest";
import {
  magnitudeBar, millions, rankY, signedBar,
} from "@/components/review/SeasonCharts";

describe("rankY — up is better", () => {
  it("puts a better rank higher on the screen", () => {
    // Smaller y is higher. Rank 1 must sit above rank 7,000,000.
    const best = rankY(1, 7_000_000, 30, 190);
    const worst = rankY(7_000_000, 7_000_000, 30, 190);
    expect(best).toBeLessThan(worst);
  });

  it("pins the extremes to the plot area", () => {
    expect(rankY(0, 7_000_000, 30, 190)).toBe(30);
    expect(rankY(7_000_000, 7_000_000, 30, 190)).toBe(190);
  });

  it("places the real season in the right order", () => {
    // GW1 6.12m, GW2 1.67m, GW3 3.43m. GW2 was the best week, so it is highest.
    const y = (r: number) => rankY(r, 7_000_000, 30, 190);
    expect(y(1_667_220)).toBeLessThan(y(3_427_838));
    expect(y(3_427_838)).toBeLessThan(y(6_124_832));
  });

  it("does not divide by zero before anything has settled", () => {
    expect(rankY(0, 0, 30, 190)).toBe(190);
  });
});

describe("signedBar — direction carries the sign", () => {
  it("grows upward from the rule when positive", () => {
    const bar = signedBar(28, 28, 66, 45);
    expect(bar.y).toBe(21);        // 66 − 45
    expect(bar.height).toBe(45);
    expect(bar.y + bar.height).toBe(66);
  });

  it("grows downward from the rule when negative", () => {
    const bar = signedBar(-13, 28, 66, 45);
    expect(bar.y).toBe(66);
    expect(bar.height).toBeCloseTo(20.9, 1);
  });

  it("scales by magnitude, so a worse week is a longer bar", () => {
    const small = signedBar(-6, 28, 66, 45);
    const large = signedBar(-13, 28, 66, 45);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it("draws nothing rather than dividing by zero at the season's start", () => {
    expect(signedBar(0, 0, 66, 45)).toEqual({ y: 66, height: 0 });
  });
});

describe("magnitudeBar", () => {
  it("rises from the baseline", () => {
    const bar = magnitudeBar(13, 13, 110, 80);
    expect(bar.y).toBe(30);
    expect(bar.y + bar.height).toBe(110);
  });

  it("keeps the real bench weeks in proportion", () => {
    const gw1 = magnitudeBar(2, 13, 110, 80);
    const gw2 = magnitudeBar(13, 13, 110, 80);
    expect(gw2.height / gw1.height).toBeCloseTo(6.5, 1);
  });

  it("never draws below the baseline", () => {
    expect(magnitudeBar(-5, 13, 110, 80).height).toBe(0);
  });
});

describe("millions", () => {
  it("reads a rank as the two figures a manager quotes", () => {
    expect(millions(3_427_838)).toBe("3.43m");
    expect(millions(1_667_220)).toBe("1.67m");
  });
});
