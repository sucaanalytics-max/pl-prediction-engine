"use client";

/**
 * The solved plan, week by week.
 *
 * `PlanGrid` reads the **decision** artifact's horizon — `{evalHorizon,
 * transferHorizon, weeks}` where each week carries squad, xi, captain and vice —
 * which is a different type from the per-player xP horizon `Planner` consumes off
 * `xp_public`. Both are called `Horizon`; crossing them is a type error, which is
 * the only reason it has not happened yet.
 *
 * It had no importer anywhere in the tree: 295 lines and a 170-line test,
 * rendering the players x gameweeks view this dashboard exists to show, mounted
 * nowhere. This is the mount.
 */

import { PlanGrid } from "@/components/margin/PlanGrid";
import { proven } from "@/lib/data/artifact";
import { decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";

export function PlanGridSection({ gameweek }: { gameweek: number }) {
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek));
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));

  const horizon = proven(decision)?.horizon ?? null;
  const players = proven(projections)?.players ?? [];

  if (horizon === null || players.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        No solved plan has been published for GW{gameweek}. The optimiser writes
        one when it decides, which is inside the seal window before the deadline.
      </p>
    );
  }

  return <PlanGrid horizon={horizon} projections={players} />;
}
