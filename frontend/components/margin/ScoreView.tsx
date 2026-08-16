"use client";

/**
 * Score — the multi-gameweek picture, and the part of it nobody has solved.
 *
 * ## What this view is not
 *
 * The design puts an eight-gameweek plan here: every player a row, every week a
 * column, each cell a start, a bench or a sale, with transfers and bank tracked
 * along the bottom. Nothing publishes that. `decision_public_gw{NN}` is one
 * gameweek's proposal; there is no artifact carrying a solved horizon, and no
 * writer for one.
 *
 * Drawing the grid anyway from per-week projections would be the most convincing
 * fabrication in this app: a schedule of starts and sales, laid out with the
 * authority of a solver, assembled by sorting some numbers. So the grid is not
 * drawn. What is drawn is the two things that genuinely exist over a horizon —
 * **the fixture run**, from FPL's own difficulty ratings, and **the captaincy
 * plan** the heuristic engine builds — with the missing solve stated at the top
 * rather than implied by a gap.
 *
 * ## Difficulty is FPL's number, not ours
 *
 * `FixtureMatrixEntry.difficulty` is FPL's own 1–5 rating for *this* club in
 * this fixture. It is not a model output, it is not calibrated against anything
 * we have measured, and the panel says so. It earns its place because a fixture
 * run is the one part of a horizon that is known rather than forecast.
 */

import { useCallback, useMemo } from "react";
import type { FixtureMatrixRow, HeuristicView } from "@/lib/data/heuristics";
import { decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { proven } from "@/lib/data/artifact";
import { PlanGrid } from "@/components/margin/PlanGrid";
import { Planner } from "@/components/margin/Planner";
import { DecideCard } from "@/components/margin/DecideCard";
import { REGISTRY, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { PAPER, MONO, SANS, hatch } from "@/lib/margin/tokens";
import {
  Eyebrow, Hatch, MarginState, WhenProvenHere,
} from "@/components/margin/Marks";

const S = PAPER;

/** How many columns the run is shown over. */
const HORIZON = 8;

/**
 * The five difficulty grades, as ink weight rather than as colour.
 *
 * A red-to-green scale would be the obvious choice and would put the loudest
 * mark on this screen next to the one number on it we did not compute. Weight
 * says the same thing quietly, and keeps the traffic-light vocabulary for the
 * two hues that mean agreement and disagreement everywhere else.
 */
const WEIGHT: Record<number, string> = {
  1: "rgba(27,26,22,.08)",
  2: "rgba(27,26,22,.18)",
  3: "rgba(27,26,22,.32)",
  4: "rgba(27,26,22,.55)",
  5: "rgba(27,26,22,.82)",
};

interface Run {
  readonly team: string;
  readonly shortName: string;
  readonly players: readonly string[];
  readonly row: FixtureMatrixRow;
}

/** The squad's clubs, kindest run first, each carrying the players you own there. */
function runs(view: HeuristicView): readonly Run[] {
  const owned = new Map<string, string[]>();
  for (const player of view.squad?.players ?? []) {
    const list = owned.get(player.team) ?? [];
    list.push(player.name);
    owned.set(player.team, list);
  }
  return view.fixtureMatrix
    .filter((row) => owned.has(row.shortName))
    .map((row) => ({
      team: row.team,
      shortName: row.shortName,
      players: owned.get(row.shortName) ?? [],
      row,
    }));
}

function Cell({ entry }: { entry: FixtureMatrixRow["fixtures"][number] | undefined }) {
  if (!entry) {
    // No fixture published for this club in this week. A blank cell would read
    // as an easy game; the hatch reads as "nothing scheduled", which is what a
    // double gameweek or an unscheduled cup replacement actually leaves behind.
    return (
      <div style={{ padding: "5px 4px", borderLeft: `1px solid rgba(27,26,22,.07)`, display: "grid", placeItems: "center" }}>
        <span style={{ display: "block", width: "100%", height: 15, background: hatch(S) }} title="no fixture scheduled — not an easy one" />
      </div>
    );
  }
  return (
    <div
      style={{
        padding: "5px 4px", borderLeft: `1px solid rgba(27,26,22,.07)`,
        textAlign: "center",
      }}
      title={`${entry.label} · FPL difficulty ${entry.difficulty}`}
    >
      <div style={{ fontFamily: MONO, fontSize: 10, color: S.ink }}>{entry.label}</div>
      <div
        style={{
          margin: "3px auto 0", width: "70%", height: 5,
          background: WEIGHT[entry.difficulty] ?? WEIGHT[3],
        }}
      />
    </div>
  );
}

function FixtureRun({ view, gameweeks }: { view: HeuristicView; gameweeks: readonly number[] }) {
  const rows = useMemo(() => runs(view), [view]);
  const columns = `170px repeat(${gameweeks.length}, minmax(46px, 1fr))`;

  if (rows.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: S.ink2 }}>
        No fixture run could be built: the difficulty grid and the squad did not
        overlap on a single club, which means one of the two failed to load
        rather than that your players have no games.
      </p>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "grid", gridTemplateColumns: columns,
          borderTop: `1px solid rgba(27,26,22,.25)`,
          borderBottom: `1px solid ${S.hair}`,
        }}
      >
        <div style={{ padding: "6px 0", fontFamily: MONO, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: S.ink3 }}>
          Club &middot; who you own
        </div>
        {gameweeks.map((gw) => (
          <div key={gw} style={{ padding: "6px 0", textAlign: "center", borderLeft: `1px solid rgba(27,26,22,.07)` }}>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: S.ink }}>GW{gw}</div>
          </div>
        ))}
      </div>

      {rows.map((run) => (
        <div
          key={run.shortName}
          style={{
            display: "grid", gridTemplateColumns: columns, alignItems: "center",
            borderBottom: `1px solid rgba(27,26,22,.06)`,
          }}
        >
          <div style={{ padding: "5px 8px 5px 0", minWidth: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: S.ink }}>{run.shortName}</div>
            <div
              style={{
                fontFamily: MONO, fontSize: 10, color: S.ink3,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
              title={run.players.join(", ")}
            >
              {run.players.join(" · ")}
            </div>
          </div>
          {gameweeks.map((gw) => (
            <Cell key={gw} entry={run.row.fixtures.find((f) => f.gameweek === gw)} />
          ))}
        </div>
      ))}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginTop: 10, fontFamily: MONO, fontSize: 10, color: S.ink2 }}>
        {[1, 2, 3, 4, 5].map((grade) => (
          <span key={grade} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 14, height: 5, background: WEIGHT[grade] }} />
            {grade}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 10, background: hatch(S) }} />
          nothing scheduled
        </span>
      </div>
    </div>
  );
}

function Captaincy({ view }: { view: HeuristicView }) {
  if (view.captaincy.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: S.ink2 }}>
        No captaincy plan could be built, which needs at least one upcoming
        fixture per player.
      </p>
    );
  }
  return (
    <div>
      {view.captaincy.map((week) => (
        <div
          key={week.gameweek}
          style={{
            display: "grid", gridTemplateColumns: "54px minmax(0,1fr) minmax(0,1fr) 56px",
            gap: 10, alignItems: "baseline", padding: "8px 0",
            borderBottom: `1px solid rgba(27,26,22,.06)`,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>GW{week.gameweek}</span>
          <span style={{ fontSize: 12.5, color: S.ink }}>
            {week.captain.name}
            <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}> {week.captainFixture}</span>
          </span>
          <span style={{ fontSize: 12, color: S.ink2 }}>vice {week.viceCaptain.name}</span>
          <span
            style={{
              fontFamily: MONO, fontSize: 12, textAlign: "right", color: S.ink2,
              borderBottom: `1.5px dotted ${S.ink3}`,
            }}
            title="a heuristic score, not a simulated projection"
          >
            {week.projectedCaptainPoints.toFixed(1)}
          </span>
        </div>
      ))}
      <p style={{ margin: "9px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}>
        Every number in this column is dotted because it comes from the heuristic
        engine, not the simulation. The names are worth reading; the points are a
        ranking key.
      </p>
    </div>
  );
}

export function ScoreView({ gameweek }: { gameweek: number }) {
  const { artifact: heuristics } = useHeuristics();
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek, "season"));
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));
  // The solved horizon, which `decision_public` has carried all along. Null when
  // the run solved a single gameweek — then this screen is what it was.
  const horizon = proven(decision)?.horizon ?? null;
  // Memoised because the `?? []` allocates a new array on every render, and two
  // hooks below depend on it — without this the name map is rebuilt each pass
  // over all 587 projections for a lookup that never changed.
  const players = useMemo(
    () => proven(projections)?.players ?? [], [projections],
  );
  // Prices, for the transfer scratchpad. `player_stats.json` carries FPL's own
  // element id as `player_id`, so this is an exact join rather than a name match.
  const { artifact: stats } = useArtifact(REGISTRY.playerStats);
  // Element id → name, for the call card. The projection is already loaded for
  // the planner, and it carries both, so the card needs no artifact of its own.
  const names = useMemo(() => {
    const out = new Map<number, string>();
    // `name` is nullable on a projection, and a missing one must not become
    // the string "null" under a captaincy.
    for (const player of players) {
      if (player.name !== null) out.set(player.elementId, player.name);
    }
    return out;
  }, [players]);
  const nameOf = useCallback((id: number) => names.get(id) ?? null, [names]);

  const prices = useMemo(() => {
    const out = new Map<number, number>();
    for (const row of (proven(stats) ?? []) as readonly PlayerRow[]) {
      if (row.elementId !== null && row.fpl_price !== null) out.set(row.elementId, row.fpl_price);
    }
    return out;
  }, [stats]);
  const squad = proven(heuristics)?.squad ?? null;
  const gameweeks = useMemo(
    () => Array.from({ length: HORIZON }, (_, index) => gameweek + index),
    [gameweek],
  );

  return (
    <div
      style={{ flex: 1, background: S.shell, color: S.ink, padding: "20px 22px 30px", display: "flex", flexDirection: "column", gap: 22 }}
      data-testid="margin-score"
    >
      {/* The call, in one line, above the plan it changes. It used to be a tab of
          its own — five panels, two of them absent most of the time, holding the
          default view. The answer belongs here; the argument stays at /decide. */}
      <DecideCard gameweek={gameweek} nameOf={nameOf} of={decision} />

      {/* The planner leads. It is what this screen is for, and it needs nothing
          from the engine: the XI is solved from the published projection and the
          run is scheduled rather than forecast. */}
      {squad ? (
        <section>
          <Planner
            squad={squad.players}
            projections={players}
            horizon={proven(projections)?.horizon ?? null}
            decisionDraws={proven(projections)?.nDraws ?? null}
            prices={prices}
            fixtureMatrix={proven(heuristics)?.fixtureMatrix ?? []}
            bank={squad.bank}
            gameweek={gameweek}
          />
        </section>
      ) : (
        <MarginState
          of={heuristics}
          surface={S}
          what="No squad could be read from FPL, so there is nothing to plan with."
        />
      )}

      {horizon ? (
        <div>
          <Eyebrow surface={S} style={{ marginBottom: 10 }}>
            Solved horizon &middot; GW{horizon.weeks[0]?.gameweek}&ndash;GW{horizon.weeks[horizon.weeks.length - 1]?.gameweek}
          </Eyebrow>
          <h1 style={{ margin: 0, fontFamily: SANS, fontSize: 28, lineHeight: 1.12, letterSpacing: "-.035em", fontWeight: 600, color: S.ink, maxWidth: 780 }}>
            Your team over the next {horizon.transferHorizon} gameweeks, and the transfers that get you there.
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.6, color: S.ink2, maxWidth: 780 }}>
            One squad problem solved across {horizon.evalHorizon} weeks at once, with
            transfers decided for the first {horizon.transferHorizon}. The tail is
            evaluated but not planned into — it is there to price the squad you end
            up holding, so the optimiser cannot dump a terrible run one week past
            where it can see.
          </p>
          <div style={{ marginTop: 18 }}>
            <PlanGrid horizon={horizon} projections={players} />
          </div>
        </div>
      ) : (
      /* The engine's own multi-week solve, a different thing from the planner
         above: that one is yours, this one would be the optimiser's. A note
         rather than a headline now — it was the whole screen when the screen had
         nothing else, and opening by refusing while a working planner sits
         underneath reads as a contradiction. */
      <section style={{ borderTop: `1px solid ${S.hair}`, paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Hatch surface={S} width={62} height={12} />
          <Eyebrow surface={S}>The engine has not solved a horizon</Eyebrow>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: S.ink2, maxWidth: 780 }}>
          The planner above is a scratchpad: your moves, your eleven, priced and
          scored against this gameweek. What is absent is the optimiser&apos;s own
          multi-week answer — which players it would sell and when, solved rather
          than chosen. When a run publishes one it appears here as a grid, and
          until then this screen will not assemble one by sorting per-week
          projections, because that would carry a solver&apos;s authority with no
          solve behind it.
        </p>
        <div style={{ marginTop: 12 }}>
          <MarginState
            of={decision}
            surface={S}
            compact
            what={`The single-gameweek proposal for GW${gameweek} is the closest thing published to a plan.`}
          />
        </div>
      </section>

      )}

      <WhenProvenHere
        of={heuristics}
        surface={S}
        what="The live FPL state could not be read, so neither the fixture run nor the captaincy plan can be drawn."
        then={(view) => (
          <>
            <section>
              <Eyebrow surface={S} style={{ marginBottom: 9 }}>
                Fixture run &middot; your clubs &middot; GW{gameweeks[0]}&ndash;GW{gameweeks[gameweeks.length - 1]}
              </Eyebrow>
              <FixtureRun view={view} gameweeks={gameweeks} />
              <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 760 }}>
                Difficulty is FPL&apos;s own 1&ndash;5 rating for your club in each
                fixture, not a model output and not calibrated against anything we
                have measured. It is here because a fixture list is known, which
                almost nothing else over a horizon is.
              </p>
            </section>

            <section>
              <Eyebrow surface={S} style={{ marginBottom: 9 }}>
                Captaincy plan &middot; heuristic engine
              </Eyebrow>
              <Captaincy view={view} />
            </section>
          </>
        )}
      />
    </div>
  );
}
