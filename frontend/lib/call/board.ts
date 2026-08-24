/**
 * The call screen's derived values.
 *
 * Everything here is a projection of published numbers, and this file's job is to
 * keep that literally true: nothing below is invented, defaulted, or inferred
 * from an ordering. The XI is solved by `lib/margin/planner.ts` and the
 * squad-to-projection join is done by `lib/margin/squad.ts` — neither is
 * reimplemented here, because both have already been the site of a real bug
 * caused by a second copy.
 *
 * ## Why the callouts are argmaxes and nothing else
 *
 * The rail says three things about your squad, and each is the argmax of a
 * quantity the artifact publishes: the widest published interval, the lowest
 * published xP, the highest published ownership. That constraint is the point. A
 * rail choosing what to say by any other rule would be writing analysis, and an
 * analysis a reader cannot reproduce from the file looks exactly like one that
 * was measured.
 *
 * So each callout can be absent. A squad whose players carry no published
 * quantiles has no widest interval, and the rail then says nothing rather than
 * nominating whoever happened to sort first.
 */

import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";
import type { SquadRow } from "@/lib/margin/squad";

/**
 * The axis an interval bar is laid out on, in points.
 *
 * Fixed, and wide enough for the longest tail the artifact carries — a captain's
 * q90 reached 14 in the file this was designed against. A per-player axis would
 * make every interval fill its own bar, which is the one thing the bar exists to
 * disprove: comparing two players' spreads is the entire reason it is drawn.
 */
export const INTERVAL_AXIS = 16;

export interface IntervalBar {
  /** Percent from the left where the interquartile box starts. */
  readonly left: number;
  /** Percent of the axis the box covers. Never zero-width. */
  readonly width: number;
}

/**
 * Where to draw the interquartile box, or null when the artifact withheld it.
 *
 * `q25` and `q75` are published together or not at all, so half a box is never
 * drawn: a box with one end missing renders as a narrow interval, which is a
 * stronger claim than the interval we actually have.
 */
export function intervalBar(projection: Projection | null): IntervalBar | null {
  if (projection === null) return null;
  const { q25, q75 } = projection;
  if (q25 === null || q75 === null) return null;
  const left = Math.max(0, Math.min(100, (q25 / INTERVAL_AXIS) * 100));
  const span = ((q75 - q25) / INTERVAL_AXIS) * 100;
  // A floor of 2%, because a player whose middle half is a single point still has
  // a middle half, and a zero-width box reads as no data at all.
  return { left, width: Math.max(2, Math.min(100 - left, span)) };
}

export type CalloutKind = "widest" | "drag" | "template";

export interface Callout {
  readonly kind: CalloutKind;
  readonly who: string;
  /** The figure that made this the argmax. */
  readonly figure: string;
  readonly why: string;
}

/** q90 − q10, or null when either end is unpublished. */
export function spreadOf(projection: Projection | null): number | null {
  if (projection === null) return null;
  const { q10, q90 } = projection;
  if (q10 === null || q90 === null) return null;
  return q90 - q10;
}

function argmax<T>(items: readonly T[], score: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value === null) continue;
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function argmin<T>(items: readonly T[], score: (item: T) => number | null): T | null {
  return argmax(items, (item) => {
    const value = score(item);
    return value === null ? null : -value;
  });
}

/**
 * The three callouts, each derived or absent.
 *
 * `starters` scopes the widest-interval claim, because "the widest spread in your
 * eleven" is a statement about the eleven. The other two are about the whole
 * squad: a drag on your bench is still money spent, and a template player you
 * have benched is still a template player you own.
 */
export function calloutsFor(
  starters: readonly SquadRow[],
  squad: readonly SquadRow[],
): readonly Callout[] {
  const out: Callout[] = [];

  const widest = argmax(starters, (row) => spreadOf(row.projection));
  if (widest !== null && widest.projection !== null) {
    const spread = spreadOf(widest.projection) as number;
    const haul = widest.projection.pGe10;
    out.push({
      kind: "widest",
      who: widest.player.name,
      figure: `${widest.projection.q10}–${widest.projection.q90} pts`,
      why: haul === null
        ? `The widest spread in your eleven — ${spread.toFixed(0)} points between the `
          + "tenth and the ninetieth percentile."
        : "The widest spread in your eleven. Most of that mean lives in a tail that "
          + `turns up ${Math.round(haul * 100)} times in a hundred.`,
    });
  }

  const drag = argmin(squad, (row) => row.projection?.xp ?? null);
  if (drag !== null && drag.projection !== null && drag.projection.xp !== null) {
    const minutes = drag.projection.eMinutes;
    out.push({
      kind: "drag",
      who: drag.player.name,
      figure: `${drag.projection.xp.toFixed(2)} xP`,
      why: minutes === null
        ? "The lowest projection in your fifteen."
        : `${minutes.toFixed(0)} expected minutes. Nothing about this is a projection `
          + "problem — he is not expected to play.",
    });
  }

  // Ownership comes off the squad pick, not the projection: `xp_public` carries no
  // ownership, and the live route has carried it on every pick since it was written.
  const template = argmax(squad, (row) => row.player.ownership ?? null);
  if (template !== null && template.player.ownership != null) {
    const owned = template.player.ownership;
    const xp = template.projection?.xp ?? null;
    out.push({
      kind: "template",
      who: template.player.name,
      figure: `${owned.toFixed(0)}% owned`,
      why: xp === null
        ? "The most-owned player you hold. Keeping him is a bet on the field, not on him."
        : `The most-owned player you hold, at ${xp.toFixed(2)} xP this week. Keeping `
          + "him is a bet on the field, not on him.",
    });
  }

  return out;
}

/**
 * The shape of an eleven, as `D-M-F`.
 *
 * Counts what is there rather than asserting a formation: an eleven short a
 * defender prints `2-5-3` and lets `xiProblems` say it is illegal, instead of
 * silently rendering a legal-looking string.
 */
export function shapeOf(xi: readonly SquadPlayer[]): string {
  const count = (line: string) =>
    xi.filter((player) => player.position.toUpperCase() === line).length;
  return `${count("DEF")}-${count("MID")}-${count("FWD")}`;
}

/** The four position lines, in the order a pitch is read. */
export const PITCH_LINES = ["GKP", "DEF", "MID", "FWD"] as const;

/**
 * The eleven grouped into lines, best first within each line.
 *
 * Sorted by projection rather than by FPL's pick order, for the reason
 * `lib/margin/squad.ts` gives about reading order: a pick order encodes a lineup
 * nothing here has solved, so presenting it invites the reader to infer one.
 */
export function byLine(
  rows: readonly SquadRow[],
): ReadonlyArray<readonly [string, readonly SquadRow[]]> {
  return PITCH_LINES.map((line) => [
    line,
    rows
      .filter((row) => row.player.position.toUpperCase() === line)
      .slice()
      .sort((a, b) => (b.projection?.xp ?? -Infinity) - (a.projection?.xp ?? -Infinity)),
  ] as const);
}
