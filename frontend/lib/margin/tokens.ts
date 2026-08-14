/**
 * The Margin palette, as literal values rather than theme variables.
 *
 * ## Why this does not use `--text-1` and friends
 *
 * The rest of the app is a glass-and-emerald surface with a light and a dark
 * theme, and `globals.css` swaps its tokens under `.dark`. Margin is neither of
 * those. It is one design in which **the surface itself carries meaning**: the
 * decision screen is ink-on-black because it is read once under time pressure,
 * and the three reference screens are ink-on-paper because they are read at
 * length. Mapping that onto a light/dark toggle would let the reader put the
 * research table on black and the decision on paper, which inverts the only
 * thing the colour was doing.
 *
 * So the values are fixed here and the view decides which set it is on. This is
 * deliberately not themeable, and that is the design rather than an omission.
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
  /** Every rule and border on this surface. */
  readonly hair: string;
  /** Primary text. */
  readonly ink: string;
  /** Secondary text — labels, units, captions. */
  readonly ink2: string;
  /** Tertiary text — the eyebrow labels above every panel. */
  readonly ink3: string;
  /** Agreement, and the only colour used for a link. */
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

/** The decision surface. Read once, under a clock. */
export const INK: MarginSurface = {
  shell: "#14140f",
  bar: "#1a1913",
  hair: "rgba(244,243,238,.13)",
  ink: "#f4f3ee",
  ink2: "rgba(244,243,238,.62)",
  ink3: "rgba(244,243,238,.42)",
  agree: "oklch(0.82 0.14 155)",
  conflict: "oklch(0.72 0.16 30)",
  noise: "oklch(0.8 0.13 85)",
  block: "rgba(244,243,238,.22)",
  face: "#181711",
};

/** The reference surfaces. Read at length. */
export const PAPER: MarginSurface = {
  shell: "#f6f5f2",
  bar: "#fffefb",
  hair: "rgba(27,26,22,.14)",
  ink: "#1b1a16",
  ink2: "#55534a",
  ink3: "#8d8a7f",
  agree: "oklch(0.45 0.13 155)",
  conflict: "oklch(0.55 0.13 30)",
  noise: "oklch(0.64 0.13 80)",
  block: "rgba(27,26,22,.22)",
  face: "#fffefb",
};

/** The rail beside the decision — one step off the shell, not a card. */
export const RAIL_BG = "#181711";

/**
 * The hatch used wherever a cell has no view at all.
 *
 * Distinct from a zero and distinct from a blank, which is the entire point:
 * `∅` and this hatch both mean "nothing was fitted here", and an empty cell
 * would read as "fitted, and it came out low".
 */
export function hatch(surface: MarginSurface): string {
  const stroke = surface === INK
    ? "rgba(244,243,238,.18)"
    : "rgba(27,26,22,.12)";
  return `repeating-linear-gradient(45deg, ${stroke} 0 3px, transparent 3px 6px)`;
}

/** IBM Plex Mono, applied by `app/margin/layout.tsx` through next/font. */
export const MONO = "var(--font-plex-mono), ui-monospace, monospace";
/** IBM Plex Sans, likewise. */
export const SANS = "var(--font-plex-sans), system-ui, sans-serif";
