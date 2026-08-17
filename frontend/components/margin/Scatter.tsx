"use client";

/**
 * Finishers against creators, and a way into the comparison.
 *
 * ## Why this chart and not a form line
 *
 * The obvious FPL chart is form over time and the data does not exist: FPL
 * reports 0 of 38 events finished, `form` is 0.0 on every player, and nothing
 * in this repo publishes a per-gameweek history. A line through no points is a
 * fabrication with axes on it, which is the failure this whole surface is built
 * to avoid.
 *
 * A cross-section of a completed season is real, and it answers something a
 * manager asks before GW1: who finishes, who creates, and who costs as though
 * they do both. Haaland sits far right and low; B.Fernandes high and left.
 *
 * ## Clicking a point pins it
 *
 * The chart is a way of finding two players worth putting side by side, so a
 * point is a control rather than a decoration. That also means it needs to be
 * reachable without a mouse, so every point is a `<button>` in the tab order
 * with its numbers in the accessible name — a scatter that only works by
 * pointing is a scatter half the readers cannot use.
 *
 * SVG rather than canvas, for 400 points: hit-testing, focus and screen-reader
 * names come free, and hand-rolling them over a bitmap to save a few
 * milliseconds would be the wrong trade on a chart this size.
 */

import { useMemo } from "react";
import type { PlayerRow } from "@/lib/data/narrow";
import { notable, place, plot, ticks } from "@/lib/margin/scatter";
import { INK, MONO, SANS } from "@/lib/margin/tokens";

const S = INK;

/** Room for the axis labels, in the chart's own units. */
const PAD = { left: 34, right: 10, top: 10, bottom: 26 };
const W = 640;
const H = 320;

/** Position decides the mark's tone, because it is what a reader groups by. */
const TONE: Record<string, string> = {
  FWD: S.conflict,
  MID: S.noise,
  DEF: S.agree,
  GKP: S.ink3,
};

export function Scatter(
  { rows, pinned, onPin }: {
    rows: readonly PlayerRow[];
    pinned: readonly number[];
    onPin: (elementId: number) => void;
  },
) {
  const { points, bounds } = useMemo(() => plot(rows), [rows]);
  const named = useMemo(() => notable(points), [points]);

  if (points.length === 0) return null;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const at = (p: (typeof points)[number]) => {
    const { x, y } = place(p, bounds);
    return { cx: PAD.left + x * innerW, cy: PAD.top + (1 - y) * innerH };
  };

  return (
    <section data-testid="scatter" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
                       textTransform: "uppercase", color: S.ink, opacity: .55 }}>
          finishing against creating &middot; {points.length} players
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink, opacity: .35 }}>
          click a point to compare
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Expected goals against expected assists for ${points.length} players, last season`}
          style={{ width: "100%", minWidth: 420, height: "auto", display: "block" }}
        >
          {/* Grid first, so every mark sits above it. */}
          {ticks(bounds.maxX).map((value) => {
            const x = PAD.left + (value / bounds.maxX) * innerW;
            return (
              <g key={`x${value}`}>
                <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + innerH}
                      stroke={S.hair} strokeWidth={1} />
                <text x={x} y={H - 8} fill={S.ink} fillOpacity={.45}
                      fontFamily={MONO} fontSize={9} textAnchor="middle">{value}</text>
              </g>
            );
          })}
          {ticks(bounds.maxY).map((value) => {
            const y = PAD.top + innerH - (value / bounds.maxY) * innerH;
            return (
              <g key={`y${value}`}>
                <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y}
                      stroke={S.hair} strokeWidth={1} />
                <text x={PAD.left - 6} y={y + 3} fill={S.ink} fillOpacity={.45}
                      fontFamily={MONO} fontSize={9} textAnchor="end">{value}</text>
              </g>
            );
          })}

          <text x={PAD.left + innerW / 2} y={H - 20} fill={S.ink} fillOpacity={.55}
                fontFamily={MONO} fontSize={9} textAnchor="middle">expected goals</text>
          <text x={12} y={PAD.top + innerH / 2} fill={S.ink} fillOpacity={.55}
                fontFamily={MONO} fontSize={9} textAnchor="middle"
                transform={`rotate(-90 12 ${PAD.top + innerH / 2})`}>expected assists</text>

          {points.map((point) => {
            const { cx, cy } = at(point);
            const isPinned = pinned.includes(point.elementId);
            return (
              <g key={point.elementId}>
                <circle
                  cx={cx} cy={cy}
                  // Minutes as radius: a season of evidence should look heavier
                  // than a third of one, and it is the axis a reader cannot see.
                  r={isPinned ? 6 : 3 + Math.min(2.5, point.minutes / 1400)}
                  fill={isPinned ? S.ink : TONE[point.position] ?? S.ink3}
                  fillOpacity={isPinned ? 1 : .55}
                  stroke={isPinned ? S.agree : "none"}
                  strokeWidth={2}
                />
                {named.has(point.elementId) || isPinned ? (
                  <text x={cx + 7} y={cy + 3} fill={S.ink} fillOpacity={.7}
                        fontFamily={SANS} fontSize={9.5}>{point.name}</text>
                ) : null}
                {/* The control. Transparent and on top, so the mark stays the
                    thing you see and the target stays big enough to hit. */}
                <circle
                  cx={cx} cy={cy} r={9} fill="transparent"
                  data-testid="scatter-point"
                  data-element={point.elementId}
                  data-pinned={isPinned ? "yes" : "no"}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isPinned}
                  aria-label={`${point.name}, ${point.position}, ${point.xg.toFixed(1)} expected goals, ${point.xa.toFixed(1)} expected assists`}
                  style={{ cursor: "pointer" }}
                  onClick={() => onPin(point.elementId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onPin(point.elementId);
                    }
                  }}
                >
                  <title>
                    {point.name} — {point.xg.toFixed(2)} xG, {point.xa.toFixed(2)} xA,
                    {" "}{point.minutes} minutes
                  </title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>

      <p style={{ margin: 0, fontFamily: SANS, fontSize: 11, lineHeight: 1.5,
                  color: S.ink, opacity: .45, maxWidth: "68ch" }}>
        Last season&rsquo;s totals, which is what FPL still reports until a
        gameweek has been played &mdash; there is no form line here because no
        match has been played this season. Players under 90 minutes are left out:
        at that sample they sit on the origin next to players who did not play,
        and the cluster would read as a finding. Mark size is minutes.
      </p>
    </section>
  );
}
