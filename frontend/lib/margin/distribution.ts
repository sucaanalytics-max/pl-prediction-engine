/**
 * The distribution glyph, as geometry rather than as a chart.
 *
 * ## Why a glyph and not a Recharts series
 *
 * This mark appears once per player and there are 581 of them. It has to be
 * legible at 88px wide inside a table row, it has to line up across rows so the
 * eye can compare two players by position alone, and it must not cost a chart
 * library per row. So it is four absolutely-positioned divs whose offsets are
 * computed here, and `chartable()` is not involved because nothing here is a
 * chart.
 *
 * ## Every mark is a published number
 *
 * The design this implements draws a five-number summary and derives the two
 * inner quantiles from the standard deviation — `q25 = q50 − sd × 0.5`. That is
 * a shape invented from a spread, and it would sit on the screen looking exactly
 * like the three marks that were measured.
 *
 * `fpl/xp_public_gw{NN}.json` publishes `q10`, `q50`, `q90`, `mode` and `xp` per
 * player, so this draws those and nothing else:
 *
 * - the **whisker** spans q10–q90, the published interval;
 * - the **tick** is the median;
 * - the **diamond** is the mean, which is the number every competitor ships
 *   alone and which usually sits well right of the median;
 * - the **notch** is the mode, the single most likely return, and the gap
 *   between it and the diamond is the thing the whole view exists to show.
 *
 * A mark whose input is null is omitted. It is never defaulted to the mean, to
 * zero, or to the edge of the scale — an absent median drawn at the mean would
 * claim a symmetric distribution, which is the opposite of what FPL points do.
 */

/** One mark's position, as a percentage of the glyph's width. */
export interface Mark {
  /** 0–100, already clamped to the scale. */
  readonly at: number;
  /** True when the value fell outside `[lo, hi]` and was clamped to the edge. */
  readonly clamped: boolean;
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface DistributionGeometry {
  /** q10–q90. Null when either end is unpublished. */
  readonly whisker: Span | null;
  /** The median. */
  readonly median: Mark | null;
  /** The mean. */
  readonly mean: Mark | null;
  /** The most likely single return. */
  readonly mode: Mark | null;
  /** True when nothing could be drawn, so the caller renders `∅` instead. */
  readonly blank: boolean;
}

export interface DistributionInput {
  readonly q10?: number | null;
  readonly q50?: number | null;
  readonly q90?: number | null;
  readonly mean?: number | null;
  readonly mode?: number | null;
}

/**
 * The scale every glyph shares.
 *
 * Fixed rather than per-row, and that is the whole reason the glyphs are worth
 * drawing: a per-row scale would make a 2-point defender's spread look identical
 * to Haaland's. 18 is the published q90 ceiling with headroom — a haul above it
 * clamps and is marked as clamped, which the caller renders as an arrowhead so a
 * pinned mark never passes for a measured one.
 */
export const SCALE_LO = 0;
export const SCALE_HI = 18;

function place(
  value: number | null | undefined, lo: number, hi: number,
): Mark | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const raw = ((value - lo) / (hi - lo)) * 100;
  const at = Math.max(0, Math.min(100, raw));
  return { at, clamped: at !== raw };
}

export function geometry(
  input: DistributionInput,
  lo: number = SCALE_LO,
  hi: number = SCALE_HI,
): DistributionGeometry {
  // A degenerate scale would divide by zero and place every mark at Infinity.
  // Refusing it here means no caller has to check.
  if (!(hi > lo)) {
    return { whisker: null, median: null, mean: null, mode: null, blank: true };
  }

  const q10 = place(input.q10, lo, hi);
  const q90 = place(input.q90, lo, hi);
  const median = place(input.q50, lo, hi);
  const mean = place(input.mean, lo, hi);
  const mode = place(input.mode, lo, hi);

  // Both ends or no whisker. A bar drawn from q10 to the mean because q90 was
  // missing would be a narrower interval than the one that was measured, which
  // is the flattering direction to be wrong in.
  const whisker = q10 && q90
    ? { from: Math.min(q10.at, q90.at), to: Math.max(q10.at, q90.at) }
    : null;

  return {
    whisker,
    median,
    mean,
    mode,
    blank: whisker === null && median === null && mean === null && mode === null,
  };
}

/**
 * How far the mean sits above the most likely return, in points.
 *
 * The one number that says "do not read the mean as a forecast". Null rather
 * than 0 when either side is unknown: 0 is the claim that the two agree, and
 * they almost never do.
 *
 * Duplicated in spirit by `skew()` in `lib/data/projections.ts`, which takes a
 * `Projection`. This one takes the two numbers so the glyph's caption can be
 * computed for anything with a mean and a mode, including a squad total.
 */
export function meanOverMode(
  mean: number | null | undefined, mode: number | null | undefined,
): number | null {
  if (mean === null || mean === undefined) return null;
  if (mode === null || mode === undefined) return null;
  if (!Number.isFinite(mean) || !Number.isFinite(mode)) return null;
  return mean - mode;
}
