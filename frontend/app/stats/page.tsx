"use client";

/**
 * Stats — the detail behind a transfer, on players owned and not owned.
 *
 * ## Why this is not part of /players
 *
 * `/players` answers "who scores most over the next N weeks" — one question, one
 * grid, one number per cell. This answers "what is this player actually doing",
 * which is a dozen columns across three different sources with three different
 * warranties: what happened (FPL's own record), what is forecast (our simulation),
 * and what a second provider measured (Understat's shots and its own xG model).
 *
 * Putting them on one page would mean one table whose columns cannot be compared
 * with each other, which is the failure the tabs exist to prevent.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StatsTable } from "@/components/stats/StatsTable";
import { proven } from "@/lib/data/artifact";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { useHeuristics } from "@/lib/data/useHeuristics";

export default function StatsPage() {
  const gameweek = useCurrentGameweek();
  const { artifact } = useHeuristics();
  const live = proven(artifact);

  const ownedIds = new Set(
    (live?.squad?.players ?? [])
      .map((player) => player.elementId)
      .filter((id): id is number => typeof id === "number"),
  );

  return (
    <ErrorBoundary pageName="Stats">
      <div className="space-y-6">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Stats
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What players are actually doing — mine and everyone else&apos;s
          </p>
        </header>

        {/* No gameweek gate on the whole table. Season reads `player_stats.json`
            and Shots reads `player_events.json`; neither is keyed by week, so
            withholding them over an unresolved gameweek refuses two tabs' worth
            of data for a number they never use. `StatsTable` blocks the one tab
            that does need it — Expected — and says why on that tab. */}
        <StatsTable gameweek={gameweek} ownedIds={ownedIds} />

        {/* The blocked tabs are named by `StatsTable`'s own footer, directly under
            the struck-through tab a reader just tried to click. A duplicate list
            lived here too and said the same three things a second time; the
            footer is the one that is where the question gets asked. */}
      </div>
    </ErrorBoundary>
  );
}
