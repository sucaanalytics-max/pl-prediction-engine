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
  buildPlanGrid, type Cell, type PlanRow, type WeekTotal,
} from "@/lib/margin/plan";
import { indexClubWeeks, weekFor, type ClubWeekIndex } from "@/lib/margin/fdr";
import type { PhaseWeek } from "@/lib/projections/phases";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import type { Horizon as XpHorizon } from "@/lib/data/projections";
import {
  hatch, MONO, FLOODLIT, SANS, difficultyTint, positionHue,
} from "@/lib/margin/tokens";
import { ageLine } from "@/lib/formats";
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

/**
 * The fixture chip under a cell's number.
 *
 * Three states, kept apart on `data-fdr` as well as in colour, because the
 * colour is the part a screenshot loses and the part a colour-blind reader may
 * not resolve:
 *
 * - a fixture: FPL's own 1-5, on `difficultyTint`;
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
  // `difficultyTint`, not the `TRAFFIC` ramp. TRAFFIC is built for the
  // twenty-club matrix on /phases, where the colour IS the content and no number
  // shares the cell. Here every chip sits under an xP, and a saturated fill
  // under each of 168 numbers competes with the thing it is meant to support —
  // which is what made this grid unreadable. `difficultyTint` is the app's own
  // answer for a fixture chip beside a number, and the call screen already uses
  // it, so this also stops one quantity being painted two ways on one app.
  const known = week !== null && !week.blank && week.difficulty !== null;
  const [background, ink] = known
    ? difficultyTint(week.difficulty, S)
    : (["transparent", S.ink3] as const);

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
        backgroundImage: known ? undefined : hatch(S),
      }}
    >
      {week === null || week.blank ? "\u2014" : week.labels.join(" · ")}
    </span>
  );
}

function CellMark({ cell, fixture }: { cell: Cell; fixture: PhaseWeek | null }) {
  const title = cell.unplanned
    ? "in the squad; no plan has been solved for this week, so nothing here says whether he starts"
    : cell.off
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
      data-state={
        cell.off ? "off"
          : cell.unplanned ? "held"
          : cell.captain ? "captain"
          : cell.start ? "start"
          : "bench"
      }
    >
      {cell.off ? (
        <span style={{ display: "block", width: "100%", height: 26, background: hatch(S) }} />
      ) : (
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, height: 18 }}>
          {cell.unplanned ? null : cell.captain ? (
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
  {
    horizon, projections, fixtures = [], xpHorizon = null,
    sealed = true, solvedAt = null, prices,
  }: {
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
    /**
     * Selling and buying prices by element id, off `playerStats`.
     *
     * A THIRD artifact — the plan and the projection are the other two — so it
     * is optional and a miss renders no price rather than a zero. `PlayerRow`
     * carries `fpl_price` and its own docstring says the id join exists so "the
     * planner can price a transfer instead of leaving the bank unknown".
     */
    prices?: ReadonlyMap<number, number | null>;
    /**
     * Whether this is the committed plan or a midweek re-solve.
     *
     * Defaults to sealed, matching the narrower: every artifact written before
     * the producer emitted the field came from the seal.
     */
    sealed?: boolean;
    /** When the solve ran, for the age line. */
    solvedAt?: string | null;
  },
) {
  const model = useMemo(
    () => buildPlanGrid(horizon, projections, xpHorizon),
    [horizon, projections, xpHorizon],
  );
  const { weeks, rows, totals } = model;
  // Nothing was solved when no week names an eleven. The grid still draws — the
  // squad, its numbers and its fixtures do not depend on a solve — but every
  // claim the solve would have made is withheld rather than faked.
  const solved = weeks.some((w) => w.xi.length > 0);
  const grid = columns(weeks.length);
  const clubs: ClubWeekIndex = useMemo(
    () => indexClubWeeks(fixtures, weeks.map((w) => w.gameweek)),
    [fixtures, weeks],
  );
  const nameOf = useMemo(() => {
    const byId = new Map<number, string>();
    for (const p of projections) if (p.name) byId.set(p.elementId, p.name);
    return byId;
  }, [projections]);
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
        {!solved ? null : (
          <Eyebrow surface={S} style={{ letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
            transfers planned {model.transferHorizon} of {model.evalHorizon} weeks
          </Eyebrow>
        )}
      </div>

      {/* Which plan this is, and how old.

          The agent solves on every refresh, so this grid is populated all week
          and most of what it draws will disagree with itself as team news lands.
          Only the solve inside the seal window is the commitment the forecast
          was sealed against, and the cells cannot show the difference — so the
          header does.

          Age via `ageLine`, the helper every other provenance line here uses. It
          already handles a future stamp and the point past a week where a
          weekday names two days; a second formatter would drift from it. */}
      <div
        data-testid="plan-provenance"
        style={{ marginBottom: 9, fontFamily: MONO, fontSize: 11, color: S.ink3 }}
      >
        {!solved
          ? "your squad and its fixtures — no plan has been solved for these weeks yet"
          : sealed
            ? "the sealed plan for this deadline"
            : "provisional — re-solved every few hours until the deadline"}
        {ageLine(solvedAt) ? ` · solved ${ageLine(solvedAt)}` : null}
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
            {/* Both labels describe what the SOLVE did with the week, so
                neither is sayable when there was no solve. */}
            {!solved ? null : (
              <div style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
                {week.planned ? "planned" : "eval only"}
              </div>
            )}
          </div>
        ))}
        <div style={{ padding: "6px 0", textAlign: "right", fontFamily: MONO, fontSize: 11, textTransform: "uppercase", color: S.ink3 }}>
          Starts
        </div>
      </div>

      {LINES.flatMap(([position, label]) => {
        const line = rows.filter((r) => r.position === position);
        if (line.length === 0) return [];
        return [
          <BandHead key={`band-${position}`} position={position} label={label} />,
          ...line.map((row) => (
            <PlanGridRow
              key={row.elementId}
              row={row}
              grid={grid}
              fixtureFor={(gameweek) =>
                weekFor(clubs, teamOf.get(row.elementId), gameweek)}
              solved={solved}
            />
          )),
        ];
      })}
      {/* A row whose position the projection never reported still belongs on the
          grid — it is in the squad. It sits after the four lines rather than
          under a heading that would state a line nobody published. */}
      {rows.filter((r) => !LINES.some(([p]) => p === r.position)).map((row) => (
        <PlanGridRow
          key={row.elementId}
          row={row}
          grid={grid}
          fixtureFor={(gameweek) =>
            weekFor(clubs, teamOf.get(row.elementId), gameweek)}
          solved={solved}
        />
      ))}

      {/* Summaries */}
      <div style={{ marginTop: 8, borderTop: `1px solid rgba(27,26,22,.25)` }}>
        {/* Not a `SummaryRow`: that one hatches the eval-only tail, because a
            transfer count is a thing the solve chose. An XI total is not — the
            tail's eleven is priced by the same solve, and hatching it would
            hide a number that is as real as the rest.

            Absent entirely with no solve behind it. Summing fifteen owned
            players under a heading that says XI would be a different quantity
            wearing the right label. */}
        {!solved ? null : <div
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
        </div>}
        {!solved ? null : <SummaryRow
          label="transfers · hits"
          weeks={weeks}
          render={(w) => (
            <span>
              {w.transfers_in.length} &middot; {w.hits === 0 ? "0" : `−${w.hits * 4}`}
            </span>
          )}
        />}
        {!solved ? null : <SummaryRow
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
        />}
      </div>

      <Transfers
        weeks={weeks}
        nameOf={(id) => nameOf.get(id) ?? `#${id}`}
        prices={prices}
      />

      <p style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3, maxWidth: 780 }}>
        {!solved
          ? "No plan has been solved for these weeks yet, so nothing here says who starts, who is benched or what to transfer — only what the squad is projected to score and who it plays. The agent solves on every refresh; this fills in on its next run."
          : <>Only GW{weeks[0]?.gameweek} is a commitment. The rest exists to inform it
        and is re-solved from scratch every week against fresh prices, injuries
        and projections — publishing week three as a decision would be false
        precision.</>}
        {" "}
        No simulated mean or standard deviation is published per week, so those
        rows are absent rather than filled with the solver&apos;s objective,
        which is bench-weighted and carries the free-transfer credit.
        {/* Only when the row it describes is on screen. A footnote explaining a
            heading the reader cannot see is the same stale copy as a colour note
            naming a ramp the grid no longer uses. */}
        {!solved ? null : (
          <>
            {" "}The <b>XI xP</b> row is the plain sum of the eleven in the column
            above it, with no armband doubling and no bench, so it can be checked
            by adding them up.
          </>
        )}
        {" "}
        GW{weeks[0]?.gameweek}&apos;s figures come from the decision&apos;s own
        simulation
        {xpHorizon?.nDraws
          ? ` and every later week from the horizon's ${xpHorizon.nDraws.toLocaleString()} draws, which is the coarser of the two`
          : ", and no horizon was published, so later weeks carry no figure"}.
        {" "}
        Fixture colours are FPL&apos;s own FDR, 1&ndash;5, on the same tint the
        call screen uses &mdash; published, not simulated, and not a points forecast. A
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

/**
 * The moves, as a section rather than a run-on line.
 *
 * This was one wrapped paragraph of `GW4 out → in` fragments carrying no cost,
 * no bank and no prices. It is the half of the plan a human actually executes —
 * everything above it is what the plan is WORTH, this is what they have to go
 * and do — so it gets its own block, one row per week that moves.
 *
 * The quiet weeks are named rather than omitted. Silence would read as "nothing
 * planned for GW5"; the solve did price GW5, it chose not to transfer into it,
 * and those are different statements.
 */
function Transfers(
  { weeks, nameOf, prices }: {
    weeks: readonly HorizonWeek[];
    /** Off the PROJECTION, not the row list — see the sold-player case below. */
    nameOf: (elementId: number) => string;
    prices?: ReadonlyMap<number, number | null>;
  },
) {
  const moved = weeks.filter((w) => w.transfers_in.length || w.transfers_out.length);
  const quiet = weeks.filter((w) => !w.transfers_in.length && !w.transfers_out.length);
  if (moved.length === 0) return null;

  const hits = moved.reduce((n, w) => n + w.hits, 0);
  const priced = (ids: readonly number[], colour: string) =>
    ids.map((id) => {
      const price = prices?.get(id);
      // Names come from the projection, never from `rows`. A player sold in the
      // first planned week is in NO week's squad — week 0's squad is already
      // post-transfer — so he has no row, and reading names off the rows printed
      // "#152 → Tavernier" on the real board. The projection has all 652.
      const name = nameOf(id);
      return (
        <span key={id} style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontFamily: SANS, fontSize: 12.5, color: colour }}>{name}</span>
          {typeof price === "number" ? (
            <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
              &pound;{price.toFixed(1)}
            </span>
          ) : null}
        </span>
      );
    });

  return (
    <div style={{ marginTop: 20, borderTop: `1px solid ${S.rule}`, paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <Eyebrow surface={S}>Transfers</Eyebrow>
        <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
          {moved.length} {moved.length === 1 ? "move" : "moves"}
          {" · "}
          {hits === 0 ? "no hits" : `−${hits * 4} in hits`}
        </span>
      </div>

      {moved.map((week) => (
        <div
          key={week.gameweek}
          data-testid="plan-move"
          style={{
            display: "grid",
            gridTemplateColumns: "52px 1fr 18px 1fr 60px 124px",
            alignItems: "center", gap: 12,
            padding: "10px 0", borderBottom: `1px solid rgba(27,26,22,.06)`,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink2 }}>
            GW{week.gameweek}
          </span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            {priced(week.transfers_out, S.conflict)}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: S.ink3, textAlign: "center" }}>
            &rarr;
          </span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            {priced(week.transfers_in, S.agree)}
          </span>
          <span style={{
            fontFamily: MONO, fontSize: 12,
            color: week.hits === 0 ? S.ink3 : S.conflict,
          }}>
            {week.hits === 0 ? "free" : `−${week.hits * 4}`}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3, textAlign: "right" }}>
            &pound;{(week.bank_after / 10).toFixed(1)} left
            {week.free_transfers_after === null ? null : ` · ${week.free_transfers_after} FT`}
          </span>
        </div>
      ))}

      {quiet.length === 0 ? null : (
        <p
          data-testid="plan-quiet-weeks"
          style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.5, color: S.ink3 }}
        >
          No move planned for {quiet.map((w) => `GW${w.gameweek}`).join(", ")} — the
          solve prices those weeks, it does not transfer into them.
        </p>
      )}
    </div>
  );
}

/** The four lines, in the order every FPL surface reads them. */
const LINES: readonly (readonly [string, string])[] = [
  ["GKP", "Goalkeepers"], ["DEF", "Defenders"],
  ["MID", "Midfielders"], ["FWD", "Forwards"],
];

/**
 * A line's heading.
 *
 * The structural half of separating twenty-one rows; `positionHue` is the
 * chromatic half. A line nobody is picked in gets no heading — an empty
 * "Forwards" would claim a line the squad does not field.
 */
function BandHead({ position, label }: { position: string; label: string }) {
  const hue = positionHue(position, S);
  return (
    <div
      data-testid="plan-band"
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "14px 0 6px", borderBottom: `1px solid ${S.rule}`,
      }}
    >
      <span style={{ width: 16, height: 3, background: hue, borderRadius: 1 }} />
      <span style={{
        fontFamily: MONO, fontSize: 11, letterSpacing: ".09em",
        textTransform: "uppercase", color: hue,
      }}>
        {label}
      </span>
    </div>
  );
}

function PlanGridRow(
  { row, grid, fixtureFor, solved }: {
    row: PlanRow;
    grid: string;
    fixtureFor: (gameweek: number) => PhaseWeek | null;
    /** Whether any week names an eleven. See {@link PlanGrid}. */
    solved: boolean;
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
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "3px 8px 3px 0", minWidth: 0 }}>
        {/* The hue rather than the code: the band above already names the line,
            so repeating "MID" on all five of its rows spends a column on a word
            the reader has just read. */}
        <span
          style={{
            width: 3, height: 20, flex: "none", borderRadius: 1,
            background: positionHue(row.position, S),
          }}
        />
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
      {/* `0/8` reads as "the solve benched him every week", which is a finding.
          With nothing solved there is no answer, and the nil mark says so. */}
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 11, color: S.ink2 }}>
        {solved ? row.starts : <Nil surface={S} size={11} />}
      </div>
    </div>
  );
}
