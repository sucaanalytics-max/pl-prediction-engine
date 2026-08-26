"use client";

import { AGENT_STATUS, type AgentStatus } from "@/lib/data/agent-status";
import { proven } from "@/lib/data/artifact";
import { useArtifact } from "@/lib/data/useArtifact";

/**
 * Why the agent has produced nothing, in one line.
 *
 * ## The fact this restores
 *
 * `agent_status.json` exists for exactly one purpose, stated in
 * `schedule.py:475-492`: the agent self-gates, so its artifacts are absent for
 * most of a gameweek cycle, and a screen must be able to tell **idle by design**
 * from **broken**. Those are opposite facts and every absence on this page
 * rendered them identically.
 *
 * `agentRan` and `reason` were narrowed and read by nothing. The previous
 * consumer was removed on the reasoning that `reason` "already carries the
 * resolver's own sentence" — true, and beside the point: a sentence nothing
 * renders is not available to a reader.
 *
 * ## One line, and only when it says something
 *
 * `null` when the agent ran, because then the artifacts below are the answer and
 * a line about the agent's phase would be noise. `null` too when the status
 * artifact itself cannot be read — the sections below already declare their own
 * state, and a notice that cannot say why would be a shrug with a border.
 *
 * The resolver's `reason` is quoted rather than recomposed. Composing one here is
 * what the deleted `describeIdleAgent` did, and it grew a second definition of
 * how a deadline is formatted; the sentence is written by the code that made the
 * decision, which is the only place that knows it.
 */
export function AgentIdleNotice() {
  const { artifact } = useArtifact<AgentStatus>(AGENT_STATUS);
  const status = proven(artifact);

  if (!status || status.agentRan) return null;

  return (
    <p
      className="text-xs"
      role="status"
      data-testid="agent-idle"
      style={{ color: "var(--text-3)" }}
    >
      The agent has not run, so what it writes is absent by design rather than
      broken
      {status.reason ? ` — ${status.reason}` : ""}
      {status.phase ? ` (phase ${status.phase})` : ""}.
    </p>
  );
}
