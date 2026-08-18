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

/** The decision surface. Read once, under a clock. */
export const INK: MarginSurface = {
  shell: "#14140f",
  bar: "#1a1913",
  inset: "#181711",
  hair: "rgba(244,243,238,.13)",
  rule: "rgba(244,243,238,.26)",
  ink: "#f4f3ee",
  ink2: "rgba(244,243,238,.62)",
  ink3: "rgba(244,243,238,.42)",
  ink4: "rgba(244,243,238,.32)",
  brand: "oklch(0.8 0.08 250)",
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
  inset: "#fbfaf7",
  hair: "rgba(27,26,22,.14)",
  rule: "rgba(27,26,22,.22)",
  ink: "#1b1a16",
  ink2: "#55534a",
  ink3: "#8d8a7f",
  ink4: "#b0ada2",
  brand: "oklch(0.5 0.09 250)",
  agree: "oklch(0.45 0.13 155)",
  conflict: "oklch(0.55 0.13 30)",
  noise: "oklch(0.64 0.13 80)",
  block: "rgba(27,26,22,.22)",
  face: "#fffefb",
};

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

/**
 * Newsreader, the display face, likewise loaded by the root layout.
 *
 * It sets headings and the sentence that answers a screen's question, and it
 * **never sets a figure and never sets a label** — figures are Mono so a column
 * of them reads as a ranking, labels are Mono so they read as apparatus rather
 * than as prose. Weight is a designed pair rather than one weight reused: 400 on
 * paper, 500 on ink, because 400 goes spindly against black.
 *
 * Named here beside {@link MONO} and {@link SANS} so a view spells the face once
 * and `var(--font-newsreader)` does not spread through the component tree as a
 * literal — the same reason those two exist.
 */
export const DISPLAY = "var(--font-newsreader), Georgia, serif";
