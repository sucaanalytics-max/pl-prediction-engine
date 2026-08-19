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

describe("a weekday only names one day inside the week", () => {
  /**
   * `as at Thu 18:53` identifies an instant only within the current week. Past that it
   * names two Thursdays and the reader takes the recent one.
   *
   * Not hypothetical: `accuracy.json` and `evidence_view.json` were 5.3 days old and
   * rendering "as at Thu 18:53" on a Wednesday, which reads as yesterday. At seven days
   * the two Thursdays are indistinguishable.
   */
  const now = new Date("2026-08-19T12:00:00Z"); // a Wednesday

  it("keeps the weekday for something earlier this week", () => {
    // Two days back: "Mon" can only mean one Monday from here.
    expect(ageLine("2026-08-17T06:30:00Z", now)).toMatch(/^as at Mon /);
  });

  it("dates anything a week or more old, rather than naming a weekday twice", () => {
    const line = ageLine("2026-08-11T06:30:00Z", now)!;
    expect(line).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    expect(line).toMatch(/^as at 11 Aug /);
  });

  it("dates the artifacts that prompted this, at 5.3 days", () => {
    /* Rendered in `DISPLAY_TIME_ZONE` (Asia/Kolkata, UTC+5:30), so 13 Aug 18:53Z is
       Friday 00:23 there — which is exactly why a weekday is a poor identifier: it is
       not even the weekday of the timestamp as written. Six days is the boundary; this
       sits under it and stays a weekday, and a day older does not. */
    expect(ageLine("2026-08-13T18:53:00Z", now)).toMatch(/^as at Fri /);
    // A day older crosses the boundary and takes a date. Asserted as a form rather than
    // a literal, because the display zone shifts the calendar day too.
    const older = ageLine("2026-08-12T18:53:00Z", now)!;
    expect(older).toMatch(/^as at \d{1,2} Aug \d{2}:\d{2}$/);
    expect(older).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it("still reports hours inside a day", () => {
    expect(ageLine("2026-08-19T06:00:00Z", now)).toBe("6h old");
  });

  it("still states a future stamp as an instant, and dates a far-future one", () => {
    /* A future age rendered as "0h old" would be a quiet lie; as an instant it is
       visibly wrong, which is the point. */
    expect(ageLine("2026-08-20T06:00:00Z", now)).toMatch(/^as at /);
    expect(ageLine("2027-01-01T06:00:00Z", now)).toMatch(/^as at 1 Jan /);
  });

  it("still returns null for an absent or unparseable stamp", () => {
    expect(ageLine(null, now)).toBeNull();
    expect(ageLine("not a date", now)).toBeNull();
  });
});
