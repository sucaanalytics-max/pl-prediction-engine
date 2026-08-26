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
 * ## Clicking pins the nearest point
 *
 * The chart is a way of finding two players worth putting side by side, so a
 * click is a control rather than a decoration.
 *
 * It was one transparent hit target per point, and that could not be made to
 * work: targets draw in series order, so a later point's target covers an
 * earlier point's mark. On the real artifact **278 of 367** marks sat under
 * someone else's target — clicking the dot labelled Watkins pinned
 * Calvert-Lewin — and 161 players could not be pinned at all. One handler
 * asking which point is nearest has no ordering in it.
 *
 * ## The keyboard route is the table, not this
 *
 * Those targets were also 367 tab stops, sitting in front of the comparison
 * panel and the entire table with no way past them. The table below has a pin
 * button on every row and reaches every player including the ones excluded
 * here, so it is the better keyboard path and this is the pointer one. The plot
 * is a single `role="img"` with a describing label rather than 367 silent
 * stops.
 */

import { useMemo } from "react";
import type { Artifact } from "@/lib/data/artifact";
import type { PlayerRow } from "@/lib/data/narrow";
import { nearest, notable, place, plot, ticks } from "@/lib/margin/scatter";
import { FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";
import { MarginState } from "@/components/margin/Marks";

const S = FLOODLIT;

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
  { rows, artifact, pinned, onPin }: {
    rows: readonly PlayerRow[];
    /**
     * The artifact the rows came from, so its absence can be named.
     *
     * Without it this returned `null` for an empty cloud, and a 404 on
     * `player_stats.json` deleted the whole panel with nothing saying a chart
     * was ever meant to be there — the blank that house rule 1 forbids.
     */
    artifact?: Artifact<readonly PlayerRow[]>;
    pinned: readonly number[];
    onPin: (elementId: number) => void;
  },
) {
  const { points, bounds } = useMemo(() => plot(rows), [rows]);
  const named = useMemo(() => notable(points), [points]);

  if (points.length === 0) {
    return (
      <section data-testid="scatter" data-state="empty"
               style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {artifact ? (
          <MarginState of={artifact} what="the season's totals, for the chart"
                       surface={S} compact />
        ) : null}
        <p style={{ margin: 0, fontFamily: SANS, fontSize: 11.5, lineHeight: 1.5,
                    color: S.ink3, maxWidth: "62ch" }}>
          No player has the 90 minutes this chart needs, so there is nothing to
          plot. That is a fact about the data, not an empty panel.
        </p>
      </section>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  /**
   * One handler for the whole plot, asking which point is nearest.
   *
   * There used to be a transparent hit target per point. Targets draw in series
   * order, so a later point's target covered an earlier point's mark: on the
   * real artifact 278 of 367 marks sat under someone else's target, clicking
   * the dot labelled Watkins pinned Calvert-Lewin, and 161 players could not be
   * pinned at all. Nearest-point has no ordering in it.
   */
  function pinNearest(event: React.MouseEvent<SVGSVGElement>) {
    const svg = event.currentTarget;
    const box = svg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    // Client pixels -> viewBox units -> plot fractions.
    const vx = ((event.clientX - box.left) / box.width) * W;
    const vy = ((event.clientY - box.top) / box.height) * H;
    const hit = nearest(
      points, bounds,
      (vx - PAD.left) / innerW,
      1 - (vy - PAD.top) / innerH,
    );
    if (hit) onPin(hit.elementId);
  }
  const at = (p: (typeof points)[number]) => {
    const { x, y } = place(p, bounds);
    return { cx: PAD.left + x * innerW, cy: PAD.top + (1 - y) * innerH };
  };

  return (
    <section data-testid="scatter" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        {/* `S.ink3`, NOT `S.ink` at reduced opacity.
            `opacity` multiplies the composited colour, so `ink` at .35 painted
            2.91:1 — under even the 3:1 graphical floor, on text. Measured on this
            page before the change: .55 -> 5.50:1, .35 -> 2.91:1, and the caption
            below at .45 -> 4.05:1. Only the first was legible, and all three read as
            the same deliberate "quiet" treatment.
            ink3 is 5.50:1 by construction and is the tier that MEANS quiet, so the
            tone comes from the palette instead of an arbitrary multiply. This is
            what `legibility.test.ts` rule 3 forbids; it could not see these because
            it scanned only `HeatGrid.tsx`. It scans everything now. */}
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
                       textTransform: "uppercase", color: S.ink3 }}>
          finishing against creating &middot; {points.length} players
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          click a point to compare
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Expected goals against expected assists for ${points.length} players, last season`}
          onClick={pinNearest}
          style={{ width: "100%", minWidth: 420, height: "auto", display: "block",
                   cursor: "pointer" }}
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
                  data-testid="scatter-point"
                  data-element={point.elementId}
                  data-pinned={isPinned ? "yes" : "no"}
                />
                {named.has(point.elementId) || isPinned ? (
                  <text x={cx + 7} y={cy + 3} fill={S.ink} fillOpacity={.7}
                        fontFamily={SANS} fontSize={9.5}>{point.name}</text>
                ) : null}
                {/* No per-point control. Every point used to be a tab stop —
                    367 of them, in front of the comparison panel and the whole
                    table, with no bypass. The table below has a pin button on
                    every row and is the keyboard route; this is the pointer
                    one. */}
                <title>
                  {point.name} — {point.xg.toFixed(2)} xG, {point.xa.toFixed(2)} xA,
                  {" "}{point.minutes} minutes
                </title>
              </g>
            );
          })}
        </svg>
      </div>

      <p style={{ margin: 0, fontFamily: SANS, fontSize: 11, lineHeight: 1.5,
                  color: S.ink3, maxWidth: "68ch" }}>
        Last season&rsquo;s totals, which is what FPL still reports until a
        gameweek has been played &mdash; there is no form line here because no
        match has been played this season. Players under 90 minutes are left out:
        at that sample they sit on the origin next to players who did not play,
        and the cluster would read as a finding. Mark size is minutes.
      </p>
    </section>
  );
}
