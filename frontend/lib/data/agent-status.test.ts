/**
 * The artifact that explains an absent agent.
 *
 * Its whole job is to be present and informative when the agent's own artifacts are
 * not, so the tests are about the idle case. The happy path — agent running, notice
 * hidden — is one assertion.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_STATUS, narrowAgentStatus, agentStatusIsEmpty,
} from "@/lib/data/agent-status";

const IDLE = {
  schema_version: 1,
  generated_at: "2026-08-11T12:00:00Z",
  phase: "idle",
  gameweek: 1,
  deadline: "2026-08-21T17:30:00+00:00",
  seconds_to_deadline: 890583,
  reason: "GW1 deadline in 247.4h; nothing due yet",
  agent_ran: false,
  explains_absence: "The agent computes projections… absent — not broken —",
};

function narrow(raw: unknown) {
  const result = narrowAgentStatus(raw);
  return result.ok ? result.value : null;
}

describe("narrowAgentStatus", () => {
  it("narrows the real published artifact", () => {
    const file = join(process.cwd(), "public", "predictions", "fpl", "agent_status.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const value = narrow(raw);
    expect(value).not.toBeNull();
    expect(typeof value!.agentRan).toBe("boolean");
  });

  it("refuses a file with no agent_ran rather than guessing", () => {
    // Deriving it from `phase` would mean a new Python phase silently reads as
    // "ran", which is the wrong way to be wrong.
    const { agent_ran: _omitted, ...withoutFlag } = IDLE;
    expect(narrow(withoutFlag)).toBeNull();
  });

  it("refuses a non-boolean agent_ran", () => {
    expect(narrow({ ...IDLE, agent_ran: "false" })).toBeNull();
  });

  it("is never empty", () => {
    // An idle agent IS the content. `chartable()` refuses `empty`, so treating this
    // as empty would hide the explanation exactly when it is needed.
    expect(agentStatusIsEmpty()).toBe(false);
  });
});

describe("the descriptor", () => {
  it("points at the path the phase job writes", () => {
    expect(AGENT_STATUS.path).toBe("fpl/agent_status.json");
  });

  it("is attributed to the agent, and carries a freshness budget", () => {
    // Republished every three hours; a day-old copy means the resolver stopped,
    // which is a real fault worth showing as stale.
    expect(AGENT_STATUS.owner).toBe("agent");
    expect(AGENT_STATUS.freshnessBudgetMs).toBeGreaterThan(0);
  });

  it("reads its produced-at from the artifact, not the clock", () => {
    const value = narrow(IDLE)!;
    expect(AGENT_STATUS.producedAtOf?.(value)).toBe("2026-08-11T12:00:00Z");
  });
});
