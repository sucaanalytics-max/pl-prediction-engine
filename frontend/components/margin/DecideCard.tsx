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
import { proven, type Artifact } from "@/lib/data/artifact";
import type { PublicDecision } from "@/lib/data/narrow";
import { INK, MONO } from "@/lib/margin/tokens";
import { MarginState } from "@/components/margin/Marks";

const S = INK;

/** A name for an element id, from whatever the caller could resolve. */
export type NameOf = (elementId: number) => string | null;

/** Named `nameFor`, not `label`: the `label` prop below would shadow it. */
function nameFor(id: number, nameOf?: NameOf): string {
  return nameOf?.(id) ?? `#${id}`;
}

export function DecideCard(
  { gameweek, nameOf, of }: {
    gameweek: number;
    nameOf?: NameOf;
    /**
     * The decision the planner below is already reading.
     *
     * Passed in rather than fetched again: this card mounts inside `ScoreView`,
     * which holds the same artifact, and fetching it here put two requests for
     * the same URL 3ms apart — measured as a pair of 404s in the console on
     * every load. Sharing it also makes the guarantee real rather than
     * conventional: the card and the grid cannot describe two different solves,
     * because there is only one read.
     */
    of: Artifact<PublicDecision>;
  },
) {
  const call = proven(of);

  const frame = {
    display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" as const,
    padding: "10px 12px", border: `1px solid ${S.hair}`, background: S.bar,
    fontFamily: MONO, fontSize: 11.5,
  };

  if (!call || !call.plan) {
    /**
     * Four different no-value states, and they are not the same fact.
     *
     * This used to print "not solved for GW{n} yet — the engine runs on the
     * deadline" for absent, stale, unreadable, empty AND the pre-fetch state,
     * discarding `of.reason` entirely. A Supabase 500 was reported as a
     * scheduling fact, and a solve that merely failed to narrow was reported as
     * an idle engine — while ScoreView, lower on the same page, printed the
     * true reason. A page contradicting itself is worse than a page saying
     * nothing.
     *
     * `MarginState` already names each state and carries the reason, so this
     * defers to it rather than keeping a second vocabulary. `plan === null` on
     * an otherwise-ok artifact is its own case: the decision was published and
     * carries no plan, which no state label covers.
     */
    return (
      <div data-testid="decide-card" data-state={of.state}
           style={{ ...frame, color: S.ink }}>
        <span style={{ letterSpacing: ".08em", textTransform: "uppercase",
                       fontSize: 10, opacity: .55 }}>
          the call
        </span>
        {call && !call.plan ? (
          <span style={{ opacity: .7 }}>
            published for GW{gameweek} with no plan in it
          </span>
        ) : (
          <MarginState of={of} what={`the call for GW${gameweek} —`} surface={S} compact />
        )}
        <Link href="/decide" style={{ marginLeft: "auto", color: "inherit", opacity: .6 }}>
          why →
        </Link>
      </div>
    );
  }

  const { plan } = call;
  /**
   * Two lists, never arrowed pairs.
   *
   * `milp.py` publishes `sorted(transfers_in)` and `sorted(transfers_out)`
   * independently by element id, so the artifact records no pairing at all.
   * Zipping them by index printed one the engine never proposed — with two
   * transfers it read "Saka → Watkins, Haaland → Palmer" where the plan meant
   * "Saka → Palmer, Haaland → Watkins", a MID→FWD swap that is not even a legal
   * transfer. `DecideView.moveLine` has always rendered it as two lists; this is
   * the same, with names.
   *
   * The gate is on both arrays, not just `transfers_out`. On an opening build —
   * fifteen buys and no sells — the old test read `transfers_out.length === 0`
   * and rendered "roll the transfer" over a plan that bought a whole squad.
   */
  const outs = plan.transfers_out;
  const ins = plan.transfers_in;
  const named = (ids: readonly number[]) =>
    ids.map((id) => nameFor(id, nameOf)).join(", ");
  const move = outs.length === 0 && ins.length === 0
    ? "roll the transfer"
    : [
        outs.length ? `out ${named(outs)}` : null,
        ins.length ? `in ${named(ins)}` : null,
      ].filter(Boolean).join(" · ");

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
