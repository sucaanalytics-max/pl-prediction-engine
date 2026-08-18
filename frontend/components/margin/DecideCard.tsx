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
 * ## Absence renders nothing at all
 *
 * This used to print a `THE CALL · NOT PUBLISHED` line whenever the artifact was
 * absent — which is roughly ten days of every cycle, since the writing agent is
 * deadline-gated. Mounted at the top of `/margin`, that made the loudest element
 * on the owner's planning screen an alarm about a cron gate. Worse, the artifact
 * it named, `decision_public_gw{NN}_season.json`, is the plan for **Ronny**, an
 * automated entry (2561567, `pipeline/config.py`), not the owner's team (20945) —
 * so the banner was reporting the absence of a file about a team the app does not
 * display.
 *
 * So absence now renders nothing. A card that has no call to deliver is not a
 * state worth a line; the artifact's real state is still named once, lower on
 * whatever screen is reading it, by `MarginState`.
 *
 * Nothing currently mounts this component — `ScoreView` dropped it with the read
 * — and it is kept only because `/decide` remains the home of the argument it
 * summarises.
 */

import Link from "next/link";
import { proven, type Artifact } from "@/lib/data/artifact";
import type { PublicDecision } from "@/lib/data/narrow";
import { INK, MONO } from "@/lib/margin/tokens";

const S = INK;

/** A name for an element id, from whatever the caller could resolve. */
export type NameOf = (elementId: number) => string | null;

/** Named `nameFor`, not `label`: the `label` prop below would shadow it. */
function nameFor(id: number, nameOf?: NameOf): string {
  return nameOf?.(id) ?? `#${id}`;
}

export function DecideCard(
  { nameOf, of }: {
    /**
     * Which gameweek the caller is showing. Accepted, no longer read: it named
     * the week only in the absent banner, and that banner is gone.
     */
    gameweek?: number;
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

  // No call, or a call with no plan in it: render nothing rather than an alarm.
  // See the docstring — this file's absent state was a NOT PUBLISHED banner about
  // another team's artifact, mounted above the owner's own plan.
  if (!call || !call.plan) return null;

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
