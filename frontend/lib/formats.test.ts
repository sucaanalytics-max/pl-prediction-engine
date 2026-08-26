import { describe, it, expect } from "vitest";
import {
  pct,
  odds,
  xg,
  compactIstDeadline,
  istDateTime,
  kickoffTime,
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

describe("Kolkata time formatting", () => {
  it("converts UTC kickoffs to IST and labels the timezone", () => {
    expect(kickoffTime("2026-08-21T17:30:00Z")).toBe("23:00 IST");
    expect(compactIstDeadline("2026-08-21T17:30:00Z")).toBe(
      "Fri 21 Aug · 23:00 IST"
    );
  });

  it("moves post-midnight IST fixtures onto the correct Kolkata date", () => {
    // The 20:30Z kickoff is 02:00 the NEXT day in Kolkata, which is the whole
    // reason these formatters exist rather than a toLocaleString call at the point
    // of use. `shortDate` used to be asserted here too and is gone with the rest of
    // the unused date spellings; `istDateTime` carries the date now.
    const timestamp = "2026-08-21T20:30:00Z";
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

  it("does not invent GW1's deadline when null is forced past the type", () => {
    // `new Date(null)` coerces to the epoch instead of `NaN`, so the
    // `Number.isNaN` guard alone never catches it. The type forbids this in
    // real callers, but pin it anyway: a `null` cast through the type must not
    // come back as a formatted date, let alone the old hardcoded one.
    const forced = null as unknown as string;
    expect(compactIstDeadline(forced)).toBe(forced);
    expect(compactIstDeadline(forced)).not.toBe("Thu 01 Jan · 05:30 IST");
  });
});

