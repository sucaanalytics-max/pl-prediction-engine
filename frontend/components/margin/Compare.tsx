"use client";

/**
 * Two to four players, side by side, from both artifacts at once.
 *
 * ## Why the columns are players and the rows are metrics
 *
 * The same shape as the planner, deliberately: this app already asks you to read
 * players across the top and quantities down the side, and a comparison that
 * transposed that would be a second grammar for the same act of scanning.
 *
 * It also puts the numbers that must be compared next to each other. A table of
 * players as rows is for finding one; a table of players as columns is for
 * choosing between them, which is the whole job here.
 *
 * ## The forecast and the record are separated by a rule
 *
 * The top block is what the simulation expects, the bottom is what the player
 * has actually done. They are different kinds of claim — one is a distribution
 * this repo computed, the other is a count someone recorded — and the rule
 * between them says so without a paragraph. The interesting reading is the
 * disagreement across it: a high xP over a thin xG is a projection leaning on
 * fixtures rather than on form.
 *
 * ## What is not drawn
 *
 * No verdict, no score, no "best pick". Marking the leader per row is as far as
 * this goes, because a composite ranking across xP, price and ownership would
 * need weights nobody has fitted, and it would look like an answer.
 */

import { useMemo } from "react";
import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";
import { compare, leaders, METRICS, type Metric } from "@/lib/margin/compare";
import { INK, MONO, SANS } from "@/lib/margin/tokens";
import { Nil } from "@/components/margin/Marks";

const S = INK;

/** Where the forecast ends and the record begins. */
const RECORD_STARTS_AT = "minutes";

function format(value: number | null, metric: Metric): string | null {
  if (value === null) return null;
  if (metric.unit === "pct") {
    // `p60` arrives as a probability and ownership as a percentage already. The
    // metric knows which it is by its own scale rather than by a second flag:
    // nothing in this set is a share above 1 that is not already a percentage.
    const scaled = value <= 1 ? value * 100 : value;
    return `${scaled.toFixed(metric.dp)}%`;
  }
  if (metric.unit === "money") return `£${value.toFixed(metric.dp)}`;
  return value.toFixed(metric.dp);
}

export function Compare(
  { ids, projections, stats, onRemove, onClear }: {
    ids: readonly number[];
    projections: readonly Projection[];
    stats: readonly PlayerRow[];
    onRemove: (elementId: number) => void;
    onClear: () => void;
  },
) {
  const rows = useMemo(
    () => compare(ids, projections, stats), [ids, projections, stats],
  );

  if (rows.length === 0) return null;

  const columns = `minmax(120px, 1.2fr) repeat(${rows.length}, minmax(80px, 1fr))`;

  return (
    <section
      data-testid="compare"
      style={{
        border: `1px solid ${S.hair}`, background: S.bar, padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
                       textTransform: "uppercase", color: S.ink, opacity: .55 }}>
          comparing {rows.length}
        </span>
        {rows.length === 1 ? (
          <span style={{ fontFamily: SANS, fontSize: 11.5, color: S.ink, opacity: .5 }}>
            pick another to see them against each other
          </span>
        ) : null}
        <button
          type="button"
          data-testid="compare-clear"
          onClick={onClear}
          style={{
            marginLeft: "auto", fontFamily: MONO, fontSize: 10, cursor: "pointer",
            background: "transparent", color: S.ink, opacity: .6,
            border: `1px solid ${S.hair}`, padding: "2px 7px",
          }}
        >
          clear
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 320 }}>
          {/* Names */}
          <div style={{ display: "grid", gridTemplateColumns: columns,
                        borderBottom: `1px solid ${S.block}` }}>
            <div />
            {rows.map((row) => (
              <div key={row.elementId} style={{ padding: "0 0 6px", minWidth: 0 }}>
                <div style={{ fontFamily: SANS, fontSize: 12.5, color: S.ink,
                              whiteSpace: "nowrap", overflow: "hidden",
                              textOverflow: "ellipsis" }} title={row.name}>
                  {row.name}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink, opacity: .45 }}>
                    {row.position ?? "—"} {row.team ?? ""}
                  </span>
                  <button
                    type="button"
                    data-testid="compare-remove"
                    aria-label={`remove ${row.name} from the comparison`}
                    onClick={() => onRemove(row.elementId)}
                    style={{
                      fontFamily: MONO, fontSize: 10, cursor: "pointer", lineHeight: 1,
                      background: "transparent", border: "none", padding: 0,
                      color: S.ink, opacity: .4,
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>

          {METRICS.map((metric) => {
            const best = leaders(metric, rows);
            const opensRecord = metric.key === RECORD_STARTS_AT;
            return (
              <div
                key={metric.key}
                data-testid="compare-row"
                style={{
                  display: "grid", gridTemplateColumns: columns, alignItems: "baseline",
                  borderTop: opensRecord ? `1px solid ${S.block}` : `1px solid ${S.hair}`,
                  marginTop: opensRecord ? 8 : 0,
                  paddingTop: opensRecord ? 8 : 0,
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: S.ink,
                              opacity: .55, padding: "4px 8px 4px 0" }}>
                  {metric.label}
                </div>
                {rows.map((row) => {
                  const shown = format(metric.of(row), metric);
                  const leads = best.has(row.elementId);
                  return (
                    <div
                      key={row.elementId}
                      data-testid="compare-cell"
                      data-leads={leads ? "yes" : "no"}
                      style={{
                        fontFamily: MONO, fontSize: 12, padding: "4px 0",
                        fontVariantNumeric: "tabular-nums",
                        color: leads ? S.agree : S.ink,
                        opacity: shown === null ? 1 : leads ? 1 : .8,
                      }}
                    >
                      {shown ?? <Nil surface={S} size={11} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <p style={{ margin: 0, fontFamily: SANS, fontSize: 11, lineHeight: 1.5,
                  color: S.ink, opacity: .45, maxWidth: "64ch" }}>
        Above the rule is what the simulation expects this gameweek; below it is
        what the player has actually done this season. xGI and xA per 90 are the
        only derived numbers here — everything else is published as shown. A rate
        is blank rather than estimated when the minutes cannot carry one.
      </p>
    </section>
  );
}
