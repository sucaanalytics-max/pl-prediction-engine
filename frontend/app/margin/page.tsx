"use client";

/**
 * Margin — one workspace, four views, and no number that was not published.
 *
 * ## What this screen is
 *
 * The decision surface as a single workspace rather than as nine routes. Decide
 * is the answer, Score is the horizon, Research is every player as a
 * distribution, and Watch is what has decayed since the last solve. They share a
 * bar, a clock and a mode, and they switch with `1`–`4`.
 *
 * ## The rule this implementation is built around
 *
 * The design it comes from is a prototype, and a prototype's numbers are written
 * by hand: 59.6 ±15.6, `P(≥60) 47.9%`, an eight-week grid of starts and sales,
 * a runner-up list with margins. Shipping those as they stand would reproduce
 * `lib/fpl-portal.ts` — 205 lines of hand-typed fake data that fed four sections
 * of the old homepage and were deleted for exactly this reason.
 *
 * So every value on this screen comes from a published artifact through
 * `useArtifact`, and every panel whose artifact is absent says which artifact,
 * and why, in Margin's own marks rather than the app's cards. Three things the
 * design draws are therefore **not** drawn here, each for a stated reason:
 *
 * - the XI's quantile strip — `PublicDecision` publishes a mean and no interval,
 *   and a squad total's spread is not the sum of its players' because clean
 *   sheets are drawn jointly (`DecideView`);
 * - the eight-week grid of starts, benchings and sales — nothing solves a
 *   horizon, and a grid assembled from per-week projections would carry a
 *   solver's authority without a solve (`ScoreView`);
 * - the interquartile box inside each distribution glyph — the producer
 *   publishes q10, q50 and q90, and the design derives q25 and q75 from the
 *   standard deviation (`lib/margin/distribution.ts`).
 *
 * ## Which gameweek
 *
 * `agent_status.json` is the primary source: it is written by the phase
 * resolver, which always runs, so it has an answer even when the agent has not.
 * The live route's `event.id` is the fallback, and 1 is the last resort — the
 * same choice `SquadBoard` makes, and for the same reason. A wrong gameweek
 * renders `absent`, which is honest; not asking renders nothing on the one week
 * it matters.
 */

import { useCallback, useState } from "react";
import { proven } from "@/lib/data/artifact";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Shell, useViewKeys, type MarginView } from "@/components/margin/Shell";
import { DecideView } from "@/components/margin/DecideView";
import { ScoreView } from "@/components/margin/ScoreView";
import { ResearchView } from "@/components/margin/ResearchView";
import { WatchView } from "@/components/margin/WatchView";

export default function MarginPage() {
  const [view, setView] = useState<MarginView>("decide");
  // `useCallback` so the key listener is bound once rather than re-bound on
  // every keystroke into the research table's search box.
  const select = useCallback((next: MarginView) => setView(next), []);
  useViewKeys(select);

  const { artifact: status } = useArtifact(AGENT_STATUS);
  const { artifact: heuristics } = useHeuristics();
  const gameweek =
    proven(status)?.gameweek
    ?? proven(heuristics)?.event.id
    ?? 1;

  return (
    <ErrorBoundary pageName="Margin">
      <Shell view={view} onView={select} status={status}>
        {view === "decide" ? <DecideView gameweek={gameweek} status={status} /> : null}
        {view === "score" ? <ScoreView gameweek={gameweek} /> : null}
        {view === "research" ? <ResearchView gameweek={gameweek} /> : null}
        {view === "watch" ? <WatchView gameweek={gameweek} /> : null}
      </Shell>
    </ErrorBoundary>
  );
}
