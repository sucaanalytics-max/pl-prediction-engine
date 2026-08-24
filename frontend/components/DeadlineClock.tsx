"use client";

/**
 * One clock, on the screen the deadline constrains.
 *
 * ## Why this file exists at all
 *
 * The app spent a week with NO deadline anywhere. Two clocks used to run: Margin's
 * countdown and a second one in the sidebar chrome. The route cut deleted `/margin`,
 * and the sidebar's was removed in the same commit as "the second deadline clock" —
 * a description that was true when it was written and false by the time it was
 * applied. Net: zero clocks on a planner whose entire purpose is deciding before a
 * deadline, and `compactIstDeadline` left with no caller at all.
 *
 * ## Why exactly one, and why here
 *
 * The two-clock arrangement is what the surviving rule in `lib/margin/mode.ts` was
 * written against: `schedule.py` stamps a duration into `reason` when the agent runs,
 * and a countdown recomputed on every tick sat beside it, so hours later the screen
 * showed a frozen "71.0h" next to a live "2d 23h" — two clocks for one deadline, one
 * of them wrong. Two clocks with independent staleness budgets can disagree on a
 * Friday, which is the day it matters. So this renders once, on `/`, beside the
 * decision it constrains. `app/page.test.tsx` asserts the count, not just the
 * presence.
 *
 * ## Where the time comes from
 *
 * `agent_status.deadline`, which the phase resolver writes and republishes every
 * three hours whether or not the agent ran — so it is present during the ~10 days
 * per cycle when every agent-owned artifact is absent. It is NOT recomputed here:
 * this component holds no timer and no client-clock arithmetic, which is what keeps
 * it from becoming the second clock itself.
 */

import { proven } from "@/lib/data/artifact";
import { AGENT_STATUS, type AgentStatus } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { compactIstDeadline } from "@/lib/formats";

/** One line, in the register the rest of this page uses for absence. */
function Unknown({ why }: { why: string }) {
  return (
    <p
      className="text-xs"
      style={{ color: "var(--text-4)" }}
      data-testid="deadline-unknown"
    >
      {why}
    </p>
  );
}

export function DeadlineClock() {
  const { artifact } = useArtifact<AgentStatus>(AGENT_STATUS);
  const status = proven(artifact);

  if (status === null) {
    return (
      <Unknown why="The agent&rsquo;s status could not be read, so this gameweek&rsquo;s deadline is unknown." />
    );
  }

  const deadline = status.deadline;
  const parsed = deadline === null ? null : new Date(deadline);
  if (deadline === null || parsed === null || Number.isNaN(parsed.getTime())) {
    // Absence is this component's decision to state, not the formatter's to paper
    // over. `compactIstDeadline` used to answer a hardcoded "Fri 21 Aug · 23:00 IST"
    // when handed nothing; it now requires a string and returns an unparseable one
    // unchanged, so the only way to show a date here is to have been given one.
    return (
      <Unknown why="The agent&rsquo;s status carries no deadline yet, so there is none to show." />
    );
  }

  return (
    <div className="text-right" data-testid="deadline-clock">
      <span
        className="block text-xs uppercase"
        style={{ color: "var(--text-4)", letterSpacing: ".08em" }}
      >
        {status.gameweek === null ? "Next deadline" : `GW${status.gameweek} deadline`}
      </span>
      <strong
        className="block text-sm mt-0.5"
        style={{ color: "var(--text-1)", fontFamily: "var(--font-mono)" }}
      >
        {compactIstDeadline(deadline)}
      </strong>
    </div>
  );
}
