/**
 * The agent's feed and its idle line, rendered rather than inspected.
 *
 * The defect these guard is not "renders wrong" — it is "renders nowhere". The
 * feed's narrower had zero consumers for the whole of the route cut while the
 * page that absorbed `/inbox` said in its docstring that it had absorbed it, and
 * `agentRan` and `reason` were narrowed and read by nothing at all. A source-text
 * test cannot see the difference between a component that exists and a component
 * that is on a page, so these mount, and `test/rescued-mounts.test.tsx` asserts
 * the mount.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { narrowMessages } from "@/lib/data/narrow";
import { narrowAgentStatus } from "@/lib/data/agent-status";

/**
 * Stubs the artifact layer, exactly as `MinutesConflicts.test.tsx` does.
 *
 * `value === null` stands for an artifact that is not published, which is the
 * common case for anything agent-owned.
 */
function mountWith(value: unknown, module: string) {
  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: value === null ? "not published" : null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import(module);
}

/** Built through the real narrower, so the fixture cannot drift from the wire shape. */
function feed(messages: unknown[]) {
  const result = narrowMessages({
    generated_at: "2026-08-21T13:40:53Z",
    messages,
  });
  if (!("value" in result) || !result.value) {
    throw new Error(`fixture did not narrow: ${JSON.stringify(result)}`);
  }
  return result.value;
}

const SEALED = {
  id: "gw01-missed-seal",
  gameweek: 1,
  kind: "warning",
  severity: "critical",
  title: "GW1 was never sealed",
  body: "No pre-deadline forecast exists for this gameweek.",
  created_at: "2026-08-21T18:00:00Z",
};

const ROUTINE = {
  id: "gw02-status",
  gameweek: 2,
  kind: "status",
  severity: "info",
  title: "GW2 projection refreshed",
  body: "Nothing else is due.",
  created_at: "2026-08-24T09:00:00Z",
};

describe("the agent's message feed", () => {
  it("renders each message with its severity and gameweek", async () => {
    const { default: AgentMessages } = await mountWith(
      feed([SEALED]), "@/components/AgentMessages",
    );
    render(<AgentMessages />);
    expect(screen.getByText("GW1 was never sealed")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    // The week the message is about, in its own element beside the severity.
    expect(screen.getByText(/^GW1 ·/)).toBeTruthy();
    // The body is the payload, not a tooltip.
    expect(screen.getByText(/No pre-deadline forecast/)).toBeTruthy();
  });

  it("orders newest first, whatever order the file is in", async () => {
    const { default: AgentMessages } = await mountWith(
      feed([SEALED, ROUTINE]), "@/components/AgentMessages",
    );
    const { container } = render(<AgentMessages />);
    const titles = [...container.querySelectorAll('[data-testid="agent-message"]')]
      .map((node) => node.textContent ?? "");
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain("GW2 projection refreshed");
    expect(titles[1]).toContain("GW1 was never sealed");
  });

  it("states an empty feed in one line, because silence is the normal state", async () => {
    const { default: AgentMessages } = await mountWith(
      feed([]), "@/components/AgentMessages",
    );
    const { container } = render(<AgentMessages />);
    expect(container.textContent).toMatch(/said nothing/);
    expect(container.querySelectorAll('[data-testid="agent-message"]')).toHaveLength(0);
  });

  it("states absence as a line, not a panel", async () => {
    const { default: AgentMessages } = await mountWith(
      null, "@/components/AgentMessages",
    );
    const { container } = render(<AgentMessages />);
    expect(container.querySelector('[data-weight="line"]')).not.toBeNull();
    expect(container.querySelector(".card")).toBeNull();
  });

  it("shows a record it could not read rather than dropping it", async () => {
    // `parseFeed` replaces an unparseable record with a visible placeholder and
    // counts it. A feed that quietly shrinks looks like a quiet agent.
    const { default: AgentMessages } = await mountWith(
      feed([{ nothing: "useful" }]), "@/components/AgentMessages",
    );
    const { container } = render(<AgentMessages />);
    expect(container.querySelectorAll('[data-testid="agent-message"]')).toHaveLength(1);
    expect(container.textContent).toMatch(/could not be read/);
  });
});

/** Built through the real narrower, same reason as the feed fixture. */
function status(agentRan: boolean) {
  const result = narrowAgentStatus({
    phase: agentRan ? "refresh" : "idle",
    gameweek: 2,
    deadline: "2026-08-29T17:30:00Z",
    seconds_to_deadline: 455_000,
    reason: "GW2 deadline in 126.4h; nothing due yet",
    agent_ran: agentRan,
    generated_at: "2026-08-24T09:00:00Z",
  });
  if (!("value" in result) || !result.value) {
    throw new Error(`fixture did not narrow: ${JSON.stringify(result)}`);
  }
  return result.value;
}

describe("the idle notice", () => {
  it("quotes the resolver's reason when the agent has not run", async () => {
    const { AgentIdleNotice } = await mountWith(
      status(false), "@/components/AgentIdleNotice",
    );
    render(<AgentIdleNotice />);
    const line = screen.getByTestId("agent-idle");
    expect(line.tagName).toBe("P");
    expect(line.textContent).toMatch(/absent by design/);
    // The sentence written by the code that made the decision, not a second one
    // composed here.
    expect(line.textContent).toMatch(/nothing due yet/);
  });

  it("says nothing when the agent ran, because then the artifacts answer", async () => {
    const { AgentIdleNotice } = await mountWith(
      status(true), "@/components/AgentIdleNotice",
    );
    const { container } = render(<AgentIdleNotice />);
    expect(container.textContent).toBe("");
  });

  it("says nothing when the status itself is unreadable", async () => {
    // A notice that cannot say WHY would be a shrug with a border. Every section
    // on the page already declares its own state.
    const { AgentIdleNotice } = await mountWith(
      null, "@/components/AgentIdleNotice",
    );
    const { container } = render(<AgentIdleNotice />);
    expect(container.textContent).toBe("");
  });
});
