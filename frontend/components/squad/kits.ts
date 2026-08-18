/**
 * The twenty clubs, as two colours and a pattern.
 *
 * ## Why colour is here at all
 *
 * Club is the **correlation grouping variable**. Same-club returns are correlated,
 * which raises squad variance — so the season objective prices a cluster as a cost
 * and the weekly objective wants one, because a correlated cluster is how a right
 * tail gets manufactured. The whole disagreement between the two bots runs through
 * club grouping, which makes this the one categorical variable on the row worth
 * spending hue on.
 *
 * Concretely: this squad holds three Man United players — Maguire, B.Fernandes with
 * the armband, and Mbeumo — all away at Hull in GW1. That is the three-per-club
 * limit, one shared fixture, and the captain inside the cluster. With three-letter
 * codes you have to read and compare to notice. With colour you see it.
 *
 * ## Why real kit colours are not enough on their own
 *
 * The league has six reds (ARS, MUN, LIV, NFO, BRE, SUN) and five blues. Hue alone
 * cannot discriminate them. What makes a real shirt recognisable is hue PLUS
 * pattern, so the mark encodes both and the three-letter code stays in the row as
 * the disambiguator of last resort. Colour narrows to a family; pattern and code
 * settle it.
 *
 * ## Why these are hand-defined and not rendered
 *
 * No crest, no sponsor, no sleeves, no photograph. A crest is unreadable below 24px
 * and a sponsor logo is somebody else's brand sitting in your table. Real kit
 * renders are club IP, about twenty assets to license, and obsolete every August
 * when the kits change. Note that fplreview does not use them either — look closely
 * at their pitch and the shirts carry their own sponsor names.
 */

export type KitPattern = "plain" | "stripes" | "sash";

export interface Kit {
  /** Short code as the artifacts spell it. */
  readonly code: string;
  /** The dominant shirt colour. */
  readonly primary: string;
  /** The stripe, sash or trim colour. Equal to `primary` only for a plain shirt. */
  readonly secondary: string;
  readonly pattern: KitPattern;
}

/**
 * Keyed by the three-letter code the pipeline emits.
 *
 * The 2026/27 Premier League as this repo's artifacts spell it, including the
 * promoted sides — Coventry, Hull and Ipswich appear in `matches.json` and a
 * missing entry would leave a player with no mark at all.
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
 * The mark's fill, given a surface's muting.
 *
 * Paper mutes; ink does not, and that asymmetry is designed rather than an
 * oversight. Kit colours are made to sing against a dark screen — which is why
 * fplreview chose that surface — so on ink they are left alone. On warm paper at
 * full strength, Hull amber and Coventry sky either shout or turn to mud, and
 * fifteen of them become a quilt. Mixing 66% toward the paper's own tint keeps the
 * hue RELATIONSHIPS (six reds still read as reds) while landing every mark in one
 * lightness band, which leaves the distribution glyph as the loudest thing in the
 * row. For a projection tool that is the correct hierarchy: the club is context,
 * the distribution is the answer.
 *
 * `color-mix` in oklab rather than sRGB: mixing toward a tint in sRGB darkens and
 * desaturates unevenly across hues, which would undo the single lightness band the
 * muting exists to produce.
 */
export function kitFill(colour: string, mute: boolean, target: string): string {
  return mute ? `color-mix(in oklab, ${colour} 66%, ${target})` : colour;
}

/** The pattern, as a CSS background. */
export function kitBackground(kit: Kit, mute: boolean, target: string): string {
  const a = kitFill(kit.primary, mute, target);
  const b = kitFill(kit.secondary, mute, target);
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
