/**
 * The token system's structural claims, after the floodlit redesign.
 *
 *   1. Hue carries judgement and nothing else. Three semantic hues mean fine,
 *      inside-the-noise and needs-attention. Identity is not a judgement, so the
 *      brand takes a fourth hue that cannot be mistaken for a verdict. Before it
 *      existed, `--accent` did both jobs: a green active tile and a green
 *      "agrees with the market" were the same colour.
 *   2. There is ONE surface now. The previous two — ink for the decision, paper
 *      for reference — encoded a reading mode, and the tests below used to
 *      assert they were designed as a pair rather than mechanically inverted.
 *      That claim is retired with the surfaces themselves; what survives is the
 *      part that still constrains anything: the token set is complete, the
 *      hues stay apart, and the heat ramp is monotonic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { FLOODLIT, HEAT, KIT_MIX_TARGET, hatch, heatStep } from "@/lib/margin/tokens";

/** Pull the hue angle out of an oklch() triple. */
function hue(value: string): number {
  const m = value.match(/oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  return Number(m[1]);
}
function lightness(value: string): number {
  const m = value.match(/oklch\(\s*([\d.]+)/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  return Number(m[1]);
}

describe("hue carries judgement, and identity is not a judgement", () => {
  it("keeps the brand off all three semantic hues", () => {
    const semantic = [hue(FLOODLIT.agree), hue(FLOODLIT.noise), hue(FLOODLIT.conflict)];
    for (const h of semantic) {
      // Not merely different — far enough that no reader reads a verdict.
      expect(Math.abs(hue(FLOODLIT.brand) - h)).toBeGreaterThan(25);
    }
  });

  it("keeps the three semantic hues distinct from each other", () => {
    const [fine, noise, attention] =
      [hue(FLOODLIT.agree), hue(FLOODLIT.noise), hue(FLOODLIT.conflict)];
    expect(new Set([fine, noise, attention]).size).toBe(3);
    expect(Math.abs(fine - noise)).toBeGreaterThan(40);
    expect(Math.abs(noise - attention)).toBeGreaterThan(40);
  });

  it("puts identity on the lime, not on the old blue", () => {
    // The brand hue moved from 250 to 128 with the redesign: on a dark ground a
    // blue identity mark sat too close to the surface to register, and the lime
    // is the one saturated colour on the screen that is not a verdict.
    expect(hue(FLOODLIT.brand)).toBe(128);
  });
});

describe("one surface, and a ramp that means something", () => {
  it("carries every token the design's table names", () => {
    for (const key of [
      "shell", "bar", "inset", "hair", "rule",
      "ink", "ink2", "ink3", "ink4",
      "brand", "agree", "conflict", "noise", "block", "face",
    ] as const) {
      expect(FLOODLIT[key], `missing ${key}`).toBeTruthy();
    }
  });

  it("is a dark ground with light ink over it", () => {
    // The direction of the surface is the whole redesign; asserting it stops a
    // later edit half-reverting to paper and leaving the glyphs unreadable.
    expect(FLOODLIT.shell.startsWith("#0")).toBe(true);
    expect(FLOODLIT.ink2.startsWith("rgba")).toBe(true);
  });

  it("hatches against a dark ground", () => {
    const g = hatch(FLOODLIT);
    expect(g).toContain("repeating-linear-gradient(45deg");
    expect(g).toContain("0 3px");
    // A light stroke, because the ground it must show against is dark — and
    // floodlit's ink, so the hatch is the same colour as the text near it.
    expect(g).toContain("233,238,245");
  });

  it("keeps the kit mix target, which only a light ground would use", () => {
    // Retained rather than deleted: mixing a club colour toward a light target
    // is wrong on this surface, and `surfaceIsLight` is what refuses it.
    expect(KIT_MIX_TARGET).toBe("#f0eee8");
  });

  it("climbs monotonically through the heat ramp", () => {
    // A ramp that dips reads as two categories rather than one scale.
    const ls = HEAT.map(([bg]) => lightness(bg));
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    }
  });

  it("scales a heat cell against a stated ceiling, never the row", () => {
    // Same value, two ceilings, two steps — this is what stops a per-row scale
    // making every player look equally good.
    expect(heatStep(3.5, 7)).not.toBe(heatStep(3.5, 14));
    expect(heatStep(7, 7)).toBe(HEAT[HEAT.length - 1]);
    expect(heatStep(0, 7)).toBe(HEAT[0]);
  });

  it("clamps rather than throwing outside the ceiling", () => {
    expect(heatStep(99, 7)).toBe(HEAT[HEAT.length - 1]);
    expect(heatStep(-1, 7)).toBe(HEAT[0]);
    expect(heatStep(1, 0)).toBeTruthy();
  });
});

describe("the display face is loaded, not merely configured", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");

  it("loads Anton through next/font beside the two Plex faces", () => {
    // Anton replaced Newsreader in the floodlit redesign: a serif built for
    // reading at length suited a surface that no longer exists. Plex Sans and
    // Mono are deliberately unchanged — Mono's figures are what let a column of
    // projections line up closely enough to compare two players by eye, which
    // is exactly what the heat grid asks of them.
    expect(layout).toMatch(/import\s*\{[^}]*Anton[^}]*\}\s*from\s*"next\/font\/google"/);
    expect(layout).toContain('variable: "--font-display-anton"');
    expect(layout).toMatch(/IBM_Plex_Sans/);
    expect(layout).toMatch(/IBM_Plex_Mono/);
  });

  it("carries the one weight Anton ships", () => {
    // The old pair loaded 400 and 500 because two surfaces needed different
    // weights for the same optical result. There is one surface now, and Anton
    // is a single-weight face, so asking for a second would fail to load rather
    // than fall back.
    const block = layout.slice(layout.indexOf("Anton({"));
    expect(block).toMatch(/weight:\s*\["400"\]/);
  });

  it("actually reaches the document via the html className", () => {
    // A font configured and never applied is a font that does not load.
    expect(layout).toMatch(/className=\{`[^`]*\$\{anton\.variable\}[^`]*`\}/);
  });

  it("is what --font-display resolves to", () => {
    // The indirection is what makes one edit change every heading; a page
    // naming the face directly would drift from this.
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/--font-display:\s*var\(--font-display-anton\)/);
  });
});
