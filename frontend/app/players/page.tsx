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

import { useState, type ReactNode } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ResearchView } from "@/components/margin/ResearchView";
import { PlayersPhone } from "@/components/projections/PlayersPhone";
import { ProjectionGridSection } from "@/components/projections/ProjectionGridSection";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { useIsPhone } from "@/lib/phone";
import { SANS, SIGNAL } from "@/lib/margin/tokens";

/**
 * A closed section whose body is not even mounted until it is opened.
 *
 * On a phone the list is the page. The eight-week grid and the distribution tools
 * are still reachable, but they are 600 rows apiece, and mounting them behind a
 * closed disclosure would pay for them on every visit.
 */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      style={{ marginTop: 16, background: SIGNAL.bar, border: `1px solid ${SIGNAL.hair}`, fontFamily: SANS }}
    >
      <summary
        style={{
          minHeight: 44, display: "flex", alignItems: "center", padding: "0 12px",
          fontSize: 14, fontWeight: 600, color: SIGNAL.ink, cursor: "pointer",
        }}
      >
        {summary}
      </summary>
      {open ? <div style={{ padding: "0 0 12px", overflowX: "auto" }}>{children}</div> : null}
    </details>
  );
}

export default function PlayersPage() {
  const gameweek = useCurrentGameweek();
  const phone = useIsPhone();

  if (phone && gameweek !== null) {
    return (
      <ErrorBoundary pageName="Players">
        <PlayersPhone gameweek={gameweek} />
        <Disclosure summary="Eight-week projection grid">
          <ProjectionGridSection gameweek={gameweek} />
        </Disclosure>
        <Disclosure summary="Distributions, scatter and compare">
          <ResearchView gameweek={gameweek} />
        </Disclosure>
      </ErrorBoundary>
    );
  }

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
