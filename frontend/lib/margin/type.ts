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

import { SANS } from "@/lib/margin/tokens";

/**
 * The small tracked uppercase label above a block.
 *
 * 9px is deliberate and is the floor: `lib/margin/legibility.test.ts` fixes 11px
 * as the minimum for anything that carries MEANING, and an eyebrow does not — it
 * names a region the reader is already looking at, and the thing carrying meaning
 * is the figure underneath. A label below the floor is only acceptable because it
 * is redundant with what it labels.
 */
export const EYEBROW = {
  fontFamily: SANS,
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: ".15em",
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
