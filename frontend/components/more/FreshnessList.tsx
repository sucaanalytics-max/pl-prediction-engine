"use client";

/**
 * "Data freshness" — each artifact the app loads, and when its writer produced it.
 *
 * Read through the registry's own descriptors and `useArtifact`, so the time shown
 * is `Provenance.producedAt` (the file's own timestamp) and the judgement is the
 * descriptor's own `freshnessBudgetMs`. Nothing is computed from model output and
 * no field is invented: an artifact with no timestamp says so rather than showing
 * the fetch time, which would make a stale file look new.
 *
 * Times are UTC, as the heading says. The live FPL state is the one row that does
 * not come from `useArtifact`; it is the `/api/fpl/state` route read through
 * `useHeuristics`, which carries the same provenance.
 *
 * The state is a word as well as a shape. Fresh is the quiet case and gets no
 * word on screen; every other state names itself, so the dot is never the only
 * thing saying it.
 */

import { isStale, type Artifact } from "@/lib/data/artifact";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { REGISTRY, decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { formatUtc, freshnessOf, type Freshness } from "@/lib/freshness";
import type { Descriptor } from "@/lib/data/registry";
import { SIGNAL } from "@/lib/margin/tokens";

const WORD: Record<Freshness, string> = {
  fresh: "fresh",
  ageing: "ageing",
  stale: "stale",
  unstamped: "no timestamp",
  missing: "not readable",
};

const DOT: Record<Freshness, { background: string; ring: boolean }> = {
  fresh: { background: SIGNAL.agree, ring: false },
  ageing: { background: SIGNAL.noise, ring: false },
  stale: { background: SIGNAL.conflict, ring: false },
  unstamped: { background: "transparent", ring: true },
  missing: { background: "transparent", ring: true },
};

export function Row({ name, artifact }: { name: string; artifact: Artifact<unknown> }) {
  const { provenance } = artifact;
  const readable = artifact.state === "ok" || artifact.state === "empty" || artifact.state === "stale";
  const state = freshnessOf({
    readable,
    stale: isStale(artifact),
    producedAt: provenance.producedAt,
    ageMs: provenance.ageMs,
    budgetMs: provenance.freshnessBudgetMs,
  });
  const when = formatUtc(provenance.producedAt);
  const dot = DOT[state];
  return (
    <div
      data-testid="freshness-row"
      data-state={state}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 12, minHeight: 44, padding: "0 14px", background: SIGNAL.bar,
      }}
    >
      <dt style={{ fontSize: 14 }}>{name}</dt>
      <dd style={{
        margin: 0, display: "flex", alignItems: "center", gap: 6,
        fontSize: 13, color: SIGNAL.ink2,
      }}>
        <span
          aria-hidden="true"
          style={{
            width: 8, height: 8, flex: "none", boxSizing: "border-box",
            background: dot.background,
            border: dot.ring ? `1.5px solid ${SIGNAL.ink3}` : 0,
          }}
        />
        <span>{when ?? (readable ? "no timestamp" : "not readable")}</span>
        {state === "fresh" ? <span className="sr-only">, fresh</span> : null}
        {state !== "fresh" && !(state === "unstamped" && when === null) && !(state === "missing" && when === null)
          ? <span style={{ color: SIGNAL.ink3, fontSize: 12 }}>· {WORD[state]}</span>
          : null}
      </dd>
    </div>
  );
}

function ArtifactRow<T>({ name, descriptor }: { name: string; descriptor: Descriptor<T> }) {
  const { artifact } = useArtifact(descriptor);
  return <Row name={name} artifact={artifact} />;
}

/** Only mounted once the gameweek is known: the week is part of the file's path. */
function GameweekRows({ gameweek }: { gameweek: number }) {
  return (
    <>
      <ArtifactRow name={`GW${gameweek} decision`} descriptor={decisionDescriptor(gameweek)} />
      <ArtifactRow name={`GW${gameweek} projections`} descriptor={projectionsDescriptor(gameweek)} />
    </>
  );
}

export function FreshnessList() {
  const gameweek = useCurrentGameweek();
  const { artifact: live } = useHeuristics();
  return (
    <dl style={{
      margin: 0, display: "flex", flexDirection: "column", gap: 1,
      background: SIGNAL.hair, border: `1px solid ${SIGNAL.hair}`,
    }}>
      <Row name="FPL live state" artifact={live} />
      <ArtifactRow name="Agent status" descriptor={AGENT_STATUS} />
      {gameweek === null ? null : <GameweekRows gameweek={gameweek} />}
      <ArtifactRow name="Player stats" descriptor={REGISTRY.playerStats} />
      <ArtifactRow name="Team metrics" descriptor={REGISTRY.teamMetrics} />
      <ArtifactRow name="Agent messages" descriptor={REGISTRY.messages} />
      <ArtifactRow name="Manager history" descriptor={REGISTRY.managerHistory} />
    </dl>
  );
}
