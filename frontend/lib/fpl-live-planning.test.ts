/**
 * Which gameweek the live route calls "next".
 *
 * FPL keeps an event `is_current` from its own deadline until the NEXT one. So for
 * the days between a gameweek's last match and the following deadline, the current
 * event names a week already played — and anything forward-looking that trusts it
 * points at the past.
 *
 * Measured in production on 2026-08-26: Raya's fixture list began
 * `{gameweek: 1, label: "COV (H)", difficulty: 2}`, a match played five days
 * earlier, while his real next fixture was
 * `{gameweek: 2, label: "AVL (A)", difficulty: 4}`. The call screen paired GW2
 * projections with GW1 opponents, and since the fixture chip is tinted by
 * difficulty, it painted a hard away trip in the green this app reserves for a kind
 * fixture. Colour was stating the opposite of the truth.
 *
 * These use the real event ids, deadlines and difficulties from that incident.
 */
import { describe, expect, it } from "vitest";

import { planningEventId } from "@/lib/fpl-live-server";

/** The shape `bootstrap.events` actually returns, trimmed to what is read. */
function event(
  id: number,
  deadline: string,
  flags: { current?: boolean; next?: boolean; finished?: boolean } = {},
) {
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: deadline,
    is_current: flags.current ?? false,
    is_next: flags.next ?? false,
    finished: flags.finished ?? false,
  };
}

const GW1 = "2026-08-21T17:30:00Z";
const GW2 = "2026-08-28T17:30:00Z";
const GW3 = "2026-09-04T17:30:00Z";

const SEASON = [
  event(1, GW1, { current: true }),
  event(2, GW2, { next: true }),
  event(3, GW3),
];

describe("the incident", () => {
  it("rolls past the current event once its deadline has gone", () => {
    // 26 Aug: GW1 played, GW2 not yet locked. The answer must be 2.
    expect(planningEventId(SEASON, new Date("2026-08-26T08:35:00Z"))).toBe(2);
  });

  it("stays on the current event before its deadline", () => {
    expect(planningEventId(SEASON, new Date("2026-08-20T09:00:00Z"))).toBe(1);
  });

  it("stays put in the last minute before the deadline", () => {
    expect(planningEventId(SEASON, new Date("2026-08-21T17:29:59Z"))).toBe(1);
  });

  it("rolls forward the instant the deadline lands", () => {
    // FPL locks teams on the second; at the deadline the week is closed.
    expect(planningEventId(SEASON, new Date(GW1))).toBe(2);
  });
});

describe("what it refuses to guess", () => {
  it("does not roll forward without a parseable deadline", () => {
    // No deadline is no evidence the week has closed. Rolling forward here would
    // aim every fixture chip at a week that may not be next.
    const odd = [event(1, "not a date", { current: true }), event(2, GW2)];
    expect(planningEventId(odd, new Date("2026-08-26T08:35:00Z"))).toBe(1);
  });

  it("never names a gameweek the season does not contain", () => {
    const last = [event(38, "2027-05-24T14:00:00Z", { current: true })];
    expect(planningEventId(last, new Date("2027-06-01T00:00:00Z"))).toBe(38);
  });

  it("falls back to 1 on an empty season rather than NaN", () => {
    // The id becomes a fixture filter and an API path segment; NaN would be worse
    // than wrong, because it fails silently rather than loudly.
    expect(planningEventId([], new Date())).toBe(1);
  });
});

describe("it follows FPL's own precedence when nothing is current", () => {
  it("uses is_next when no event is current", () => {
    const between = [
      event(1, GW1, { finished: true }),
      event(2, GW2, { next: true }),
    ];
    // is_next's deadline is still ahead, so it stands.
    expect(planningEventId(between, new Date("2026-08-26T08:35:00Z"))).toBe(2);
  });
});
