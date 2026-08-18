"use client";

import { useHeuristics } from "@/lib/data/useHeuristics";
import { proven } from "@/lib/data/artifact";
import type { SquadPlayer } from "@/lib/data/heuristics";
import { useCurrentGameweek } from "@/lib/data/gameweek";
import { useArtifact } from "@/lib/data/useArtifact";
import {
  projectionsDescriptor, type Projection,
} from "@/lib/data/projections";
import { joinProjections } from "@/lib/margin/squad";

/**
 * Your fifteen, with the model's own projection beside each of them.
 *
 * ## Why this leads the app
 *
 * Every product in this category — Solio, FPL Review, Fantasy Football Fix — opens
 * with your squad and an answer. This app opened with four `NOT PUBLISHED` panels,
 * and the squad was not on any screen at all: `/api/fpl/state` had returned all
 * fifteen players with position, team and price the whole time, and the narrower
 * dropped them.
 *
 * ## What this no longer says
 *
 * It used to lead with a HEURISTIC card naming a transfer and a captain. That card
 * is gone, and its removal is the point rather than a side effect. It named a
 * *second, different* captain from the one {@link GameweekCall} computes directly
 * above it — Mbeumo against the model's B.Fernandes — and it printed that captain's
 * figure already **doubled** (`fpl-ranking-engine.ts` returns
 * `projectedPoints * 2`), so a reader compared the model's undoubled 6.66 against a
 * doubled 8.8 and picked the weaker player. The heuristic's own ranking agreed with
 * the model; it only lost Fernandes because `buildCaptaincyPlan` filters candidates
 * on `expectedMinutes >= 60` and he is *estimated* at 59. It also claimed a gain
 * "over 4 GW" while `/margin` states that no horizon has been solved, and cited
 * elite ownership from an FPLReview export that is gitignored and therefore absent
 * from every deployment.
 *
 * {@link GameweekCall} already states the policy this carries out: this app does
 * not suggest transfers, because the model publishes one gameweek. One screen may
 * not hold two answers to the same question.
 *
 * ## What the numbers are
 *
 * **The per-player `xP` is the real model.** This docstring
 * used to say model projections "do not exist yet", which was true when it was
 * written and false from the moment `xp_public_gw01.json` began shipping a
 * projection for every player in the game. The consequence was not cosmetic: the
 * squad rendered heuristic numbers while the fitted ones sat unread in a published
 * artifact, so the strongest thing the pipeline produces was invisible on the
 * screen that matters most.
 *
 * The count that stood here read 577 and was 581 by the time anyone re-read it —
 * the same failure in miniature — so coverage is now stated as a fact rather than
 * as a number somebody has to maintain.
 *
 * A stale comment did that. The projection is now read directly and shown per
 * player, and a missing one prints `— xP` rather than a blank, because "the model
 * has no view of this player" and "we did not look" are different facts.
 *
 * The squad source is stated for the same reason. A captured draft is not a live
 * team, and the two diverge the moment you make a transfer on the official site.
 */

const ORDER = ["GKP", "DEF", "MID", "FWD"];

function byPosition(players: readonly SquadPlayer[]) {
  return ORDER.map((position) => ({
    position,
    players: players.filter((p) => p.position === position),
  })).filter((row) => row.players.length > 0);
}

function money(value: number | null): string {
  return value === null ? "—" : `£${value.toFixed(1)}m`;
}

/**
 * How the squad was obtained, in words, keyed by the values the server emits.
 *
 * `fpl-live-server.ts:419` emits exactly these two. The previous code compared
 * against `"live"` — a third value nothing produces — so its "never presented as
 * live when it is a draft" guard was unreachable and both cases printed the raw
 * identifier. Keying off the real values is what makes the distinction real, and
 * the difference matters: one is the official endpoint, the other is a snapshot
 * taken on a particular day that has been ageing ever since.
 */
const SOURCE_LABEL: Record<string, string> = {
  official_public: "live from FPL",
  captured_authenticated_draft: "captured draft, not live",
};

/**
 * The model's projection for each of the fifteen, keyed by FPL's own id.
 *
 * This used to be a hand-rolled match on folded name **and position**, carrying a
 * docstring that said "the squad shape carries no `element_id` to join on". That
 * was true when it was written and false from the moment `lib/data/heuristics.ts`
 * began narrowing `elementId` off every pick. The consequence was not academic:
 * today's shipped `xp_public_gw01.json` holds two colliding folded pairs —
 * `kamara/MID` (Aston Villa 47 vs Hull City 293) and `sangare/MID` (Brentford 565
 * vs Nott'm Forest 488) — and a collision makes the player silently vanish from
 * the card's number. None of the current fifteen collides, so this removes a
 * landmine rather than defuses a live one.
 *
 * {@link joinProjections} is the tested primitive for exactly this: id first,
 * folded name and position as the fallback for a captured draft that arrives
 * without one, ambiguity still refused rather than guessed. Keeping a second copy
 * of the rule here is how the two drifted apart in the first place.
 */
function projectionByPlayer(
  players: readonly SquadPlayer[],
  projections: readonly Projection[],
): Map<SquadPlayer, Projection | null> {
  const out = new Map<SquadPlayer, Projection | null>();
  for (const row of joinProjections(players, projections).rows) {
    out.set(row.player, row.projection);
  }
  return out;
}

/**
 * The gameweek is resolved here, and the projection is read one component down.
 *
 * This read `view?.event?.id ?? 1` — FPL's own `is_current ?? is_next` — while
 * `app/page.tsx`, which mounts it beside {@link GameweekCall}, resolved the week
 * through {@link useCurrentGameweek} (`agent_status.gameweek` first, which is the
 * NEXT deadline's week). During any in-progress gameweek N those differ by one, so
 * one page held two answers and read two different `xp_public_gwNN.json` files
 * under a single heading. The number is a fetch path, not a label.
 *
 * The old comment here argued that guessing gw01 is better than not reading,
 * "because a wrong gameweek 404s and renders absent, which is honest". It is not:
 * gw01's file EXISTS, so a wrong guess of 1 renders GW1's numbers as though they
 * were this week's, silently. Hence the split — hooks cannot be conditional, so
 * the only way to not read on an unknown week is for the read to live in a child.
 */
export default function SquadBoard({ gameweek }: { gameweek?: number } = {}) {
  const resolved = useCurrentGameweek();
  const week = gameweek ?? resolved;
  return week === null
    ? <Board projections={[]} gameweekKnown={false} />
    : <BoardForGameweek gameweek={week} />;
}

/**
 * The published model projection for the week. Absent for most of a cycle — the
 * agent that writes it is deadline-gated — so the read is optional and the board
 * renders without it.
 */
function BoardForGameweek({ gameweek }: { gameweek: number }) {
  const { artifact: projectionsArtifact } = useArtifact(
    projectionsDescriptor(gameweek),
  );
  return <Board projections={proven(projectionsArtifact)?.players ?? []} />;
}

function Board(
  { projections, gameweekKnown = true }: {
    projections: readonly Projection[];
    /** False when no resolver could name the week, so nothing was read. */
    gameweekKnown?: boolean;
  },
) {
  const { artifact } = useHeuristics();
  const view = proven(artifact);
  const squad = view?.squad ?? null;

  if (!squad) {
    // One line. A missing squad is worth saying and not worth a panel — the rest of
    // the page still works without it.
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        No squad could be read from FPL, so the fifteen are not shown. Everything
        else on this page is unaffected.
      </p>
    );
  }

  const projectionOf = projectionByPlayer(squad.players, projections);

  return (
    <div className="space-y-4">
      {/* No recommendation card here, by design.
          The model's captain is stated once, by GameweekCall, above this board.
          See this component's docstring for what the deleted heuristic card was
          claiming and why none of it survived checking. */}

      {/* The squad itself. */}
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          {squad.players.length} players · {money(squad.value)} committed ·{" "}
          {/* Unknown bank says unknown.
              The server used to send 0 for "no deadline has passed yet", which
              read here as a confident "£0.0m in the bank" — the one number on
              this line a transfer decision turns on. */}
          {squad.bank === null || squad.bank === undefined
            ? "bank unknown until the first deadline"
            : `${money(squad.bank)} in the bank`}
          {squad.formation ? ` · ${squad.formation}` : ""}
        </p>
        {/* Never presented as live when it is a draft.
            This compared against `"live"`, which the field cannot hold: the
            server emits `official_public` or `captured_authenticated_draft`. So
            the guard never fired and the raw enum was printed to the user
            either way. Mapping the values it does hold is what makes the
            distinction the comment claims. */}
        <p className="text-[10px] font-mono" style={{ color: "var(--text-4)" }}>
          {SOURCE_LABEL[squad.source ?? ""] ?? squad.source ?? "source unknown"}
        </p>
      </div>

      {/* Said once, not fifteen times in tooltips: an empty xP column has two
          possible causes and only one of them is about the model. */}
      {gameweekKnown ? null : (
        <p className="text-xs" style={{ color: "var(--text-4)" }}>
          No source could name the current gameweek, so no projection was read and
          the xP column is empty. Guessing a week would read another one&apos;s file.
        </p>
      )}

      <div className="space-y-2">
        {byPosition(squad.players).map((row) => (
          <div key={row.position} className="flex gap-2 items-start flex-wrap">
            <span
              className="text-[10px] font-mono w-9 shrink-0 pt-2"
              style={{ color: "var(--text-4)" }}
            >
              {row.position}
            </span>
            <div className="flex gap-2 flex-wrap">
              {row.players.map((player) => {
                const projection = projectionOf.get(player) ?? null;
                return (
                  <div
                    key={`${player.name}-${player.team}`}
                    className="glass-inset px-3 py-2 text-center min-w-[92px]"
                    data-testid="squad-player"
                  >
                    <p className="text-sm" style={{ color: "var(--text-1)" }}>
                      {player.name}
                    </p>
                    <p className="text-[10px] font-mono" style={{ color: "var(--text-4)" }}>
                      {player.team} · {money(player.price)}
                    </p>
                    {/* The model's own projection, when it exists.
                        This component's docstring used to say per-player model
                        projections "do not exist yet" — true when it was written
                        and false since `xp_public_gw01.json` began shipping one
                        for every player. So the squad showed heuristic numbers
                        while the real ones sat unread in the artifact.

                        `—` rather than a blank when a player is absent from the
                        projection: the two states are "the model has no view" and
                        "we did not look", and only the first is true here. */}
                    <p
                      className="text-[11px] font-mono mt-1"
                      style={{ color: projection ? "var(--text-2)" : "var(--text-4)" }}
                      data-testid="squad-xp"
                      title={
                        projection
                          ? `model projection: ${projection.xp?.toFixed(2)} xP, `
                            + `${projection.eMinutes?.toFixed(0)} expected minutes`
                          // The two states the docstring above distinguishes. With
                          // no gameweek there is no file to be absent FROM, so
                          // "we did not look" is the true one and says so.
                          : gameweekKnown
                            ? "not in the published projection"
                            : "no gameweek could be resolved, so no projection was read"
                      }
                    >
                      {projection?.xp !== null && projection?.xp !== undefined
                        ? `${projection.xp.toFixed(1)} xP`
                        : "— xP"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
