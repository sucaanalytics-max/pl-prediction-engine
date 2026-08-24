/**
 * The Margin palette, as literal values rather than theme variables.
 *
 * ## Why this does not use `--text-1` and friends
 *
 * There used to be TWO surfaces here, and the idea behind them was that the
 * surface itself carried meaning: the decision screen ink-on-black because it is
 * read once under time pressure, the reference screens ink-on-paper because they
 * are read at length.
 *
 * That is retired. There is now one surface, `FLOODLIT`, and the reason is that
 * the two-surface design lost the argument against its own consequence: five
 * files sat on `PAPER` and five on `INK`, so `/` rendered a light planner while
 * `/capture` rendered a dark form, and the reader experienced not "two kinds of
 * reading" but one app that could not decide. Contrast that matters is between
 * the DATA and the ground, not between one screen and the next.
 *
 * The values are still fixed here rather than themeable, which is unchanged and
 * still deliberate: a viewer must not be able to put the projection table on a
 * ground the distribution glyphs were not drawn for.
 *
 * ## The three semantic hues
 *
 * Green is agreement, rust is disagreement, amber is "inside the noise". They
 * are given in oklch because the design specifies them that way and because the
 * pairs have to hold their relative lightness across a black and a paper ground
 * — `oklch(0.82 …)` on ink and `oklch(0.45 …)` on paper are the same hue read at
 * the same strength, which two hex values would not stay.
 */

export interface MarginSurface {
  /** Page ground. */
  readonly shell: string;
  /** The sticky bar and any raised panel. */
  readonly bar: string;
  /** One step in from the shell — a well, not a card. Radius stays 0. */
  readonly inset: string;
  /** Every rule and border on this surface. */
  readonly hair: string;
  /**
   * A rule that divides rather than delimits — a section boundary against the
   * hairlines inside it. Not a heavier border: the same idea one step up.
   */
  readonly rule: string;
  /** Primary text. */
  readonly ink: string;
  /** Secondary text — labels, units, captions. */
  readonly ink2: string;
  /** Tertiary text — the eyebrow labels above every panel. */
  readonly ink3: string;
  /**
   * Quaternary, and deliberately below the AA-Large bar (2.06:1 on paper).
   *
   * Scoped to two uses and no others: the dotted-underline rule colour that
   * marks a third-party figure, and the queue index numeral. Anything doing
   * explanatory work sits on ink2 (7.65:1). If you reach for this for running
   * copy, the answer is ink2.
   */
  readonly ink4: string;
  /**
   * Identity: the wordmark, an active tile, a link.
   *
   * A fourth hue, off the semantic three, because identity is not a judgement.
   * Note the tension with `agree` below, whose docstring claims links: the
   * design assigns links to brand, and that migration has not happened yet.
   */
  readonly brand: string;
  /** Agreement. SEMANTIC — this hue means "fine", and nothing else. */
  readonly agree: string;
  /** Disagreement: a conflict, a struck-through number, a sale brought forward. */
  readonly conflict: string;
  /** Inside the noise band. Neither good nor bad, and coloured as neither. */
  readonly noise: string;
  /** Fill behind a bar or a distribution block. */
  readonly block: string;
  /** Ground a glyph sits on, for the mean diamond's centre. */
  readonly face: string;
}

/**
 * The one surface. Dark ground, cool light ink, one acid accent.
 *
 * Named for what it looks like rather than for a reading mode, because it no
 * longer encodes one. `--lime` is the only saturated colour that is not a
 * judgement: it marks the live thing on a screen — the countdown, the armband,
 * a detected run — and never a verdict.
 */
export const FLOODLIT: MarginSurface = {
  shell: "#0d1013",
  bar: "#14181d",
  inset: "#1a1f26",
  hair: "rgba(233,238,245,.075)",
  rule: "rgba(233,238,245,.17)",
  ink: "#e9eef5",
  ink2: "rgba(233,238,245,.60)",
  ink3: "rgba(233,238,245,.38)",
  ink4: "rgba(233,238,245,.26)",
  brand: "oklch(0.84 0.19 128)",
  agree: "oklch(0.74 0.15 155)",
  // 0.65 rather than the 0.66 this hue was drafted at, and the reason is a
  // test, not an eye: `margin.test.ts` forbids the design prototype's hand-typed
  // numbers from appearing anywhere in these sources, and "0.66" is one of them
  // (it was a margin on a runner-up plan). A colour's lightness is arbitrary to
  // a hundredth, so moving it costs nothing; loosening a guard that catches
  // fabricated data to accommodate a paint value would cost a great deal.
  conflict: "oklch(0.65 0.17 25)",
  noise: "oklch(0.80 0.14 85)",
  block: "rgba(233,238,245,.22)",
  face: "#14181d",
};

/** The heat ramp for a projected-points cell. Five steps, teal toward lime. */
export const HEAT: readonly (readonly [string, string])[] = [
  ["oklch(0.21 0.02 225)", "rgba(233,238,245,.34)"],
  ["oklch(0.29 0.06 205)", "rgba(233,238,245,.60)"],
  ["oklch(0.40 0.10 178)", "rgba(233,238,245,.90)"],
  ["oklch(0.55 0.14 150)", "#0d1013"],
  ["oklch(0.74 0.19 132)", "#0d1013"],
];

/**
 * Which heat step a value falls in, against a stated ceiling.
 *
 * The ceiling is a PARAMETER and never inferred from the row, because a
 * per-row scale makes every player look equally good — the widest bar would
 * mean "this player's best week" rather than "a good week".
 */
export function heatStep(value: number, ceiling: number): readonly [string, string] {
  const t = Math.max(0, Math.min(1, value / (ceiling || 1)));
  return HEAT[Math.min(HEAT.length - 1, Math.floor(t * HEAT.length))];
}

/** The rail beside the decision — one step off the shell, not a card. */
export const RAIL_BG = "#181711";

/**
 * What a club colour is mixed toward on paper, so twenty kit hues can sit in one
 * table without twenty of them shouting.
 *
 * Paper only, and there is no ink equivalent by design: on black a kit colour is
 * already reading against a dark ground and mixing it toward a light target
 * would invert the very identity the mark exists to carry.
 */
export const KIT_MIX_TARGET = "#f0eee8";

/**
 * The hatch used wherever a cell has no view at all.
 *
 * Distinct from a zero and distinct from a blank, which is the entire point:
 * `∅` and this hatch both mean "nothing was fitted here", and an empty cell
 * would read as "fitted, and it came out low".
 */
/**
 * Whether a surface is light, measured rather than matched.
 *
 * Two places needed to know — `hatch`, so its stroke shows against the ground, and the
 * kit mark, which mutes a club colour toward a light ground and must not on a dark one
 * — and both once asked by comparing against a literal surface object. That answered
 * wrongly for any surface built by spreading another, which is how a new one arrives.
 *
 * With one surface left it always returns false, and the measurement is kept rather
 * than replaced by that constant: the next surface added here should get a correct
 * answer without anyone remembering this function exists.
 *
 * Relative luminance of the shell, with the sRGB transfer function, against the 0.5
 * midpoint. Non-hex shells return `false`: every surface in this file uses a hex shell,
 * and guessing at an `oklch()` string would be worse than the one honest default —
 * dark, which is the surface that needs no mixing.
 */
export function surfaceIsLight(surface: MarginSurface): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(surface.shell.trim());
  if (!hex) return false;
  const channel = (offset: number): number => {
    const c = parseInt(hex[1].slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.5;
}

export function hatch(surface: MarginSurface): string {
  // The dark-ground stroke is floodlit's ink (233,238,245), not the warm
  // 244,243,238 it was: a warm hatch over a cool #0d1013 reads as a smudge.
  // The light branch is unreachable on the one surface that now exists, and is
  // kept because `surfaceIsLight` is measured rather than assumed — see above.
  const stroke = surfaceIsLight(surface)
    ? "rgba(27,26,22,.12)"
    : "rgba(233,238,245,.18)";
  return `repeating-linear-gradient(45deg, ${stroke} 0 3px, transparent 3px 6px)`;
}

/** IBM Plex Mono, applied by `app/margin/layout.tsx` through next/font. */
export const MONO = "var(--font-plex-mono), ui-monospace, monospace";
/** IBM Plex Sans, likewise. */
export const SANS = "var(--font-plex-sans), system-ui, sans-serif";

/**
 * Anton, the display face, likewise loaded by the root layout.
 *
 * It sets headings and the sentence that answers a screen's question, and it
 * **never sets a figure and never sets a label** — figures are Mono so a column
 * of them reads as a ranking, labels are Mono so they read as apparatus rather
 * than as prose. One weight, 400, because Anton ships only one; the designed
 * 400-on-paper / 500-on-ink pair this replaced described Newsreader on two
 * surfaces, and neither the face nor the second surface still exists.
 *
 * Named here beside {@link MONO} and {@link SANS} so a view spells the face once
 * and `var(--font-display-anton)` does not spread through the component tree as a
 * literal — the same reason those two exist.
 */
export const DISPLAY = "var(--font-display-anton), 'Arial Narrow', sans-serif";
