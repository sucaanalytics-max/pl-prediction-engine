"use client";

/**
 * The solved horizon, drawn.
 *
 * Rows are players, columns are gameweeks, and every mark comes from the MILP's
 * own per-week solution — see `lib/margin/plan.ts` for where it was hiding.
 *
 * The two rows the design carries and this does not — `mean, simulated` and
 * `sd` — have no published source. The producer emits a per-week `objective`,
 * which is bench-weighted, vice-weighted and carries the free-transfer credit;
 * printing it under a heading that says "points" would be a relabelling, and
 * this whole surface exists to not do that.
 */

import { useMemo } from "react";
import type { HorizonWeek } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";
import type { Horizon } from "@/lib/data/narrow";
import {
  buildPlanGrid, movesFor, type Cell, type PlanRow, type WeekTotal,
} from "@/lib/margin/plan";
import { indexClubWeeks, weekFor, type ClubWeekIndex } from "@/lib/margin/fdr";
import { difficultyBand } from "@/lib/projections/phases";
import type { PhaseWeek } from "@/lib/projections/phases";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import type { Horizon as XpHorizon } from "@/lib/data/projections";
import { hatch, MONO, FLOODLIT, SANS, TRAFFIC, stepOf } from "@/lib/margin/tokens";
import { Eyebrow, Nil } from "@/components/margin/Marks";

const S = FLOODLIT;

/**
 * `170px` of name, then one column per week, then the starts tally.
 *
 * 44px held a mark and nothing else. A cell now carries a number and an opponent
 * label — `MCI (H)` at 10px is about 52px — so the floor is 66. Below that the
 * label truncates, and a truncated opponent is worse than none: `MCI (H)` and
 * `MCI (A)` differ by the character that gets cut.
 */
function columns(weeks: number): string {
  return `168px repeat(${weeks}, minmax(66px, 1fr)) 52px`;
}

/** The same four-stop ramp `/phases` colours its matrix with. */
const TRAFFIC_STEPS = TRAFFIC.length;

/**
 * The fixture chip under a cell's number.
 *
 * Three states, kept apart on `data-fdr` as well as in colour, because the
 * colour is the part a screenshot loses and the part a colour-blind reader may
 * not resolve:
 *
 * - a fixture: FPL's own 1-5, on the `TRAFFIC` ramp;
 * - `blank`: the club is idle that week. Not a kind fixture. `phases.ts` names
 *   this exact trap — treating an absent difficulty as "not above the threshold"
 *   "invents the softest possible week out of a week that does not exist";
 * - `unknown`: the fixture list could not be read at all. `/api/fpl/state` is a
 *   live route and it has 503'd in production this week, so this is a state that
 *   happens rather than a defensive branch.
 *
 * Neither absence borrows the kind end of the ramp. Both are the hatch and the
 * surface's own dim ink, which is what every other unreadable value here uses.
 */
function FixtureChip({ week, gameweek }: { week: PhaseWeek | null; gameweek: number }) {
  const band = week === null ? null : difficultyBand(week.difficulty, TRAFFIC_STEPS);
  const [background, ink] = band === null
    ? (["transparent", S.ink3] as const)
    : stepOf(TRAFFIC, band);

  const state = week === null ? "unknown" : week.blank ? "blank" : String(week.difficulty);
  const title = week === null
    ? "the fixture list could not be read, so this club's fixture is unknown — not a kind one"
    : week.blank
      ? `GW${gameweek}: blank gameweek — this club has no fixture, which is not the same as an easy one`
      : `GW${gameweek}: ${week.labels.join(" · ")} · FDR ${week.difficulty}${
          week.doubleGameweek ? " (the worst of a double)" : ""
        }`;

  return (
    <span
      data-testid="plan-fixture"
      data-fdr={state}
      title={title}
      style={{
        display: "block", fontFamily: MONO, fontSize: 11, lineHeight: "14px",
        textAlign: "center", background, color: ink,
        whiteSpace: "nowrap", overflow: "hidden",
        // A hatch for both absences, so neither reads as a rating of any kind.
        backgroundImage: band === null ? hatch(S) : undefined,
      }}
    >
      {week === null || week.blank ? "\u2014" : week.labels.join(" · ")}
    </span>
  );
}

function CellMark({ cell, fixture }: { cell: Cell; fixture: PhaseWeek | null }) {
  const title = cell.off
    ? "not in the squad this week — not a zero"
    : cell.captain
      ? "captain"
      : cell.start
        ? (cell.vice ? "starts · vice-captain" : "starts")
        : "benched";

  return (
    <div
      style={{
        position: "relative", display: "grid", gap: 1, padding: "2px 1px",
        borderLeft: `1px solid rgba(27,26,22,.07)`,
      }}
      title={title}
      data-testid="plan-cell"
      data-state={cell.off ? "off" : cell.captain ? "captain" : cell.start ? "start" : "bench"}
    >
      {cell.off ? (
        <span style={{ display: "block", width: "100%", height: 26, background: hatch(S) }} />
      ) : (
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, height: 18 }}>
          {cell.captain ? (
        <span
          style={{
            width: 16, height: 16, borderRadius: "50%",
            border: `1.5px solid ${S.agree}`, display: "grid", placeItems: "center",
            fontFamily: MONO, fontSize: 11, fontWeight: 600, color: S.agree,
          }}
        >
          C
        </span>
          ) : cell.start ? (
            <span style={{ width: 11, height: 11, background: S.ink }} />
          ) : (
            <span style={{ width: 11, height: 11, border: `1px solid rgba(27,26,22,.45)` }} />
          )}

          {/* The number, in the same weight as every other figure here. Null is
              the surface's own nil mark and never `0.0` — a zero is a forecast
              of nothing, and the absence of a forecast is a different claim the
              reader would act on differently. */}
          <span
            style={{
              fontFamily: MONO, fontSize: 11.5,
              fontWeight: cell.captain ? 500 : 400,
              color: cell.bench ? S.ink3 : S.ink,
            }}
          >
            {cell.xp === null ? <Nil surface={S} size={11} /> : cell.xp.toFixed(1)}
          </span>
        </span>
      )}

      {/* Enter and exit sit on the edge of the week they happen in, in the two
          hues that mean agreement and disagreement everywhere else. */}
      {cell.enter ? (
        <span
          title="transferred in this week"
          style={{
            position: "absolute", left: -5, top: 3, fontFamily: MONO,
            fontSize: 12, color: S.agree, lineHeight: 1,
          }}
        >
          &#9656;
        </span>
      ) : null}
      {cell.exit ? (
        <span
          title="transferred out this week"
          style={{
            position: "absolute", left: -5, top: 3, fontFamily: MONO,
            fontSize: 12, color: S.conflict, lineHeight: 1,
          }}
        >
          &#9666;
        </span>
      ) : null}

      <FixtureChip week={fixture} gameweek={cell.gameweek} />
    </div>
  );
}

function SummaryRow(
  { label, weeks, render }: {
    label: string;
    weeks: readonly HorizonWeek[];
    render: (week: HorizonWeek) => React.ReactNode;
  },
) {
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: columns(weeks.length),
        borderBottom: `1px solid rgba(27,26,22,.06)`,
      }}
    >
      <div style={{ padding: "5px 0", fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
        {label}
      </div>
      {weeks.map((week) => (
        <div
          key={week.gameweek}
          style={{
            padding: "5px 2px", textAlign: "center",
            borderLeft: `1px solid rgba(27,26,22,.07)`,
            fontFamily: MONO, fontSize: 11, color: S.ink,
          }}
        >
          {/* A week the solve planned no transfers into must not print a
              transfer count it never chose. */}
          {week.planned ? render(week) : (
            <span
              title="evaluated but not transferred into — the solve prices this week, it does not plan it"
              style={{ display: "block", height: 12, background: hatch(S) }}
            />
          )}
        </div>
      ))}
      <div />
    </div>
  );
}

export function PlanGrid(
  { horizon, projections, fixtures = [], xpHorizon = null }: {
    horizon: Horizon;
    projections: readonly Projection[];
    /**
     * FPL's fixture list, from `/api/fpl/state`.
     *
     * Defaulted to empty rather than required: it comes from a live route while
     * everything else here comes from a published artifact, so the grid has to
     * draw without it. Every club then reads `unknown`, which is true.
     */
    fixtures?: readonly FixtureMatrixRow[];
    /** The per-player xP horizon off `xp_public`. Null when none was solved. */
    xpHorizon?: XpHorizon | null;
  },
) {
  const model = useMemo(
    () => buildPlanGrid(horizon, projections, xpHorizon),
    [horizon, projections, xpHorizon],
  );
  const { weeks, rows, totals } = model;
  const grid = columns(weeks.length);
  const clubs: ClubWeekIndex = useMemo(
    () => indexClubWeeks(fixtures, weeks.map((w) => w.gameweek)),
    [fixtures, weeks],
  );
  const teamOf = useMemo(() => {
    const byId = new Map<number, string | null>();
    for (const p of projections) byId.set(p.elementId, p.team);
    return byId;
  }, [projections]);

  return (
    <section data-testid="margin-plan-grid">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9, flexWrap: "wrap" }}>
        <Eyebrow surface={S}>
          The plan &middot; GW{weeks[0]?.gameweek}&ndash;GW{weeks[weeks.length - 1]?.gameweek}
        </Eyebrow>
        <Eyebrow surface={S} style={{ letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
          transfers planned {model.transferHorizon} of {model.evalHorizon} weeks
        </Eyebrow>
      </div>

      {/* Header */}
      <div
        style={{
          display: "grid", gridTemplateColumns: grid,
          borderTop: `1px solid rgba(27,26,22,.25)`,
          borderBottom: `1px solid ${S.hair}`,
        }}
      >
        <div style={{ padding: "6px 0", fontFamily: MONO, fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: S.ink3 }}>
          Player
        </div>
        {weeks.map((week) => (
          <div key={week.gameweek} style={{ padding: "6px 0", textAlign: "center", borderLeft: `1px solid rgba(27,26,22,.07)` }}>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: S.ink }}>
              GW{week.gameweek}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: week.planned ? S.ink3 : S.ink3 }}>
              {week.planned ? "planned" : "eval only"}
            </div>
          </div>
        ))}
        <div style={{ padding: "6px 0", textAlign: "right", fontFamily: MONO, fontSize: 11, textTransform: "uppercase", color: S.ink3 }}>
          Starts
        </div>
      </div>

      {rows.map((row) => (
        <PlanGridRow
          key={row.elementId}
          row={row}
          grid={grid}
          fixtureFor={(gameweek) =>
            weekFor(clubs, teamOf.get(row.elementId), gameweek)}
        />
      ))}

      {/* Summaries */}
      <div style={{ marginTop: 8, borderTop: `1px solid rgba(27,26,22,.25)` }}>
        {/* Not a `SummaryRow`: that one hatches the eval-only tail, because a
            transfer count is a thing the solve chose. An XI total is not — the
            tail's eleven is priced by the same solve, and hatching it would
            hide a number that is as real as the rest. */}
        <div
          style={{
            display: "grid", gridTemplateColumns: grid,
            borderBottom: `1px solid rgba(27,26,22,.06)`,
          }}
        >
          <div style={{ padding: "5px 0", fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
            XI xP
          </div>
          {totals.map((total) => (
            <TotalCell key={total.gameweek} total={total} />
          ))}
          <div />
        </div>
        <SummaryRow
          label="transfers · hits"
          weeks={weeks}
          render={(w) => (
            <span>
              {w.transfers_in.length} &middot; {w.hits === 0 ? "0" : `−${w.hits * 4}`}
            </span>
          )}
        />
        <SummaryRow
          label="bank · FT after"
          weeks={weeks}
          render={(w) => (
            <span>
              {(w.bank_after / 10).toFixed(1)}
              {" · "}
              {w.free_transfers_after === null
                ? <Nil surface={S} size={11} />
                : w.free_transfers_after}
            </span>
          )}
        />
      </div>

      {/* The moves, in words. */}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
        {weeks.filter((w) => w.transfers_in.length || w.transfers_out.length).map((week) => {
          const moves = movesFor(week, rows);
          return (
            <span key={week.gameweek} style={{ fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
              <span style={{ color: S.ink3 }}>GW{week.gameweek}</span>{" "}
              <span style={{ color: S.conflict }}>{moves.out.join(", ") || "—"}</span>
              {" → "}
              <span style={{ color: S.agree }}>{moves.in.join(", ") || "—"}</span>
            </span>
          );
        })}
      </div>

      <p style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 780 }}>
        Only GW{weeks[0]?.gameweek} is a commitment. The rest exists to inform it
        and is re-solved from scratch every week against fresh prices, injuries
        and projections — publishing week three as a decision would be false
        precision.
        {" "}
        No simulated mean or standard deviation is published per week, so those
        rows are absent rather than filled with the solver&apos;s objective,
        which is bench-weighted and carries the free-transfer credit. The
        <b> XI xP</b> row is the plain sum of the eleven in the column above it,
        with no armband doubling and no bench, so it can be checked by adding
        them up.
        {" "}
        GW{weeks[0]?.gameweek}&apos;s figures come from the decision&apos;s own
        simulation
        {xpHorizon?.nDraws
          ? ` and every later week from the horizon's ${xpHorizon.nDraws.toLocaleString()} draws, which is the coarser of the two`
          : ", and no horizon was published, so later weeks carry no figure"}.
        {" "}
        Fixture colours are FPL&apos;s own FDR, 1&ndash;5, on the same ramp as
        Phases &mdash; published, not simulated, and not a points forecast. A
        hatched chip is a blank gameweek or a fixture list that could not be
        read; neither is an easy fixture.
        {model.unnamed > 0
          ? ` ${model.unnamed} player${model.unnamed === 1 ? " is" : "s are"} shown by id: the projection has no view of them to take a name from.`
          : ""}
      </p>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginTop: 12, fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 13, height: 13, background: S.ink }} />start
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 13, height: 13, border: `1px solid rgba(27,26,22,.45)` }} />bench
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 15, height: 15, borderRadius: "50%", border: `1.5px solid ${S.agree}` }} />captain
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 12, background: hatch(S) }} />not owned
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: S.agree }}>&#9656;</span>in
          <span style={{ color: S.conflict, marginLeft: 8 }}>&#9666;</span>out
        </span>
      </div>
    </section>
  );
}

/**
 * One column's XI total.
 *
 * `missing` is on the title rather than buried: a total quietly short of two
 * players is a wrong number, and the only place that can say so is here. The
 * figure itself stays legible so the column still adds up by eye, which is the
 * entire warrant for showing a total at all — see `WeekTotal` for what this is
 * deliberately not.
 */
function TotalCell({ total }: { total: WeekTotal }) {
  const short = total.missing > 0;
  return (
    <div
      data-testid={`plan-total-${total.gameweek}`}
      title={short
        ? `${total.counted} of ${total.counted + total.missing} in the XI have a projection; ${total.missing} missing, so this total is short`
        : `all ${total.counted} in the XI have a projection`}
      style={{
        padding: "5px 2px", textAlign: "center",
        borderLeft: `1px solid rgba(27,26,22,.07)`,
        fontFamily: MONO, fontSize: 11.5, fontWeight: 500,
        color: short ? S.ink3 : S.ink,
      }}
    >
      {total.counted === 0 ? <Nil surface={S} size={11} /> : total.xp.toFixed(1)}
      {short ? <span style={{ color: S.conflict }}>&nbsp;&lowast;</span> : null}
    </div>
  );
}

function PlanGridRow(
  { row, grid, fixtureFor }: {
    row: PlanRow;
    grid: string;
    fixtureFor: (gameweek: number) => PhaseWeek | null;
  },
) {
  return (
    <div
      data-testid="plan-row"
      data-player={row.name}
      style={{
        display: "grid", gridTemplateColumns: grid, alignItems: "center",
        borderBottom: `1px solid rgba(27,26,22,.06)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 8px 3px 0", minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3, width: 26 }}>
          {row.position || "—"}
        </span>
        <span
          style={{
            fontFamily: SANS, fontSize: 12.5, color: S.ink,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {row.name}
        </span>
      </div>
      {row.cells.map((cell) => (
        <CellMark
          key={cell.gameweek}
          cell={cell}
          fixture={fixtureFor(cell.gameweek)}
        />
      ))}
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        {row.starts}
      </div>
    </div>
  );
}
