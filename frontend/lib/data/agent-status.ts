/**
 * Why the agent's artifacts are missing.
 *
 * ## The gap this closes
 *
 * The agent self-gates on phase: `needs_work` is false in IDLE and LOCKED, and the
 * CI job that runs it is skipped accordingly. Measured on 2026-08-11 that was every
 * run for days — the GW1 deadline was 247 hours away and the resolver correctly said
 * "nothing due yet".
 *
 * It writes `evidence_view.json`, `messages.json` and `xp_gw*`, so all three are
 * absent for roughly the ten days before a deadline. `/evidence` rendered `absent`
 * with nothing to distinguish **the agent is idle by design** from **the agent is
 * broken** — two facts a reader would act on very differently, shown identically.
 *
 * Rule 1 of this layer is that absence is a state. This is the state's reason.
 *
 * ## Written by the phase job, not the agent job
 *
 * Deliberate, and the whole design. The agent job is skipped exactly when this file
 * is most needed, so publishing it there would reproduce the problem it solves.
 * `pipeline/learning/schedule.py` writes it from the resolver, which always runs.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import { optNumber, optString, Problems, reqRecord } from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface AgentStatus {
  /** `idle`, `locked`, or a phase in which the agent does work. */
  readonly phase: string | null;
  readonly gameweek: number | null;
  /** ISO deadline of the gameweek being worked toward, when there is one. */
  readonly deadline: string | null;
  readonly secondsToDeadline: number | null;
  /** The resolver's own sentence, e.g. "GW1 deadline in 247.4h; nothing due yet". */
  readonly reason: string | null;
  /**
   * Whether the expensive job ran. `false` means every agent-owned artifact is
   * legitimately absent, and is the answer a screen should show instead of a shrug.
   */
  readonly agentRan: boolean;
  readonly generatedAt: string | null;
}

export function narrowAgentStatus(raw: unknown): NarrowResult<AgentStatus> {
  const problems = new Problems();
  const file = reqRecord(raw, "agent_status", problems);
  if (!file) return malformed(problems.all);

  // `agent_ran` is published explicitly rather than derived from `phase` here: the
  // frontend should not have to know which phase names count as idle, and a new
  // phase added on the Python side would otherwise silently read as "ran".
  const agentRan = file.agent_ran;
  if (typeof agentRan !== "boolean") {
    problems.add("agent_ran is absent, expected a boolean");
    return malformed(problems.all);
  }

  return narrowed({
    phase: optString(file.phase),
    gameweek: optNumber(file.gameweek),
    deadline: optString(file.deadline),
    secondsToDeadline: optNumber(file.seconds_to_deadline),
    reason: optString(file.reason),
    agentRan,
    generatedAt: optString(file.generated_at),
  });
}

/**
 * Never empty.
 *
 * An idle agent is this artifact's most useful content, not an absence of content —
 * treating it as `empty` would hide the explanation exactly when it is needed, and
 * `chartable()` refuses `empty`.
 */
export function agentStatusIsEmpty(): boolean {
  return false;
}

export const AGENT_STATUS: Descriptor<AgentStatus> = {
  key: "agentStatus",
  path: "fpl/agent_status.json",
  owner: "agent",
  describes: "the agent's phase, and why its artifacts may be absent",
  // Republished every three hours by the phase job. A day-old copy means the
  // resolver itself has stopped, which is worth surfacing as stale.
  freshnessBudgetMs: DAY,
  narrow: narrowAgentStatus,
  producedAtOf: (v: AgentStatus) => v.generatedAt,
  isEmpty: agentStatusIsEmpty,
};

/*
 * `describeIdleAgent` was here.
 *
 * It composed one sentence from `phase`, `reason` and `deadline` for a screen to
 * print when the agent had not run. Its only-ever caller was
 * `AgentIdleNotice.tsx`, and its only-ever mount point in the whole git history
 * was `app/evidence/page.tsx` — by the time it was removed it had no callers,
 * and it formatted the deadline with its own `toLocaleString`, which made it a
 * SECOND definition of what a deadline looks like in a tree that now has
 * exactly one (`compactIstDeadline`, rendered once by
 * `components/DeadlineClock.tsx`).
 *
 * Nothing is lost: `reason` on this artifact already carries the resolver's own
 * sentence — "GW1 deadline in 247.4h; nothing due yet" — written by the code that
 * decided it, and `agentRan` is the boolean a surface should branch on.
 */
