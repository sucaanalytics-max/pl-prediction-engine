import { describe, it, expect } from "vitest";
import {
  pct,
  odds,
  xg,
  featureName,
  impliedOdds,
  confidenceColor,
  edgeColor,
  predictionLabel,
} from "./formats";

describe("pct", () => {
  it("converts 0.523 to '52.3%'", () => {
    expect(pct(0.523)).toBe("52.3%");
  });

  it("converts 0 to '0.0%'", () => {
    expect(pct(0)).toBe("0.0%");
  });

  it("converts 1 to '100.0%'", () => {
    expect(pct(1)).toBe("100.0%");
  });

  it("uses 1 decimal place by default", () => {
    expect(pct(0.333)).toBe("33.3%");
  });

  it("respects custom decimal count of 2", () => {
    expect(pct(0.333, 2)).toBe("33.30%");
  });

  it("respects 0 decimal places", () => {
    expect(pct(0.5, 0)).toBe("50%");
  });

  it("handles values near 1", () => {
    expect(pct(0.999)).toBe("99.9%");
  });
});

describe("odds", () => {
  it("formats 2.1 as '2.10'", () => {
    expect(odds(2.1)).toBe("2.10");
  });

  it("formats 3.456 as '3.46' (rounds)", () => {
    expect(odds(3.456)).toBe("3.46");
  });

  it("formats 1 as '1.00'", () => {
    expect(odds(1)).toBe("1.00");
  });

  it("always shows 2 decimal places", () => {
    expect(odds(10)).toBe("10.00");
  });
});

describe("xg", () => {
  it("formats 1.723 as '1.72'", () => {
    expect(xg(1.723)).toBe("1.72");
  });

  it("formats 0 as '0.00'", () => {
    expect(xg(0)).toBe("0.00");
  });

  it("formats 2.5 as '2.50'", () => {
    expect(xg(2.5)).toBe("2.50");
  });
});

describe("featureName", () => {
  it("converts snake_case to Title Case", () => {
    expect(featureName("home_form")).toBe("Home Form");
  });

  it("converts multi-word snake_case", () => {
    expect(featureName("xg_difference_last_5")).toBe("Xg Difference Last 5");
  });

  it("handles single word without underscores", () => {
    expect(featureName("momentum")).toBe("Momentum");
  });

  it("capitalizes each word", () => {
    expect(featureName("goals_scored")).toBe("Goals Scored");
  });

  it("handles already-spaced names", () => {
    expect(featureName("home goal")).toBe("Home Goal");
  });
});

describe("impliedOdds", () => {
  it("returns '2.00' for probability 0.5", () => {
    expect(impliedOdds(0.5)).toBe("2.00");
  });

  it("returns '4.00' for probability 0.25", () => {
    expect(impliedOdds(0.25)).toBe("4.00");
  });

  it("returns '1.00' for probability 1.0", () => {
    expect(impliedOdds(1)).toBe("1.00");
  });

  it("returns '∞' for probability 0", () => {
    expect(impliedOdds(0)).toBe("∞");
  });

  it("returns '∞' for negative probability", () => {
    expect(impliedOdds(-0.1)).toBe("∞");
  });
});

describe("confidenceColor", () => {
  it("returns emerald for pct exactly 55", () => {
    expect(confidenceColor(55)).toBe("text-emerald-400");
  });

  it("returns emerald for pct above 55", () => {
    expect(confidenceColor(70)).toBe("text-emerald-400");
  });

  it("returns amber for pct exactly 45", () => {
    expect(confidenceColor(45)).toBe("text-amber-400");
  });

  it("returns amber for pct between 45 and 54", () => {
    expect(confidenceColor(50)).toBe("text-amber-400");
  });

  it("returns red for pct exactly 44", () => {
    expect(confidenceColor(44)).toBe("text-red-400");
  });

  it("returns red for pct of 0", () => {
    expect(confidenceColor(0)).toBe("text-red-400");
  });
});

describe("edgeColor", () => {
  it("returns emerald for edge exactly 0.10", () => {
    expect(edgeColor(0.10)).toBe("text-emerald-400");
  });

  it("returns emerald for edge above 0.10", () => {
    expect(edgeColor(0.15)).toBe("text-emerald-400");
  });

  it("returns amber for edge exactly 0.05", () => {
    expect(edgeColor(0.05)).toBe("text-amber-400");
  });

  it("returns amber for edge between 0.05 and 0.09", () => {
    expect(edgeColor(0.07)).toBe("text-amber-400");
  });

  it("returns slate for edge below 0.05", () => {
    expect(edgeColor(0.04)).toBe("text-slate-400");
  });

  it("returns slate for edge of 0", () => {
    expect(edgeColor(0)).toBe("text-slate-400");
  });
});

describe("predictionLabel", () => {
  it("maps 'home' to 'H'", () => {
    expect(predictionLabel("home")).toBe("H");
  });

  it("maps 'draw' to 'D'", () => {
    expect(predictionLabel("draw")).toBe("D");
  });

  it("maps 'away' to 'A'", () => {
    expect(predictionLabel("away")).toBe("A");
  });

  it("uppercases unknown predictions", () => {
    expect(predictionLabel("other")).toBe("OTHER");
  });

  it("handles empty string", () => {
    expect(predictionLabel("")).toBe("");
  });
});
