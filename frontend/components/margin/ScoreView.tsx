"use client";

/**
 * Score — the multi-gameweek picture, and the part of it nobody has solved.
 *
 * ## What this view is not
 *
 * The design puts an eight-gameweek plan here: every player a row, every week a
 * column, each cell a start, a bench or a sale, with transfers and bank tracked
 * along the bottom. Nothing publishes that for this team.
 *
 * Drawing the grid anyway from per-week projections would be the most convincing
 * fabrication in this app: a schedule of starts and sales, laid out with the
 * authority of a solver, assembled by sorting some numbers. So the grid is not
 * drawn. What is drawn is the planner — the reader's own scratchpad, scored
 * against the published projection — plus the two things that genuinely exist
 * over a horizon: **the fixture run**, from FPL's own difficulty ratings, and
 * **the captaincy plan** the heuristic engine builds, dotted throughout because
 * it is a ranking key rather than a simulation.
 *
 * ## Nothing here reads another entry's decision
 *
 * This screen used to open with a `THE CALL · NOT PUBLISHED` banner and close with
 * a refusal to draw a horizon, both reading `decision_public_gw{NN}_season.json`.
 * That artifact belongs to **Ronny**, an automated entry (2561567, see
 * `pipeline/config.py`), not to the owner's team (20945) — the only team this
 * screen displays. So the loudest and the longest elements on a planning screen
 * were both about a cron gate for a team that appears nowhere on it, and had the
 * file ever published, a bot's transfers would have been drawn under the heading
 * "Your team over the next N gameweeks". The read is gone with them.
 *
 * ## Difficulty is FPL's number, not ours
 *
 * `FixtureMatrixEntry.difficulty` is FPL's own 1–5 rating for *this* club in
 * this fixture. It is not a model output, it is not calibrated against anything
 * we have measured, and the panel says so. It earns its place because a fixture
 * run is the one part of a horizon that is known rather than forecast.
 */

import { useMemo } from "react";
import type { FixtureMatrixRow, HeuristicView } from "@/lib/data/heuristics";
import { projectionsDescriptor } from "@/lib/data/projections";
import { proven } from "@/lib/data/artifact";
import { Planner } from "@/components/margin/Planner";
import { REGISTRY, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { PAPER, MONO, SANS, hatch } from "@/lib/margin/tokens";
import {
  Eyebrow, MarginState, WhenProvenHere,
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
            title="a heuristic score, not a simulated projection — already doubled for the armband"
          >
            {week.projectedCaptainPoints.toFixed(1)}
            <span style={{ color: S.ink3 }}>{"  \u00d72"}</span>
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

export function ScoreView(
  { gameweek, captaincyPlan = true, speaksForUnsolvedWeeks = true }: {
    gameweek: number;
    /**
     * Whether to draw the heuristic engine's six-week armband list.
     *
     * `/` passes `false`, and that is the point of the prop rather than a
     * convenience. The front page names **one** captain — the model's argmax over
     * `xp_public_gw{NN}.json`, stated by `GameweekCall` at the top of that page —
     * while this panel names six more from a different engine, on a ranking key
     * already doubled for the armband. Two answers to the single highest-leverage
     * choice of the week is the exact defect the front page exists to remove; see
     * `components/SquadBoard.tsx`'s docstring for the same cut made there.
     *
     * Defaults to `true` so `/margin` keeps rendering it while the two surfaces
     * are compared side by side. The panel and this prop go together, later.
     */
    captaincyPlan?: boolean;
    /** Forwarded to {@link Planner}; see its own docstring for what it governs. */
    speaksForUnsolvedWeeks?: boolean;
  },
) {
  const { artifact: heuristics } = useHeuristics();
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));
  // Memoised because the `?? []` allocates a new array on every render, and the
  // planner below takes it as a prop — a fresh array each pass would re-run its
  // own memos over all 587 projections for a value that never changed.
  const players = useMemo(
    () => proven(projections)?.players ?? [], [projections],
  );
  // Prices, for the transfer scratchpad. `player_stats.json` carries FPL's own
  // element id as `player_id`, so this is an exact join rather than a name match.
  const { artifact: stats } = useArtifact(REGISTRY.playerStats);
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
      {/* One absent artifact, named once.
          `players` is `proven(projections) ?? []`, which erases the state — so a
          missing xp_public rendered as twenty-two per-player nil marks, each
          titled "no rate was fitted here", with the file itself named nowhere
          and no reason given. House rule 2: one absent artifact costs one panel,
          not twenty-two measurements. Rendered above the planner because the
          planner is what it explains. */}
      {players.length === 0 ? (
        <MarginState of={projections}
                     what={`the projection for GW${gameweek}`} surface={S} />
      ) : null}

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
            speaksForUnsolvedWeeks={speaksForUnsolvedWeeks}
          />
        </section>
      ) : (
        <MarginState
          of={heuristics}
          surface={S}
          what="No squad could be read from FPL, so there is nothing to plan with."
        />
      )}

      {/* Neither a solved-horizon grid nor a refusal to draw one.
          Both read `decision_public_gw{NN}_season.json`, which is **Ronny's**
          plan — an automated entry (2561567, `pipeline/config.py`) — and not the
          owner's team (20945), the only team this screen displays. Absent, that
          file put a full-width near-black NOT PUBLISHED banner at the top of his
          planning screen about a cron gate for a team the app does not display;
          present, it would have rendered a bot's transfers under the heading
          "Your team over the next N gameweeks". Neither state was ever about the
          reader.

          The refusal essay went with it. It existed to answer a multi-gameweek
          claim made elsewhere in the app — the deleted heuristic card's "+3.8 pts
          over 4 GW" — and with that claim gone there is nothing left for it to
          answer. The planner above already says in its own footnote that the
          later columns are fixtures rather than a solved eleven. */}

      <WhenProvenHere
        of={heuristics}
        surface={S}
        what={captaincyPlan
          ? "The live FPL state could not be read, so neither the fixture run nor the captaincy plan can be drawn."
          : "The live FPL state could not be read, so the fixture run cannot be drawn."}
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

            {captaincyPlan ? (
              <section>
                <Eyebrow surface={S} style={{ marginBottom: 9 }}>
                  Captaincy plan &middot; heuristic engine
                </Eyebrow>
                <Captaincy view={view} />
              </section>
            ) : null}
          </>
        )}
      />
    </div>
  );
}
