"use client";

/**
 * The control room's typographic parts, so five sections spell them once.
 *
 * ## Tailwind for structure, tokens for colour
 *
 * The design ships as inline-styled prototypes because its prototyping runtime
 * requires that, and those style strings are not ported. Layout, spacing and type
 * size are Tailwind here. Colour is not: every surface and ink value on this
 * screen comes from {@link PAPER} in `lib/margin/tokens.ts`, which is the module
 * the design's own token table is reconciled against, and a hex typed into a class
 * name would be a fifth copy of a value that already has one home.
 *
 * ## Three faces, three jobs, and the boundary is enforced by these components
 *
 * `Answer` is Newsreader and takes a sentence. `Figure` is Mono, tabular, and
 * takes a number. `Label` is Mono, uppercase, and takes a name. Newsreader never
 * sets a figure and never sets a label, so nothing here lets it: the display face
 * appears in exactly one component and that component is for prose.
 */

import type { CSSProperties, ReactNode } from "react";
import { DISPLAY, INK, MONO, SANS } from "@/lib/margin/tokens";

/** The screen's surface. Paper: this board is read at length, not under a clock. */
/**
 * The control room's surface.
 *
 * INK, not PAPER, and the reason is measured rather than aesthetic.
 *
 * The board shipped on PAPER inside chrome that is dark — the navigation, the manager
 * card, the deadline strip — so a light sheet sat in a dark frame, which is the first
 * thing the eye complains about. Two of the four surfaces that survive the surface cut
 * (`/margin` and this one) now agree instead of arguing.
 *
 * It is also the more legible surface at every tier that carries meaning. Against its
 * own shell: `ink2` 6.88:1, `ink3` 3.82:1, `ink4` 2.71:1. PAPER's equivalents are
 * 7.08:1, **3.17:1** and **2.06:1** — so the two tones this board uses for labels,
 * counts, provenance and the absence glyph were below the 3:1 floor on paper and one of
 * them was barely half of it.
 *
 * And it is the surface the kit marks were drawn for. `KitMark` mutes a club colour
 * toward the ground only when the surface is light, so on ink the twenty kits keep full
 * strength — which is the whole reason club is encoded as colour, because the league has
 * six reds and muted 66% toward a paper neutral they converge into one salmon.
 *
 * One line to reverse, and PAPER remains fully supported: every component here reads its
 * colours from this token and none hardcodes a light or dark literal.
 */
export const S = INK;

/**
 * The answer, or a claim, in the display face.
 *
 * Weight 400 because this screen is paper. On ink the designed pair is 500 — 400
 * goes spindly against black — and that switch belongs to the surface, not here.
 */
export function Answer(
  { size, children, className, style, as: Tag = "p" }: {
    size: number;
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
    as?: "h1" | "h2" | "p" | "span" | "div";
  },
) {
  return (
    <Tag
      className={className}
      style={{
        fontFamily: DISPLAY,
        fontSize: size,
        fontWeight: 400,
        color: S.ink,
        margin: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/**
 * A figure. Mono, tabular, and marked as one.
 *
 * `data-role="figure"` is load-bearing rather than decorative: the page's tests
 * assert that no figure appears in Ronny's or Wazza's projection, value or call
 * cells, and asserting on the absence of this attribute is what makes that a
 * mechanical check instead of a regex over a paragraph that happens to contain a
 * file name with a gameweek number in it.
 */
export function Figure(
  { size = 17, tone, title, children, style }: {
    size?: number;
    tone?: string;
    title?: string;
    children: ReactNode;
    style?: CSSProperties;
  },
) {
  return (
    <span
      data-role="figure"
      title={title}
      className="tabular-nums"
      style={{
        fontFamily: MONO,
        fontSize: size,
        fontWeight: 500,
        letterSpacing: "-.01em",
        lineHeight: 1.3,
        color: tone ?? S.ink,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * A column header or a row name. Mono, uppercase, tracked.
 *
 * The default was 9.5px, and because it was a default rather than a prop nothing
 * scanning for sizes could see it — so the eight facet labels, which are the names of
 * every row on the board, were the smallest text on the page. 11 is the floor.
 */
export function Label(
  { size = 11, tone, children, style }: {
    size?: number; tone?: string; children: ReactNode; style?: CSSProperties;
  },
) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: size,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: tone ?? S.ink2,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The eyebrow above a section. 11px, wider tracking, tertiary ink. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: ".16em",
        textTransform: "uppercase",
        color: S.ink3,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Running copy.
 *
 * Defaults to `ink2` at 7.65:1 rather than to `ink3`. The design document is
 * explicit about it: the 11px row notes failed contrast at 2.06:1 on `ink4` and
 * that was rejected, and anything doing explanatory work sits on `ink2`.
 */
export function Body(
  { size = 11.5, tone, children, style, className }: {
    size?: number;
    tone?: string;
    children: ReactNode;
    style?: CSSProperties;
    className?: string;
  },
) {
  return (
    <p
      className={className}
      style={{
        fontFamily: SANS,
        fontSize: size,
        lineHeight: 1.5,
        color: tone ?? S.ink2,
        margin: 0,
        textWrap: "pretty",
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/**
 * A sub-line under a figure: mono, 9.5px, tertiary.
 *
 * `future` dash-underlines it. That is the design's rule and it is not
 * decoration — a sub-line naming a time that has not happened yet reads
 * identically to one naming a time that has, and this board's whole tense
 * grammar is solid for fact and dashed for calendar.
 */
export function Sub(
  { future = false, children, title }: {
    future?: boolean; children: ReactNode; title?: string;
  },
) {
  return (
    <span
      title={title}
      className="tabular-nums"
      style={{
        fontFamily: MONO,
        // 11 is the floor for anything carrying meaning on this board. `Sub` states a
        // filename, an age or a counting rule — all of them things a reader checks.
        fontSize: 11,
        lineHeight: 1.5,
        color: S.ink3,
        ...(future
          ? {
            display: "inline-block",
            paddingBottom: 2,
            borderBottom: `1px dashed ${S.rule}`,
          }
          : null),
      }}
    >
      {children}
    </span>
  );
}
