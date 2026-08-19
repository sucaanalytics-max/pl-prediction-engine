"use client";

/**
 * Record the position actually submitted to FPL, for the entries the agent
 * decides for.
 *
 * A committed file cannot reach a run already in flight — the agent's job checks
 * out, installs dependencies, and only then runs — so this posts to
 * `/api/hub/position`, which writes to Supabase, and `pipeline/fpl/hub_state.py`
 * reads it over the network at decision time.
 *
 * Only the bot entries appear. The owner's own team is advisory: it never reaches
 * `_decide_for_entries`, so a capture for it would imply a proposal that never
 * arrives, and the route refuses one.
 */

import { proven } from "@/lib/data/artifact";
import { REGISTRY, type MatchesFile, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { TEAMS } from "@/lib/control-room/model";
import { INK, SANS } from "@/lib/margin/tokens";
import CaptureForm, { type PickablePlayer } from "@/components/hub/CaptureForm";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const S = INK;

const TARGETS = TEAMS.filter((team) => team.kind === "bot").map((team) => ({
  entryId: team.entryId,
  name: team.name,
}));

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
          <CaptureForm players={players} targets={TARGETS} gameweek={gameweek} />
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
