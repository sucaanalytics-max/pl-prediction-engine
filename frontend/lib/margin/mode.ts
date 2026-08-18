/**
 * Which mode the screen is in, and what the clock counts down to.
 *
 * ## The mode is derived, never toggled
 *
 * The design carries a mode switch in the top bar — deadline against idle — as a
 * prototype affordance, so both states could be shown to a reviewer. Shipping it
 * would be a control that lets the reader put the app into deadline mode while
 * the engine has not run, which is precisely the confusion the two modes exist
 * to remove.
 *
 * So the mode comes from `fpl/agent_status.json`, which is written by the phase
 * resolver rather than by the agent — deliberately, because the agent job is
 * skipped exactly when this answer matters most. `agent_ran` is published
 * explicitly rather than inferred from `phase` here, so a phase name added on
 * the Python side does not silently start reading as "ran".
 *
 * ## `unknown` is a fourth state and is not folded into `idle`
 *
 * When the status artifact itself cannot be read we do not know whether the
 * engine has run. Rendering that as idle would put a confident "the engine has
 * not run for this gameweek" on screen on the strength of a failed fetch, which
 * is the same class of mistake as `Date.parse("") === NaN` classifying every
 * expired proposal as ready.
 */

import type { AgentStatus } from "@/lib/data/agent-status";

export type MarginMode = "deadline" | "idle" | "locked" | "unknown";

export function modeOf(status: AgentStatus | null): MarginMode {
  if (status === null) return "unknown";
  if (status.phase === "locked") return "locked";
  return status.agentRan ? "deadline" : "idle";
}

/** What the clock above the countdown is measuring. */
export function clockLabel(mode: MarginMode): string {
  switch (mode) {
    case "deadline": return "Deadline in";
    case "idle": return "Next gate in";
    // Still counting DOWN to the deadline — see `describeMode`. "Locked since" put the
    // deadline in the past and the countdown beside it in the future.
    case "locked": return "Deadline in";
    default: return "Deadline";
  }
}

/**
 * `01:47:12` inside a day, `5d 21h` beyond it, and words at the edges.
 *
 * Seconds are shown only in the last day because that is the only range in which
 * they carry a decision — a second-by-second counter six days out is motion
 * dressed as urgency.
 */
export function countdown(remainingMs: number | null): string {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return "—";
  if (remainingMs <= 0) return "passed";

  const seconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(seconds / 86_400);

  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3600);
    return `${days}d ${hours}h`;
  }

  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Milliseconds to the deadline, or null when there is no readable one.
 *
 * Null rather than 0 on an unparseable date. `Date.parse("")` is NaN and NaN
 * arithmetic propagates silently — an expired-proposal branch in this app was
 * unreachable for exactly that reason, and every proposal read "ready".
 */
export function remainingMs(
  deadline: string | null | undefined, now: Date,
): number | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return null;
  return at - now.getTime();
}

/**
 * The sentence under the headline when the engine has not run.
 *
 * Distinct from `describeIdleAgent` in `lib/data/agent-status.ts`, which is one
 * long paragraph built for a state card. This is the top line of a screen whose
 * whole layout is already saying "no fresh answer", so it says only the part the
 * reader cannot see: which state, and what would change it.
 */
export function describeMode(mode: MarginMode, status: AgentStatus | null): string {
  switch (mode) {
    case "deadline":
      return status?.reason
        ?? "The engine has run for this gameweek. The call below is its answer.";
    case "idle":
      return status?.reason
        ?? "The engine gates on the deadline and has not run for this gameweek.";
    case "locked":
      /*
       * `locked` is the lockout BEFORE the deadline, not after it.
       *
       * `pipeline/learning/schedule.py:288` reads
       * `if remaining <= LOCKOUT_BEFORE_DEADLINE` with
       * `LOCKOUT_BEFORE_DEADLINE = timedelta(minutes=30)`, and `remaining` is time UNTIL
       * the deadline — so this phase is the last half hour before it, and it can never be
       * emitted after.
       *
       * This said "The deadline has passed and this gameweek is settled. Nothing below is
       * actionable." It was exactly backwards, and it rendered in the only thirty minutes
       * where being wrong about it costs a team: the reader can still change theirs, and
       * was being told not to bother.
       *
       * What is actually locked is the agent, not the owner.
       */
      return status?.reason
        ?? "Inside the last half hour before the deadline: the agent will not seal a new "
          + "forecast now, so the figures below are the ones it sealed earlier. Your team "
          + "is still yours to change until the deadline passes.";
    default:
      return "The phase resolver could not be read, so whether the engine has run "
        + "is unknown — which is not the same as it having not run.";
  }
}

/**
 * `3d 08h 43m` beyond a day, `01:47:12` inside it.
 *
 * A second format rather than a second resolver: it shares {@link remainingMs}
 * and its null handling, so there is still exactly one place that turns a
 * deadline string into time remaining.
 *
 * It exists because {@link countdown} drops to `3d 8h` beyond a day, and a
 * display whose smallest unit is an hour has nothing for a per-minute tick to
 * change — the masthead clock ticks per minute outside the last day, so the
 * minutes have to be on screen or the tick is a re-render nobody can see.
 * Inside the last day the two formats agree, because that is the only range in
 * which seconds carry a decision.
 */
export function countdownLong(remaining: number | null): string {
  if (remaining === null || !Number.isFinite(remaining)) return "—";
  if (remaining <= 0) return "passed";

  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86_400);
  const pad = (n: number) => String(n).padStart(2, "0");

  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  }

  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}`
    + `:${pad(seconds % 60)}`;
}

/**
 * How often the clock should tick, in milliseconds.
 *
 * Per second inside the last day, per minute beyond it. Seconds six days out are
 * motion dressed as urgency, and they re-render the masthead 86,400 times for a
 * digit no reader is watching.
 */
export function tickPeriodMs(remaining: number | null): number {
  if (remaining === null || !Number.isFinite(remaining)) return 60_000;
  return remaining > 0 && remaining < 86_400_000 ? 1_000 : 60_000;
}
