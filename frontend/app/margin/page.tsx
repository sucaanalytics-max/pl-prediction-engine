"use client";

/**
 * Margin — one workspace, four views, and no number that was not published.
 *
 * ## What this screen is
 *
 * The decision surface as a single workspace rather than as nine routes. Plan is
 * the grid you edit and the call above it, Players is every player as a
 * distribution with a compare panel, News is what was written this week, and Now
 * is what has decayed since the last solve. They share a bar, a clock and a
 * mode, and they switch with `1`–`4` in that order.
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
 * - the XI's quantile strip — listed here for a long time as undrawable, on the
 *   strength of a narrower reading field names no producer writes. The
 *   simulation publishes the squad total's distribution and always did; the
 *   reads were pointed at it, and the strip is backed (`DecideView`, reached
 *   from the call card at `/decide` rather than from a tab here);
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

import { useCallback, useEffect, useState } from "react";
import { proven } from "@/lib/data/artifact";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  Shell, useViewKeys, VIEW_ALIASES, VIEWS, type MarginView,
} from "@/components/margin/Shell";
import { ScoreView } from "@/components/margin/ScoreView";
import { ResearchView } from "@/components/margin/ResearchView";
import { WatchView } from "@/components/margin/WatchView";
import { NewsView } from "@/components/margin/NewsView";

export default function MarginPage() {
  const [view, setView] = useState<MarginView>("plan");

  /**
   * `?view=plan` opens on that tab, and the URL follows the tabs.
   *
   * Four views behind one path means "look at the Plan tab" is not a link
   * anyone can send, and a workspace you cannot point at loses arguments it
   * should win. Read in an effect rather than in the initial state so the server
   * render and the first client render agree — reading `location.search` during
   * render hydrates with a mismatch on every deep link.
   *
   * The alias pass keeps every link that was sent before the rename working:
   * `?view=score` was the planner and is now Plan. Without it those URLs would
   * fall through to the default and land somewhere plausible, which is the worst
   * outcome — a link that opens the wrong tab and looks like it worked.
   */
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("view");
    if (!wanted) return;
    if ((VIEWS as readonly string[]).includes(wanted)) {
      setView(wanted as MarginView);
    } else if (Object.hasOwn(VIEW_ALIASES, wanted)) {
      // `hasOwn`, not `in`: `in` walks Object.prototype, so `?view=toString`
      // resolved to a function, React 18 took it for a state updater, and the
      // page rendered the bar with no panel under it, four tabs all
      // aria-selected="false" and not one role="status" — the blank screen
      // rule 1 exists to prevent. `?view=nonsense` was always fine; only the
      // inherited keys reached setView.
      setView(VIEW_ALIASES[wanted]);
    }
  }, []);

  // `useCallback` so the key listener is bound once rather than re-bound on
  // every keystroke into the research table's search box.
  //
  // `replaceState`, not a router push: this is the same screen with a different
  // pane, and a history entry per tab makes Back undo something the reader
  // never did.
  const select = useCallback((next: MarginView) => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState(null, "", url);
  }, []);
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
        {view === "plan" ? <ScoreView gameweek={gameweek} /> : null}
        {view === "players" ? <ResearchView gameweek={gameweek} /> : null}
        {view === "news" ? <NewsView /> : null}
        {view === "now" ? <WatchView gameweek={gameweek} /> : null}
      </Shell>
    </ErrorBoundary>
  );
}
