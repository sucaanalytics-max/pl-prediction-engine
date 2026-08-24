"use client";

/**
 * Players — who could I bring in, and how wide is the spread on him.
 *
 * ## What this replaces
 *
 * 763 lines that carried three panels answering the same question three ways: a
 * "Projections" table, a "Ranked players" list that duplicated the transfer
 * shortlist, and "Season statistics" built on player_stats.json's per-90 trap.
 *
 * `ResearchView` is the only surface in the app that reads `xp_public` end to end
 * with its quantiles, which is the reason this route survives the cut at all. It
 * was reachable only from `/margin`, a route now deleted.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ResearchView } from "@/components/margin/ResearchView";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function PlayersPage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="Players">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Players
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Who could I bring in, and how wide is the spread on him
          </p>
        </header>

        {gameweek === null ? (
          // One line, not a panel. There is no substance on this page to be
          // outweighed, but the rule is the rule.
          <p className="text-xs" style={{ color: "var(--text-4)" }}>
            Neither the agent&apos;s status nor FPL&apos;s own state could be read,
            so the gameweek is unknown. Guessing one would read a different
            gameweek&apos;s projection.
          </p>
        ) : (
          <ResearchView gameweek={gameweek} />
        )}
      </div>
    </ErrorBoundary>
  );
}
