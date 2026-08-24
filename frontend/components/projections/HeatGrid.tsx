"use client";

/**
 * The projection grid — the screen this redesign was benchmarked against.
 *
 * Every player a row, the next eight gameweeks the columns, fill by projected
 * points. The arithmetic lives in `lib/projections/grid.ts` and is tested there;
 * this file is layout, controls and the sentences that keep the picture honest.
 *
 * ## The span control is the point
 *
 * "Who is best over the next eight" and "who is best over the next two" are
 * different questions with different answers, and a grid that only totals eight
 * silently answers the wrong one for a manager deciding this week's transfer. The
 * control re-runs the total AND the sort, so the ranking always matches the span
 * on screen.
 *
 * ## Two scales, and why both are offered
 *
 * Absolute puts all eight columns on one 0–{@link ABSOLUTE_CEILING} ramp, so a
 * cell means the same thing wherever it sits. Every row then dims rightward,
 * because the availability haircut widens with distance — that is certainty
 * draining, not fixtures worsening, and it is why a flat row is worth noticing.
 *
 * Per-week ranks each column against itself over the rows in view. Good for
 * picking within a week, useless for judging whether a later week is worth
 * planning around, because the brightest cell in the last column is only the best
 * of that column. Both notes are rendered, not just documented.
 */

import { useDeferredValue, useMemo, useState } from "react";

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import type { Horizon, Projection } from "@/lib/data/projections";
import { DISPLAY, FLOODLIT, MONO, SANS, heatStep } from "@/lib/margin/tokens";
import {
  ABSOLUTE_CEILING, HEAT_STEPS, SPANS, bandOf, buildGridRows, findRuns,
  gridSummary, gridWeeks, type GridRow, type Span,
} from "@/lib/projections/grid";

const S = FLOODLIT;

type Scale = "absolute" | "week";
type Sort = "total" | "now" | "tail";
type Show = "all" | "mine";

const POSITIONS = ["ALL", "GKP", "DEF", "MID", "FWD"] as const;

const SORTS: ReadonlyArray<readonly [Sort, string]> = [
  ["total", "span total"], ["now", "this week"], ["tail", "P(10+)"],
];

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "5px 9px",
    fontSize: 11,
    fontWeight: on ? 600 : 400,
    background: on ? "rgba(233,238,245,.10)" : "transparent",
    color: on ? S.ink : S.ink3,
    borderRight: `1px solid ${S.rule}`,
    cursor: "pointer",
  };
}

function Group({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", border: `1px solid ${S.rule}` }}>{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 9, letterSpacing: ".14em",
      textTransform: "uppercase", color: S.ink3, fontWeight: 600,
    }}>
      {children}
    </span>
  );
}

export interface HeatGridProps {
  readonly players: readonly Projection[];
  readonly horizon: Horizon | null;
  readonly currentGameweek: number;
  readonly fixtures: readonly FixtureMatrixRow[];
  readonly ownedIds: ReadonlySet<number>;
  readonly nDraws: number | null;
}

export function HeatGrid(props: HeatGridProps) {
  const [span, setSpan] = useState<Span>(8);
  const [scale, setScale] = useState<Scale>("absolute");
  const [sort, setSort] = useState<Sort>("total");
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  // The grid is 609 rows deep, so a keystroke must not block on rebuilding it.
  const deferredQuery = useDeferredValue(query);

  const weeks = useMemo(
    () => gridWeeks(props.currentGameweek, props.horizon),
    [props.currentGameweek, props.horizon],
  );

  // Built once per span, not per keystroke: the fixture join is the expensive part.
  const rows = useMemo(() => buildGridRows({
    players: props.players,
    horizon: props.horizon,
    currentGameweek: props.currentGameweek,
    fixtures: props.fixtures,
    ownedIds: props.ownedIds,
    span,
  }), [props.players, props.horizon, props.currentGameweek, props.fixtures,
       props.ownedIds, span]);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const filtered = rows.filter((row) =>
      (position === "ALL" || row.position === position)
      && (show === "all" || row.owned)
      && (q === "" || row.name.toLowerCase().includes(q)
          || row.team.toLowerCase().includes(q)));

    // Nulls last under every sort. A player with no projection is not the worst
    // player; he is a player we have nothing to say about, and sorting him to the
    // bottom of a descending list says the first thing.
    const key = (row: GridRow): number | null =>
      sort === "total" ? row.total
      : sort === "now" ? row.cells[0]?.xp ?? null
      : row.pGe10;
    return filtered.slice().sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    });
  }, [rows, deferredQuery, position, show, sort]);

  // The per-week scale is ranked over the rows IN VIEW, which is what makes it a
  // within-week ranking rather than a second absolute scale.
  const columnCeilings = useMemo(() => weeks.map((_, index) => Math.max(
    0.1, ...visible.map((row) => row.cells[index]?.xp ?? 0),
  )), [weeks, visible]);

  const template = `210px 46px repeat(${weeks.length}, minmax(58px, 1fr)) 86px`;

  return (
    <section style={{ fontFamily: SANS, color: S.ink }}>
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16,
        padding: "11px 14px", background: S.inset,
        border: `1px solid ${S.hair}`, borderBottom: "none",
      }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="name or club"
          aria-label="Filter by player name or club"
          style={{
            width: 150, padding: "6px 9px", fontSize: 12, color: S.ink,
            border: `1px solid ${S.rule}`, background: S.shell, fontFamily: SANS,
          }}
        />
        <Group>
          {POSITIONS.map((key) => (
            <button key={key} onClick={() => setPosition(key)} style={chip(position === key)}
              aria-pressed={position === key}>
              {key}
            </button>
          ))}
        </Group>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Label>Rank</Label>
          <Group>
            {SORTS.map(([key, label]) => (
              <button key={key} onClick={() => setSort(key)} style={chip(sort === key)}
                aria-pressed={sort === key}>
                {label}
              </button>
            ))}
          </Group>
        </div>
        <Group>
          {([["all", "everyone"], ["mine", "my squad"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setShow(key)} style={chip(show === key)}
              aria-pressed={show === key}>
              {label}
            </button>
          ))}
        </Group>
      </div>

      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "12px 14px", background: S.bar,
        border: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.rule}`,
      }}>
        <Label>Total the next</Label>
        <Group>
          {SPANS.map((value) => (
            <button
              key={value}
              onClick={() => setSpan(value)}
              style={{ ...chip(span === value), fontFamily: MONO, minWidth: 26,
                       textAlign: "center" }}
              aria-pressed={span === value}
              aria-label={`Total the next ${value} gameweeks`}
              disabled={value > weeks.length}
            >
              {value}
            </button>
          ))}
        </Group>
        <Label>gameweeks</Label>
        <div style={{ width: 1, height: 20, background: S.rule }} />
        <Label>Heat</Label>
        <Group>
          {([["absolute", "absolute"], ["week", "per week"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setScale(key)} style={chip(scale === key)}
              aria-pressed={scale === key}>
              {label}
            </button>
          ))}
        </Group>
        <div style={{ flexGrow: 1 }} />
        <span data-testid="grid-summary" style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          {gridSummary(visible.length, props.players.length, props.nDraws,
                       props.horizon?.nDraws ?? null, props.currentGameweek, weeks)}
        </span>
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${S.hair}`, borderTop: "none" }}>
        <div style={{ minWidth: 860 }}>
          <div style={{
            display: "grid", gridTemplateColumns: template, alignItems: "center",
            background: S.bar, borderBottom: `1px solid ${S.rule}`,
          }}>
            <div style={{ padding: "0 12px", height: 30, display: "flex", alignItems: "center" }}>
              <Label>Player</Label>
            </div>
            <div style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Label>P10</Label>
            </div>
            {weeks.map((week, index) => (
              <div key={week} style={{
                height: 30, display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <span style={{
                  fontFamily: MONO, fontSize: 9, letterSpacing: ".1em", fontWeight: 600,
                  // Inside the span it is part of the answer; outside it is context.
                  color: index < span ? S.ink2 : S.ink4,
                }}>
                  GW{week}
                </span>
              </div>
            ))}
            <div style={{
              height: 30, display: "flex", alignItems: "center",
              justifyContent: "flex-end", paddingRight: 12,
            }}>
              {/* Always a span of two or more: `SPANS` starts at two, because a
                  one-week "total" is just the first column repeated. */}
              <Label>next {span}</Label>
            </div>
          </div>

          {visible.map((row) => {
            const bands = row.cells.map((cell, index) => bandOf(
              cell.xp,
              scale === "absolute" ? ABSOLUTE_CEILING : columnCeilings[index],
              HEAT_STEPS,
            ));
            const runs = findRuns(bands, HEAT_STEPS);
            const inRun = (index: number) =>
              runs.some(([from, to]) => index >= from && index <= to);

            return (
              <div
                key={row.elementId}
                data-testid="grid-row"
                style={{
                  display: "grid", gridTemplateColumns: template,
                  borderBottom: `1px solid ${S.hair}`,
                  background: row.owned ? "rgba(233,238,245,.03)" : "transparent",
                }}
              >
                <div style={{
                  padding: "0 12px", height: 40, display: "flex",
                  flexDirection: "column", justifyContent: "center", minWidth: 0,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {row.name}
                    </span>
                    {runs.length > 0 ? (
                      <span
                        title="Three or more consecutive strong weeks. A statement about this player's projected cells, not about anybody's eleven."
                        style={{
                          fontFamily: MONO, fontSize: 8, letterSpacing: ".1em",
                          fontWeight: 700, padding: "1px 4px",
                          border: `1px solid ${S.brand}`, color: S.brand,
                        }}
                      >
                        RUN
                      </span>
                    ) : null}
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3 }}>
                    {row.position} · {row.team}
                  </span>
                </div>

                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: MONO, fontSize: 10, color: S.ink3,
                }}>
                  {row.pGe10 === null ? "—" : `${Math.round(row.pGe10 * 100)}%`}
                </div>

                {row.cells.map((cell, index) => {
                  const band = bands[index];
                  const [background, ink] = band === null
                    ? ["transparent", S.ink4] as const
                    : heatStep(band, HEAT_STEPS - 1);
                  return (
                    <div key={cell.gameweek} style={{ padding: 1, position: "relative" }}>
                      <div style={{
                        height: 38, background, color: ink,
                        display: "flex", flexDirection: "column",
                        alignItems: "center", justifyContent: "center",
                        // Outside the span the cell is context for the total, so
                        // it is dimmed rather than removed: fixtures beyond the
                        // span are exactly what makes a span worth changing.
                        opacity: index < span ? 1 : 0.42,
                        border: band === null ? `1px solid ${S.hair}` : "none",
                      }}>
                        <span style={{
                          fontFamily: MONO, fontSize: 8, letterSpacing: ".04em",
                          opacity: 0.75,
                        }}>
                          {cell.blank ? "—" : cell.fixture ?? "?"}
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>
                          {cell.xp === null ? "·" : cell.xp.toFixed(1)}
                        </span>
                      </div>
                      {inRun(index) ? (
                        <div style={{
                          position: "absolute", left: 1, right: 1, bottom: 0,
                          height: 2, background: S.brand,
                        }} />
                      ) : null}
                    </div>
                  );
                })}

                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "flex-end",
                  paddingRight: 12, gap: 4,
                }}>
                  {row.partial && row.total !== null ? (
                    <span
                      data-testid="partial-mark"
                      title={`Only ${row.weeksCounted} of these ${span} gameweeks carry a projection for this player. The total is over the weeks that do.`}
                      style={{ fontFamily: MONO, fontSize: 9, color: S.noise }}
                    >
                      {row.weeksCounted}/{span}
                    </span>
                  ) : null}
                  <span style={{
                    fontFamily: DISPLAY, fontSize: 17,
                    color: row.total === null ? S.ink4 : S.ink,
                  }}>
                    {row.total === null ? "—" : row.total.toFixed(1)}
                  </span>
                </div>
              </div>
            );
          })}

          {visible.length === 0 ? (
            <p style={{ padding: "22px 14px", fontSize: 12, color: S.ink2 }}>
              Nothing matches. The filter is what is empty, not the projection.
            </p>
          ) : null}
        </div>
      </div>

      <div style={{
        display: "flex", flexWrap: "wrap", gap: 28, padding: "14px",
        background: S.bar, border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <div style={{ maxWidth: 420 }}>
          <div style={{ marginBottom: 6 }}><Label>Reading a cell</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            Fill is the projected points and the label above it is the fixture, so a
            cell says what it expects and who against. A dot means this player has no
            projection for that week — which is not the same as a zero, and is why a
            total can cover fewer weeks than its heading. A bar under three or more
            cells is a run of strong weeks for this player; it is not a claim that he
            starts them.
          </p>
        </div>
        <div style={{ maxWidth: 420 }}>
          <div style={{ marginBottom: 6 }}>
            <Label>{scale === "absolute" ? "Why the right-hand side is dim" : "What per-week hides"}</Label>
          </div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            {scale === "absolute"
              ? `One 0–${ABSOLUTE_CEILING} ramp across every column, so a cell means the
                 same thing wherever it sits. Rows dim rightward because the
                 availability haircut widens with distance — certainty draining, not
                 fixtures worsening. A flat row is the one worth noticing.`
              : `Each column ranked against itself, over the rows you can see. Good for
                 picking within a week, useless for judging whether a later week is
                 worth planning around: the brightest cell in the last column is only
                 the best of that column.`}
          </p>
        </div>
        <div style={{ maxWidth: 300 }}>
          <div style={{ marginBottom: 6 }}><Label>Totals</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            The total follows the span control and so does the ranking, because
            &ldquo;best over two&rdquo; and &ldquo;best over eight&rdquo; are
            different questions. The first column is simulated at a higher draw
            count than the rest, so a long total mixes precisions — the line above
            the grid says which.
          </p>
        </div>
      </div>
    </section>
  );
}
