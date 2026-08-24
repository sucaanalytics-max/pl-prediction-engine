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
import { blockedTabs } from "@/lib/projections/stat-tabs";

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

        {gameweek === null ? (
          // One line, the same rule every `useCurrentGameweek` surface follows: a
          // guessed gameweek would point the Expected tab at another week's file.
          <p className="text-xs" style={{ color: "var(--text-4)" }}>
            Neither the agent&apos;s status nor FPL&apos;s own state could be read, so
            the gameweek is unknown. The Season and Shots tabs do not depend on it,
            but Expected does, and guessing would read the wrong projection.
          </p>
        ) : (
          <StatsTable gameweek={gameweek} ownedIds={ownedIds} />
        )}

        <section>
          <h2
            className="text-xs mb-2"
            style={{
              color: "var(--text-3)", fontFamily: "var(--font-mono)",
              letterSpacing: ".14em", textTransform: "uppercase",
            }}
          >
            Tabs this app cannot fill yet
          </h2>
          <dl className="space-y-2">
            {blockedTabs().map((tab) => (
              <div key={tab.key} className="text-xs">
                <dt style={{ color: "var(--text-2)", fontWeight: 600 }}>{tab.label}</dt>
                <dd style={{ color: "var(--text-3)", margin: 0, lineHeight: 1.55 }}>
                  {tab.note} {tab.blockedBy}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </ErrorBoundary>
  );
}
