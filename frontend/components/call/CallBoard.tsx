"use client";

/**
 * The call — the whole screen, wired to the two artifacts it needs.
 *
 * Reads the live squad and this gameweek's projection, joins them with the one
 * join this app has (`joinProjections`, on FPL's own element id), solves the
 * eleven with the one solver it has (`optimiseXi`, exhaustive over legal
 * formations), and lets the reader edit the result.
 *
 * ## The bench set is the only state
 *
 * Everything else is derived from it. That is deliberate: a screen that stored a
 * total alongside the eleven it came from can show a total that does not match
 * the eleven on screen, which is the class of bug that had two surfaces printing
 * different sums for one squad. Here there is nowhere for a stale total to live.
 *
 * The set starts empty and means "use the optimiser's answer". The first click
 * seeds it from the optimum's bench and then applies the click, so one click
 * benches one player rather than discarding the solve — the same reseeding
 * `components/margin/Planner.tsx` does, and for the same reason.
 *
 * ## What it refuses to do
 *
 * Suggest a transfer. `xp_public` covers one gameweek, so a swap's gain is
 * computable for this week alone, and a sale priced on one week is the most
 * confident wrong number this app could print. The transfer tile says so.
 *
 * Claim a future eleven. The rail's horizon table draws per-player projections
 * for the weeks the file carries; the solved plan for the weeks that were
 * actually solved is `PlanGridSection`, from the decision artifact, below.
 */

import { useMemo, useState } from "react";

import { proven } from "@/lib/data/artifact";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import {
  COUNTING_RULE, asPickedTotal, optimiseXi, pointsFrom, projectedTotal, xiProblems,
} from "@/lib/margin/planner";
import { joinProjections, type SquadRow } from "@/lib/margin/squad";
import { FLOODLIT, MONO } from "@/lib/margin/tokens";
import { EYEBROW } from "@/lib/margin/type";
import { calloutsFor, shapeOf, swapFrom, swapSentence } from "@/lib/call/board";
import { Eleven } from "@/components/call/Eleven";
import { Pitch, type PitchMode } from "@/components/call/Pitch";
import { Rail, type HorizonScale } from "@/components/call/Rail";
import { Tiles } from "@/components/call/Tiles";

const S = FLOODLIT;

function Line({ children }: { children: React.ReactNode }) {
  // One line, never a panel: the rule from the usable-surface spec is that an
  // absence must not occupy more space than the substance it replaces.
  return (
    <p data-weight="line" style={{
      fontFamily: MONO, fontSize: 11, color: S.ink3, margin: 0,
    }}>
      {children}
    </p>
  );
}

export function CallBoard({ gameweek }: { readonly gameweek: number }) {
  const { artifact: liveArtifact } = useHeuristics();
  const { artifact: projectionsArtifact } = useArtifact(projectionsDescriptor(gameweek));

  const live = proven(liveArtifact);
  const projections = proven(projectionsArtifact);

  const [benched, setBenched] = useState<ReadonlySet<number>>(new Set());
  const [mode, setMode] = useState<PitchMode>("xp");
  /**
   * Table first, pitch second.
   *
   * Five of seven reviewers put a sortable table ahead of every alternative,
   * for five unrelated reasons — comparison rides on position, it survives being
   * used at speed, it matches the spreadsheet already being kept, it is calm, and
   * it reuses the grammar `HeatGrid` proves at 609 rows. The pitch answers "what
   * shape am I playing", which is real but asked less often, and it cannot be
   * sorted, which is the operation this screen exists for.
   */
  const [view, setView] = useState<"table" | "pitch">("table");
  const [scale, setScale] = useState<HorizonScale>("absolute");

  const squad = live?.squad ?? null;
  const players = projections?.players ?? [];

  const solved = useMemo(() => {
    if (squad === null || players.length === 0) return null;
    const points = pointsFrom(players);
    const best = optimiseXi(squad.players, points);
    if (best === null) return null;
    return { points, best };
  }, [squad, players]);

  const board = useMemo(() => {
    if (squad === null || solved === null) return null;
    const { points, best } = solved;

    // The eleven on screen: the optimum until the reader edits it, then the
    // squad minus whoever they have benched.
    const xi = benched.size === 0
      ? best.xi
      : squad.players.filter(
        (player) => player.elementId !== undefined && !benched.has(player.elementId),
      );
    const onBench = squad.players.filter((player) => !xi.includes(player));

    const join = joinProjections(squad.players, players);
    const rowOf = new Map<string, SquadRow>();
    for (const row of join.rows) {
      rowOf.set(String(row.player.elementId ?? row.player.name), row);
    }
    const rowsFor = (list: readonly typeof squad.players[number][]) => list
      .map((player) => rowOf.get(String(player.elementId ?? player.name)))
      .filter((row): row is SquadRow => row !== undefined);

    const starterRows = rowsFor(xi);
    const benchRows = rowsFor(onBench);

    // The captain is the optimiser's, and only while he is actually in the eleven
    // the reader is looking at. Benching him must not leave an armband on a
    // player who is not playing.
    const captain = best.captain !== null && xi.includes(best.captain)
      ? best.captain
      : null;
    const captainRow = captain === null
      ? null
      : starterRows.find((row) => row.player === captain) ?? null;

    // What to change to get from the eleven FPL has to the eleven on screen.
    // Compared on the player OBJECTS, never on names — FPL has six Wilsons.
    const swap = swapFrom(squad.players, xi);

    return {
      swap,
      swapLine: swapSentence(swap),
      xi,
      starterRows,
      benchRows,
      captain,
      captainRow,
      // `projectedTotal`, so the counting rule is the shared one. `best.total`
      // double-counts the captain as a comparison key and must never be printed.
      total: projectedTotal(xi, points),
      asPicked: asPickedTotal(squad.players, points),
      shape: shapeOf(xi),
      problems: xiProblems(xi),
      callouts: calloutsFor(starterRows, join.rows),
      unprojected: join.unmatched,
      matchedByName: join.matchedByName,
    };
  }, [squad, solved, benched, players]);

  const toggle = (row: SquadRow) => {
    const id = row.player.elementId;
    if (id === undefined) return;
    setBenched((was) => {
      const seed = was.size === 0
        ? new Set(
          (solved?.best.bench ?? [])
            .map((player) => player.elementId)
            .filter((value): value is number => value !== undefined),
        )
        : new Set(was);
      if (seed.has(id)) seed.delete(id);
      else seed.add(id);
      return seed;
    });
  };

  if (squad === null) {
    return <Line>No squad could be read, so there is no call to make.</Line>;
  }
  if (players.length === 0) {
    return (
      <Line>
        {projectionsArtifact.reason
          ?? `The GW${gameweek} projection this call is computed from could not be read.`}
      </Line>
    );
  }
  if (board === null) {
    return <Line>The projection does not cover enough of the squad to pick an XI.</Line>;
  }

  return (
    <div>
      <Tiles
        total={board.total}
        asPicked={board.asPicked}
        shape={board.shape}
        captainName={board.captain?.name ?? null}
        captainXp={board.captainRow?.projection?.xp ?? null}
        captainHaul={board.captainRow?.projection?.pGe10 ?? null}
        squadValue={squad.value}
        bank={squad.bank}
        /* Null, and the tile says "unknown" rather than "1".
           Nothing publishes the free-transfer count: the planner asks the reader
           for it, because `transferCost` propagates null rather than assuming,
           and charging a reader four points for a hit they may not be taking is
           worse than saying the cost is unknown. The design's tile read "1 free
           transfer"; that was prototype data, and printing it here would be a
           fabricated number in the one place a reader checks before spending. */
        freeTransfers={null}
        /* This component called `projectedTotal`, so this component states how it
           counted. `Tiles` renders the words and asserts nothing about them. */
        countingRule={COUNTING_RULE}
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 420px)",
        borderBottom: `1px solid ${S.rule}`,
      }}
        // The rail drops under the pitch rather than squeezing it, because a
        // 150px tile cannot narrow and the pitch is the answer.
        className="call-board"
      >
        <div style={{ borderRight: `1px solid ${S.rule}`, minWidth: 0 }}>
          <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
            padding: "10px 14px", background: S.bar,
            borderBottom: `1px solid ${S.hair}`,
          }}>
            <span style={{ ...EYEBROW, color: S.ink3 }}>The eleven</span>

            {/* The instruction, beside the delta it explains. The tile says the
                optimum is worth more; without this it never says how. */}
            {board.swapLine === null ? (
              <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
                {board.swap.known
                  ? "already the best eleven from this squad"
                  : "no lineup on file to compare against"}
              </span>
            ) : (
              <span data-testid="swap-line" style={{
                fontFamily: MONO, fontSize: 10.5, color: S.ink2,
              }}>
                to match it: <span style={{ color: S.brand }}>{board.swapLine}</span>
              </span>
            )}

            <span style={{ flexGrow: 1 }} />
            <span style={{ display: "flex", border: `1px solid ${S.rule}` }}>
              {([["table", "table"], ["pitch", "pitch"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={view === key}
                  style={{
                    padding: "4px 9px", fontSize: 10.5,
                    fontWeight: view === key ? 600 : 400,
                    background: view === key ? "rgba(233,238,245,.10)" : "transparent",
                    color: view === key ? S.ink : S.ink3,
                    // No `border: 0` after this. React assigns style keys in insertion
                // order, so the shorthand landed last and reset the divider to
                // none — the two segments read as one box. Tailwind preflight
                // already zeroes every border, which is why the sibling controls
                // in PhaseMatrix and StatsTable, which omit it, DO show theirs.
                borderRight: `1px solid ${S.rule}`, cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>

          {view === "table" ? (
            <div style={{ padding: "0 8px 10px" }}>
              <Eleven
                starters={board.starterRows}
                bench={board.benchRows}
                captainId={board.captain?.elementId ?? null}
                bringIn={board.swap.bringIn}
                sitDown={board.swap.sitDown}
                onToggle={toggle}
              />
            </div>
          ) : (
            <Pitch
              starters={board.starterRows}
              bench={board.benchRows}
              captainId={board.captain?.elementId ?? null}
              mode={mode}
              onMode={setMode}
              onToggle={toggle}
            />
          )}
        </div>
        <Rail
          callouts={board.callouts}
          starters={board.starterRows}
          horizon={projections?.horizon ?? null}
          currentGameweek={projections?.gameweek ?? gameweek}
          scale={scale}
          onScale={setScale}
        />
      </div>

      {/* The two things that can be wrong about the eleven above, each in one
          line. `xiProblems` exists because an illegal XI once printed a projected
          total with no complaint — the per-line minima sum to seven, so any size
          from 7 to 14 passed every check. */}
      {board.problems.length > 0 ? (
        <p style={{
          fontFamily: MONO, fontSize: 11, color: S.conflict, margin: "10px 0 0",
        }} data-testid="xi-problems">
          This eleven is not legal: {board.problems.map((problem) => (
            problem.line === null
              ? `${problem.have} players, ${problem.need}`
              : `${problem.have} ${problem.line}, ${problem.need}`
          )).join("; ")}.
        </p>
      ) : null}
      {/* The gameweek, named ONCE, beside the file it was read from.
          The page chrome deliberately carries no gameweek literal — a hardcoded
          "GW1" is wrong for 37 weeks of 38 and cannot 404 to tell anyone — so this
          is where the reader learns which week they are looking at, and it names
          the artifact so the number can be checked rather than trusted. */}
      <p style={{
        fontFamily: MONO, fontSize: 10.5, color: S.ink3, margin: "10px 0 0",
      }} data-testid="call-provenance">
        GW{projections?.gameweek ?? gameweek} · from fpl/xp_public_gw
        {String(projections?.gameweek ?? gameweek).padStart(2, "0")}.json
        {projections?.nDraws === null || projections?.nDraws === undefined
          ? ""
          : ` · ${projections.nDraws.toLocaleString("en-GB")} draws`}
      </p>

      {board.unprojected > 0 ? (
        <p style={{
          fontFamily: MONO, fontSize: 11, color: S.ink3, margin: "6px 0 0",
        }}>
          {board.unprojected} of your fifteen could not be matched to a projection and
          are scored as nothing in these totals.
          {board.matchedByName > 0
            ? ` ${board.matchedByName} were matched by name rather than by id, which is a weaker claim.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
