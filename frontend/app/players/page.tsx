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
 *
 * ## Why the nav says Projections and the URL says /players
 *
 * The grid is now the page: players across the next eight gameweeks, which is the
 * screen the redesign was benchmarked against, and "Projections" is what it is.
 * The URL is not the label, and renaming a route means a redirect or a 410 plus
 * the allow-list churn that goes with it — a cost with no reader on the other end.
 * If this page is ever split, the grid takes the new URL and this one 410s.
 *
 * `ResearchView` stays below the grid rather than being replaced by it: the grid
 * answers "who scores most over N weeks" and the quantiles answer "how wide is
 * the spread on him", and the second question is the one that decides whether a
 * one-point difference in the first is worth a transfer.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ResearchView } from "@/components/margin/ResearchView";
import { ProjectionGridSection } from "@/components/projections/ProjectionGridSection";
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
            Projections
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Who scores most over the next few gameweeks, and how wide the spread is
          </p>
        </header>

        {gameweek === null ? (
          // One line, not a panel. There is no substance on this page to be
          // outweighed, but the rule is the rule.
          <p className="text-xs" style={{ color: "var(--text-3)" }}>
            Neither the agent&apos;s status nor FPL&apos;s own state could be read,
            so the gameweek is unknown. Guessing one would read a different
            gameweek&apos;s projection.
          </p>
        ) : (
          <>
            <ProjectionGridSection gameweek={gameweek} />
            <ResearchView gameweek={gameweek} />
          </>
        )}
      </div>
    </ErrorBoundary>
  );
}
