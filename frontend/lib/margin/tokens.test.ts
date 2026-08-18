/**
 * The token system's two structural claims.
 *
 *   1. Hue carries judgement and nothing else. Three semantic hues mean fine,
 *      inside-the-noise and needs-attention. Identity is not a judgement, so the
 *      brand takes a fourth hue that cannot be mistaken for a verdict. Before it
 *      existed, `--accent` did both jobs: a green active tile and a green
 *      "agrees with the market" were the same colour.
 *   2. Ink and paper are two DESIGNED sets, not one inverted. A chroma that
 *      reads as considered on paper reads as a glow on black, so the pairs
 *      differ deliberately rather than mechanically.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { INK, PAPER, KIT_MIX_TARGET, hatch } from "@/lib/margin/tokens";

/** Pull the hue angle out of an oklch() triple. */
function hue(value: string): number {
  const m = value.match(/oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  return Number(m[1]);
}
function chroma(value: string): number {
  const m = value.match(/oklch\(\s*[\d.]+\s+([\d.]+)/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  return Number(m[1]);
}

describe("hue carries judgement, and identity is not a judgement", () => {
  for (const [name, s] of [["paper", PAPER], ["ink", INK]] as const) {
    it(`keeps the brand off all three semantic hues on ${name}`, () => {
      const semantic = [hue(s.agree), hue(s.noise), hue(s.conflict)];
      for (const h of semantic) {
        // Not merely different — far enough that no reader reads a verdict.
        expect(Math.abs(hue(s.brand) - h)).toBeGreaterThan(40);
      }
    });

    it(`keeps the three semantic hues distinct from each other on ${name}`, () => {
      const [fine, noise, attention] = [hue(s.agree), hue(s.noise), hue(s.conflict)];
      expect(new Set([fine, noise, attention]).size).toBe(3);
      expect(Math.abs(fine - noise)).toBeGreaterThan(40);
      expect(Math.abs(noise - attention)).toBeGreaterThan(40);
    });
  }

  it("puts the brand on the hue the design specifies", () => {
    expect(hue(PAPER.brand)).toBe(250);
    expect(hue(INK.brand)).toBe(250);
  });
});

describe("two designed surfaces, not one inverted", () => {
  it("carries every token the design's table names", () => {
    for (const s of [PAPER, INK]) {
      for (const key of [
        "shell", "bar", "inset", "hair", "rule",
        "ink", "ink2", "ink3", "ink4",
        "brand", "agree", "conflict", "noise", "block", "face",
      ] as const) {
        expect(s[key], `missing ${key}`).toBeTruthy();
      }
    }
  });

  it("drops brand chroma on ink rather than reusing the paper value", () => {
    // The tell that these were designed as a pair: on black the same chroma
    // reads as a glow, so ink is lighter AND less saturated.
    expect(chroma(INK.brand)).toBeLessThan(chroma(PAPER.brand));
  });

  it("does not simply invert the ink levels", () => {
    // Paper's ink levels are opaque hexes; ink's are alpha over the ground.
    // A mechanical inversion would have produced hexes on both.
    expect(PAPER.ink2.startsWith("#")).toBe(true);
    expect(INK.ink2.startsWith("rgba")).toBe(true);
  });

  it("gives the hatch a different stroke per surface", () => {
    expect(hatch(PAPER)).not.toBe(hatch(INK));
    for (const g of [hatch(PAPER), hatch(INK)]) {
      expect(g).toContain("repeating-linear-gradient(45deg");
      expect(g).toContain("0 3px");
    }
  });

  it("has no ink equivalent for the kit mix target, by design", () => {
    // Mixing a club colour toward a light target on black would invert the
    // identity the mark exists to carry.
    expect(KIT_MIX_TARGET).toBe("#f0eee8");
  });
});

describe("the display face is loaded, not merely configured", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");

  it("loads Newsreader through next/font beside the two Plex faces", () => {
    expect(layout).toMatch(/import\s*\{[^}]*Newsreader[^}]*\}\s*from\s*"next\/font\/google"/);
    expect(layout).toContain('variable: "--font-newsreader"');
  });

  it("carries both weights, because the surfaces need different ones", () => {
    // 400 on paper, 500 on ink — 400 goes spindly against black.
    const block = layout.slice(layout.indexOf("Newsreader({"));
    expect(block).toMatch(/weight:\s*\["400",\s*"500"\]/);
  });

  it("actually reaches the document via the html className", () => {
    // A font configured and never applied is a font that does not load.
    expect(layout).toMatch(/className=\{`[^`]*\$\{newsreader\.variable\}[^`]*`\}/);
  });
});
