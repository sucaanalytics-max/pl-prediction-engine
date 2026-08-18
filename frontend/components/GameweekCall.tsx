"use client";

import { useMemo } from "react";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { useArtifact } from "@/lib/data/useArtifact";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { proven } from "@/lib/data/artifact";
import { projectionsDescriptor, type Projection } from "@/lib/data/projections";
import { minutesConflictsDescriptor } from "@/lib/data/minutes-conflicts";
import { StateCard } from "@/components/data/Artifact";
import { optimiseXi, pointsFrom, projectedTotal } from "@/lib/margin/planner";
import { fold } from "@/lib/margin/squad";
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
 *
 * ## Why none of the arithmetic lives here any more
 *
 * This file used to carry its own `rate`, `bestEleven` and `total` — a name-and-
 * position join and a greedy XI fill — beside a second, differently-behaved copy in
 * `lib/margin/planner.ts`. Two consequences, both measured:
 *
 *  - **The join could drop a player.** It folded name and position and refused on
 *    collision, and `xp_public_gw01.json` ships two colliding folded pairs
 *    (`kamara/MID`, `sangare/MID`). A collision here did not show a dash, it
 *    removed the player from the eleven — or, if it hit enough of them, collapsed
 *    this whole card. {@link pointsFrom} keys on `elementId`, FPL's own id, and
 *    additionally drops a player whose gameweek is `blank`; this surface had no
 *    blank guard at all, so a blank gameweek could have started a player with no
 *    fixture.
 *  - **The totals disagreed with `/margin`.** Both numbers were defensible and
 *    neither screen said which it was. {@link projectedTotal} is now the only
 *    definition of the phrase, and the line below states that the captain is not
 *    doubled in it — the captain's own doubling is printed on the captain's line,
 *    where the reader asked for it.
 *
 * The greedy fill was also only *nearly* right: it was optimal given minimum-only
 * constraints, which is not the game's rule set. {@link optimiseXi} is exhaustive
 * over the legal formations, respects the maxima, and is already tested.
 *
 * ## The gameweek comes from the shared resolver
 *
 * This read `view?.event?.id ?? 1` — FPL's own `is_current ?? is_next` — while
 * `app/page.tsx`, which mounts it, resolved the week through
 * {@link useCurrentGameweek} (`agent_status.gameweek` first, which is the NEXT
 * deadline's week). During any in-progress gameweek N the two disagree by one, so
 * the page printed "GW N" here and "Planner · GW N+1" three sections down while
 * reading two different `xp_public_gwNN.json` files under one heading.
 *
 * The number is a fetch path, not a label, so there is no version of that which is
 * merely cosmetic. One resolver, and no `?? 1`: an unknown week says so rather
 * than silently reading GW1's file for 37 weeks of 38.
 */

/**
 * The gameweek is resolved here and the work happens one component down.
 *
 * Hooks cannot be conditional, so a component that both resolves the week and
 * reads the week's artifact has no way to *not* read when the week is unknown —
 * it can only substitute a guess, which is the defect. Splitting them means the
 * absent case issues no fetch at all.
 */
export default function GameweekCall({ gameweek }: { gameweek?: number } = {}) {
  const resolved = useCurrentGameweek();
  const week = gameweek ?? resolved;

  if (week === null) {
    // One line, not a panel: the rest of the page still works.
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        Neither the agent&apos;s status nor FPL&apos;s own state could be read, so
        the gameweek is unknown and there is no projection to compute a call from.
        Guessing one would read a different gameweek&apos;s file.
      </p>
    );
  }
  return <Call gameweek={week} />;
}

function Call({ gameweek }: { gameweek: number }) {
  const { artifact: heuristics } = useHeuristics();
  const view = proven(heuristics);
  const squad = view?.squad ?? null;

  const { artifact: projectionsArtifact } = useArtifact(projectionsDescriptor(gameweek));
  const projections = proven(projectionsArtifact)?.players ?? [];

  const { artifact: conflictsArtifact } =
    useArtifact(minutesConflictsDescriptor(gameweek));
  const conflicts = proven(conflictsArtifact)?.conflicts ?? [];

  const call = useMemo(() => {
    if (!squad || projections.length === 0) return null;
    const points = pointsFrom(projections);
    const best = optimiseXi(squad.players, points);
    if (!best || best.xi.length !== 11) return null;

    // Identity sets, not name sets: `optimiseXi` returns the very objects it was
    // given, and two players can share a name.
    const current = squad.players.filter((p) => !p.bench);
    const inBest = new Set(best.xi);
    const inCurrent = new Set(current);
    const xpOf = (p: SquadPlayer) =>
      (p.elementId === undefined ? undefined : points.get(p.elementId)) ?? null;

    return {
      captain: best.captain,
      captainXp: best.captain ? xpOf(best.captain) : null,
      bringIn: best.xi.filter((p) => !inCurrent.has(p)),
      sitDown: current.filter((p) => !inBest.has(p)),
      currentTotal: projectedTotal(current, points),
      bestTotal: projectedTotal(best.xi, points),
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
            {"  "}{(call.captainXp ?? 0).toFixed(2)} xP · doubled{" "}
            {((call.captainXp ?? 0) * 2).toFixed(2)}
          </span>
          {suspect.has(fold(call.captain.name)) ? (
            <span className="text-[10px]" style={{ color: "var(--warning)" }}>
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
            <span style={{ color: "var(--success)" }}>
              {call.bringIn.map((p) => p.name).join(", ")}
            </span>
            {call.sitDown.length ? (
              <>
                {" for "}
                <span style={{ color: "var(--error)" }}>
                  {call.sitDown.map((p) => p.name).join(", ")}
                </span>
              </>
            ) : null}
          </p>
          {/* Labelled, because `/margin` prints a total for the same eleven and
              the two used to differ by the captain's projection with nothing on
              either screen saying so. One definition now, named on both. */}
          <p className="text-xs font-mono" style={{ color: "var(--text-3)" }}>
            {call.currentTotal.toFixed(2)} → {call.bestTotal.toFixed(2)} xP
            {"  (+"}{gain.toFixed(2)}{")"}
            <span style={{ color: "var(--text-4)" }}>
              {"  "}· XI total, captain not doubled
            </span>
          </p>
          {/* Naming the players whose projection is contested is the difference
              between advice and advice you can weigh. */}
          {[...call.bringIn, ...call.sitDown].some((p) => suspect.has(fold(p.name))) ? (
            <p className="text-[10px]" style={{ color: "var(--warning)" }}>
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
