/**
 * Finishers against creators — the one chart the data actually supports today.
 *
 * ## Why a cross-section and not a time series
 *
 * The obvious FPL chart is form over time, and it cannot be drawn: FPL reports
 * **0 of 38 events finished**, `form` is `0.0` on all 400 players who have
 * minutes, and no per-gameweek history is published anywhere in this repo. A
 * line through no points is a fabrication with axes on it.
 *
 * What does exist is a full completed season across 400 players — Haaland at
 * 25.50 xG against 2.67 xA, B.Fernandes at 10.79 against 12.28 — and plotting
 * players against each other answers a question a manager actually has before
 * GW1: who finishes, who creates, and who is priced as though they do both.
 *
 * These are LAST season's totals. FPL retains them until a gameweek is played,
 * and every label built here says so.
 *
 * ## Who is plotted
 *
 * Only players with enough minutes for the pair to mean anything. A player at
 * 40 minutes sits at the origin next to one who played none, and the eye reads
 * a cluster there as a finding rather than as an absence of evidence.
 */

import { MIN_MINUTES_FOR_RATES, type PlayerRow } from "@/lib/data/narrow";

/** One plotted player, in data units. */
export interface Point {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
  readonly position: string;
  readonly xg: number;
  readonly xa: number;
  readonly minutes: number;
  readonly price: number | null;
  readonly ownership: number | null;
}

export interface Bounds {
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * The players worth plotting, and the box that holds them.
 *
 * Axes start at zero rather than at the data's minimum: xG and xA are counts,
 * and a zoomed axis on a count exaggerates a gap that is one goal wide. The
 * maximum is rounded up to a whole unit so the ticks land on numbers a reader
 * recognises.
 */
export function plot(rows: readonly PlayerRow[]): { points: Point[]; bounds: Bounds } {
  const points: Point[] = [];
  for (const row of rows) {
    if (row.elementId === null) continue;
    // The narrower's own threshold, so the chart and the per-90 columns agree
    // about when a season is long enough to describe a player.
    if (row.minutes < MIN_MINUTES_FOR_RATES) continue;
    points.push({
      elementId: row.elementId,
      name: row.name,
      team: row.team,
      position: row.position,
      xg: row.xg,
      xa: row.xa,
      minutes: row.minutes,
      price: row.fpl_price,
      ownership: row.fpl_ownership,
    });
  }
  return {
    points,
    bounds: {
      maxX: Math.max(1, Math.ceil(Math.max(0, ...points.map((p) => p.xg)))),
      maxY: Math.max(1, Math.ceil(Math.max(0, ...points.map((p) => p.xa)))),
    },
  };
}

/**
 * Players whose combined output puts them on the outside edge of the cloud.
 *
 * Used for labelling, because 400 labels is a solid block of text. This is a
 * ranking for display and nothing reads it as a recommendation — the top of
 * xG + xA is descriptive, not a pick.
 */
export function notable(points: readonly Point[], count = 8): ReadonlySet<number> {
  return new Set(
    [...points]
      .sort((a, b) => (b.xg + b.xa) - (a.xg + a.xa))
      .slice(0, count)
      .map((p) => p.elementId),
  );
}

/**
 * Where a player sits, as a fraction of each axis.
 *
 * Returned in data-space fractions rather than pixels so the caller owns the
 * geometry — the same split `lib/margin/distribution.ts` uses, and for the same
 * reason: a test can assert a position without rendering anything.
 */
export function place(point: Point, bounds: Bounds): { x: number; y: number } {
  return {
    x: bounds.maxX <= 0 ? 0 : Math.min(1, point.xg / bounds.maxX),
    y: bounds.maxY <= 0 ? 0 : Math.min(1, point.xa / bounds.maxY),
  };
}

/** Ticks a reader recognises: whole units, at most six of them. */
export function ticks(max: number): number[] {
  const step = Math.max(1, Math.ceil(max / 5));
  const out: number[] = [];
  for (let value = 0; value <= max; value += step) out.push(value);
  return out;
}
