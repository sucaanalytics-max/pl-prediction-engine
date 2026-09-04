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
 *
 * ## Three sources, and only one of them may block the render
 *
 * The decision artifact carries the plan, `xp_public` carries both the decided
 * week's per-player xP and the later weeks' horizon, and `/api/fpl/state`
 * carries FPL's fixture list. The first two are published files; the third is a
 * live route that has returned 503 in production inside the last day.
 *
 * So the fixture list is passed as whatever it is, empty included, and never
 * gated on. A grid of numbers with every fixture reading "unknown" is the honest
 * degradation; withholding the plan because a fixture lookup failed would trade
 * the thing this screen is for against decoration on it.
 */

import { PlanGrid } from "@/components/margin/PlanGrid";
import { proven } from "@/lib/data/artifact";
import { decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";

export function PlanGridSection({ gameweek }: { gameweek: number }) {
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek));
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));
  const { artifact: live } = useHeuristics();

  const horizon = proven(decision)?.horizon ?? null;
  const players = proven(projections)?.players ?? [];
  // Off the SAME artifact as `players`, so the decided week's number and the
  // later weeks' numbers can never come from two different runs.
  const xpHorizon = proven(projections)?.horizon ?? null;
  const fixtures = proven(live)?.fixtureMatrix ?? [];

  if (horizon === null || players.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        No solved plan has been published for GW{gameweek}. The optimiser writes
        one when it decides, which is inside the seal window before the deadline.
      </p>
    );
  }

  return (
    <PlanGrid
      horizon={horizon}
      projections={players}
      fixtures={fixtures}
      xpHorizon={xpHorizon}
    />
  );
}
