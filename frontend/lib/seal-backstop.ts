/**
 * Whether to ask GitHub for one more FPL agent tick, decided from facts alone.
 *
 * ## Why this exists
 *
 * A seal must be written between SEAL_WINDOW (4h) and LOCKOUT_BEFORE_DEADLINE
 * (30m) before a deadline, and a missed one can never be recovered. It rides on
 * GitHub's scheduler, which delivered about six and a half runs a day per
 * workflow whatever the cron asked for — measured 2026-09-24: a `*\/15` workflow
 * got 6.6 a day and the hourly agent 6.5 — and left a 3.5-hour band empty about
 * one day in four. A `workflow_dispatch` is not queued with schedules: measured,
 * the run was created 5 seconds after the request.
 *
 * So `app/api/cron/seal-backstop` runs on Vercel's cron (Pro plan: to the minute)
 * and dispatches when a seal is at risk. `scripts/seal_backstop.py` does the same
 * from the owner's Mac; this one needs no machine to be awake.
 *
 * ## Why a redundant dispatch is safe
 *
 * The dispatched run goes through the agent's own phase resolver, which returns
 * IDLE once the gameweek is sealed, and `seal_forecast` raises AlreadySealedError
 * rather than overwriting. So this decides only whether to ASK, never what the
 * agent does — and two askers (this and the Mac) at once cost a second no-op run.
 *
 * Pure, so every refusal is testable without a network.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Mirrors `pipeline/learning/schedule.py`; `seal-backstop.test.ts` pins them equal. */
export const SEAL_WINDOW_MS = 4 * HOUR_MS;
export const LOCKOUT_BEFORE_DEADLINE_MS = 30 * MINUTE_MS;
/** A run started this recently is left to finish rather than joined. */
export const RECENT_RUN_MS = 10 * MINUTE_MS;

const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

export interface Deadline {
  readonly gameweek: number;
  readonly deadline: Date;
}

export interface AgentRun {
  readonly id: number;
  readonly status: string | null;
  readonly createdAt: Date | null;
}

/** The first deadline still ahead, from FPL's bootstrap `events`. Narrowed, not cast. */
export function nextDeadline(bootstrap: unknown, now: Date): Deadline | null {
  const events =
    bootstrap && typeof bootstrap === "object" && Array.isArray((bootstrap as { events?: unknown }).events)
      ? ((bootstrap as { events: unknown[] }).events)
      : [];
  const upcoming: Deadline[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { id, deadline_time: stamp } = event as { id?: unknown; deadline_time?: unknown };
    if (typeof id !== "number" || typeof stamp !== "string") continue;
    const deadline = new Date(stamp);
    if (Number.isNaN(deadline.getTime()) || deadline <= now) continue;
    upcoming.push({ gameweek: id, deadline });
  }
  upcoming.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
  return upcoming[0] ?? null;
}

export function sealBand(deadline: Date): { opens: Date; closes: Date } {
  return {
    opens: new Date(deadline.getTime() - SEAL_WINDOW_MS),
    closes: new Date(deadline.getTime() - LOCKOUT_BEFORE_DEADLINE_MS),
  };
}

export function inBand(deadline: Date, now: Date): boolean {
  const { opens, closes } = sealBand(deadline);
  return now >= opens && now < closes;
}

/** GitHub's `workflow_runs`, narrowed. Anything malformed is dropped, not guessed. */
export function narrowRuns(body: unknown): AgentRun[] {
  const runs =
    body && typeof body === "object" && Array.isArray((body as { workflow_runs?: unknown }).workflow_runs)
      ? ((body as { workflow_runs: unknown[] }).workflow_runs)
      : [];
  return runs.flatMap((run) => {
    if (!run || typeof run !== "object") return [];
    const { id, status, created_at: created } = run as Record<string, unknown>;
    if (typeof id !== "number") return [];
    const createdAt = typeof created === "string" ? new Date(created) : null;
    return [{
      id,
      status: typeof status === "string" ? status : null,
      createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    }];
  });
}

/** Why a run in flight stops a dispatch, or null when none does. */
export function busyReason(runs: readonly AgentRun[], now: Date): string | null {
  for (const run of runs) {
    if (run.status && ACTIVE.has(run.status)) return `run ${run.id} is ${run.status}`;
    if (run.createdAt && now.getTime() - run.createdAt.getTime() < RECENT_RUN_MS) {
      return `run ${run.id} started ${Math.floor((now.getTime() - run.createdAt.getTime()) / MINUTE_MS)}m ago`;
    }
  }
  return null;
}

/**
 * The body GitHub's dispatch API is sent. `dry_run` is spelled out as "false"
 * because the workflow's input DEFAULTS TO TRUE, which produces and notifies
 * without sealing — a rescue that rescues nothing.
 */
export const DISPATCH_BODY = { ref: "main", inputs: { dry_run: "false" } } as const;
