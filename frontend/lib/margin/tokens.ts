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
  /** Secondary text — labels, units, captions. 8.73:1 on this ground. */
  readonly ink2: string;
  /**
   * Tertiary text — the eyebrow labels above every panel. 5.50:1.
   *
   * Was 0.38 alpha, which measured 3.22:1 and FAILED WCAG 1.4.3 for normal text.
   * It was the second most common text colour on the call screen — 89 nodes,
   * most of them at 9.5px, where the 3:1 large-text allowance is categorically
   * unavailable (that needs 24px, or 18.66px bold). 0.55 is the first alpha above
   * the measured 0.487 minimum that leaves a round number.
   */
  readonly ink3: string;
  /**
   * Quaternary, and deliberately below the AA bar at 2.14:1 on this ground.
   *
   * Scoped to two uses and no others: the dotted-underline rule colour that
   * marks a third-party figure, and the queue index numeral. Anything doing
   * explanatory work sits on ink2 (8.73:1). If you reach for this for running
   * copy, the answer is ink2.
   *
   * Deliberately NOT raised when ink2 and ink3 were. A border tone that cleared
   * the text floor would stop being a border tone, and the rule that keeps it
   * off text would lose its premise. The fix for the places that painted text
   * with it was to move them to ink3, not to make this one safe.
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
  /**
   * The ground the eleven stand on, on the call screen.
   *
   * A shade off `shell` and pulled slightly green, which is the only place in
   * this palette where a colour is representational rather than semantic — a
   * pitch is green, and eleven tiles floating on the page ground read as a list
   * rather than as a team. It is deliberately barely green: enough to say
   * "pitch", not enough to compete with `agree`, which on this screen has to keep
   * meaning "kind fixture".
   */
  readonly pitch: string;
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
  ink2: "rgba(233,238,245,.72)",
  ink3: "rgba(233,238,245,.55)",
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
  pitch: "#0f1714",
};

/**
 * The tint for a fixture-difficulty chip: `[background, foreground]`.
 *
 * FPL rates each fixture 1–5 for the club playing it, 1 kindest. The chip is the
 * one place on the call screen where a fixture's difficulty is stated as a
 * colour, and it reuses the SEMANTIC three rather than inventing a fourth scale:
 * kind is `agree`, mid is plain ink, hard is `noise`, hardest is `conflict`.
 *
 * Note what this deliberately does NOT do: it does not tint by expected points.
 * A chip says who the opponent is and how FPL rated them; the number beside it
 * says what the model expects. Colouring both by the same quantity would make
 * the fixture look like evidence for the projection, when the projection already
 * priced the fixture.
 *
 * A difficulty outside 1–5 gets the mid tint rather than being clamped to an
 * end: a rating we do not recognise is not a kind fixture and it is not a brutal
 * one, and guessing either way would be a claim.
 */
/**
 * The line a player is picked in, as a colour.
 *
 * **New vocabulary, and deliberately fenced.** This app colours by CLUB
 * (`lib/margin/kits.ts`) and has never coloured by position, so this is a second
 * colour language on a screen that already has one. It exists for the plan grid,
 * where twenty-one rows in four lines are otherwise an undifferentiated stack —
 * and it is confined to the NAME COLUMN and the band header. It must never enter
 * the cell field: the fixture tint already means something there, and two
 * languages inside one cell is the thing that made the grid unreadable enough to
 * be redesigned.
 *
 * One cool family, hue varying, lightness and chroma held: a set that varied
 * lightness would read as a ranking, and there is no ordering among the four to
 * state. Clear of green, amber and red because those three already mean fixture
 * difficulty here.
 *
 * An unrecognised line gets plain ink rather than one of the four — colouring it
 * would claim a membership the data did not report.
 */
const POSITION_HUE: Readonly<Record<string, string>> = {
  GKP: "oklch(0.72 0.10 300)",
  DEF: "oklch(0.72 0.10 250)",
  MID: "oklch(0.72 0.10 195)",
  FWD: "oklch(0.72 0.10 345)",
};

export function positionHue(
  position: string | null | undefined,
  surface: MarginSurface = FLOODLIT,
): string {
  return POSITION_HUE[String(position ?? "").toUpperCase()] ?? surface.ink3;
}

export function difficultyTint(
  difficulty: number | null,
  surface: MarginSurface = FLOODLIT,
): readonly [string, string] {
  const mid: readonly [string, string] = ["rgba(233,238,245,.07)", surface.ink2];
  if (difficulty === null || !Number.isFinite(difficulty)) return mid;
  if (difficulty < 1 || difficulty > 5) return mid;
  // FIVE steps across the same three hues, not three steps and a collapse. FPL
  // rates 1 and 2 differently and the plan grid spends colour on every rating,
  // so folding them together hid a distinction the source publishes. They keep
  // one foreground and differ in how much of it the background carries — a step
  // on the existing scale, which is what the test above pins, rather than the
  // fourth scale this function exists to avoid.
  if (difficulty === 1) return ["rgba(120,220,140,.24)", surface.agree];
  if (difficulty === 2) return ["rgba(120,220,140,.13)", surface.agree];
  if (difficulty === 3) return mid;
  if (difficulty === 4) return ["rgba(255,140,90,.16)", surface.noise];
  return ["rgba(255,90,70,.24)", surface.conflict];
}

/**
 * The points ramp: one warm family, dark to cream.
 *
 * Sequential and single-hue on purpose. It means MORE, never BETTER — a
 * projection is a quantity, not a verdict, and a diverging ramp would paint every
 * ordinary week as a warning. Green is deliberately not used: green already means
 * a kind fixture on {@link TRAFFIC}, and one colour cannot mean "high points" on
 * one screen and "easy fixture" on the next.
 *
 * This replaces a teal-to-lime ramp that was the hardest of eight candidates to
 * read — 0.017 lightness between neighbouring bands, 0.015 under simulated
 * red-green colour blindness, and one band whose figures measured 4.17:1 against
 * the 4.5:1 floor for text that size. Copper measures 0.036 and 0.045, and every
 * band clears the floor.
 */
export const HEAT: readonly (readonly [string, string])[] = [
  ["#3b2418", "#e9eef5"],
  ["#6b3a1f", "#e9eef5"],
  ["#9c5726", "#e9eef5"],
  ["#c8823f", "#0d1013"],
  ["#e8c9a0", "#0d1013"],
];

/**
 * The difficulty ramp: red at the worst end, green at the kindest.
 *
 * The one place in this app where a colour carries a VERDICT, and it is earned:
 * an easy fixture really is good and a brutal one really is bad, which is not
 * true of a projection — a 2.5 xP defender is a smaller number, not a warning.
 * It is also the convention FPL itself prints a fixture list in, so a reader
 * arrives already knowing how to read it.
 *
 * ## Why red-to-green is safe here and usually is not
 *
 * Red-green ramps fail colour blindness when the two ends share a LIGHTNESS and
 * hue is the only thing separating them. This one runs dark red → pale amber →
 * mid green, so the lightness does the work and the hue only reinforces it.
 * Measured against the seven other candidates it separated best of all: 0.124
 * between neighbouring bands under simulated deuteranopia, against 0.015 for the
 * teal-to-lime ramp both of these replace.
 *
 * Bright means KIND here and bright means MORE on {@link HEAT}. That inversion is
 * deliberate — the two ramps measure opposite kinds of thing — and it is why the
 * two never appear on one screen without a legend saying which is which.
 */
export const TRAFFIC: readonly (readonly [string, string])[] = [
  // FOUR stops, not five, and that is the fix rather than an economy. FPL rates
  // fixtures 1 to 5 and never once assigns a 1 across a published list — the
  // observed distribution is 2:44, 3:72, 4:36, 5:8 over 160 fixtures. A five-stop
  // ramp therefore always had one colour that never appeared on screen. Four
  // values, four colours, nothing idle.
  //
  // #b3352d, not the brighter #c8443a it was drafted at: the lighter red put its
  // own figures at 4.15:1 — under the 4.5:1 floor, and the exact defect that
  // disqualified the ramp this replaces. Caught by the measurement in
  // `tokens.test.ts` rather than by eye, which is the point of measuring.
  ["#b3352d", "#e9eef5"],
  ["#d97a35", "#0d1013"],
  ["#d9bb42", "#0d1013"],
  ["#4f9455", "#0d1013"],
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

/**
 * A ramp's colours for a band index, clamped.
 *
 * Callers that have already computed a BAND — every heat surface in the app does,
 * through `bandOf` or `difficultyBand` — were reaching them through
 * {@link heatStep} by passing the band as a value and the step count as a
 * ceiling. That works and reads as arithmetic on a quantity, which it is not.
 * This says what is happening: pick stop N.
 */
export function stepOf(
  ramp: readonly (readonly [string, string])[],
  band: number,
): readonly [string, string] {
  return ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(band)))];
}



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

/** DM Mono, loaded by the root layout through next/font. */
export const MONO = "var(--font-dm-mono), ui-monospace, monospace";
/** Archivo, likewise. */
export const SANS = "var(--font-archivo), 'Helvetica Neue', system-ui, sans-serif";

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
