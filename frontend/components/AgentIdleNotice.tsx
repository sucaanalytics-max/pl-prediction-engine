"use client";

import { AGENT_STATUS, describeIdleAgent, type AgentStatus } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";

/**
 * Says why an agent-owned artifact is absent.
 *
 * ## The measured problem
 *
 * The agent self-gates on phase and is skipped whenever nothing is due. On
 * 2026-08-11 that was every run: the GW1 deadline was 247 hours away, and the
 * resolver correctly reported "nothing due yet". It writes `evidence_view.json`,
 * `messages.json` and `xp_gw*`, so those are absent for about ten days before each
 * deadline.
 *
 * Without this, `/evidence` showed the same `absent` state whether the agent was
 * idle by design or had crashed — and `evidence_view.json` has in fact **never**
 * been published, which looks alarming until you know the reason.
 *
 * ## Why it renders nothing when the agent is working
 *
 * A banner that is always present stops being read. This returns null the moment
 * `agent_ran` is true, so its appearance carries information.
 */
export default function AgentIdleNotice() {
  const { artifact } = useArtifact<AgentStatus>(AGENT_STATUS);

  // `proven` rather than `.value`: the payload is behind a module-private symbol
  // precisely so a page cannot read it without passing through a state check.
  const status = proven(artifact);
  if (!status) {
    // The status file itself is missing. That is a different and much smaller
    // problem than the agent being broken, and saying nothing is better than
    // guessing which one it is.
    return null;
  }

  const sentence = describeIdleAgent(status);
  if (!sentence) return null;

  return (
    <div
      className="glass-inset p-3 text-xs"
      role="status"
      data-testid="agent-idle-notice"
      style={{ color: "var(--text-2)", borderLeft: "3px solid var(--warning, #f59e0b)" }}
    >
      <p>
        <strong style={{ color: "var(--text-1)" }}>The agent is idle.</strong>{" "}
        {sentence}
      </p>
    </div>
  );
}
