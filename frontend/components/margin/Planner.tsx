"use client";

/**
 * The planner: your squad across the horizon, and the moves that change it.
 *
 * ## A plan is a sequence, not a set
 *
 * Selling Shaw in GW2 and Gabriel in GW4 are two decisions a week apart, each
 * with its own free transfer and its own bank. So every move carries the week it
 * happens in, the squad is recomputed per column, and a player is drawn as owned
 * or not in each week rather than once for the whole horizon. That is the only
 * thing that makes a horizon worth planning: *when*.
 *
 * ## Why this is always on screen
 *
 * Neither question it answers needs the engine to have solved anything:
 *
 * - **Who plays this week?** `fpl/xp_public_gw{NN}.json` publishes a projection
 *   for every player, and the best legal eleven is a small maximisation over
 *   fifteen of them.
 * - **What does the run look like?** Every squad player carries their next ten
 *   fixtures with FPL's difficulty. Fixtures are scheduled, not forecast.
 *
 * ## What it will not do
 *
 * Pick your eleven for a later week. The projection covers one gameweek, so the
 * later columns stay fixtures. Sorting six weeks of difficulty into a lineup
 * would be a rotation plan with a model's authority and none of its evidence.
 *
 * ## Free transfers are the reader's to supply
 *
 * FPL does not publish the count to this app. Rather than assume one and dock
 * four points for a hit that may not be owed, the planner asks — the number is
 * on the FPL site, and until it is given every hit reads as unknown.
 */

import { useMemo, useState } from "react";
import type { FixtureMatrixRow, SquadPlayer } from "@/lib/data/heuristics";
import type {
  Horizon as ProjectionHorizon, Projection,
} from "@/lib/data/projections";
import {
  formationOf, MAX_BANKED_FREE_TRANSFERS, moveDelta, optimiseXi, ownedIn,
  pairRows, playersAcross, pointsFrom, weeklyLedger, xiProblems,
  type Move, type PlannerRowModel, type WeekLedger,
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

/** Which cell the replacement picker is open for. */
interface Picking {
  readonly player: SquadPlayer;
  readonly gameweek: number;
}

export function Planner(
  { squad, projections, horizon, decisionDraws, prices, fixtureMatrix, bank, gameweek, weeks = 6 }: {
    squad: readonly SquadPlayer[];
    projections: readonly Projection[];
    /**
     * Expected points for the weeks after this one, when the run solved a
     * horizon. Null means later weeks show fixtures and no XI, as before.
     */
    horizon: ProjectionHorizon | null;
    /** Draws behind this gameweek's numbers, for the fidelity note. */
    decisionDraws: number | null;
    /** Every club's run, so a player you have never held still has fixtures. */
    fixtureMatrix: readonly FixtureMatrixRow[];
    /** Price by FPL element id, from `player_stats.json`. */
    prices: ReadonlyMap<number, number>;
    bank: number | null;
    gameweek: number;
    /** How many gameweeks of run to plan over. */
    weeks?: number;
  },
) {
  const [moves, setMoves] = useState<readonly Move[]>([]);
  const [benched, setBenched] = useState<ReadonlySet<number>>(new Set());
  const [picking, setPicking] = useState<Picking | null>(null);
  const [query, setQuery] = useState("");
  const [freeTransfers, setFreeTransfers] = useState<number | null>(null);

  const points = useMemo(() => pointsFrom(projections), [projections]);

  /**
   * The projection for each week of the plan, by gameweek.
   *
   * This gameweek comes from the rows themselves, which are simulated at the
   * decision draw count; the rest come from the horizon block at the horizon
   * draw count. Keeping them in one map lets the XI be solved per column
   * without any caller having to know which fidelity it is looking at — the
   * footnote says, once.
   */
  const pointsByWeek = useMemo(() => {
    const out = new Map<number, ReadonlyMap<number, number>>();
    out.set(gameweek, points);
    for (const week of horizon?.weeks ?? []) out.set(week.gameweek, week.xp);
    return out;
  }, [gameweek, points, horizon]);
  const byId = useMemo(
    () => new Map(projections.map((p) => [p.elementId, p])), [projections],
  );
  const gameweeks = useMemo(
    () => Array.from({ length: weeks }, (_, i) => gameweek + i), [gameweek, weeks],
  );

  /**
   * A club's fixture run by full club name.
   *
   * `xp_public` and `fixtureMatrix` both name clubs in full ("Arsenal"), while
   * the squad carries FPL's short code ("ARS") — so the join for an incoming
   * player is on the projection's team, not the squad's.
   */
  const fixturesFor = useMemo(() => {
    const byTeam = new Map<string, readonly { gameweek: number; label: string; difficulty: number }[]>();
    for (const row of fixtureMatrix) byTeam.set(row.team, row.fixtures);
    return (team: string | null) => (team === null ? [] : byTeam.get(team) ?? []);
  }, [fixtureMatrix]);

  const ledger = useMemo(
    () => weeklyLedger(squad, moves, gameweeks, bank, freeTransfers, fixturesFor),
    [squad, moves, gameweeks, bank, freeTransfers, fixturesFor],
  );

  const thisWeek = ledger[0];

  /**
   * The best legal eleven for every week the projection reaches.
   *
   * Was the first week alone, because that was the only week with numbers. Each
   * week is solved against *its own* squad, so a transfer in GW4 changes the
   * eleven from GW4 and not before.
   */
  const bestByWeek = useMemo(() => {
    const out = new Map<number, ReturnType<typeof optimiseXi>>();
    for (const week of ledger) {
      const forWeek = pointsByWeek.get(week.gameweek);
      out.set(week.gameweek, forWeek ? optimiseXi(week.squad, forWeek) : null);
    }
    return out;
  }, [ledger, pointsByWeek]);

  const best = bestByWeek.get(gameweek) ?? null;

  /**
   * The eleven on screen: yours if you have edited it, otherwise the optimum.
   *
   * Held as a bench set rather than a starting eleven, so a transfer that
   * changes the squad does not silently drop a player you never benched.
   */
  const xi = useMemo(() => {
    const from = thisWeek?.squad ?? squad;
    if (benched.size === 0) return best?.xi ?? [];
    return from.filter((p) => p.elementId !== undefined && !benched.has(p.elementId));
  }, [benched, best, thisWeek, squad]);

  const problems = benched.size === 0 ? [] : xiProblems(xi);
  const formation = formationOf(xi);

  const rows = useMemo(() => {
    const everyone = playersAcross(ledger, squad);
    const inXi = new Set(xi);
    const sorted = [...everyone].sort((a, b) => {
      const line = (LINE_ORDER[a.position] ?? 9) - (LINE_ORDER[b.position] ?? 9);
      if (line !== 0) return line;
      const av = a.elementId === undefined ? null : points.get(a.elementId) ?? null;
      const bv = b.elementId === undefined ? null : points.get(b.elementId) ?? null;
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return bv - av;
    });
    return pairRows(sorted, moves).map((row) => {
      const id = row.player.elementId;
      const startingWeeks = new Set<number>();
      if (id !== undefined) {
        for (const [week, solved] of bestByWeek) {
          if (solved?.xi.some((p) => p.elementId === id)) startingWeeks.add(week);
        }
      }
      return { ...row, starting: inXi.has(row.player), startingWeeks };
    });
  }, [ledger, squad, xi, points, moves, bestByWeek]);

  // No leading toggle column any more. The XI switch lives inside the GW1 cell,
  // because it only applies to GW1 — a control at row level sat across six
  // columns and read as though it governed all of them.
  const columns = `132px 42px 74px minmax(72px, 1.2fr) repeat(${weeks - 1}, minmax(56px, 1fr))`;

  const toggle = (player: SquadPlayer) => {
    if (player.elementId === undefined) return;
    const id = player.elementId;
    setBenched((was) => {
      // The first edit seeds from the optimum, so one click does not bench
      // everyone who happened to be starting.
      const seed = was.size === 0
        ? new Set((best?.bench ?? [])
            .map((p) => p.elementId)
            .filter((v): v is number => v !== undefined))
        : new Set(was);
      if (seed.has(id)) seed.delete(id); else seed.add(id);
      return seed;
    });
  };

  const candidates = useMemo(() => {
    if (!picking) return [];
    const week = ledger.find((w) => w.gameweek === picking.gameweek);
    const owned = new Set((week?.squad ?? squad).map((p) => p.elementId));
    const needle = query.trim().toLowerCase();
    return projections
      .filter((p) => p.position === picking.player.position)
      .filter((p) => !owned.has(p.elementId) && !p.blank)
      .filter((p) => !needle || `${p.name ?? ""} ${p.team ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0))
      .slice(0, 40);
  }, [picking, projections, ledger, squad, query]);

  const totalHits = ledger.reduce((sum, w) => sum + w.pointsCost, 0);

  return (
    <section data-testid="margin-planner">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <Eyebrow surface={S}>
          Planner &middot; GW{gameweek}&ndash;GW{gameweeks[gameweeks.length - 1]}
        </Eyebrow>
        <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: S.ink2 }}>
          <label style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
            free transfers now
            <input
              type="number"
              min={0}
              max={MAX_BANKED_FREE_TRANSFERS}
              value={freeTransfers ?? ""}
              placeholder="?"
              aria-label="Free transfers you currently hold"
              onChange={(event) => {
                const raw = event.target.value;
                setFreeTransfers(raw === "" ? null : Math.max(0, Math.min(MAX_BANKED_FREE_TRANSFERS, Number(raw))));
              }}
              style={{
                width: 34, fontFamily: MONO, fontSize: 11, color: S.ink,
                background: "transparent", border: `1px solid ${S.hair}`,
                padding: "1px 4px", textAlign: "center",
              }}
            />
          </label>
          <span>moves {moves.length}{totalHits > 0 ? ` · −${totalHits}` : ""}</span>
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

      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, color: S.ink, letterSpacing: "-.03em" }}>
          {best === null ? <Nil surface={S} size={22} /> : projectedTotal(xi, points).toFixed(1)}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
          projected GW{gameweek}{formation ? ` · ${formation}` : ""}
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

      <div
        style={{
          display: "grid", gridTemplateColumns: columns, gap: 4,
          borderTop: `1px solid rgba(27,26,22,.25)`, borderBottom: `1px solid ${S.hair}`,
          fontFamily: MONO, fontSize: 9, letterSpacing: ".06em",
          textTransform: "uppercase", color: S.ink3, padding: "6px 0",
        }}
      >
        <span>Player</span>
        <span style={{ textAlign: "right" }}>&pound;</span>
        <span style={{ textAlign: "right" }}>xP GW{gameweek}</span>
        {gameweeks.map((gw, i) => (
          <span key={gw} style={{ textAlign: "center" }}>
            GW{gw}
            {i === 0 ? (
              <span style={{ display: "block", fontSize: 8, letterSpacing: ".04em", color: S.ink3 }}>
                xi &middot; fixture
              </span>
            ) : null}
          </span>
        ))}
      </div>

      {rows.map(({ player, starting, move, side, startingWeeks }) => (
        <PlannerRow
          key={`${side ?? "solo"}-${player.elementId ?? player.name}`}
          player={player}
          starting={starting}
          move={move}
          side={side}
          startingWeeks={startingWeeks}
          firstWeek={gameweeks[0]}
          projection={player.elementId === undefined ? null : byId.get(player.elementId) ?? null}
          ledger={ledger}
          columns={columns}
          onToggle={() => toggle(player)}
          onPick={(week) => { setPicking({ player, gameweek: week }); setQuery(""); }}
        />
      ))}

      {/* The plan's arithmetic, week by week. */}
      <div style={{ marginTop: 8, borderTop: `1px solid rgba(27,26,22,.25)` }}>
        <LedgerRow
          label="transfers &middot; hits"
          ledger={ledger}
          columns={columns}
          render={(w) => (
            <>{w.transfersIn.length} {w.pointsCost > 0 ? `· −${w.pointsCost}` : "· 0"}</>
          )}
        />
        <LedgerRow
          label="bank &middot; FT after"
          ledger={ledger}
          columns={columns}
          render={(w) => (
            <>
              {w.bankAfter === null ? <Nil surface={S} size={10} /> : w.bankAfter.toFixed(1)}
              {" · "}
              {w.freeAfter === null ? <Nil surface={S} size={10} /> : w.freeAfter}
            </>
          )}
        />
      </div>

      {moves.length > 0 ? (
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
          {[...moves].sort((a, b) => a.gameweek - b.gameweek).map((move) => (
            <span
              key={`${move.gameweek}-${move.out.elementId}`}
              style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}
            >
              <span style={{ color: S.ink3 }}>GW{move.gameweek}</span>{" "}
              <span style={{ color: S.conflict }}>{move.out.name}</span>
              {" → "}
              <span style={{ color: S.agree }}>{move.in.name}</span>
              {(() => {
                const d = moveDelta(move, points, gameweek);
                return d === null ? null : (
                  <span
                    style={{ color: d >= 0 ? S.agree : S.conflict, marginLeft: 6 }}
                    title="change in this gameweek's projection, before any hit"
                  >
                    {d >= 0 ? "+" : ""}{d.toFixed(1)}
                  </span>
                );
              })()}
              <button
                type="button"
                onClick={() => setMoves((was) => was.filter((m) => m !== move))}
                aria-label={`undo ${move.out.name} to ${move.in.name} in GW${move.gameweek}`}
                style={{
                  marginLeft: 6, fontFamily: MONO, fontSize: 11, color: S.ink3,
                  background: "transparent", border: 0, cursor: "pointer", padding: 0,
                }}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <p style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 820 }}>
        Click any week&apos;s cell to transfer that player out from that gameweek
        on. The square in the GW{gameweek} column starts or benches a player;
        it is only in that column because only this week&apos;s eleven is yours
        to edit.
        {horizon
          ? ` Every week is solved for its own best eleven — a fixture at half strength is a week that player does not make it. This gameweek is simulated on ${decisionDraws?.toLocaleString() ?? "the decision"} draws and the rest on ${horizon.nDraws?.toLocaleString() ?? "fewer"}, so a later week is a weaker estimate of the same thing, not a different kind of number.`
          : " The later columns are fixtures and FPL's own difficulty, which are scheduled rather than forecast; no eleven is chosen for them, because the published projection covers this gameweek only."}
        {freeTransfers === null
          ? " FPL does not tell this app how many free transfers you hold, so hits are unknown until you enter the number above."
          : ` Free transfers roll over and cap at ${MAX_BANKED_FREE_TRANSFERS}; the real cap comes from FPL's own game settings, which this app does not receive.`}
        {best && best.unprojected > 0
          ? ` ${best.unprojected} of the eleven have no published projection and are excluded from the total.`
          : ""}
        {" Nothing here is submitted to FPL — it is a scratchpad."}
      </p>

      {picking ? (
        <ReplacePanel
          picking={picking}
          candidates={candidates}
          query={query}
          prices={prices}
          onQuery={setQuery}
          onClose={() => setPicking(null)}
          onPick={(candidate) => {
            setMoves((was) => [
              // One move per player per week; picking again replaces it.
              ...was.filter((m) => !(m.gameweek === picking.gameweek
                && m.out.elementId === picking.player.elementId)),
              {
                gameweek: picking.gameweek,
                out: picking.player,
                in: candidate,
                price: prices.get(candidate.elementId) ?? null,
              },
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

function LedgerRow(
  { label, ledger, columns, render }: {
    label: string;
    ledger: readonly WeekLedger[];
    columns: string;
    render: (week: WeekLedger) => React.ReactNode;
  },
) {
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: columns, gap: 4,
        borderBottom: `1px solid rgba(27,26,22,.06)`, padding: "5px 0",
      }}
    >
      <span
        style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}
        dangerouslySetInnerHTML={{ __html: label }}
      />
      <span />
      <span />
      {ledger.map((week) => (
        <span
          key={week.gameweek}
          style={{
            textAlign: "center", fontFamily: MONO, fontSize: 10,
            color: week.unaffordable ? S.conflict : S.ink2,
          }}
          title={week.unaffordable ? "this plan cannot be afforded" : undefined}
        >
          {render(week)}
        </span>
      ))}
    </div>
  );
}

function PlannerRow(
  { player, starting, projection, ledger, columns, move, side, startingWeeks, firstWeek, onToggle, onPick }: {
    player: SquadPlayer;
    starting: boolean;
    /** The transfer this row is half of, so the pair can be bracketed. */
    move: Move | null;
    side: PlannerRowModel["side"];
    /** Gameweeks in which this player makes the best legal eleven. */
    startingWeeks: ReadonlySet<number>;
    firstWeek: number;
    projection: Projection | null;
    ledger: readonly WeekLedger[];
    columns: string;
    onToggle: () => void;
    onPick: (gameweek: number) => void;
  },
) {
  const runByWeek = new Map(player.fixtures.map((f) => [f.gameweek, f]));

  return (
    <div
      data-testid="planner-row"
      data-starting={starting}
      data-side={side ?? undefined}
      style={{
        display: "grid", gridTemplateColumns: columns, gap: 4, alignItems: "center",
        padding: "3px 0 3px 8px",
        // The pair reads as one object: a rule down the left of both rows, open
        // at neither end, so the eye takes the two together rather than as
        // neighbours that happen to be adjacent.
        borderLeft: side ? `2px solid ${side === "out" ? S.conflict : S.agree}` : "2px solid transparent",
        borderBottom: side === "out"
          ? "none"
          : `1px solid rgba(27,26,22,.06)`,
        background: side ? "rgba(27,26,22,.025)" : undefined,
      }}
    >
      <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, opacity: starting ? 1 : 0.6 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3, width: 24 }}>
          {side === "out" ? "OUT" : side === "in" ? "IN" : player.position}
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
            width={40}
            height={12}
          />
        ) : null}
        <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink, minWidth: 26, textAlign: "right" }}>
          {/* A player who arrives later cannot score this week's projection for
              you, so the column shows nothing rather than a number his row's
              own first cell contradicts. */}
          {move && side === "in" && move.gameweek !== firstWeek
            ? <Nil surface={S} size={10} />
            : projection?.xp === null || projection === null
              ? <Nil surface={S} size={10} />
              : projection.xp.toFixed(1)}
        </span>
      </span>

      {ledger.map((week, index) => {
        const owned = ownedIn(week, player);
        const fixture = runByWeek.get(week.gameweek);
        const leaving = player.elementId !== undefined
          && week.transfersOut.includes(player.elementId);
        const arriving = player.elementId !== undefined
          && week.transfersIn.includes(player.elementId);
        // The XI switch belongs to the first column and only the first column,
        // because that is the only week the projection can solve an eleven for.
        const isFirst = index === 0;
        // Each week marks its own eleven. Only the first is editable, because
        // only the first carries a bench set the reader has touched.
        const startsThisWeek = startingWeeks.has(week.gameweek);

        if (!owned) {
          return (
            <span
              key={week.gameweek}
              title="not in the squad this week — not a zero"
              style={{ display: "block", height: 20, background: hatch(S) }}
            />
          );
        }

        const cell = !fixture ? (
          <span
            title="no fixture scheduled — not an easy one"
            style={{ display: "block", height: 20, width: "100%", background: hatch(S), opacity: 0.55 }}
          />
        ) : (
          <button
            type="button"
            data-testid="planner-cell"
            onClick={() => onPick(week.gameweek)}
            title={`${fixture.label} · FPL difficulty ${fixture.difficulty} — click to transfer ${player.name} out from GW${week.gameweek}`}
            style={{
              display: "grid", placeItems: "center", height: 20, width: "100%",
              cursor: "pointer", border: 0, padding: 0, fontFamily: MONO, fontSize: 9,
              background: WEIGHT[fixture.difficulty] ?? WEIGHT[3],
              color: WEIGHT_INK[fixture.difficulty] ?? WEIGHT_INK[3],
              // A week this player does not make the eleven reads back at half
              // strength: the fixture is still the fact, but he is not in it.
              opacity: startsThisWeek ? 1 : 0.45,
              boxShadow: arriving
                ? `inset 2px 0 0 ${S.agree}`
                : leaving ? `inset 2px 0 0 ${S.conflict}` : undefined,
            }}
          >
            {fixture.label}
          </button>
        );

        if (!isFirst) return <span key={week.gameweek}>{cell}</span>;

        return (
          <span
            key={week.gameweek}
            style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}
          >
            <button
              type="button"
              data-testid="planner-xi-toggle"
              onClick={onToggle}
              title={
                starting
                  ? `starting GW${week.gameweek} — click to bench`
                  : `benched GW${week.gameweek} — click to start`
              }
              aria-label={`${player.name}: ${starting ? "starting" : "benched"} in GW${week.gameweek}`}
              aria-pressed={starting}
              style={{
                flex: "0 0 auto", width: 13, height: 13, padding: 0, cursor: "pointer",
                background: starting ? S.ink : "transparent",
                border: starting ? "none" : `1px solid rgba(27,26,22,.45)`,
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>{cell}</span>
          </span>
        );
      })}
    </div>
  );
}

function ReplacePanel(
  { picking, candidates, query, prices, onQuery, onPick, onClose }: {
    picking: Picking;
    candidates: readonly Projection[];
    query: string;
    prices: ReadonlyMap<number, number>;
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
          GW{picking.gameweek} &middot; replace {picking.player.name} &middot; {picking.player.position}
        </Eyebrow>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="search"
          aria-label={`Search a replacement for ${picking.player.name}`}
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
            No {picking.player.position} in the published projection matches that
            search.
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
        The incoming player is owned from GW{picking.gameweek} onwards. Prices come
        from `player_stats.json`, joined on FPL&apos;s own element id; one without
        a price leaves the bank unknown rather than a plausible wrong number,
        because this is the figure you commit real transfers against.
      </p>
    </div>
  );
}
