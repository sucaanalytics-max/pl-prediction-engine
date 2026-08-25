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

import {
  FLOODLIT, HEAT, KIT_MIX_TARGET, TRAFFIC, difficultyTint, hatch, heatStep,
} from "@/lib/margin/tokens";

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

/** sRGB channels from a `#rrggbb`. Both ramps are hex so they can be measured. */
function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((o) => parseInt(m[1].slice(o, o + 2), 16)) as [number, number, number];
}

function toLinear(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A colour as a deuteranope sees it.
 *
 * The LMS-space approximation: the missing M response is reconstructed from L
 * and S, which is what collapses a red-green distinction while leaving a
 * lightness difference intact. Good enough to RANK ramps, which is all the
 * assertions above ask of it.
 */
function deuteranope(hex: string): string {
  const [r, g, b] = channels(hex).map(toLinear);
  const L = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
  const M = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
  const S = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;
  void M;
  const M2 = 0.9513092 * L + 0.04866992 * S;
  const out = [
    5.47221206 * L - 4.6419601 * M2 + 0.16963708 * S,
    -1.1252419 * L + 2.29317094 * M2 - 0.1678952 * S,
    0.02980165 * L - 0.19318073 * M2 + 1.16364789 * S,
  ].map((u) => {
    const c = Math.max(0, Math.min(1, u));
    const v = c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  });
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
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

  it("climbs monotonically through the points ramp", () => {
    // A sequential ramp that dips reads as two categories rather than one scale.
    const ls = HEAT.map(([bg]) => relLuminance(bg));
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i], `band ${i} is not brighter than ${i - 1}`)
        .toBeGreaterThan(ls[i - 1]);
    }
  });

  it("does NOT climb monotonically through the difficulty ramp", () => {
    /* Correct, not a fault. Traffic is DIVERGING: both ends are dark and the
       middle is pale, because it runs bad → neutral → good rather than less →
       more. Asserting it here stops someone "fixing" it into a sequential ramp
       and silently turning a verdict scale into a quantity scale. */
    const ls = TRAFFIC.map(([bg]) => relLuminance(bg));
    const rises = ls.slice(1).some((l, i) => l > ls[i]);
    const falls = ls.slice(1).some((l, i) => l < ls[i]);
    expect(rises && falls, "traffic is not diverging").toBe(true);
  });

  it("separates every neighbouring band under red-green colour blindness", () => {
    /**
     * The measurement both ramps were chosen on, and the reason a red-to-green
     * ramp is safe here when it usually is not.
     *
     * Red-green ramps fail when the two ends share a LIGHTNESS and only hue
     * separates them — simulate the deficiency and the scale collapses. These
     * move lightness as well, so the steps survive. The teal-to-lime ramp both
     * of these replaced measured 0.015 here, which is why it was the hardest of
     * eight candidates to read.
     */
    for (const [name, ramp, floor] of [
      ["points", HEAT, 0.03] as const,
      ["difficulty", TRAFFIC, 0.08] as const,
    ]) {
      const ls = ramp.map(([bg]) => relLuminance(deuteranope(bg)));
      for (let i = 1; i < ls.length; i++) {
        const gap = Math.abs(ls[i] - ls[i - 1]);
        expect(gap, `${name} bands ${i - 1}→${i} collapse to ${gap.toFixed(3)}`)
          .toBeGreaterThan(floor);
      }
    }
  });

  it("puts legible ink on every band of both ramps", () => {
    /* The figure sits ON the cell. A band whose own ink misses the 4.5:1 floor
       for text this size is a band that cannot carry the number it exists to
       colour — which is the specific defect that disqualified the ramp these
       replaced, at 4.17:1. */
    for (const [name, ramp] of [["points", HEAT] as const, ["difficulty", TRAFFIC] as const]) {
      ramp.forEach(([bg, ink], index) => {
        const ratio = contrast(bg, ink);
        expect(ratio, `${name} band ${index} renders text at ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(4.5);
      });
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

  it("loads all three faces the design is drawn in, through next/font", () => {
    /* Anton, Archivo, DM Mono — the stack the artboards specify.
       IBM Plex Sans and Mono were here and were kept through the palette change
       on the argument that Plex Mono's figures were what let a column of
       projections compare by eye. Sound about mono figures, wrong about the face:
       shipping Plex made every screen a near miss of its own approved design, and
       DM Mono is monospaced with tabular figures too. Pinned here because a
       half-done swap — one face changed, the variable still naming the other — is
       the failure this file exists to catch. */
    expect(layout).toMatch(/import\s*\{[^}]*Anton[^}]*\}\s*from\s*"next\/font\/google"/);
    expect(layout).toContain('variable: "--font-display-anton"');
    expect(layout).toMatch(/Archivo\(/);
    expect(layout).toContain('variable: "--font-archivo"');
    expect(layout).toMatch(/DM_Mono\(/);
    expect(layout).toContain('variable: "--font-dm-mono"');
    // And no trace of the pair they replaced, in either the import or a variable.
    expect(layout).not.toMatch(/IBM_Plex/);
    expect(layout).not.toMatch(/font-plex/);
  });

  it("asks DM Mono for no weight it does not publish", () => {
    /* DM Mono ships 300, 400 and 500. Plex Mono shipped 600 as well and a few
       rules asked for 700 and 800, which a browser synthesises into a faux bold —
       a thicker stroke on the same skeleton, which is exactly the muddiness a
       10px figure inside a coloured cell cannot afford. */
    const block = layout.slice(layout.indexOf("DM_Mono({"));
    const weights = block.slice(0, block.indexOf("})")).match(/"\d00"/g) ?? [];
    expect(weights.length).toBeGreaterThan(0);
    for (const weight of weights) {
      expect(["\"300\"", "\"400\"", "\"500\""]).toContain(weight);
    }
  });

  it("never sets a mono weight the face cannot answer", () => {
    // The stylesheet's own asks, not just the loader's.
    const css = readFileSync("app/globals.css", "utf8");
    const offenders = [...css.matchAll(/font:\s*([678]\d0)\s[^;]*var\(--font-mono\)/g)]
      .map((match) => match[0]);
    expect(offenders, "asks DM Mono for a weight it does not ship").toEqual([]);
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

describe("the fixture-difficulty chip", () => {
  it("reuses the semantic three rather than inventing a fourth scale", () => {
    // Kind is agree, hard is noise, hardest is conflict. A separate palette for
    // fixtures would mean two colour languages on one screen.
    expect(difficultyTint(1)[1]).toBe(FLOODLIT.agree);
    expect(difficultyTint(2)[1]).toBe(FLOODLIT.agree);
    expect(difficultyTint(4)[1]).toBe(FLOODLIT.noise);
    expect(difficultyTint(5)[1]).toBe(FLOODLIT.conflict);
  });

  it("gives a mid fixture plain ink, not a weak green", () => {
    // FDR 3 is the median rating and the most common one. Tinting it green would
    // make most of the league look kind.
    expect(difficultyTint(3)[1]).toBe(FLOODLIT.ink2);
  });

  it("treats an unknown rating as mid rather than guessing an end", () => {
    // A rating we do not recognise is neither kind nor brutal, and clamping to
    // either end would state something FPL did not.
    const mid = difficultyTint(3);
    expect(difficultyTint(null)).toEqual(mid);
    expect(difficultyTint(0)).toEqual(mid);
    expect(difficultyTint(9)).toEqual(mid);
    expect(difficultyTint(Number.NaN)).toEqual(mid);
  });

  it("returns a background as well as a foreground, so the chip is legible", () => {
    for (const difficulty of [1, 2, 3, 4, 5]) {
      const [background, foreground] = difficultyTint(difficulty);
      expect(background, `fdr ${difficulty}`).toBeTruthy();
      expect(foreground, `fdr ${difficulty}`).toBeTruthy();
      expect(background).not.toBe(foreground);
    }
  });
});

describe("the pitch", () => {
  it("is a distinct ground from the page and the bars on it", () => {
    // Eleven tiles on the page ground read as a list rather than as a team, so
    // the pitch has to be visibly its own surface — but only just.
    expect(FLOODLIT.pitch).not.toBe(FLOODLIT.shell);
    expect(FLOODLIT.pitch).not.toBe(FLOODLIT.bar);
  });

  it("is dark enough that the ink measured against the shell still reads on it", () => {
    // The contrast figures in `legibility.test.ts` are measured against `shell`.
    // A pitch materially lighter than the shell would invalidate them for every
    // tile drawn on it, so this pins the pitch as the darker of the two grounds.
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const c = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    };
    expect(luminance(FLOODLIT.pitch)).toBeLessThan(luminance(FLOODLIT.bar));
  });
});
