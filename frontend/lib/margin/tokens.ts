/**
 * The Margin palette, as literal values rather than theme variables.
 *
 * ## Signal: paper, one family, and colour spent only on data
 *
 * This surface replaces SIGNAL, and the change is not a repaint. Floodlit put
 * an acid lime on a near-neutral #0d1013 and used it for identity — the
 * countdown, the wordmark, an active tab. Signal removes that job entirely:
 * `brand` is now the ink, so nothing in the chrome is coloured, and every
 * coloured thing left on a screen is a figure. A reader who sees colour here is
 * always looking at data.
 *
 * The ground is paper. Two consequences worth stating because both are load
 * bearing and neither is obvious:
 *
 *   - `surfaceIsLight` now answers TRUE, which is what the measurement was
 *     always for. The hatch takes its light-ground stroke and `KitMark` mutes a
 *     club colour toward the paper instead of away from it. Neither needed a
 *     change here; both were written against the measurement rather than
 *     against an assumption, and that is why.
 *   - {@link HEAT} runs light to DARK. Its ordering claim is unchanged — a step
 *     means more — but on paper "more" is more ink, not more light, so the
 *     ramp's luminance descends where floodlit's climbed. `tokens.test.ts`
 *     asserts monotonicity and distance-from-the-ground rather than a direction,
 *     which is the ground-independent form of the same claim.
 *
 * ## Why this does not use `--text-1` and friends
 *
 * There used to be TWO surfaces here, and the idea behind them was that the
 * surface itself carried meaning: the decision screen ink-on-black because it is
 * read once under time pressure, the reference screens ink-on-paper because they
 * are read at length.
 *
 * That is retired. There is now one surface, `SIGNAL`, and the reason is that
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
 * pairs have to hold their relative lightness across grounds — `oklch(0.82 …)`
 * on ink and `oklch(0.48 …)` on paper are the same hue read at the same
 * strength, which two hex values would not stay. Moving to paper is exactly the
 * move that form was written for, so the three keep their HUES (155, 85, 25)
 * and drop roughly 0.3 of lightness. Measured on the shell: agree 5.46:1,
 * noise 4.94:1, conflict 5.83:1.
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
 * The one surface. Paper ground, near-black ink, and no accent at all.
 *
 * Named for what it does rather than what it looks like: a signal surface spends
 * colour only where something is being reported. `brand` is the ink, which is
 * the whole of the Pressbox rule in one line — identity gets weight, case and a
 * rule, never a hue, so the four coloured things left on any screen (the two
 * ramps and the semantic three) are all quantities or verdicts.
 *
 * Alphas measured against the shell, and against `--chrome` where the masthead
 * uses them: ink 16.04:1, ink2 6.77 / 6.98, ink3 5.14 / 5.30. `ink4` is 1.75:1
 * and stays there — it is a border tone, and `legibility.test.ts` rule 2 needs
 * it to fail the text floor or the rule that keeps it off text loses its
 * premise.
 */
export const SIGNAL: MarginSurface = {
  shell: "#f1f2f4",
  bar: "#f8f9fb",
  inset: "#e6e9ee",
  hair: "rgba(20,23,28,.095)",
  rule: "rgba(20,23,28,.20)",
  ink: "#14171c",
  ink2: "rgba(20,23,28,.72)",
  // .64, not the .55 floodlit carried. The same alpha reads differently through
  // a light ground: .55 measures 3.85:1 on this shell where it measured 5.50:1
  // on #0d1013, because compositing toward paper LIGHTENS ink where compositing
  // toward ink lightens paper. .64 is the first round alpha above the measured
  // 0.60 minimum, and it clears on the chrome ground too.
  ink3: "rgba(20,23,28,.64)",
  ink4: "rgba(20,23,28,.26)",
  // Identity is the ink. See the surface docstring: this is the one token that
  // carries the redesign's whole argument, and it is deliberately not a colour.
  brand: "#14171c",
  agree: "oklch(0.48 0.12 155)",
  conflict: "oklch(0.50 0.17 25)",
  noise: "oklch(0.52 0.12 85)",
  block: "rgba(20,23,28,.22)",
  face: "#f8f9fb",
  // Barely green, and now barely green ON PAPER — a pale wash rather than a
  // dark one. Held below `bar` in luminance so the eleven still read as
  // standing on something, which `tokens.test.ts` pins.
  pitch: "#e8eee9",
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
  // 0.50 lightness, not the 0.72 these carried on ink. Same four hues, same
  // chroma, moved as a set: on paper a 0.72 lightness is a wash that no longer
  // reads as a name. Measured on the shell — GKP 5.57:1, DEF 5.35, MID 4.99,
  // FWD 5.66 — because these paint the NAME COLUMN, which is text.
  GKP: "oklch(0.50 0.10 300)",
  DEF: "oklch(0.50 0.10 250)",
  MID: "oklch(0.50 0.10 195)",
  FWD: "oklch(0.50 0.10 345)",
};

/**
 * The same five-step difficulty scale, as an opaque plate.
 *
 * **Why a second rendering rather than a second scale.** `difficultyTint` is a
 * chip that sits BESIDE text, so it is low alpha and the words next to it still
 * read. The plan grid has no words in the cell — the tile IS the cell — and a
 * low-alpha wash over the `#0d1013` shell went muddy brown-green across 168 of
 * them. Opaque plates at controlled lightness mix with nothing and stay the hue
 * they were given. `tokens.test.ts` pins that the two renderings agree on which
 * end is which, so this is one scale drawn two ways.
 *
 * **Measured, not chosen by eye.** Contrast of `ink` against each plate:
 *
 *     FDR 1  #c9e4d2  13.27:1     FDR 4  #f2dec2  13.69:1
 *     FDR 2  #dceadd  14.42:1     FDR 5  #efd0cc  12.46:1
 *     FDR 3  #eceef1  15.45:1
 *
 * On paper every plate clears the floor with room, because the figure is dark
 * and the plates are all light — the binding constraint moved. What binds now
 * is the RANKING below: a plate has to stay quieter than the neutral middle,
 * which on a light ground means it must be darker than #eceef1 rather than
 * lighter than #171b20.
 *
 * **Intensity tracks how ACTIONABLE a rating is, not its number.** FDR 3 is 45%
 * of all fixtures (see `difficultyBand` for the counted distribution), so it
 * sits almost on the shell and most of the board stays quiet. Colour appearing
 * is then itself information.
 */
const DIFFICULTY_TILE: Readonly<Record<number, string>> = {
  1: "#c9e4d2",
  2: "#dceadd",
  3: "#eceef1",
  4: "#f2dec2",
  5: "#efd0cc",
};

/**
 * The same plates, mixed halfway to the shell, for a benched week.
 *
 * On paper "halfway to the shell" lightens the plate rather than darkening it,
 * so the figure's contrast RISES again — measured with `ink2`, 5.98:1 at worst
 * (FDR 5) and 6.66:1 at best. The direction reversed; the guarantee did not.
 *
 * A bench must NOT be drawn with `opacity` on the cell — rule 3 of
 * `legibility.test.ts`, and it is there because HeatGrid did exactly that and
 * every band fell to between 1.71:1 and 2.62:1: container opacity multiplies the
 * fill and the figure together, and a light figure over a lightening ground
 * converge as both fade toward the shell.
 *
 * Dimming the PLATE moves the other way. The signal is carried by the plate and
 * a dimmer ink, both of which stay above the floor.
 */
const DIFFICULTY_TILE_BENCHED: Readonly<Record<number, string>> = {
  1: "#ddebe3",
  2: "#e7eee9",
  3: "#eff0f3",
  4: "#f2e8db",
  5: "#f0e1e0",
};

export function difficultyTile(
  difficulty: number | null | undefined,
  benched: boolean = false,
): string {
  const table = benched ? DIFFICULTY_TILE_BENCHED : DIFFICULTY_TILE;
  const mid = table[3];
  if (difficulty === null || difficulty === undefined) return mid;
  if (!Number.isFinite(difficulty)) return mid;
  return table[Math.round(difficulty)] ?? mid;
}

export function positionHue(
  position: string | null | undefined,
  surface: MarginSurface = SIGNAL,
): string {
  return POSITION_HUE[String(position ?? "").toUpperCase()] ?? surface.ink3;
}

export function difficultyTint(
  difficulty: number | null,
  surface: MarginSurface = SIGNAL,
): readonly [string, string] {
  const mid: readonly [string, string] = ["rgba(20,23,28,.055)", surface.ink2];
  if (difficulty === null || !Number.isFinite(difficulty)) return mid;
  if (difficulty < 1 || difficulty > 5) return mid;
  // FIVE steps across the same three hues, not three steps and a collapse. FPL
  // rates 1 and 2 differently and the plan grid spends colour on every rating,
  // so folding them together hid a distinction the source publishes. They keep
  // one foreground and differ in how much of it the background carries — a step
  // on the existing scale, which is what the test above pins, rather than the
  // fourth scale this function exists to avoid.
  if (difficulty === 1) return ["rgba(0,140,80,.20)", surface.agree];
  if (difficulty === 2) return ["rgba(0,140,80,.11)", surface.agree];
  if (difficulty === 3) return mid;
  if (difficulty === 4) return ["rgba(190,120,0,.20)", surface.noise];
  return ["rgba(190,40,40,.20)", surface.conflict];
}

/**
 * The points ramp: one cool family, paper to slate.
 *
 * Sequential and single-hue on purpose. It means MORE, never BETTER — a
 * projection is a quantity, not a verdict, and a diverging ramp would paint every
 * ordinary week as a warning. Green is deliberately not used: green already means
 * a kind fixture on {@link TRAFFIC}, and one colour cannot mean "high points" on
 * one screen and "easy fixture" on the next.
 *
 * ## It descends, where the copper ramp climbed
 *
 * On ink, more points meant more light. On paper, more points means more INK —
 * so the luminance runs the other way and the ordering claim is untouched.
 * `tokens.test.ts` asserts strict monotonicity plus "the far end is further from
 * the ground than the near end", which is the same guarantee written so it holds
 * on either surface; the old assertion baked in a direction that was only ever
 * true of a dark ground.
 *
 * Blue rather than a warm family because this ramp has to survive the colour
 * vision test that the fixture ramp is measured on, and a blue scale barely
 * moves under it. Measured neighbour separation under simulated deuteranopia:
 * 0.215, 0.200, 0.194, 0.141, against a 0.03 floor. Every band carries its
 * figure — 15.17, 11.53, 8.14, 4.82 and 6.78:1, the fourth on dark ink and the
 * last on paper, which is where the ramp crosses over.
 */
export const HEAT: readonly (readonly [string, string])[] = [
  ["#e9ecf1", "#14171c"],
  ["#c6d0de", "#14171c"],
  ["#9fb0c8", "#14171c"],
  ["#6e86a8", "#14171c"],
  ["#3b5480", "#f1f2f4"],
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
  // STRONGER THAN THE ARTBOARD, and this is the one place the shipped surface
  // departs from the design it was approved from. Signal's sketch drew these as
  // pale tints — #f2d8da, #f4e2ce, #e9eaee, #d3e9e2 — which look right beside
  // one another on paper and measure 0.044, 0.032 and 0.064 of neighbour
  // separation under simulated deuteranopia, against this ramp's 0.08 floor.
  // Two of the three collapse. A reader with the most common colour vision
  // deficiency would have seen a fixture list with no fixture difficulty in it.
  //
  // These four are the palest set that clears the floor: 0.301, 0.235 and 0.341.
  // They still read as tints rather than plates, and every one carries the dark
  // figure — 5.10, 10.50, 14.94 and 9.58:1 — so the mid band can sit almost on
  // the shell and colour appearing is still itself information.
  ["#c96f6a", "#14171c"],
  ["#e9bf88", "#14171c"],
  ["#e9eaee", "#14171c"],
  ["#95c9a8", "#14171c"],
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
  // Signal's ink (20,23,28) on the light branch, which is the one the single
  // surviving surface now takes — the same idea as before, that the hatch is
  // the colour of the text near it. The dark branch is what is unreachable now,
  // and it is kept for the same reason its opposite was: `surfaceIsLight` is
  // measured, so a surface added later gets the right stroke without anyone
  // remembering this function exists.
  const stroke = surfaceIsLight(surface)
    ? "rgba(20,23,28,.16)"
    : "rgba(233,238,245,.18)";
  return `repeating-linear-gradient(45deg, ${stroke} 0 3px, transparent 3px 6px)`;
}

/**
 * IBM Plex Sans, loaded by the root layout through next/font — and the only
 * face this app loads.
 *
 * Signal's typographic claim is that ONE family does every job and weight alone
 * separates a figure from a label. So `MONO`, `SANS` and `DISPLAY` all resolve
 * here. They are kept as three names rather than collapsed to one because they
 * are three ROLES, and the roles are what a view spells: a component asking for
 * `MONO` is saying "this is a figure in a column", and that stays true and stays
 * worth reading whether or not the answer is currently a separate face.
 *
 * ## Losing the monospaced face costs nothing here, and the reason is specific
 *
 * DM Mono was carried for one property: figures of equal width, so a column of
 * projections compares by eye. That property is not a monospaced font's to give
 * — it is `font-variant-numeric: tabular-nums`, which `globals.css` applies at
 * the body and which Plex Sans answers. What a monospaced face adds on top is
 * equal widths for LETTERS, which this app never needed and which is what made
 * every tracked label read as a terminal rather than as apparatus.
 *
 * The weight ceiling that came with DM Mono goes too. It published 300/400/500
 * and no more, so rules wanting emphasis had to reach for a display face or for
 * case and tracking. Plex publishes 400 through 700, which is what lets Signal
 * put a figure and its label in one family without the figure going quiet.
 */
export const SANS = "var(--font-plex-sans), 'Helvetica Neue', system-ui, sans-serif";

/**
 * The figure role. Same family as {@link SANS}; see that docstring for why a
 * column still lines up without a monospaced face.
 */
export const MONO = SANS;

/**
 * The display role: the one figure a screen exists to deliver.
 *
 * Anton set this, and Anton was a heavy condensed poster face chosen to carry a
 * scoreboard number on a dark ground. Signal has no scoreboard and no dark
 * ground — the figure is set large in the body family at 600, and the size does
 * the work that the condensed face used to do with weight and width. That is
 * the whole of the "one family" argument: nothing on the screen is a different
 * shape, only a different size.
 */
export const DISPLAY = SANS;
