/**
 * The twenty clubs, as two colours and a pattern.
 *
 * ## Recovered, not written
 *
 * This shipped once as `components/squad/kits.ts` and was deleted in 585a423,
 * "delete the 21 modules only the cut routes reached" — not judged and cut, but
 * swept up, because its only importer was `components/squad/SquadRow.tsx` and that
 * whole directory became unreachable when a route was removed. Two orphans in the
 * live tree recorded the loss without anyone reading them: `KIT_MIX_TARGET`, still
 * exported from `tokens.ts` and asserted by `tokens.test.ts` but imported by
 * nothing; and `surfaceIsLight()`'s docstring, still naming "the kit mark" as a
 * caller. The token has since been deleted — this file muted the three white
 * shirts with {@link KIT_CEILING} instead, mixing toward the DARK shell, which is
 * the surface that actually exists.
 *
 * It lives HERE, beside the palette, rather than back under `components/`, because
 * the directory was the whole cause: a token next to `tokens.ts` cannot be orphaned
 * by a route cut.
 *
 * ## Why colour is here at all
 *
 * Club is the **correlation grouping variable**. Same-club returns are correlated,
 * which raises squad variance, so a cluster is a risk you should be able to see
 * rather than count. Measured on this squad in GW2: three Man United players —
 * Maguire, B.Fernandes with the armband, and Mbeumo — one shared fixture, and 33%
 * of the eleven's projected points riding on it. Today that reads as three
 * identical fixture chips a reader has to notice. In colour it is one glance.
 *
 * That is why this is not decoration and does not breach the three-meaning rule:
 * `tokens.ts` permits "a fourth hue, off the semantic three, because identity is
 * not a judgement". A club colour names WHO, never HOW GOOD.
 *
 * ## Why real kit colours are not enough on their own
 *
 * The league has seven reds and five blues; hue alone cannot discriminate them.
 * (The original docstring said six, omitting Bournemouth — whose #da291c is
 * byte-identical to Man United's. It reads as a stripe rather than a red shirt,
 * but by hue it is a red, and `kits.test.ts` pins the seven.) Measured on these twenty primaries, 22 pairs collide on
 * hue and 10 still collide after pattern is added — LIV and MUN are both plain reds
 * and nothing here separates them, which is also true on a television. So the mark
 * narrows to a family and the three-letter code in the row settles it. The shirt is
 * a recognition accelerator, never an identifier, and must not be asked to carry a
 * fact on its own.
 *
 * ## Why these are hand-defined and not rendered
 *
 * No crest, no sponsor, no sleeves, no photograph. A crest is unreadable below 24px,
 * a sponsor is somebody else's brand in your table, and real kit renders are club IP
 * that goes obsolete every August. fplreview does not use them either — their pitch
 * shirts carry invented sponsors ("EYETEST", "GRASS FC") for exactly this reason.
 *
 * This app goes one step further and carries no lettering at all, because it has to:
 * for six of the twenty clubs the best available foreground — the app's own ink or
 * its shell, whichever wins — lands between 3.7:1 and 4.4:1, under the 4.5:1 floor
 * for text this size. So the operative rule, and the reason `Kit` has no `ink`
 * field: **club colour paints geometry and never sits behind type.**
 */

import { SIGNAL } from "@/lib/margin/tokens";

/** Plain, vertically striped, or a diagonal sash. Enough to separate the reds. */
export type KitPattern = "plain" | "stripes" | "sash";

export interface Kit {
  /** Short code exactly as `SquadPlayer.team` spells it (FPL's `short_name`). */
  readonly code: string;
  /** The dominant shirt colour. */
  readonly primary: string;
  /** The stripe, sash or trim colour. Equal to `primary` only for a plain shirt. */
  readonly secondary: string;
  readonly pattern: KitPattern;
}

/**
 * Keyed by the three-letter code the live route emits.
 *
 * The 2026/27 Premier League including the promoted sides — Coventry, Hull and
 * Ipswich. A missing entry leaves a player with no mark at all, which is why the
 * renderer refuses rather than guessing a colour.
 */
export const KITS: Readonly<Record<string, Kit>> = {
  ARS: { code: "ARS", primary: "#ef0107", secondary: "#ffffff", pattern: "plain" },
  AVL: { code: "AVL", primary: "#670e36", secondary: "#95bfe5", pattern: "sash" },
  BOU: { code: "BOU", primary: "#da291c", secondary: "#000000", pattern: "stripes" },
  BHA: { code: "BHA", primary: "#0057b8", secondary: "#ffffff", pattern: "stripes" },
  BRE: { code: "BRE", primary: "#e30613", secondary: "#ffffff", pattern: "stripes" },
  CHE: { code: "CHE", primary: "#034694", secondary: "#ffffff", pattern: "plain" },
  COV: { code: "COV", primary: "#78d2f7", secondary: "#ffffff", pattern: "plain" },
  CRY: { code: "CRY", primary: "#1b458f", secondary: "#c4122e", pattern: "stripes" },
  EVE: { code: "EVE", primary: "#003399", secondary: "#ffffff", pattern: "plain" },
  FUL: { code: "FUL", primary: "#ffffff", secondary: "#000000", pattern: "plain" },
  HUL: { code: "HUL", primary: "#f5a12d", secondary: "#000000", pattern: "stripes" },
  IPS: { code: "IPS", primary: "#0044a9", secondary: "#ffffff", pattern: "plain" },
  LEE: { code: "LEE", primary: "#ffffff", secondary: "#1d428a", pattern: "plain" },
  LIV: { code: "LIV", primary: "#c8102e", secondary: "#00b2a9", pattern: "plain" },
  MCI: { code: "MCI", primary: "#6caddf", secondary: "#ffffff", pattern: "plain" },
  MUN: { code: "MUN", primary: "#da291c", secondary: "#ffe500", pattern: "plain" },
  NEW: { code: "NEW", primary: "#241f20", secondary: "#ffffff", pattern: "stripes" },
  NFO: { code: "NFO", primary: "#dd0000", secondary: "#ffffff", pattern: "plain" },
  SUN: { code: "SUN", primary: "#eb172b", secondary: "#ffffff", pattern: "stripes" },
  TOT: { code: "TOT", primary: "#ffffff", secondary: "#132257", pattern: "plain" },
};

/**
 * How far a white shirt is pulled toward the ink before it stops being the page.
 *
 * The clamp survives the move to paper; its ARGUMENT inverts, and the fraction has
 * to move with it. On the dark surface the three white shirts — Fulham, Leeds and
 * Spurs — were the loudest objects on the call screen at 19.08:1, brighter than the
 * app's own ink, and 0.84 pulled them under it. On paper `#ffffff` is 1.12:1 against
 * the shell: the same three shirts are now the QUIETEST objects, indistinguishable
 * from the paper they are printed on, and the same clamp at 0.84 lands them at
 * #d4d5d6 / 1.31:1, which is still nothing.
 *
 * 0.50 lands them at #7f8184 / 3.49:1 — clear of the 3:1 graphical floor, and a mid
 * grey rather than a dark one, so a white shirt still reads as the lightest kit on
 * the board and the ordering between clubs is preserved. No other club is touched.
 *
 * Coventry's sky blue is 1.52:1 here and is deliberately NOT clamped, for the same
 * reason Aston Villa's claret was not clamped on ink at 1.54:1: a shirt that is
 * merely close to the ground is the OUTLINE's problem, and `KIT_OUTLINE` traces
 * every shape at 5.14:1 whatever the fill does. Only the shirt that is literally the
 * ground gets a fill adjustment.
 */
export const KIT_CEILING = 0.5;

/**
 * The silhouette's outline, fixed rather than derived from the club.
 *
 * On paper it is Coventry's sky blue at 1.52:1 and the three white shirts at 1.12:1
 * that are holes in the page without one — the exact inverse of the dark surface,
 * where Aston Villa's claret (1.54:1) and Newcastle's near-black (1.17:1) were the
 * two that vanished and those two now measure 11.07:1 and 14.51:1. Which clubs need
 * the outline changes with the ground; that every club has one does not, and that is
 * the argument for a club-independent outline rather than a derived one. The original used
 * the surface hairline, `rgba(233,238,245,.075)`, which composites to 1.18:1 — an
 * invisible outline around an invisible shirt.
 *
 * A REFERENCE to `SIGNAL.ink3`, not a copy of its value. It shipped as the literal
 * `rgba(233, 238, 245, 0.38)` with a docstring calling it "a fixed ink3 outline at
 * 3.21:1" — and three commits later ink3 was raised from .38 to .55, so the literal
 * silently stopped being ink3 while the docstring went on claiming
 * `legibility.test.ts` certified it. It now measures 5.50:1 and tracks the palette,
 * which is the only version of "fixed" worth having. `kits.test.ts` pins the
 * identity so a future edit cannot re-fork them.
 *
 * Club-independent by design: the SHAPE is then legible whatever the fill does,
 * which is a property a per-club outline could never promise.
 */
export const KIT_OUTLINE = SIGNAL.ink3;

/**
 * Clamp a colour that would sit brighter than type. Others pass through.
 *
 * Mixed toward `SIGNAL.ink`, not toward a literal. It shipped as `#0d1013` — the
 * floodlit shell — which was the right direction on ink and the wrong one on
 * paper: a white shirt mixed toward a light GROUND stays invisible, and the
 * whole point of the clamp is to pull it away from whatever the page is. Ink is
 * the thing it must move toward on either surface, and naming the token rather
 * than the value is the same lesson `KIT_OUTLINE` above already learned.
 */
export function kitTone(colour: string): string {
  // `color-mix` in oklab rather than sRGB: mixing in sRGB shifts unevenly across
  // hues and would break the lightness band the ceiling creates.
  return colour.toLowerCase() === "#ffffff"
    ? `color-mix(in oklab, ${colour} ${Math.round(KIT_CEILING * 100)}%, ${SIGNAL.ink})`
    : colour;
}

/*
 * `kitBackground()` used to live here: the pattern as a CSS `background` string, for
 * the bordered-div version of the mark. `KitMark` is an `<svg>` now — a `<polygon>`
 * with a `<pattern>`/`<linearGradient>` fill — because a CSS border cannot trace a
 * clipped shoulder, so nothing needed a CSS gradient any more and the function was
 * left with only its own test for company. `kitStripe` below stays: the eleven's
 * club rule really is a CSS background-image on a table row.
 */

/**
 * A club's colour as a narrow rule, for a table row's leading edge.
 *
 * A 3px-repeat stripe inside a 4px-wide bar renders as a single arbitrary colour —
 * whichever band the pixel lands in — so a striped club would read as a plain one
 * and, worse, as a DIFFERENT plain one depending on rounding. At this width the
 * pattern becomes a two-stop vertical split, which keeps the club's two colours
 * present and stays stable under any width.
 */
export function kitStripe(kit: Kit): string {
  const a = kitTone(kit.primary);
  const b = kitTone(kit.secondary);
  // ALWAYS a gradient, including for a plain club, and that is not stylistic.
  // A caller paints this through `background-image`, which cannot take a colour:
  // a bare hex is simply dropped, so returning one made the rule vanish for the
  // eleven plain clubs while the four striped ones rendered. Shipped that way —
  // four of fifteen rows carried a stripe and the feature looked absent.
  //
  // TWO comma-separated stops for a plain club, not one stop spanning the whole
  // bar, and that is not stylistic either. `linear-gradient(180deg, X 0 100%)` is
  // valid CSS and Chrome paints it — this rendered correctly in production — but
  // jsdom's parser rejects a single-stop gradient and DROPS the whole declaration,
  // so `style.backgroundImage` came back empty and no test could ever observe the
  // club rule on a plain club. Eleven of the twenty. Measured through
  // `element.style`: `X 0 100%` and `X 0% 100%` both round-trip to `""`, while
  // `X 0%, X 100%` round-trips intact. The two are the same paint, so the spelling
  // that survives both parsers is free.
  if (kit.pattern === "plain") {
    return `linear-gradient(180deg, ${a} 0%, ${a} 100%)`;
  }
  return `linear-gradient(180deg, ${a} 0% 50%, ${b} 50% 100%)`;
}

/** The kit for a club code, or null. Never a guessed colour. */
export function kitFor(code: string | null | undefined): Kit | null {
  if (!code) return null;
  return KITS[code.toUpperCase()] ?? null;
}
