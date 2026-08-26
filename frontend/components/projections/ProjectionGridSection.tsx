"use client";

/**
 * The grid, wired to the two artifacts it needs.
 *
 * Separate from {@link HeatGrid} so that the grid itself takes plain data and can
 * be tested without a fetch, and so the two failure modes are stated in one
 * place: no projection for this gameweek, and no fixture list.
 *
 * They fail differently on purpose. Without a projection there is nothing to draw
 * and the section says so. Without the fixture list the numbers are all still
 * true — only the labels above them are missing — so the grid renders and says
 * the labels are absent, rather than withholding a projection over a caption.
 */

import { proven } from "@/lib/data/artifact";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { FLOODLIT, MONO } from "@/lib/margin/tokens";
import { HeatGrid } from "@/components/projections/HeatGrid";

const S = FLOODLIT;

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontFamily: MONO, fontSize: 11, color: S.ink3, margin: "8px 0 0" }}>
      {children}
    </p>
  );
}

export function ProjectionGridSection({ gameweek }: { gameweek: number }) {
  const { artifact } = useArtifact(projectionsDescriptor(gameweek));
  const { artifact: liveArtifact } = useHeuristics();

  const projections = proven(artifact);
  const live = proven(liveArtifact);

  if (projections === null) {
    return (
      <section>
        {/* The artifact's own reason, not a rewritten one: `absent`,
            `unreadable` and `empty` are different facts and the envelope already
            phrases each of them fit to render. */}
        <Note>
          No grid for GW{gameweek}: {artifact.reason ?? "the projection could not be read."}
        </Note>
      </section>
    );
  }

  // The squad is what "my squad" filters to. An unread squad means the filter has
  // nothing to select, and the control is left enabled and empty rather than
  // hidden — a hidden control looks like a missing feature.
  const ownedIds = new Set(
    (live?.squad?.players ?? [])
      .map((player) => player.elementId)
      .filter((id): id is number => typeof id === "number"),
  );

  const fixtures = live?.fixtureMatrix ?? [];

  return (
    <section>
      <HeatGrid
        players={projections.players}
        horizon={projections.horizon}
        currentGameweek={projections.gameweek ?? gameweek}
        fixtures={fixtures}
        ownedIds={ownedIds}
        nDraws={projections.nDraws}
      />
      {fixtures.length === 0 ? (
        <Note>
          FPL&apos;s fixture list could not be read, so the cells carry projections
          without the opponent above them. The numbers are unaffected.
        </Note>
      ) : null}
      {projections.horizon === null ? (
        <Note>
          This run solved no horizon, so the grid is the current gameweek alone. The
          span control has nothing further to total.
        </Note>
      ) : null}
    </section>
  );
}
