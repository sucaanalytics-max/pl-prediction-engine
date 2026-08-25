/**
 * The gameweek a manager can still act on.
 *
 * This exists because of a production outage on 2026-08-25: `/` and `/players`
 * both rendered empty for the four days between GW1's last match and GW2's
 * deadline. Nothing was broken in either page. The resolver returned FPL's
 * `event.id` of 1 — correct by FPL's semantics, since an event stays current
 * until the next deadline — while the producer had already published GW2 and
 * pruned GW1. Every surface fetched a file that had been correctly deleted.
 *
 * The window recurs every gameweek, so these are regression tests with dates
 * from the real incident rather than round numbers.
 */
import { describe, expect, it } from "vitest";

import {
  agentPlanningWeek,
  planningGameweek,
  LAST_GAMEWEEK,
} from "@/lib/data/gameweek";

// The live values read from /api/fpl/state during the incident.
const GW1_DEADLINE = "2026-08-21T17:30:00Z";
const DURING_THE_OUTAGE = new Date("2026-08-25T14:55:00Z");

describe("the incident", () => {
  it("rolls forward once the current event's deadline has passed", () => {
    expect(planningGameweek(1, GW1_DEADLINE, DURING_THE_OUTAGE)).toBe(2);
  });

  it("agrees with the artifact the producer actually published", () => {
    // xp_public_gw02.json was the only surviving projection, first kickoff 28 Aug.
    expect(planningGameweek(1, GW1_DEADLINE, DURING_THE_OUTAGE)).toBe(2);
  });

  it("stays put before the deadline", () => {
    const beforeGw1 = new Date("2026-08-20T09:00:00Z");
    expect(planningGameweek(1, GW1_DEADLINE, beforeGw1)).toBe(1);
  });

  it("stays put in the minute before the deadline", () => {
    const justBefore = new Date("2026-08-21T17:29:59Z");
    expect(planningGameweek(1, GW1_DEADLINE, justBefore)).toBe(1);
  });

  it("rolls forward the instant the deadline passes", () => {
    // Exactly at the deadline the week is closed: FPL locks teams on the second.
    expect(planningGameweek(1, GW1_DEADLINE, new Date(GW1_DEADLINE))).toBe(2);
  });
});

describe("what it refuses to guess", () => {
  it("returns null for no event at all", () => {
    expect(planningGameweek(null, GW1_DEADLINE, DURING_THE_OUTAGE)).toBeNull();
    expect(planningGameweek(undefined, GW1_DEADLINE, DURING_THE_OUTAGE)).toBeNull();
  });

  it("does not roll forward without a deadline", () => {
    // No deadline is no evidence the week has closed. Guessing forward here would
    // point every surface at a week nobody has projected.
    expect(planningGameweek(2, null, DURING_THE_OUTAGE)).toBe(2);
    expect(planningGameweek(2, undefined, DURING_THE_OUTAGE)).toBe(2);
  });

  it("treats an unparseable deadline as not passed, not as passed", () => {
    // NaN comparisons are all false, so this would read as "not passed" by
    // accident. It is asserted so the behaviour is a decision, not a side effect.
    expect(planningGameweek(2, "not a date", DURING_THE_OUTAGE)).toBe(2);
  });

  it("rejects a non-finite id rather than building a path from it", () => {
    expect(planningGameweek(Number.NaN, GW1_DEADLINE, DURING_THE_OUTAGE)).toBeNull();
    expect(planningGameweek(Infinity, GW1_DEADLINE, DURING_THE_OUTAGE)).toBeNull();
  });
});

describe("the end of the season", () => {
  it("never names a gameweek that does not exist", () => {
    const after = new Date("2027-05-30T00:00:00Z");
    expect(
      planningGameweek(LAST_GAMEWEEK, "2027-05-24T14:00:00Z", after),
    ).toBe(LAST_GAMEWEEK);
  });

  it("still rolls forward from the second-to-last week", () => {
    const after = new Date("2027-05-18T00:00:00Z");
    expect(planningGameweek(37, "2027-05-17T14:00:00Z", after)).toBe(38);
  });

  it("has thirty-eight gameweeks", () => {
    expect(LAST_GAMEWEEK).toBe(38);
  });
});

describe("the agent's gameweek means different things in different phases", () => {
  /**
   * The three retrospective branches of `schedule.py`. In each, `gameweek` is a
   * week already played that still needs work, so it must not reach a fetch path.
   */
  it.each(["refit", "settle_final", "settle_provisional"])(
    "ignores the agent in the %s phase",
    (phase) => {
      expect(agentPlanningWeek(1, phase)).toBeNull();
    },
  );

  /**
   * Every other branch derives its gameweek from the UPCOMING deadline, which is
   * exactly what a planner wants — so the agent stays the preferred source and
   * the pre-existing precedence is unchanged.
   */
  it.each(["idle", "locked", "seal", "refresh", "missed_seal"])(
    "trusts the agent in the %s phase",
    (phase) => {
      expect(agentPlanningWeek(7, phase)).toBe(7);
    },
  );

  it("treats an unknown phase as forward-looking", () => {
    // A phase added on the Python side must not silently become retrospective;
    // the failure mode of guessing wrong that way is a blank screen.
    expect(agentPlanningWeek(7, "some_new_phase")).toBe(7);
    expect(agentPlanningWeek(7, null)).toBe(7);
    expect(agentPlanningWeek(7, undefined)).toBe(7);
  });

  it("has nothing to say without a gameweek", () => {
    expect(agentPlanningWeek(null, "idle")).toBeNull();
    expect(agentPlanningWeek(undefined, "idle")).toBeNull();
    expect(agentPlanningWeek(Number.NaN, "idle")).toBeNull();
  });

  it("reproduces the incident end to end", () => {
    // Live values, 2026-08-25: agent in refit on GW1, FPL event 1 with a passed
    // deadline, and xp_public_gw02.json the only published projection.
    const fromAgent = agentPlanningWeek(1, "refit");
    const resolved =
      fromAgent ?? planningGameweek(1, GW1_DEADLINE, DURING_THE_OUTAGE);
    expect(fromAgent).toBeNull();
    expect(resolved).toBe(2);
  });
});
