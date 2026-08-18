/**
 * The distribution glyph, as geometry rather than as a chart.
 *
 * ## What changed against the shipped file
 *
 * Two additions, both additive: an interquartile box (drawn only when the
 * producer publishes BOTH q25 and q75 — see contracts/xp_public.delta.md), and a
 * second pair of scale constants for a squad total, which does not fit the
 * per-player scale.
 *
 * ## Why a glyph and not a Recharts series
 *
 * This mark appears once per player and there are 581 of them. It has to be
 * legible at 88px wide inside a table row, it has to line up across rows so the
 * eye can compare two players by position alone, and it must not cost a chart
 * library per row. So it is a handful of absolutely-positioned divs whose offsets
 * are computed here, and `chartable()` is not involved because nothing here is a
 * chart.
 *
 * ## Every mark is a published number
 *
 * The design this implements derives its two inner quantiles from the standard
 * deviation — `q25 = q50 − sd × 0.5`. That is a shape invented from a spread,
 * and it would sit on the screen looking exactly like the marks that were
 * measured. It is still not done here. `box` is null unless the producer
 * published both ends.
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
  /**
   * q25–q75. Null when either end is unpublished.
   *
   * This read "which is every player until the producer ships the pair" until
   * 2026-08-18. The producer ships it: `xp_public_gw01.json` carries q10, q25,
   * q50, q75 and q90 for 590 of 590 players. The refusal below is now a real
   * guard against a partial file rather than a description of every file.
   */
  readonly box: Span | null;
  /**
   * q75–q90 — the right tail, and the mark the weekly objective reads.
   *
   * Computed as its own span rather than inferred from the box and the whisker,
   * because when it is drawn it thickens while the median thins: same marks, same
   * scale, opposite conclusion. That is what lets a season-versus-weekly diff use
   * one chart type instead of two.
   *
   * Non-null here means "measured", not "drawn". `Marks.tsx` draws it only under
   * `emphasis="tail"`, and never at all when {@link blank} — see below.
   */
  readonly tail: Span | null;
  /** The median. */
  readonly median: Mark | null;
  /** The mean. */
  readonly mean: Mark | null;
  /** The most likely single return. */
  readonly mode: Mark | null;
  /**
   * True when nothing could be drawn, so the caller renders `∅` instead.
   *
   * ## The tail does not count, and that is the rule
   *
   * A file carrying q75 and q90 and nothing else has an upper tail and nothing to
   * read it against: no median, no mean, no lower end, no interval it is the top
   * of. Drawing that alone is the error {@link span} refuses one field up — half
   * an interval, in the flattering direction to be wrong in — committed at the
   * level of the whole glyph instead of one mark.
   *
   * It was also incoherent as rendered: the mark appeared inside a `role="img"`
   * whose `aria-label` came from `describeGlyph`, which names only the PAIRS and
   * the point marks and therefore said "no distribution published" over a bar that
   * was visibly published.
   *
   * So: the tail is context for a distribution, never a distribution on its own.
   * It is drawn only when some other mark already establishes one.
   */
  readonly blank: boolean;
}

export interface DistributionInput {
  readonly q10?: number | null;
  /** Published since contracts/xp_public.delta.md. Optional, and dropped alone. */
  readonly q25?: number | null;
  readonly q50?: number | null;
  readonly q75?: number | null;
  readonly q90?: number | null;
  readonly mean?: number | null;
  readonly mode?: number | null;
}

/**
 * The scale every per-player glyph shares.
 *
 * Fixed rather than per-row, and that is the whole reason the glyphs are worth
 * drawing: a per-row scale would make a 2-point defender's spread look identical
 * to Haaland's. 18 is the published q90 ceiling with headroom — a haul above it
 * clamps and is marked as clamped, which the caller renders as an outward
 * arrowhead so a pinned mark never passes for a measured one.
 */
export const SCALE_LO = 0;
export const SCALE_HI = 18;

/**
 * The scale for a squad total.
 *
 * A separate pair, not a per-glyph fit: the headline strip is read against the
 * same range week to week, so a narrow week looks narrow. 20–110 brackets every
 * plausible XI-plus-captain return; a blank gameweek clamps low and a 120-point
 * triple-captain week clamps high, both marked.
 */
export const SQUAD_SCALE_LO = 20;
export const SQUAD_SCALE_HI = 110;

/**
 * The scale for a doubled player.
 *
 * Twice the per-player ceiling, not the squad scale: the armband doubles the
 * whole distribution, so a captained haul that would clamp at 18 has room, and
 * the spread doubles with the mean. Reading a doubled player against the 0–18
 * scale would clamp half the league and hide exactly the widening that makes
 * the captaincy a variance decision rather than a ranking.
 */
export const DOUBLED_SCALE_LO = 0;
export const DOUBLED_SCALE_HI = 36;

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

/** Both ends, or nothing. Shared by the whisker and the box, for one reason. */
function span(low: Mark | null, high: Mark | null): Span | null {
  // A bar drawn from q10 to the mean because q90 was missing would be a
  // narrower interval than the one that was measured, which is the flattering
  // direction to be wrong in. The same applies to half a box.
  if (!low || !high) return null;
  return { from: Math.min(low.at, high.at), to: Math.max(low.at, high.at) };
}

export function geometry(
  input: DistributionInput,
  lo: number = SCALE_LO,
  hi: number = SCALE_HI,
): DistributionGeometry {
  // A degenerate scale would divide by zero and place every mark at Infinity.
  // Refusing it here means no caller has to check.
  if (!(hi > lo)) {
    return {
      whisker: null, box: null, tail: null,
      median: null, mean: null, mode: null, blank: true,
    };
  }

  const q10 = place(input.q10, lo, hi);
  const q25 = place(input.q25, lo, hi);
  const q75 = place(input.q75, lo, hi);
  const q90 = place(input.q90, lo, hi);
  const median = place(input.q50, lo, hi);
  const mean = place(input.mean, lo, hi);
  const mode = place(input.mode, lo, hi);

  const whisker = span(q10, q90);
  const box = span(q25, q75);
  const tail = span(q75, q90);

  return {
    whisker,
    box,
    tail,
    median,
    mean,
    mode,
    // `tail` is deliberately absent from this list: a lone upper tail is not a
    // distribution, so it does not make the glyph non-blank. The rule and the
    // reasoning are on `blank` in DistributionGeometry above.
    blank:
      whisker === null && box === null
      && median === null && mean === null && mode === null,
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
