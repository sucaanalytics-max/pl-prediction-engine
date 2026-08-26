/**
 * The typographic roles, as the artboards set them.
 *
 * A new file rather than more constants in `tokens.ts`, because these are not
 * colours: they are the type treatments every screen repeats, and having them in
 * one place is what stops the ninth copy of an eyebrow drifting to 10px and
 * weight 700.
 *
 * ## What used to be here
 *
 * `FIGURE`, `DENSITY` and `chipStyle` are gone. All three had zero callers: the
 * segmented control was reimplemented inline in four places instead of importing
 * the helper, and the inline copies drifted (4px padding against the helper's 5px)
 * — which is precisely the failure this file's own docstring was written to
 * prevent. The helper was written and never adopted, so it guarded nothing while
 * looking like it did, and one of its lines carried a live bug: `borderRight`
 * followed by `border: 0` in the same object, which React applies in order, so
 * the divider never drew.
 *
 * Deleted rather than adopted because adopting it is a real consolidation of five
 * controls and belongs in its own change. Removing the unused twin is what stops
 * a reader believing the consolidation already happened.
 *
 * ## Why the eyebrow is not mono
 *
 * Every screen in this app had its small tracked uppercase labels set in the mono
 * face, on the reasoning that a label is apparatus rather than prose. The
 * artboards set them in the BODY face at 600 — and they are right, for a reason
 * that only shows at 9px: a monospaced face spends its width budget making every
 * glyph the same width, so an `I` in `PROJECTIONS` gets the same box as the `O`,
 * and tracked out to .15em the word comes apart. A proportional grotesque at 600
 * keeps the word a word. Mono earns its place on FIGURES, where equal widths are
 * the entire point because columns of them have to line up.
 *
 * So: mono for anything that is a number in a column, body face for anything that
 * is a word — including words in small caps pretending to be apparatus.
 */

import type React from "react";

import { FLOODLIT, SANS } from "@/lib/margin/tokens";

/**
 * The small tracked uppercase label above a block.
 *
 * ## 11px, and it used to be 9px on an argument that measurement dissolved
 *
 * This was the ONE exemption from the 11px floor in `legibility.test.ts`, argued like
 * this: an eyebrow names a region the reader is already looking at, so it is redundant
 * with the figure underneath, so it may be small. The argument was sound as far as it
 * went. It was also unnecessary, and an unnecessary exemption in a legibility guard is
 * a hole with a good story attached.
 *
 * What settled it was measuring instead of reasoning. Rendered in the browser with the
 * page's own Archivo, a tracked uppercase label at 11px/.04em occupies the SAME width as
 * the same label at 9px/.15em:
 *
 *     Pos       23.1px at 9/.15    ->  23.3px at 11/.04
 *     Mins      28.1px             ->  27.8px
 *     BENCH     39.6px             ->  40.1px
 *     TEMPLATE  59.7px             ->  59.8px
 *
 * Tracking was costing more width than the two extra pixels of size. So clearing the
 * floor here is free — no grid track widens, no label wraps — and the exemption bought
 * nothing but smaller text. It is gone, and `legibility.test.ts` now has no exemptions
 * at all.
 *
 * The tracking that remains (.04em) is what still makes this read as apparatus rather
 * than as a heading; {@link COLUMN_HEAD} uses the same value for the same reason.
 */
export const EYEBROW = {
  fontFamily: SANS,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".04em",
  textTransform: "uppercase",
} as const;

/**
 * A column header. 11px, because it is the only thing saying what a column means.
 *
 * Separate from {@link EYEBROW} rather than a variant of it, and the split is the
 * point: EYEBROW's exemption from the 11px floor rests on being REDUNDANT with the
 * figure beneath it, and a column header is the opposite — strip it and a column of
 * numbers means nothing. `legibility.test.ts` said so in prose ("those are being
 * moved to 11px rather than exempted") while `Eleven.tsx` spread EYEBROW into all
 * eight of its headers, so nine labels sat at 9px under a comment promising 11.
 *
 * Two deliberate differences beyond the size:
 *
 * - Tracking drops .15em → .04em. An eyebrow is tracked out so a lone word reads as
 *   apparatus; a column header is already apparatus by POSITION. Tracking is also
 *   what makes it fit: `Pos` sits in a 34px column and `Mins` in a 44px one, and at
 *   .15em they overrun their content boxes at 11px.
 * - No `textTransform`. `xP` and `q25–q75` are terms of art whose case carries
 *   meaning — uppercased they read as `XP` (experience points) and `Q25–Q75`.
 */
export const COLUMN_HEAD = {
  fontFamily: SANS,
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: ".04em",
} as const;

/**
 * The eyebrow as a component, because three grids had written it themselves.
 *
 * `HeatGrid`, `StatsTable` and `PhaseMatrix` each declared a local `Label` with an
 * inline `fontSize: 9`, and each carried its own paragraph making the SAME argument —
 * that an eyebrow is set in the body face at 600 and not in mono, because mono is for
 * figures in columns. Three copies of one rule is three places for it to drift, and it
 * had already drifted: the tracking differed between them.
 *
 * What settled the case was the floor pass. Raised independently to clear 11px, all
 * three bodies came out BYTE-IDENTICAL — same face, same size, same .04em, same weight,
 * same tone. Three files had converged on one answer by accident, which is the moment to
 * write it once.
 *
 * `color` is a prop only because `StatsTable` genuinely varies it; everything else takes
 * the default.
 */
export function Label(
  { children, color }: {
    readonly children: React.ReactNode;
    /** Defaults to the surface's third ink tier, which is what a label wants. */
    readonly color?: string;
  },
) {
  return (
    <span style={{ ...EYEBROW, color: color ?? FLOODLIT.ink3 }}>{children}</span>
  );
}
