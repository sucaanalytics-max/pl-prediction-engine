/**
 * The twenty clubs, as two colours and a pattern.
 *
 * ## Recovered, not written
 *
 * This shipped once as `components/squad/kits.ts` and was deleted in 585a423,
 * "delete the 21 modules only the cut routes reached" — not judged and cut, but
 * swept up, because its only importer was `components/squad/SquadRow.tsx` and that
 * whole directory became unreachable when a route was removed. Two orphans in the
 * live tree recorded the loss without anyone reading them: `KIT_MIX_TARGET` still
 * exported from `tokens.ts` and asserted by `tokens.test.ts`, imported by nothing;
 * and `surfaceIsLight()`'s docstring still naming "the kit mark" as a caller.
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
 * How far a shirt colour may be lightened toward the shell before it out-shouts type.
 *
 * The original shipped for two surfaces and muted DOWN toward a paper tint; that
 * surface no longer exists, and its surviving comment claimed a dark ground "needs
 * no equivalent". Measured, that is wrong on exactly three clubs. Fulham, Leeds and
 * Spurs are `#ffffff`, which is 19.08:1 against the shell — brighter than the app's
 * own primary ink at 16.37:1. Three shirts would be the loudest objects on the call
 * screen, louder than the player names beside them, which inverts the hierarchy the
 * mark exists to support: the club is context, the projection is the answer.
 *
 * 0.84 lands those three at #d6d6d6 / 13.13:1 — under the ink, and still above the
 * next brightest club (Coventry at 11.23:1), so the ordering between shirts is
 * preserved and only the shouting is removed. No other club is touched.
 */
export const KIT_CEILING = 0.84;

/**
 * The silhouette's outline, fixed rather than derived from the club.
 *
 * Aston Villa's claret measures 1.54:1 against the shell and Newcastle's near-black
 * 1.17:1, so those two shirts are holes in the page without one. The original used
 * the surface hairline, `rgba(233,238,245,.075)`, which composites to 1.18:1 — an
 * invisible outline around an invisible shirt.
 *
 * `ink3`'s composite is 3.21:1, which is what `legibility.test.ts` certifies at the
 * 3:1 floor for a non-text graphical object. Club-independent by design: the
 * SHAPE is then guaranteed legible whatever the fill does, which is the property a
 * per-club outline could never promise.
 */
export const KIT_OUTLINE = "rgba(233, 238, 245, 0.38)";

/** Clamp a colour that would sit brighter than type. Others pass through. */
export function kitTone(colour: string): string {
  // `color-mix` in oklab rather than sRGB: mixing toward the shell in sRGB darkens
  // unevenly across hues and would break the lightness band the ceiling creates.
  return colour.toLowerCase() === "#ffffff"
    ? `color-mix(in oklab, ${colour} ${Math.round(KIT_CEILING * 100)}%, #0d1013)`
    : colour;
}

/**
 * The pattern, as a CSS background, for anything at least 10px wide.
 *
 * Below that a 3px repeat degenerates into one flat colour and the stripe is a lie;
 * use {@link kitStripe} there instead.
 */
export function kitBackground(kit: Kit): string {
  const a = kitTone(kit.primary);
  const b = kitTone(kit.secondary);
  switch (kit.pattern) {
    case "stripes":
      return `repeating-linear-gradient(90deg, ${a} 0 3px, ${b} 3px 6px)`;
    case "sash":
      return `linear-gradient(115deg, ${a} 0 38%, ${b} 38% 58%, ${a} 58% 100%)`;
    case "plain":
    default:
      return a;
  }
}

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
  if (kit.pattern === "plain") return a;
  return `linear-gradient(180deg, ${a} 0 50%, ${b} 50% 100%)`;
}

/** The kit for a club code, or null. Never a guessed colour. */
export function kitFor(code: string | null | undefined): Kit | null {
  if (!code) return null;
  return KITS[code.toUpperCase()] ?? null;
}
