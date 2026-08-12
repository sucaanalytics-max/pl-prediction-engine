"use client";

import { useHeuristics } from "@/lib/data/useHeuristics";
import { proven } from "@/lib/data/artifact";
import type { SquadPlayer } from "@/lib/data/heuristics";

/**
 * Your fifteen, and the one move worth making.
 *
 * ## Why this leads the app
 *
 * Every product in this category — Solio, FPL Review, Fantasy Football Fix — opens
 * with your squad and an answer. This app opened with four `NOT PUBLISHED` panels,
 * and the squad was not on any screen at all: `/api/fpl/state` had returned all
 * fifteen players with position, team and price the whole time, and the narrower
 * dropped them.
 *
 * ## What the numbers are, and are not
 *
 * The transfer and captaincy lines come from the heuristic engine, badged. They are
 * NOT the decision model: `xp_gw` is written by the agent, which is deadline-gated
 * and idle for roughly ten days of every gameweek cycle, so per-player model
 * projections do not exist yet. Saying so beside the number is the whole point —
 * FPL Review's own docs tell you to go read a press conference and type a number in,
 * and nobody in the category tells you which of their numbers is measured.
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

export default function SquadBoard() {
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

  const move = view?.transfers?.[0] ?? null;
  const captain = view?.captaincy?.[0] ?? null;

  return (
    <div className="space-y-4">
      {/* THE MOVE, above the squad. The answer first, the evidence under it. */}
      {move || captain ? (
        <div className="card p-4 space-y-2" data-testid="the-move">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge-amber text-[9px]">HEURISTIC</span>
            <span className="text-[10px]" style={{ color: "var(--text-4)" }}>
              not the decision model — no gameweek has sealed yet
            </span>
          </div>

          {move ? (
            <p className="text-sm" style={{ color: "var(--text-1)" }}>
              <strong>Transfer</strong>{" "}
              <span style={{ color: "var(--danger, #ef4444)" }}>{move.playerOut.name}</span>
              {" → "}
              <span style={{ color: "var(--success, #22c55e)" }}>{move.playerIn.name}</span>
              <span className="font-mono" style={{ color: "var(--text-3)" }}>
                {"  "}+{move.delta4.toFixed(1)} pts over 4 GW · confidence{" "}
                {move.confidence.toFixed(0)}
              </span>
            </p>
          ) : null}

          {move?.rationale?.length ? (
            <p className="text-xs" style={{ color: "var(--text-3)" }}>
              {move.rationale.join(" · ")}
            </p>
          ) : null}

          {captain ? (
            <p className="text-sm" style={{ color: "var(--text-1)" }}>
              <strong>Captain</strong> {captain.captain.name}
              <span className="font-mono" style={{ color: "var(--text-3)" }}>
                {"  "}{captain.captainFixture} · {captain.projectedCaptainPoints.toFixed(1)} proj
                {" · vice "}{captain.viceCaptain.name}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

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
              {row.players.map((player) => (
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
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
