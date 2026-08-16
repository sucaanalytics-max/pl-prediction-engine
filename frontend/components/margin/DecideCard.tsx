"use client";

/**
 * The call, in one line, above the plan it applies to.
 *
 * ## Why this replaced a tab
 *
 * `DecideView` is 874 lines over five panels, two of which are absent for most of
 * a gameweek cycle by design, and it held the first tab and the default view. It
 * is not badly built — it is built to *justify* a decision, which is a different
 * job from delivering one, and it was answering the second question with the
 * first one's screen.
 *
 * So the answer moves here, to the top of the plan it changes: the move, the
 * captain, the cost, and whether the margin is credible. The argument is still
 * written and still reachable at `/decide`; it is a drill-down now rather than
 * the thing you land on.
 *
 * ## Absence is the normal state, not an error
 *
 * The agent is deadline-gated and idle for roughly ten days of every cycle, so
 * `decision_public_gw{NN}_{label}.json` is absent far more often than not. The
 * card says which artifact is missing and why in one line, and takes one line to
 * do it — the whole point of demoting the screen was to stop absence occupying
 * the top of the page.
 */

import Link from "next/link";
import { proven } from "@/lib/data/artifact";
import {
  decisionDescriptor, type EntryLabel, type PublicDecision,
} from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { INK, MONO } from "@/lib/margin/tokens";

const S = INK;

/** A name for an element id, from whatever the caller could resolve. */
export type NameOf = (elementId: number) => string | null;

/** Named `nameFor`, not `label`: the `label` prop below would shadow it. */
function nameFor(id: number, nameOf?: NameOf): string {
  return nameOf?.(id) ?? `#${id}`;
}

export function DecideCard(
  { gameweek, nameOf, label = "season" }:
    { gameweek: number; nameOf?: NameOf; label?: EntryLabel },
) {
  // Same label the planner reads, so the card and the grid below it can never
  // describe two different solves of the same gameweek.
  const { artifact } = useArtifact<PublicDecision>(decisionDescriptor(gameweek, label));
  const call = proven(artifact);

  const frame = {
    display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" as const,
    padding: "10px 12px", border: `1px solid ${S.hair}`, background: S.bar,
    fontFamily: MONO, fontSize: 11.5,
  };

  if (!call || !call.plan) {
    return (
      <div data-testid="decide-card" style={{ ...frame, color: S.ink, opacity: .55 }}>
        <span style={{ letterSpacing: ".08em", textTransform: "uppercase", fontSize: 10 }}>
          the call
        </span>
        <span>
          not solved for GW{gameweek} yet — the engine runs on the deadline
        </span>
        <Link href="/decide" style={{ marginLeft: "auto", color: "inherit" }}>
          why →
        </Link>
      </div>
    );
  }

  const { plan } = call;
  const moves = plan.transfers_out.length;
  const move = moves === 0
    ? "roll the transfer"
    : plan.transfers_out
        .map((out, i) => {
          const inId = plan.transfers_in[i];
          return `${nameFor(out, nameOf)} → ${inId === undefined ? "?" : nameFor(inId, nameOf)}`;
        })
        .join(", ");

  return (
    <div
      data-testid="decide-card"
      style={{
        ...frame,
        borderLeft: `2px solid ${call.credible_margin ? S.agree : S.noise}`,
      }}
    >
      <span style={{ letterSpacing: ".08em", textTransform: "uppercase", fontSize: 10,
                     color: S.ink, opacity: .55 }}>
        the call
      </span>
      <span style={{ color: S.ink }}>{move}</span>
      {plan.captain !== null ? (
        <span style={{ color: S.ink, opacity: .8 }}>
          (C) {nameFor(plan.captain, nameOf)}
        </span>
      ) : null}
      {plan.hits > 0 ? (
        <span style={{ color: S.conflict }}>−{plan.hits * 4} pts</span>
      ) : null}
      {call.mean_points !== null ? (
        <span style={{ color: S.ink, opacity: .8 }}>
          {call.mean_points.toFixed(1)} projected
        </span>
      ) : null}
      {/* The margin's credibility is the one thing that decides whether to act on
          a thin gap, so it is stated rather than left to the colour alone. */}
      <span style={{ color: call.credible_margin ? S.agree : S.noise }}>
        {call.credible_margin ? "credible margin" : "margin inside the noise"}
      </span>
      <Link href="/decide" style={{ marginLeft: "auto", color: S.ink, opacity: .6 }}>
        the argument →
      </Link>
    </div>
  );
}
