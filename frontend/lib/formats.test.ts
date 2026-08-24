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
  calendarDate,
  compactIstDeadline,
  istDateTime,
  kickoffTime,
  shortDate,
  deadlineStamp,
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

describe("calendarDate", () => {
  it("keeps a date-only fixture on the supplied calendar day", () => {
    expect(calendarDate("2025-12-30T00:00:00")).toBe("30 Dec 2025");
  });

  it("returns malformed values unchanged", () => {
    expect(calendarDate("unknown")).toBe("unknown");
    expect(calendarDate("2025-13-01")).toBe("2025-13-01");
  });
});

describe("Kolkata time formatting", () => {
  it("converts UTC kickoffs to IST and labels the timezone", () => {
    expect(kickoffTime("2026-08-21T17:30:00Z")).toBe("23:00 IST");
    expect(compactIstDeadline("2026-08-21T17:30:00Z")).toBe(
      "Fri 21 Aug · 23:00 IST"
    );
  });

  it("moves post-midnight IST fixtures onto the correct Kolkata date", () => {
    const timestamp = "2026-08-21T20:30:00Z";
    expect(shortDate(timestamp)).toBe("Sat 22 Aug");
    expect(kickoffTime(timestamp)).toBe("02:00 IST");
    expect(istDateTime(timestamp)).toContain("22 Aug 2026");
    expect(istDateTime(timestamp)).toContain("02:00 IST");
  });
});

describe("compactIstDeadline invents nothing", () => {
  /**
   * This function used to answer `"Fri 21 Aug · 23:00 IST"` when called with no
   * argument — GW1's real deadline, copied from a design document into a shared
   * formatter. Every caller with nothing to show rendered that as fact, and a reader
   * cannot tell an invented deadline from a measured one. On a planner whose entire
   * purpose is deciding before a deadline it is the worst single wrong number
   * available.
   *
   * The fix is a required parameter and no fallback, so absence became the caller's
   * sentence to write. These assertions pin the property rather than the shape: there
   * is no input for which this returns a date it was not given.
   */
  const UNPARSEABLE = ["", " ", "not a date", "undefined", "null", "2026-13-45", "GW1"];

  it("formats a real ISO timestamp", () => {
    expect(compactIstDeadline("2026-08-21T17:30:00Z")).toBe("Fri 21 Aug · 23:00 IST");
  });

  it("returns an unparseable value unchanged, as istDateTime does", () => {
    // Degrade to the input. The alternative — substituting something printable — is
    // the behaviour being removed.
    for (const bad of UNPARSEABLE) {
      expect(compactIstDeadline(bad), JSON.stringify(bad)).toBe(bad);
    }
  });

  it("returns no date it was not given, for any input", () => {
    for (const bad of UNPARSEABLE) {
      const out = compactIstDeadline(bad);
      expect(out, `${JSON.stringify(bad)} produced a formatted date`)
        .not.toMatch(/IST$/);
      expect(out, `${JSON.stringify(bad)} produced the old hardcoded deadline`)
        .not.toContain("Fri 21 Aug");
    }
  });

  it("cannot be called without a date at all", () => {
    // A type-level assertion, and the one that keeps the fallback from coming back:
    // if the parameter is ever made optional again, `@ts-expect-error` becomes an
    // unused directive and the build fails.
    // @ts-expect-error — dateStr is required on purpose; absence is the caller's to state.
    expect(() => compactIstDeadline()).not.toThrow();
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

describe("deadlineStamp", () => {
  /**
   * The masthead's sub-line, and why it is not in the reader's own zone.
   *
   * An FPL deadline is published in one zone and quoted in that zone everywhere it
   * is discussed. Rendering it as `23:00 IST` invites a reader to check it against
   * a source that says 17:30 and conclude the clock is wrong.
   */
  it("writes the deadline in the zone the deadline states", () => {
    expect(deadlineStamp("2026-08-21T17:30:00+00:00"))
      .toBe("Fri 21 Aug 2026 · 17:30 UTC");
  });

  it("treats a Z suffix as the same stated zone", () => {
    expect(deadlineStamp("2026-08-21T17:30:00Z"))
      .toBe("Fri 21 Aug 2026 · 17:30 UTC");
  });

  it("keeps a non-zero offset's own wall clock and names it", () => {
    expect(deadlineStamp("2026-08-21T23:00:00+05:30"))
      .toBe("Fri 21 Aug 2026 · 23:00 UTC+05:30");
  });

  it("handles an offset without a colon", () => {
    expect(deadlineStamp("2026-08-21T13:30:00-0400"))
      .toBe("Fri 21 Aug 2026 · 13:30 UTC-04:00");
  });

  it("refuses a timestamp that states no zone", () => {
    // There is nothing to be faithful to, and labelling it UTC would be an
    // invention on the one figure the whole screen counts down to.
    expect(deadlineStamp("2026-08-21T17:30:00")).toBeNull();
  });

  it("refuses an unparseable or absent value rather than returning NaN", () => {
    expect(deadlineStamp("")).toBeNull();
    expect(deadlineStamp(null)).toBeNull();
    expect(deadlineStamp(undefined)).toBeNull();
    expect(deadlineStamp("not a date")).toBeNull();
  });
});
