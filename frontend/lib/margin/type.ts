/**
 * The typographic roles, as the artboards set them.
 *
 * A new file rather than more constants in `tokens.ts`, because these are not
 * colours: they are the two or three type treatments every screen repeats, and
 * having them in one place is what stops the ninth copy of an eyebrow drifting to
 * 10px and weight 700.
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

import { MONO, SANS } from "@/lib/margin/tokens";

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

/** A figure in a column: mono, tabular, never above weight 500. */
export const FIGURE = {
  fontFamily: MONO,
  fontVariantNumeric: "tabular-nums",
} as const;

/**
 * Density, from the artboards.
 *
 * Named rather than inlined because the four control bars on four screens were
 * each a slightly different height, and a reader moving between them saw the
 * chrome shift under a layout that had not changed.
 */
export const DENSITY = {
  /** A control bar's padding. */
  bar: "11px 16px",
  /** A chip inside a segmented control. */
  chip: "5px 9px",
  /** The footer note block. */
  footer: "14px 16px",
  /** Between footer note columns. */
  footerGap: 32,
  /** A grid row on a dense table. */
  row: 42,
  /** A cell on the phase matrix, which is denser still. */
  cell: 26,
} as const;

/** The chip style for a segmented control, active or not. */
export function chipStyle(active: boolean, rule: string, ink: string, ink3: string) {
  return {
    padding: DENSITY.chip,
    fontSize: 10.5,
    fontWeight: active ? 600 : 400,
    background: active ? "rgba(233,238,245,.10)" : "transparent",
    color: active ? ink : ink3,
    borderRight: `1px solid ${rule}`,
    border: 0,
    cursor: "pointer",
  } as const;
}
