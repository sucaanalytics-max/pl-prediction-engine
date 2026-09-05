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
import { heldSquadHorizon } from "@/lib/margin/plan";
import { useMemo } from "react";

import { proven } from "@/lib/data/artifact";
import { REGISTRY, decisionDescriptor, type PlayerRow } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";

export function PlanGridSection({ gameweek }: { gameweek: number }) {
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek));
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));
  const { artifact: live } = useHeuristics();
  const { artifact: playerRows } = useArtifact<readonly PlayerRow[]>(REGISTRY.playerStats);

  const horizon = proven(decision)?.horizon ?? null;
  const players = proven(projections)?.players ?? [];
  // Off the SAME artifact as `players`, so the decided week's number and the
  // later weeks' numbers can never come from two different runs.
  const xpHorizon = proven(projections)?.horizon ?? null;
  const fixtures = proven(live)?.fixtureMatrix ?? [];
  // A fourth read, and the cheapest of them — `playerStats` is already fetched
  // by /capture. It only prices the transfer section; a miss renders no price
  // rather than a zero, so this never gates the grid.
  const prices = useMemo(() => {
    const byId = new Map<number, number | null>();
    for (const row of proven(playerRows) ?? []) {
      if (row.elementId !== null) byId.set(row.elementId, row.fpl_price);
    }
    return byId;
  }, [playerRows]);
  // Absent means sealed — see the narrower. Most solves are provisional now
  // that the agent decides on every refresh, and the grid says which it has.
  const sealed = proven(decision)?.sealed ?? true;
  const solvedAt = proven(decision)?.generated_at ?? null;

  // The fallback that makes this permanent. `decision_public_gwNN` exists only
  // once the agent has solved, which is never true before a gameweek's first
  // solve — so this section used to replace itself with a sentence, and a
  // dashboard section that disappears when the optimiser has not run is not a
  // section. The squad and the xP horizon are always published; the grid draws
  // from those and claims nothing the solve would have decided.
  const held = useMemo(() => {
    const ids = (proven(live)?.squad?.players ?? [])
      .map((p) => p.elementId)
      .filter((id): id is number => typeof id === "number");
    const gameweeks = (xpHorizon?.weeks ?? []).map((w) => w.gameweek);
    if (ids.length === 0 || gameweeks.length === 0) return null;
    // The decided week first: the horizon block deliberately omits it, and a grid
    // that started at GW+1 would hide the week the reader is actually setting.
    return heldSquadHorizon(ids, [gameweek, ...gameweeks]);
  }, [live, xpHorizon, gameweek]);

  const drawn = horizon ?? held;

  if (drawn === null || players.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        Neither a solved plan nor a squad could be read for GW{gameweek}, so
        there is nothing to draw the horizon from. The agent solves on every
        refresh, and the squad comes from FPL&apos;s own picks — this fills in
        when either is readable.
      </p>
    );
  }

  return (
    <PlanGrid
      horizon={drawn}
      projections={players}
      fixtures={fixtures}
      xpHorizon={xpHorizon}
      sealed={sealed}
      solvedAt={solvedAt}
      prices={prices}
    />
  );
}
