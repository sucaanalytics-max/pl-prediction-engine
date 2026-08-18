/**
 * Rule 1's age line, and the claim it refuses to make.
 *
 * "Never a relative claim the reader cannot check." Inside a day, `6h old` and
 * `as at 06:30` say the same thing and the first is shorter. Beyond a day,
 * "3 days" is unverifiable — three days from when? — so the line switches to an
 * instant the reader can check against the fixture list or the last deadline.
 */
import { describe, expect, it } from "vitest";

import { ageLine } from "@/lib/formats";

// 2026-08-18 12:00 UTC == 17:30 IST, a Tuesday.
const NOW = new Date("2026-08-18T12:00:00Z");

describe("inside a day, hours", () => {
  it("reads in whole hours", () => {
    expect(ageLine("2026-08-18T06:00:00Z", NOW)).toBe("6h old");
  });

  it("floors rather than rounds, so it never overstates freshness", () => {
    // 6h59m is still 6h old, not 7h — the artifact is no fresher than claimed.
    expect(ageLine("2026-08-18T05:01:00Z", NOW)).toBe("6h old");
  });

  it("says 0h under the hour, not minutes", () => {
    // Written by a cron; minute precision would imply freshness it lacks.
    expect(ageLine("2026-08-18T11:40:00Z", NOW)).toBe("0h old");
  });

  it("still uses hours at 23h", () => {
    expect(ageLine("2026-08-17T13:00:00Z", NOW)).toBe("23h old");
  });
});

describe("beyond a day, an instant the reader can check", () => {
  it("switches form at 24h rather than saying '1 day'", () => {
    const line = ageLine("2026-08-17T11:00:00Z", NOW)!;
    expect(line).toMatch(/^as at /);
    expect(line).not.toMatch(/day/);
  });

  it("names a weekday and a clock time", () => {
    // 2026-08-15T01:00Z is 06:30 IST on the Saturday.
    expect(ageLine("2026-08-15T01:00:00Z", NOW)).toBe("as at Sat 06:30");
  });

  it("renders in the display zone, not UTC", () => {
    // Same instant would be Fri 22:00 in UTC and Sat 03:30 in IST. If this ever
    // reads Fri, the line disagrees with the deadline printed above it.
    expect(ageLine("2026-08-14T22:00:00Z", NOW)).toBe("as at Sat 03:30");
  });

  it("never emits a relative duration beyond a day", () => {
    for (const days of [1, 2, 5, 30, 400]) {
      const then = new Date(NOW.getTime() - days * 86_400_000).toISOString();
      const line = ageLine(then, NOW)!;
      expect(line, `${days}d ago`).toMatch(/^as at /);
      expect(line).not.toMatch(/\b(day|days|hour|hours|old)\b/);
    }
  });
});

describe("what it refuses", () => {
  it("returns null with no timestamp, rather than 'unknown'", () => {
    expect(ageLine(null)).toBeNull();
    expect(ageLine(undefined)).toBeNull();
    expect(ageLine("")).toBeNull();
  });

  it("returns null on an unparseable stamp", () => {
    expect(ageLine("not a date")).toBeNull();
  });

  it("shows a future stamp as an instant, never as 0h old", () => {
    // Clock skew or a mis-stamped file. "0h old" would read as fresh; an instant
    // in the future is visibly wrong, which is the honest failure.
    const line = ageLine("2026-08-19T12:00:00Z", NOW)!;
    expect(line).toMatch(/^as at /);
    expect(line).not.toContain("old");
  });
});
