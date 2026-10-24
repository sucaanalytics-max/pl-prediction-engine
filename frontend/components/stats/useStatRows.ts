"use client";

/**
 * One player per row, gathered from every artifact that mentions him.
 *
 * Shared by the desktop sheet and the phone sheet so the two cannot disagree about
 * who is on a row or where a figure came from. Moved verbatim out of `StatsTable`;
 * the only thing it adds is returning the artifacts, because both sheets state each
 * source's age and coverage from them.
 */

import { useMemo } from "react";

import { proven } from "@/lib/data/artifact";
import { PLAYER_EVENTS } from "@/lib/data/player-events";
import { projectionsDescriptor } from "@/lib/data/projections";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import type { StatRow } from "@/lib/projections/stat-questions";

export function useStatRows(gameweek: number | null, ownedIds: ReadonlySet<number>) {
  const { artifact: statsArtifact } = useArtifact(REGISTRY.playerStats);
  /* Hooks cannot be called conditionally, so the descriptor is still built when
     the gameweek is unknown — `enabled` stops the request going out. Fetching
     `xp_public_gw00.json` would 404 on every render, and a guaranteed console
     error is how a real one gets missed. */
  const weekUnknown = gameweek === null;
  const { artifact: projArtifact } = useArtifact(
    projectionsDescriptor(gameweek ?? 0), { enabled: !weekUnknown },
  );
  const { artifact: eventArtifact } = useArtifact(PLAYER_EVENTS);

  const stats = proven(statsArtifact);
  const projections = proven(projArtifact);
  const events = proven(eventArtifact);

  const rows = useMemo<StatRow[]>(() => {
    const byId = new Map<number, StatRow>();
    const put = (id: number, patch: Partial<StatRow>, base: Omit<StatRow, "elementId">) => {
      const existing = byId.get(id);
      byId.set(id, existing ? { ...existing, ...patch } : { elementId: id, ...base, ...patch });
    };
    for (const row of stats ?? []) {
      if (row.elementId === null) continue;
      put(row.elementId, { stats: row }, {
        name: row.name, team: row.team, position: row.position,
        owned: ownedIds.has(row.elementId), stats: row, projection: null, event: null,
      });
    }
    for (const row of projections?.players ?? []) {
      put(row.elementId, { projection: row }, {
        name: row.name ?? `#${row.elementId}`, team: row.team ?? "—",
        position: row.position ?? "—", owned: ownedIds.has(row.elementId),
        stats: null, projection: row, event: null,
      });
    }
    for (const row of events?.players ?? []) {
      put(row.elementId, { event: row }, {
        name: row.name ?? `#${row.elementId}`, team: row.team ?? "—",
        position: "—", owned: ownedIds.has(row.elementId),
        stats: null, projection: null, event: row,
      });
    }
    return [...byId.values()];
  }, [stats, projections, events, ownedIds]);

  return {
    rows, stats, projections, events,
    statsArtifact, projArtifact, eventArtifact, weekUnknown,
  };
}
