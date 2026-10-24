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
 * ## The countdown is this component's, and only derived
 *
 * The strip carries "7d 3h left". It is computed here from the SAME `deadline`
 * string the date beside it prints, against the device clock, once a minute — it
 * is never the stamped `secondsToDeadline`, which is the frozen duration that
 * disagreed with a live one last time. Two numbers over one instant came from two
 * sources then; here the date and the countdown share one source, in one
 * component, so they cannot drift apart. Before mount there is no `now`, so the
 * server render and the first client render both omit it and nothing mismatches.
 *
 * ## Where the time comes from
 *
 * `agent_status.deadline`, which the phase resolver writes and republishes every
 * three hours whether or not the agent ran — so it is present during the ~10 days
 * per cycle when every agent-owned artifact is absent. It is NOT recomputed here:
 * this component holds no timer and no client-clock arithmetic, which is what keeps
 * it from becoming the second clock itself.
 */

import { useEffect, useState } from "react";

import { proven } from "@/lib/data/artifact";
import { AGENT_STATUS, type AgentStatus } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { compactIstDeadline } from "@/lib/formats";

/** One line, in the register the rest of this page uses for absence. */
function Unknown({ why }: { why: string }) {
  return (
    <p
      className="text-xs"
      style={{ color: "var(--text-3)" }}
      data-testid="deadline-unknown"
    >
      {why}
    </p>
  );
}

/** "7d 3h left", "3h 12m left", "42m left", or "Deadline passed". */
export function countdownLabel(deadlineMs: number, nowMs: number): string {
  const ms = deadlineMs - nowMs;
  if (ms <= 0) return "Deadline passed";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  return `${Math.max(minutes, 1)}m left`;
}

/** Null until mounted, then the device time, refreshed each minute. */
function useNowMs(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function DeadlineClock() {
  const nowMs = useNowMs();
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

  const left = nowMs === null ? null : countdownLabel(parsed.getTime(), nowMs);

  return (
    <section aria-label="Deadline" className="deadline-clock" data-testid="deadline-clock">
      <div>
        <span
          className="block text-xs uppercase font-semibold"
          style={{ color: "var(--text-3)", letterSpacing: ".08em" }}
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
      {left === null ? null : (
        <span
          data-testid="deadline-countdown"
          style={{
            padding: "6px 10px", background: "var(--brand)", color: "var(--surface)",
            fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
          }}
        >
          {left}
        </span>
      )}
    </section>
  );
}
