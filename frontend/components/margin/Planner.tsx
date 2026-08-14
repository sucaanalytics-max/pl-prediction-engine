"use client";

/**
 * The planner: your fifteen, your fixture run, and a scratchpad for moves.
 *
 * ## Why this is always on screen
 *
 * The Score view used to render only when the engine had published a solved
 * horizon, which is most-of-the-season never. But the two questions this screen
 * answers do not need a solve:
 *
 * - **Who plays this week?** `fpl/xp_public_gw{NN}.json` publishes a projection
 *   for every player, and the best legal eleven is a small maximisation over
 *   fifteen of them. That is the model's own number.
 * - **What does the run look like?** Every squad player carries their next ten
 *   fixtures with FPL's difficulty. Fixtures are scheduled, not forecast.
 *
 * ## The one thing it will not do
 *
 * Pick your eleven for gameweek six. The projection covers one gameweek, so the
 * grid shows fixtures and difficulty for the weeks beyond this one and says
 * plainly that an XI cannot be solved for them. Sorting six weeks of fixture
 * difficulty into a lineup would be a rotation plan with a model's authority and
 * a colour ramp behind it.
 *
 * ## The moves belong to the reader
 *
 * A transfer here is a hypothetical you are trying, not a recommendation. The
 * arithmetic is exact — prices are known, a hit is four points — and the
 * projected delta is labelled as the one gameweek it covers.
 */

import { useMemo, useState } from "react";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";
import {
  applyMoves, formationOf, optimiseXi, pointsFrom, transferCost, transferDelta,
  xiProblems, type Move,
} from "@/lib/margin/planner";
import { hatch, MONO, PAPER, SANS } from "@/lib/margin/tokens";
import { Distribution, Eyebrow, Nil } from "@/components/margin/Marks";

const S = PAPER;

/** Difficulty as ink weight, matching the fixture grid on /matches. */
const WEIGHT: Record<number, string> = {
  1: "#e6e4dc", 2: "#c6c3b8", 3: "#9a978c", 4: "#55534a", 5: "#2a2924",
};
const WEIGHT_INK: Record<number, string> = {
  1: "#1b1a16", 2: "#1b1a16", 3: "#1b1a16", 4: "#f6f5f2", 5: "#f6f5f2",
};

const LINE_ORDER: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

export function Planner(
  { squad, projections, prices, bank, freeTransfers, gameweek, weeks = 6 }: {
    squad: readonly SquadPlayer[];
    projections: readonly Projection[];
    /** Price by FPL element id, from `player_stats.json`. */
    prices: ReadonlyMap<number, number>;
    bank: number | null;
    /** Null when FPL did not tell us — see `transferCost`. */
    freeTransfers: number | null;
    gameweek: number;
    /** How many gameweeks of run to show. */
    weeks?: number;
  },
) {
  const [moves, setMoves] = useState<readonly Move[]>([]);
  const [benched, setBenched] = useState<ReadonlySet<number>>(new Set());
  const [picking, setPicking] = useState<SquadPlayer | null>(null);
  const [query, setQuery] = useState("");

  const points = useMemo(() => pointsFrom(projections), [projections]);
  const byId = useMemo(
    () => new Map(projections.map((p) => [p.elementId, p])), [projections],
  );

  const working = useMemo(() => applyMoves(squad, moves), [squad, moves]);
  const cost = useMemo(
    () => transferCost(moves, bank, freeTransfers), [moves, bank, freeTransfers],
  );
  const delta = useMemo(
    () => transferDelta(moves, points, cost), [moves, points, cost],
  );

  const best = useMemo(() => optimiseXi(working, points), [working, points]);

  /**
   * The eleven on screen: yours if you have edited it, otherwise the optimum.
   *
   * Edits are recorded as a bench set rather than as a starting eleven, so a
   * transfer that changes the squad does not silently drop a player you never
   * benched out of the lineup.
   */
  const xi = useMemo(() => {
    if (benched.size === 0) return best?.xi ?? [];
    return working.filter((p) => p.elementId !== undefined && !benched.has(p.elementId));
  }, [benched, best, working]);

  const problems = benched.size === 0 ? [] : xiProblems(xi);
  const formation = formationOf(xi);

  const gameweeks = useMemo(
    () => Array.from({ length: weeks }, (_, i) => gameweek + i), [gameweek, weeks],
  );

  const rows = useMemo(() => {
    const inXi = new Set(xi);
    return [...working].sort((a, b) => {
      const line = (LINE_ORDER[a.position] ?? 9) - (LINE_ORDER[b.position] ?? 9);
      if (line !== 0) return line;
      const av = a.elementId === undefined ? null : points.get(a.elementId) ?? null;
      const bv = b.elementId === undefined ? null : points.get(b.elementId) ?? null;
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return bv - av;
    }).map((player) => ({ player, starting: inXi.has(player) }));
  }, [working, xi, points]);

  const columns = `18px 128px 44px 76px repeat(${weeks}, minmax(52px, 1fr)) 34px`;

  const toggle = (player: SquadPlayer) => {
    if (player.elementId === undefined) return;
    const id = player.elementId;
    setBenched((was) => {
      // First edit seeds from the optimum, so one click does not bench everyone.
      const seed = was.size === 0
        ? new Set((best?.bench ?? []).map((p) => p.elementId).filter((v): v is number => v !== undefined))
        : new Set(was);
      if (seed.has(id)) seed.delete(id); else seed.add(id);
      return seed;
    });
  };

  const candidates = useMemo(() => {
    if (!picking) return [];
    const owned = new Set(working.map((p) => p.elementId));
    const needle = query.trim().toLowerCase();
    return projections
      .filter((p) => p.position === picking.position && !owned.has(p.elementId) && !p.blank)
      .filter((p) => !needle || `${p.name ?? ""} ${p.team ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0))
      .slice(0, 40);
  }, [picking, projections, working, query]);

  return (
    <section data-testid="margin-planner">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <Eyebrow surface={S}>
          Planner &middot; GW{gameweek}&ndash;GW{gameweeks[gameweeks.length - 1]}
        </Eyebrow>
        <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: S.ink2 }}>
          <span>bank {cost.bankAfter === null ? <Nil surface={S} size={10} /> : `£${cost.bankAfter.toFixed(1)}`}</span>
          <span>free transfers {freeTransfers ?? <Nil surface={S} size={10} />}</span>
          <span>
            moves {cost.moves}
            {cost.hits > 0 ? ` · −${cost.pointsCost}` : ""}
          </span>
          {(moves.length > 0 || benched.size > 0) ? (
            <button
              type="button"
              onClick={() => { setMoves([]); setBenched(new Set()); }}
              style={{
                fontFamily: MONO, fontSize: 10, letterSpacing: ".08em",
                textTransform: "uppercase", color: S.ink, background: "transparent",
                border: 0, borderBottom: `1px solid ${S.hair}`, cursor: "pointer", padding: 0,
              }}
            >
              reset
            </button>
          ) : null}
        </div>
      </div>

      {/* This week's XI, which is the one the model can actually solve. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, color: S.ink, letterSpacing: "-.03em" }}>
          {best === null ? <Nil surface={S} size={22} /> : projectedTotal(xi, points).toFixed(1)}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
          projected GW{gameweek}
          {formation ? ` · ${formation}` : ""}
          {delta !== null && moves.length > 0
            ? ` · ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} after ${cost.hits > 0 ? "the hit" : "moves"}`
            : ""}
        </span>
        {benched.size > 0 ? (
          <button
            type="button"
            onClick={() => setBenched(new Set())}
            style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: ".08em",
              textTransform: "uppercase", color: S.agree, background: "transparent",
              border: 0, borderBottom: `1px solid ${S.agree}`, cursor: "pointer", padding: 0,
            }}
          >
            use the optimal XI
          </button>
        ) : null}
      </div>

      {problems.length > 0 ? (
        <p style={{ margin: "0 0 10px", fontFamily: MONO, fontSize: 11, color: S.conflict }}>
          {problems.map((p) => `${p.line}: ${p.have}, need ${p.need}`).join(" · ")}
        </p>
      ) : null}

      {/* Header */}
      <div
        style={{
          display: "grid", gridTemplateColumns: columns, gap: 4,
          borderTop: `1px solid rgba(27,26,22,.25)`, borderBottom: `1px solid ${S.hair}`,
          fontFamily: MONO, fontSize: 9, letterSpacing: ".06em",
          textTransform: "uppercase", color: S.ink3, padding: "6px 0",
        }}
      >
        <span />
        <span>Player</span>
        <span style={{ textAlign: "right" }}>£</span>
        <span style={{ textAlign: "right" }}>xP GW{gameweek}</span>
        {gameweeks.map((gw) => (
          <span key={gw} style={{ textAlign: "center" }}>GW{gw}</span>
        ))}
        <span />
      </div>

      {rows.map(({ player, starting }) => (
        <PlannerRow
          key={player.elementId ?? player.name}
          player={player}
          starting={starting}
          projection={player.elementId === undefined ? null : byId.get(player.elementId) ?? null}
          gameweeks={gameweeks}
          columns={columns}
          onToggle={() => toggle(player)}
          onReplace={() => { setPicking(player); setQuery(""); }}
        />
      ))}

      <p style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 800 }}>
        The XI and its total are solved for <strong style={{ color: S.ink2, fontWeight: 600 }}>GW{gameweek} only</strong> —
        that is the horizon the published projection covers. The later columns are
        fixtures and FPL&apos;s own difficulty, which are scheduled rather than
        forecast; no eleven is chosen for them, because sorting six weeks of
        difficulty into a lineup would be a rotation plan with a model&apos;s
        authority and none of its evidence.
        {best && best.unprojected > 0
          ? ` ${best.unprojected} of the eleven have no published projection and are excluded from the total.`
          : ""}
        {" Nothing here is submitted to FPL — it is a scratchpad."}
      </p>

      {picking ? (
        <ReplacePanel
          player={picking}
          candidates={candidates}
          query={query}
          onQuery={setQuery}
          onClose={() => setPicking(null)}
          prices={prices}
          onPick={(candidate) => {
            setMoves((was) => [
              ...was.filter((m) => m.out.elementId !== picking.elementId),
              { out: picking, in: candidate, price: prices.get(candidate.elementId) ?? null },
            ]);
            setPicking(null);
          }}
        />
      ) : null}
    </section>
  );
}



function projectedTotal(
  xi: readonly SquadPlayer[], points: ReadonlyMap<number, number>,
): number {
  const scored = xi.map((p) => (p.elementId === undefined ? 0 : points.get(p.elementId) ?? 0));
  const captain = Math.max(0, ...scored);
  return scored.reduce((a, b) => a + b, 0) + captain;
}

function PlannerRow(
  { player, starting, projection, gameweeks, columns, onToggle, onReplace }: {
    player: SquadPlayer;
    starting: boolean;
    projection: Projection | null;
    gameweeks: readonly number[];
    columns: string;
    onToggle: () => void;
    onReplace: () => void;
  },
) {
  const runByWeek = new Map(player.fixtures.map((f) => [f.gameweek, f]));

  return (
    <div
      data-testid="planner-row"
      data-starting={starting}
      style={{
        display: "grid", gridTemplateColumns: columns, gap: 4, alignItems: "center",
        borderBottom: `1px solid rgba(27,26,22,.06)`, padding: "3px 0",
        opacity: starting ? 1 : 0.55,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        title={starting ? "starting — click to bench" : "benched — click to start"}
        aria-label={`${player.name}: ${starting ? "starting" : "benched"}`}
        style={{
          width: 13, height: 13, padding: 0, cursor: "pointer",
          background: starting ? S.ink : "transparent",
          border: starting ? "none" : `1px solid rgba(27,26,22,.45)`,
        }}
      />
      <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3, width: 24 }}>
          {player.position}
        </span>
        <span
          style={{
            fontFamily: SANS, fontSize: 12.5, color: S.ink,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {player.name}
        </span>
      </span>
      <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        {player.price === null ? <Nil surface={S} size={10} /> : player.price.toFixed(1)}
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        {projection ? (
          <Distribution
            of={{
              q10: projection.q10, q25: projection.q25, q50: projection.q50,
              q75: projection.q75, q90: projection.q90,
              mean: projection.xp, mode: projection.mode,
            }}
            surface={S}
            width={44}
            height={12}
          />
        ) : null}
        <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink, minWidth: 26, textAlign: "right" }}>
          {projection?.xp === null || projection === null
            ? <Nil surface={S} size={10} />
            : projection.xp.toFixed(1)}
        </span>
      </span>

      {gameweeks.map((gw) => {
        const fixture = runByWeek.get(gw);
        if (!fixture) {
          return (
            <span
              key={gw}
              title="no fixture scheduled — not an easy one"
              style={{ display: "block", height: 20, background: hatch(S) }}
            />
          );
        }
        return (
          <span
            key={gw}
            title={`${fixture.label} · FPL difficulty ${fixture.difficulty}`}
            style={{
              display: "grid", placeItems: "center", height: 20,
              fontFamily: MONO, fontSize: 9,
              background: WEIGHT[fixture.difficulty] ?? WEIGHT[3],
              color: WEIGHT_INK[fixture.difficulty] ?? WEIGHT_INK[3],
            }}
          >
            {fixture.label}
          </span>
        );
      })}

      <button
        type="button"
        onClick={onReplace}
        title={`replace ${player.name}`}
        aria-label={`replace ${player.name}`}
        style={{
          fontFamily: MONO, fontSize: 13, lineHeight: 1, color: S.ink3,
          background: "transparent", border: 0, cursor: "pointer", padding: 0,
        }}
      >
        &#8644;
      </button>
    </div>
  );
}

function ReplacePanel(
  { player, candidates, query, prices, onQuery, onPick, onClose }: {
    player: SquadPlayer;
    candidates: readonly Projection[];
    prices: ReadonlyMap<number, number>;
    query: string;
    onQuery: (value: string) => void;
    onPick: (candidate: Projection) => void;
    onClose: () => void;
  },
) {
  return (
    <div
      data-testid="planner-replace"
      style={{ marginTop: 14, border: `1px solid ${S.hair}`, background: S.bar }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${S.hair}`, flexWrap: "wrap" }}>
        <Eyebrow surface={S} style={{ fontSize: 10 }}>
          Replace {player.name} &middot; {player.position}
        </Eyebrow>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="search"
          aria-label={`Search a replacement for ${player.name}`}
          style={{
            fontFamily: MONO, fontSize: 11, color: S.ink, background: "transparent",
            border: `1px solid ${S.hair}`, padding: "4px 8px", minWidth: 140,
          }}
        />
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: "auto", fontFamily: MONO, fontSize: 10,
            letterSpacing: ".08em", textTransform: "uppercase", color: S.ink3,
            background: "transparent", border: 0, cursor: "pointer",
          }}
        >
          close
        </button>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {candidates.length === 0 ? (
          <p style={{ margin: 0, padding: "12px", fontSize: 12, color: S.ink3 }}>
            No {player.position} in the published projection matches that search.
          </p>
        ) : candidates.map((candidate) => (
          <button
            key={candidate.elementId}
            type="button"
            onClick={() => onPick(candidate)}
            style={{
              display: "grid", gridTemplateColumns: "1fr 60px 44px", gap: 10,
              width: "100%", textAlign: "left", alignItems: "center",
              padding: "7px 12px", background: "transparent", cursor: "pointer",
              border: 0, borderBottom: `1px solid rgba(27,26,22,.06)`,
            }}
          >
            <span style={{ fontFamily: SANS, fontSize: 12.5, color: S.ink }}>
              {candidate.name}
              <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}> {candidate.team}</span>
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3, textAlign: "right" }}>
              {prices.has(candidate.elementId)
                ? `£${prices.get(candidate.elementId)!.toFixed(1)}`
                : "£—"}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink, textAlign: "right" }}>
              {candidate.xp === null ? "—" : candidate.xp.toFixed(1)}
            </span>
          </button>
        ))}
      </div>
      <p style={{ margin: 0, padding: "10px 12px", borderTop: `1px solid ${S.hair}`, fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
        Prices come from `player_stats.json`, joined on FPL&apos;s own element id.
        A player it has no price for leaves the bank unknown rather than a
        plausible wrong number — this is the figure you commit real transfers
        against.
      </p>
    </div>
  );
}
