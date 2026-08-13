"use client";

import { useMemo } from "react";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";
import { projectionsDescriptor, type Projection } from "@/lib/data/projections";
import { MINUTES_CONFLICTS } from "@/lib/data/minutes-conflicts";
import { StateCard } from "@/components/data/Artifact";
import type { SquadPlayer } from "@/lib/data/heuristics";

/**
 * The gameweek call, computed from OUR model rather than a competitor's CSV.
 *
 * ## Why this exists
 *
 * Measured on the live app on 2026-08-13, `/now` opened with:
 *
 *     Transfer  F.Kadıoğlu → Gabriel   +7.5 pts over 4 GW · confidence 82
 *     Captain   B.Fernandes  HUL (A) · 14.2 proj · vice Semenyo
 *     source: fplreview-2026-08-04
 *
 * Every part of that disagreed with this repository's own projection.
 * F.Kadıoğlu is **3.9 xP**, the second-best defender in the squad — the heuristic
 * was recommending selling the player the model most wants on the pitch. The
 * captain's "14.2 proj" is not a number `xp_public_gw01.json` contains for anyone.
 * And the whole thing was driven by a **paid competitor's CSV dated 4 August**,
 * which the project plan already flags for deletion: "the site's headline
 * projections are currently a paid competitor's numbers".
 *
 * So the app's most prominent advice was the one thing on it least connected to
 * the model it exists to expose.
 *
 * ## What this computes, and what it refuses to
 *
 * Only three things, each a direct consequence of the published projection:
 *
 *  1. **The best XI available from the fifteen**, under FPL's formation rules,
 *     and what swapping to it is worth.
 *  2. **The captain**, which is just the highest xP in the XI.
 *  3. **Which of those players the evidence disagrees with**, from
 *     `minutes_conflicts`, so a recommendation built on a suspect projection says
 *     so instead of hiding it.
 *
 * It does NOT suggest transfers. A transfer needs a price model, a sell-value
 * model and a view of future gameweeks; the model publishes one gameweek. Offering
 * one anyway is how the heuristic ended up recommending the sale of a 3.9 xP
 * defender. The honest surface for a single-gameweek projection is the team you
 * already own.
 */

const ORDER: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

/** Lowercase, strip accents, and fold Turkish dotless ı, which does not decompose. */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i").toLowerCase().trim();
}

interface Rated extends SquadPlayer {
  readonly xp: number | null;
  readonly eMinutes: number | null;
}

/**
 * Join the squad to the projection on name and position.
 *
 * Not club: `SquadPlayer.team` is FPL's short code (`LIV`) and the projection
 * carries the full name (`Liverpool`), so a club comparison matches nothing —
 * measured. Ambiguity is refused rather than guessed, since FPL has six Wilsons.
 */
function rate(players: readonly SquadPlayer[], projections: readonly Projection[]): Rated[] {
  return players.map((p) => {
    const hits = projections.filter(
      (x) => fold(x.name ?? "") === fold(p.name)
        && fold(x.position ?? "") === fold(p.position),
    );
    const hit = hits.length === 1 ? hits[0] : null;
    return { ...p, xp: hit?.xp ?? null, eMinutes: hit?.eMinutes ?? null };
  });
}

/**
 * The highest-scoring legal XI from the fifteen.
 *
 * FPL requires exactly one keeper, at least three defenders, at least one forward,
 * eleven in total. Small enough to solve exhaustively: take the best keeper, the
 * minimum at each position, then fill the remaining outfield slots by xP. That is
 * optimal because the only constraints are minimums — once they are met, every
 * remaining slot is free, so the greedy fill cannot be beaten.
 */
function bestEleven(rated: Rated[]): Rated[] {
  const scored = rated.filter((p) => p.xp !== null);
  const by = (pos: string) => scored.filter((p) => p.position === pos)
    .sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0));

  const keeper = by("GKP").slice(0, 1);
  const defs = by("DEF");
  const mids = by("MID");
  const fwds = by("FWD");
  if (keeper.length < 1 || defs.length < 3 || fwds.length < 1) return [];

  const required = [...defs.slice(0, 3), ...fwds.slice(0, 1)];
  const chosen = new Set(required.map((p) => p.name));
  const rest = [...defs.slice(3), ...mids, ...fwds.slice(1)]
    .filter((p) => !chosen.has(p.name))
    .sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0))
    .slice(0, 11 - 1 - required.length);

  return [...keeper, ...required, ...rest]
    .sort((a, b) => (ORDER[a.position] ?? 9) - (ORDER[b.position] ?? 9)
      || (b.xp ?? 0) - (a.xp ?? 0));
}

function total(players: readonly Rated[]): number {
  return players.reduce((sum, p) => sum + (p.xp ?? 0), 0);
}

export default function GameweekCall() {
  const { artifact: heuristics } = useHeuristics();
  const view = proven(heuristics);
  const squad = view?.squad ?? null;
  const gameweek = view?.event?.id ?? 1;

  const { artifact: projectionsArtifact } = useArtifact(projectionsDescriptor(gameweek));
  const projections = proven(projectionsArtifact)?.players ?? [];

  const { artifact: conflictsArtifact } = useArtifact(MINUTES_CONFLICTS);
  const conflicts = proven(conflictsArtifact)?.conflicts ?? [];

  const call = useMemo(() => {
    if (!squad || projections.length === 0) return null;
    const rated = rate(squad.players, projections);
    const current = rated.filter((p) => !p.bench);
    const best = bestEleven(rated);
    if (best.length !== 11) return null;

    const inBest = new Set(best.map((p) => p.name));
    const inCurrent = new Set(current.map((p) => p.name));
    return {
      best,
      captain: [...best].sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0))[0] ?? null,
      bringIn: best.filter((p) => !inCurrent.has(p.name)),
      sitDown: current.filter((p) => !inBest.has(p.name)),
      currentTotal: total(current),
      bestTotal: total(best),
    };
  }, [squad, projections]);

  if (!squad) {
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        No squad could be read, so there is no call to make.
      </p>
    );
  }
  if (projections.length === 0) {
    // One line, not a panel: the rest of the page still works.
    return (
      <StateCard of={projectionsArtifact} weight="line"
                 what={`the GW${gameweek} projection this call is computed from`} />
    );
  }
  if (!call) {
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        The projection does not cover enough of the squad to pick an XI.
      </p>
    );
  }

  const gain = call.bestTotal - call.currentTotal;
  const suspect = new Set(conflicts.map((c) => fold(c.player)));

  return (
    <div className="space-y-4" data-testid="gameweek-call">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="badge-green text-[9px]">MODEL</span>
        <span className="text-[10px]" style={{ color: "var(--text-4)" }}>
          computed from xp_public_gw{String(gameweek).padStart(2, "0")}.json — not the heuristic
        </span>
      </div>

      {/* The captain first: it is the single highest-leverage choice of the week. */}
      {call.captain ? (
        <p className="text-sm" style={{ color: "var(--text-1)" }}>
          <strong>Captain</strong> {call.captain.name}
          <span className="font-mono" style={{ color: "var(--text-3)" }}>
            {"  "}{(call.captain.xp ?? 0).toFixed(2)} xP · doubled{" "}
            {((call.captain.xp ?? 0) * 2).toFixed(2)}
          </span>
          {suspect.has(fold(call.captain.name)) ? (
            <span className="text-[10px]" style={{ color: "var(--warning, #f59e0b)" }}>
              {"  "}— evidence disputes this projection, see Injury evidence
            </span>
          ) : null}
        </p>
      ) : null}

      {/* Then the XI, but only when changing it is worth something. */}
      {gain > 0.01 ? (
        <div className="space-y-1" data-testid="xi-change">
          <p className="text-sm" style={{ color: "var(--text-1)" }}>
            <strong>Start</strong>{" "}
            <span style={{ color: "var(--success, #22c55e)" }}>
              {call.bringIn.map((p) => p.name).join(", ")}
            </span>
            {call.sitDown.length ? (
              <>
                {" for "}
                <span style={{ color: "var(--danger, #ef4444)" }}>
                  {call.sitDown.map((p) => p.name).join(", ")}
                </span>
              </>
            ) : null}
          </p>
          <p className="text-xs font-mono" style={{ color: "var(--text-3)" }}>
            {call.currentTotal.toFixed(2)} → {call.bestTotal.toFixed(2)} xP
            {"  (+"}{gain.toFixed(2)}{")"}
          </p>
          {/* Naming the players whose projection is contested is the difference
              between advice and advice you can weigh. */}
          {[...call.bringIn, ...call.sitDown].some((p) => suspect.has(fold(p.name))) ? (
            <p className="text-[10px]" style={{ color: "var(--warning, #f59e0b)" }}>
              Evidence disputes the projection for{" "}
              {[...call.bringIn, ...call.sitDown]
                .filter((p) => suspect.has(fold(p.name)))
                .map((p) => p.name)
                .join(", ")}
              {" — the swap is worth checking against Injury evidence before acting."}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm" style={{ color: "var(--text-1)" }}>
          <strong>Your XI is already the best eleven</strong> the model can build from
          these fifteen.
        </p>
      )}

      <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
        No transfer is suggested. The model publishes one gameweek, and a transfer
        needs a view of several plus a sell-value model — so a single-gameweek
        projection can only honestly advise on the squad you already own.
      </p>
    </div>
  );
}
