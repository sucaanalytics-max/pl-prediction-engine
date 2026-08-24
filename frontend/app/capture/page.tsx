"use client";

/**
 * Record the position actually submitted to FPL, for the entry the agent decides
 * for.
 *
 * This posts to `/api/hub/position`, which commits the position to
 * `predictions/fpl/hub/capture/{entryId}.json` through GitHub's Contents API.
 * `pipeline/fpl/hub_state.py` reads it out of the agent's own checkout, so a
 * capture reaches the NEXT run rather than one already in flight — every half hour
 * inside a deadline window. There is no database here, and nothing to provision.
 *
 * One entry, and it is the owner's own team ({@link OWNER_ENTRY}). That is the
 * whole point of this screen: `_read_entry` reads a committed capture for it
 * BEFORE asking FPL live (`run_agent.py:1023`), so what is typed here is what the
 * agent plans from. This form used to offer the two bot entries instead — a list
 * left over from the deleted control room — which made the one surface that feeds
 * the agent unable to name the team the agent decides for.
 */

import { proven } from "@/lib/data/artifact";
import { REGISTRY, type MatchesFile, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { OWNER_ENTRY } from "@/lib/entry";
import { INK, SANS } from "@/lib/margin/tokens";
import CaptureForm, { type PickablePlayer } from "@/components/hub/CaptureForm";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const S = INK;

export default function CapturePage() {
  const { artifact } = useArtifact<readonly PlayerRow[]>(REGISTRY.playerStats);
  const { artifact: matches } = useArtifact<MatchesFile>(REGISTRY.matches);

  const rows = proven(artifact) ?? [];
  const players: PickablePlayer[] = rows.flatMap((row) =>
    row.elementId === null
      ? []
      : [{ elementId: row.elementId, name: row.name, team: row.team }]
  );
  const gameweek = proven(matches)?.gameweek ?? 1;

  return (
    <ErrorBoundary pageName="Capture">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: S.ink, fontFamily: "var(--font-display)" }}
          >
            Capture a position
          </h1>
          <p className="text-sm mt-1" style={{ color: S.ink2, font: `13px ${SANS}` }}>
            What you actually submitted, so the next proposal plans from it rather
            than from what FPL has published. Takes effect from the next agent run.
          </p>
        </header>

        {players.length === 0 ? (
          // Age, not absence: the reason is named, and the form is not offered in a
          // state where every line would fail to resolve.
          <p style={{ font: `13px ${SANS}`, color: S.ink2 }}>
            The player list is not readable, so names and ids cannot be checked
            against anything. Capturing now would record ids nothing had verified,
            so the form is withheld until it loads.
          </p>
        ) : (
          <CaptureForm players={players} entryId={OWNER_ENTRY} gameweek={gameweek} />
        )}

        <p style={{ font: `11px ${SANS}`, color: S.ink3, maxWidth: 620 }}>
          Purchase prices are not asked for. Without them the agent routes every
          player into the same &ldquo;selling price unknown&rdquo; path the FPL read
          already uses, so a sale is flagged as uncertain rather than priced
          confidently at today&rsquo;s cost.
        </p>
      </div>
    </ErrorBoundary>
  );
}
