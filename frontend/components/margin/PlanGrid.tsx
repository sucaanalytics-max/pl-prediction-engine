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
import { buildPlanGrid, movesFor, type Cell, type PlanRow } from "@/lib/margin/plan";
import { hatch, MONO, PAPER, SANS } from "@/lib/margin/tokens";
import { Eyebrow, Nil } from "@/components/margin/Marks";

const S = PAPER;

/** `170px` of name, then one column per week, then the starts tally. */
function columns(weeks: number): string {
  return `168px repeat(${weeks}, minmax(44px, 1fr)) 52px`;
}

function CellMark({ cell }: { cell: Cell }) {
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
        position: "relative", height: 26, display: "grid", placeItems: "center",
        borderLeft: `1px solid rgba(27,26,22,.07)`,
      }}
      title={title}
      data-testid="plan-cell"
      data-state={cell.off ? "off" : cell.captain ? "captain" : cell.start ? "start" : "bench"}
    >
      {cell.off ? (
        <span style={{ display: "block", width: "100%", height: 26, background: hatch(S) }} />
      ) : cell.captain ? (
        <span
          style={{
            width: 18, height: 18, borderRadius: "50%",
            border: `1.5px solid ${S.agree}`, display: "grid", placeItems: "center",
            fontFamily: MONO, fontSize: 9, fontWeight: 600, color: S.agree,
          }}
        >
          C
        </span>
      ) : cell.start ? (
        <span style={{ width: 15, height: 15, background: S.ink }} />
      ) : (
        <span style={{ width: 15, height: 15, border: `1px solid rgba(27,26,22,.45)` }} />
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
      <div style={{ padding: "5px 0", fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
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
  { horizon, projections }: {
    horizon: Horizon; projections: readonly Projection[];
  },
) {
  const model = useMemo(
    () => buildPlanGrid(horizon, projections), [horizon, projections],
  );
  const { weeks, rows } = model;
  const grid = columns(weeks.length);

  return (
    <section data-testid="margin-plan-grid">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9, flexWrap: "wrap" }}>
        <Eyebrow surface={S}>
          The plan &middot; GW{weeks[0]?.gameweek}&ndash;GW{weeks[weeks.length - 1]?.gameweek}
        </Eyebrow>
        <Eyebrow surface={S} style={{ letterSpacing: 0, textTransform: "none", fontSize: 10 }}>
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
        <div style={{ padding: "6px 0", fontFamily: MONO, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: S.ink3 }}>
          Player
        </div>
        {weeks.map((week) => (
          <div key={week.gameweek} style={{ padding: "6px 0", textAlign: "center", borderLeft: `1px solid rgba(27,26,22,.07)` }}>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: S.ink }}>
              GW{week.gameweek}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: week.planned ? S.ink3 : S.ink3 }}>
              {week.planned ? "planned" : "eval only"}
            </div>
          </div>
        ))}
        <div style={{ padding: "6px 0", textAlign: "right", fontFamily: MONO, fontSize: 10, textTransform: "uppercase", color: S.ink3 }}>
          Starts
        </div>
      </div>

      {rows.map((row) => (
        <PlanGridRow key={row.elementId} row={row} grid={grid} />
      ))}

      {/* Summaries */}
      <div style={{ marginTop: 8, borderTop: `1px solid rgba(27,26,22,.25)` }}>
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
                ? <Nil surface={S} size={10} />
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
        which is bench-weighted and carries the free-transfer credit.
        {model.unnamed > 0
          ? ` ${model.unnamed} player${model.unnamed === 1 ? " is" : "s are"} shown by id: the projection has no view of them to take a name from.`
          : ""}
      </p>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginTop: 12, fontFamily: MONO, fontSize: 10, color: S.ink2 }}>
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

function PlanGridRow({ row, grid }: { row: PlanRow; grid: string }) {
  return (
    <div
      data-testid="plan-row"
      style={{
        display: "grid", gridTemplateColumns: grid, alignItems: "center",
        borderBottom: `1px solid rgba(27,26,22,.06)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 8px 3px 0", minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3, width: 26 }}>
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
      {row.cells.map((cell) => <CellMark key={cell.gameweek} cell={cell} />)}
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        {row.starts}
      </div>
    </div>
  );
}
