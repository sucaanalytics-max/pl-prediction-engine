/**
 * The Vercel seal backstop's decisions, without a network.
 *
 * It can dispatch a run that seals, so every refusal is pinned: outside the band,
 * inside the lockout, a run in flight. And its copy of the band must be the
 * resolver's — a band that drifted from `schedule.py` would rescue the wrong hours
 * and pass every other test here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISPATCH_BODY,
  LOCKOUT_BEFORE_DEADLINE_MS,
  RECENT_RUN_MS,
  SEAL_WINDOW_MS,
  busyReason,
  inBand,
  narrowRuns,
  nextDeadline,
  sealBand,
} from "./seal-backstop";

const ROOT = join(__dirname, "..", "..");
const DEADLINE = new Date("2026-10-10T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number) {
  return new Date(DEADLINE.getTime() + offsetMs);
}

/** `NAME = timedelta(unit=n)` from schedule.py, in milliseconds. */
function pythonDelta(name: string): number {
  const source = readFileSync(join(ROOT, "pipeline", "learning", "schedule.py"), "utf8");
  const match = source.match(new RegExp(`^${name} = timedelta\\((hours|minutes)=(\\d+)\\)`, "m"));
  if (!match) throw new Error(`${name} is not a plain timedelta in schedule.py any more`);
  return Number(match[2]) * (match[1] === "hours" ? HOUR : MINUTE);
}

describe("the band is the resolver's band", () => {
  it("SEAL_WINDOW matches pipeline/learning/schedule.py", () => {
    expect(SEAL_WINDOW_MS).toBe(pythonDelta("SEAL_WINDOW"));
  });

  it("LOCKOUT_BEFORE_DEADLINE matches pipeline/learning/schedule.py", () => {
    expect(LOCKOUT_BEFORE_DEADLINE_MS).toBe(pythonDelta("LOCKOUT_BEFORE_DEADLINE"));
  });

  it("RECENT_RUN matches the Mac backstop's", () => {
    const script = readFileSync(join(ROOT, "scripts", "seal_backstop.py"), "utf8");
    const match = script.match(/^RECENT_RUN = timedelta\(minutes=(\d+)\)/m);
    expect(Number(match?.[1]) * MINUTE).toBe(RECENT_RUN_MS);
  });
});

describe("inBand", () => {
  it("opens exactly SEAL_WINDOW before the deadline", () => {
    expect(inBand(DEADLINE, at(-4 * HOUR - 1))).toBe(false);
    expect(inBand(DEADLINE, at(-4 * HOUR))).toBe(true);
  });

  it("closes at the lockout, when the agent refuses to write a forecast", () => {
    expect(inBand(DEADLINE, at(-30 * MINUTE - 1))).toBe(true);
    expect(inBand(DEADLINE, at(-30 * MINUTE))).toBe(false);
    expect(inBand(DEADLINE, at(-20 * MINUTE))).toBe(false);
  });

  it("reports the band it tests", () => {
    const band = sealBand(DEADLINE);
    expect(band.opens.toISOString()).toBe("2026-10-10T06:00:00.000Z");
    expect(band.closes.toISOString()).toBe("2026-10-10T09:30:00.000Z");
  });
});

describe("nextDeadline", () => {
  const bootstrap = {
    events: [
      { id: 5, deadline_time: "2026-09-19T10:00:00Z" },
      { id: 7, deadline_time: "2026-10-17T10:00:00Z" },
      { id: 6, deadline_time: "2026-10-10T10:00:00Z" },
    ],
  };

  it("is the first deadline still ahead, whatever order FPL lists them in", () => {
    expect(nextDeadline(bootstrap, new Date("2026-09-25T00:00:00Z"))).toEqual({
      gameweek: 6,
      deadline: DEADLINE,
    });
  });

  it("moves on once a deadline passes", () => {
    expect(nextDeadline(bootstrap, at(MINUTE))?.gameweek).toBe(7);
  });

  it("is null after the last deadline, rather than a past one", () => {
    expect(nextDeadline(bootstrap, new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });

  it("drops malformed events instead of guessing", () => {
    const messy = {
      events: [null, "GW6", { id: "6", deadline_time: "2026-10-10T10:00:00Z" },
        { id: 6, deadline_time: "not a date" }, { id: 6 },
        { id: 7, deadline_time: "2026-10-17T10:00:00Z" }],
    };
    expect(nextDeadline(messy, new Date("2026-09-25T00:00:00Z"))?.gameweek).toBe(7);
  });

  it("is null for a body that is not a bootstrap", () => {
    expect(nextDeadline(null, DEADLINE)).toBeNull();
    expect(nextDeadline({ events: "no" }, DEADLINE)).toBeNull();
    expect(nextDeadline([], DEADLINE)).toBeNull();
  });
});

describe("busyReason", () => {
  const now = at(-2 * HOUR);

  it("waits for a run that is queued or running", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = narrowRuns({ workflow_runs: [
        { id: 1, status, created_at: new Date(now.getTime() - HOUR).toISOString() },
      ] });
      expect(busyReason(runs, now)).toContain(status);
    }
  });

  it("waits for a run started in the last ten minutes, even if it already finished", () => {
    const runs = narrowRuns({ workflow_runs: [
      { id: 2, status: "completed", created_at: new Date(now.getTime() - 4 * MINUTE).toISOString() },
    ] });
    expect(busyReason(runs, now)).toBe("run 2 started 4m ago");
  });

  it("does not wait for an older finished run", () => {
    const runs = narrowRuns({ workflow_runs: [
      { id: 3, status: "completed", created_at: new Date(now.getTime() - RECENT_RUN_MS).toISOString() },
    ] });
    expect(busyReason(runs, now)).toBeNull();
  });

  it("does not wait when there are no runs, or the body is not a run list", () => {
    expect(busyReason(narrowRuns({ workflow_runs: [] }), now)).toBeNull();
    expect(busyReason(narrowRuns({ message: "Not Found" }), now)).toBeNull();
    expect(busyReason(narrowRuns(null), now)).toBeNull();
  });
});

describe("DISPATCH_BODY", () => {
  it("asks for a sealing run, because the workflow's input defaults to a dry run", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "fpl_agent.yml"), "utf8");
    // The premise: dry_run exists and defaults to true.
    expect(workflow).toMatch(/dry_run:\n(?:\s+\w+:.*\n)*?\s+default: true/);
    expect(DISPATCH_BODY).toEqual({ ref: "main", inputs: { dry_run: "false" } });
  });
});
