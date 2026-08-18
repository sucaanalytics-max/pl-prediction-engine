/**
 * The two rules that made this board unreadable, enforced instead of remembered.
 *
 * The control room shipped with labels, band counts, provenance lines and absence
 * glyphs set between 8.5px and 10px in `ink3` and `ink4`. Measured against their own
 * ground: `ink3` is 3.17:1 on paper and 3.82:1 on ink; `ink4` is 2.06:1 and 2.71:1.
 * WCAG's floor is 4.5:1 for text under 18.66px and 3:1 for large text and UI, so every
 * one of those figures was below the line — and two of them below the line for ANY size.
 *
 * The rules:
 *   1. Nothing that carries meaning is set below 11px.
 *   2. `ink4` is a border tone. It never paints text.
 *
 * Both are scanned rather than trusted, because both were violated by code written to a
 * document that stated the contrast requirement correctly.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INK, PAPER, surfaceIsLight, type MarginSurface } from "@/lib/margin/tokens";

/**
 * The floor for anything that carries meaning.
 *
 * Only the floor is enforced, not a full scale. The display tier in use (13 to 46) is
 * not yet a single system, and a "scale" test wide enough to admit every value already
 * shipped would enforce nothing while generating churn. Unifying the display sizes is a
 * separate piece of work; letting 8.5px labels back onto the board is not.
 */
const FLOOR = 11;

const SURFACES: ReadonlyArray<readonly [string, MarginSurface]> = [
  ["PAPER", PAPER], ["INK", INK],
];

/** The board and everything it renders. */
const ROOTS = [
  "components/control-room",
  "components/squad",
  "app/control-room",
];

/**
 * Margin components the BOARD renders, so its primitives are held to the board's rule.
 *
 * The rest of `components/margin` — ScoreView, Planner, DecideView, ResearchView,
 * WatchView, NewsView — carries 91 sizes below this floor. That is a real backlog and it
 * is deliberately not in scope here: those are the `/margin` surface, several are slated
 * for deletion by the surface cut, and a test that fails on 91 pre-existing violations
 * gets skipped rather than fixed. Add them when that surface is next opened.
 */
const BOARD_PRIMITIVES = [
  "components/margin/Marks.tsx",
  "components/margin/Provenance.tsx",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}
const FILES = [...ROOTS.flatMap((r) => sources(r)), ...BOARD_PRIMITIVES];

// ── contrast ────────────────────────────────────────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function parse(colour: string, ground: readonly [number, number, number]) {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    return [0, 2, 4].map((o) => parseInt(hex[1].slice(o, o + 2), 16)) as
      unknown as [number, number, number];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/
    .exec(colour.trim());
  if (rgba) {
    const [r, g, b] = [1, 2, 3].map((i) => Number(rgba[i]));
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    // Composited over the ground, which is how the browser paints it.
    return [0, 1, 2].map((i) =>
      Math.round([r, g, b][i] * a + ground[i] * (1 - a))) as unknown as
      [number, number, number];
  }
  return null;
}
function ratio(colour: string, surface: MarginSurface): number | null {
  const ground = parse(surface.shell, [0, 0, 0]);
  if (!ground) return null;
  const fg = parse(colour, ground);
  if (!fg) return null;
  const [hi, lo] = [luminance(fg), luminance(ground)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the tones this board paints text with", () => {
  for (const [name, surface] of SURFACES) {
    it(`${name}: ink and ink2 clear 4.5:1, so body text can use them`, () => {
      for (const tone of ["ink", "ink2"] as const) {
        const r = ratio(surface[tone], surface)!;
        expect(r, `${name}.${tone} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: ink3 clears 3:1, so tracked labels may use it but body may not`, () => {
      const r = ratio(surface.ink3, surface)!;
      expect(r).toBeGreaterThanOrEqual(3);
      expect(r, "if ink3 ever clears 4.5 this rule can relax").toBeLessThan(4.5);
    });

    it(`${name}: ink4 fails 3:1, which is why it may not paint text`, () => {
      // Asserted, not assumed: this is the premise the scan below depends on.
      expect(ratio(surface.ink4, surface)!).toBeLessThan(3);
    });
  }

  it("agrees with the surface helper about which ground is which", () => {
    expect(surfaceIsLight(PAPER)).toBe(true);
    expect(surfaceIsLight(INK)).toBe(false);
  });
});

describe("rule 1 — nothing meaningful below 11px", () => {
  it("finds no size under the floor anywhere on the board", () => {
    const offenders: string[] = [];
    for (const path of FILES) {
      const source = readFileSync(path, "utf8");
      const sizes = [
        ...source.matchAll(/fontSize:\s*([0-9.]+)/g),
        ...source.matchAll(/size=\{([0-9.]+)\}/g),
        /*
         * Defaults, which is how the worst offender hid: the eight facet labels — the
         * name of every row on the board — took `Label`'s `size = 9.5` default, so no
         * scan looking for an explicit size could see the smallest text on the page.
         */
        ...source.matchAll(/\bsize = ([0-9.]+)/g),
      ];
      for (const m of sizes) {
        if (Number(m[1]) < FLOOR) offenders.push(`${path}: ${m[0]}`);
      }
    }
    expect(offenders, `below the ${FLOOR}px floor`).toEqual([]);
  });

});

describe("rule 2 — ink4 is a border tone", () => {
  it("never paints text with it", () => {
    /* `color: surface.ink4` and `tone={S.ink4}` are the two ways this board sets a text
       colour. A border, a background or a gradient stop is fine — those are not read. */
    const offenders: string[] = [];
    for (const path of FILES) {
      const source = readFileSync(path, "utf8");
      for (const m of source.matchAll(/(?:color:\s*|tone=\{)\s*\w+\.ink4/g)) {
        offenders.push(`${path}: ${m[0].trim()}`);
      }
    }
    expect(
      offenders,
      "ink4 measures under 3:1 on both surfaces — use it for a border, never for text",
    ).toEqual([]);
  });
});
