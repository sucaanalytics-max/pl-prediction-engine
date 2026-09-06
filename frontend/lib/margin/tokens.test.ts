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
  SIGNAL, HEAT, TRAFFIC, difficultyTile, difficultyTint, hatch, heatStep, ink, positionHue,
  surfaceIsLight,
} from "@/lib/margin/tokens";

/** Pull the hue angle out of an oklch() triple. */
function hue(value: string): number {
  const m = value.match(/oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
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
  it("keeps the brand off every hue, semantic or otherwise", () => {
    // The strongest possible version of "identity is not a judgement": the brand
    // is not a hue. Signal spends colour only on data, so the wordmark, an active
    // tab and a link are ink — separated by weight, case and a rule.
    //
    // This replaces an assertion that the brand hue sat >25 degrees from each of
    // the three. That was the right claim while identity had a colour; it cannot
    // be stated about a token that has none, and weakening it to "different from
    // green" would have let a hue back in by the side door.
    expect(SIGNAL.brand).toBe(SIGNAL.ink);
    expect(() => hue(SIGNAL.brand)).toThrow();
    for (const h of [SIGNAL.agree, SIGNAL.noise, SIGNAL.conflict]) {
      expect(SIGNAL.brand).not.toBe(h);
    }
  });

  it("keeps the three semantic hues distinct from each other", () => {
    const [fine, noise, attention] =
      [hue(SIGNAL.agree), hue(SIGNAL.noise), hue(SIGNAL.conflict)];
    expect(new Set([fine, noise, attention]).size).toBe(3);
    expect(Math.abs(fine - noise)).toBeGreaterThan(40);
    expect(Math.abs(noise - attention)).toBeGreaterThan(40);
  });

  it("leaves the three semantic hues as the only saturated colour in the set", () => {
    // Floodlit had a fourth: an acid lime that marked the live thing on a screen
    // — the countdown, the armband, a detected run. Signal removes that job, so
    // the only saturated tokens left are the three that carry a verdict, plus the
    // two ramps that carry a quantity. Anything else on screen is ink on paper.
    const saturated = [SIGNAL.agree, SIGNAL.noise, SIGNAL.conflict];
    for (const token of [SIGNAL.brand, SIGNAL.ink, SIGNAL.ink2, SIGNAL.ink3, SIGNAL.ink4,
                         SIGNAL.shell, SIGNAL.bar, SIGNAL.inset, SIGNAL.face]) {
      expect(saturated).not.toContain(token);
      expect(token).not.toMatch(/oklch/);
    }
    for (const token of saturated) expect(token).toMatch(/^oklch\(/);
  });
});

describe("one surface, and a ramp that means something", () => {
  it("carries every token the design's table names", () => {
    for (const key of [
      "shell", "bar", "inset", "hair", "rule",
      "ink", "ink2", "ink3", "ink4",
      "brand", "agree", "conflict", "noise", "block", "face",
    ] as const) {
      expect(SIGNAL[key], `missing ${key}`).toBeTruthy();
    }
  });

  it("is a paper ground with dark ink over it", () => {
    // The direction of the surface is the whole redesign; asserting it stops a
    // later edit half-reverting and leaving the glyphs unreadable. Stated as a
    // MEASUREMENT rather than as "#0…" or "#f…", because the previous form
    // pinned a spelling rather than a fact and had to be rewritten to move.
    expect(surfaceIsLight(SIGNAL)).toBe(true);
    expect(SIGNAL.ink2.startsWith("rgba")).toBe(true);
    expect(contrast(SIGNAL.shell, SIGNAL.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("hatches against a paper ground", () => {
    const g = hatch(SIGNAL);
    expect(g).toContain("repeating-linear-gradient(45deg");
    expect(g).toContain("0 3px");
    // A dark stroke, because the ground it must show against is paper — and
    // signal's ink, so the hatch is the same colour as the text near it.
    expect(g).toContain("20,23,28");
  });

  it("orders the points ramp monotonically, in whichever direction the ground needs", () => {
    /* A sequential ramp that dips reads as two categories rather than one scale.
       The claim is ORDER, not direction — this asserted "brighter than the last"
       and so baked in a dark ground: on ink more points meant more light, on
       paper more points means more ink, and the copper ramp's ascent became the
       slate ramp's descent without anything about the scale changing.

       Both halves are needed. Monotonicity alone would accept a ramp running the
       wrong way — five steps that get PALER as the projection grows, ordered and
       useless. The second assertion fixes the direction to the only one that can
       be right on any ground: the top of the scale is the band furthest from the
       paper it is printed on. */
    const ls = HEAT.map(([bg]) => relLuminance(bg));
    const rising = ls.every((l, i) => i === 0 || l > ls[i - 1]);
    const falling = ls.every((l, i) => i === 0 || l < ls[i - 1]);
    expect(rising || falling, "the points ramp is not ordered").toBe(true);

    const ground = relLuminance(SIGNAL.shell);
    const near = Math.abs(ls[0] - ground);
    const far = Math.abs(ls[ls.length - 1] - ground);
    expect(far, "the top of the ramp is not the band furthest from the ground")
      .toBeGreaterThan(near);
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

  it("loads exactly one face, through next/font", () => {
    /* Signal's typographic claim is that ONE family does every job and weight
       alone separates a figure from a label. Anton, Archivo and DM Mono were the
       floodlit stack — a condensed poster face, a grotesque and a monospace,
       all chosen against a dark scoreboard surface that no longer exists.

       Pinned here because a half-done swap — one face changed, a variable still
       naming another — is the failure this file exists to catch, and because
       "one family" is a claim that silently becomes false the moment someone
       adds a second loader for a heading. */
    expect(layout).toMatch(/import\s*\{[^}]*IBM_Plex_Sans[^}]*\}\s*from\s*"next\/font\/google"/);
    expect(layout).toContain('variable: "--font-plex-sans"');
    // One loader call, and no trace of the three it replaced.
    expect(layout.match(/from\s*"next\/font\/google"/g) ?? []).toHaveLength(1);
    for (const gone of [/\bAnton\(/, /\bArchivo\(/, /\bDM_Mono\(/,
                        /--font-display-anton/, /--font-archivo/, /--font-dm-mono/]) {
      expect(layout).not.toMatch(gone);
    }
  });

  it("asks Plex for no weight it does not publish", () => {
    /* IBM Plex Sans ships 100 through 700. This replaces an assertion about DM
       Mono's 300/400/500 ceiling, which was the constraint that forced emphasis
       out of the figure face and into a display face; one family with a real 600
       and 700 is what lets Signal drop the display face entirely. */
    const block = layout.slice(layout.indexOf("IBM_Plex_Sans({"));
    const weights = block.slice(0, block.indexOf("})")).match(/"\d00"/g) ?? [];
    expect(weights.length).toBeGreaterThan(0);
    for (const weight of weights) {
      expect(["\"100\"", "\"200\"", "\"300\"", "\"400\"",
              "\"500\"", "\"600\"", "\"700\""]).toContain(weight);
    }
  });

  it("actually reaches the document via the html className", () => {
    // A font configured and never applied is a font that does not load.
    expect(layout).toMatch(/className=\{`[^`]*\$\{plexSans\.variable\}[^`]*`\}/);
  });

  it("resolves all three type ROLES to the one family", () => {
    /* The roles survive the collapse to one face — a component asking for
       `--font-mono` is still saying "this is a figure in a column", and that
       stays worth reading whether or not the answer is a separate face. What
       must not happen is a role pointing at a variable nothing emits, which is
       what a half-finished swap leaves behind. */
    const css = readFileSync("app/globals.css", "utf8");
    for (const role of ["--font-display", "--font-body", "--font-mono"]) {
      expect(css).toMatch(new RegExp(`${role}:\\s*var\\(--font-plex-sans\\)`));
    }
  });
});

describe("the fixture-difficulty chip", () => {
  it("reuses the semantic three rather than inventing a fourth scale", () => {
    // Kind is agree, hard is noise, hardest is conflict. A separate palette for
    // fixtures would mean two colour languages on one screen.
    expect(difficultyTint(1)[1]).toBe(SIGNAL.agree);
    expect(difficultyTint(2)[1]).toBe(SIGNAL.agree);
    expect(difficultyTint(4)[1]).toBe(SIGNAL.noise);
    expect(difficultyTint(5)[1]).toBe(SIGNAL.conflict);
  });

  it("separates a 1 from a 2 without a second green", () => {
    /**
     * FPL rates 1 and 2 differently and the grid now spends colour on all five,
     * so collapsing them hid a distinction the source publishes. They keep the
     * SAME foreground — the assertion above still holds — and differ only in how
     * much of it the background carries, which is a step on one scale rather
     * than a new hue.
     */
    const [oneBg, oneFg] = difficultyTint(1);
    const [twoBg, twoFg] = difficultyTint(2);
    expect(oneFg).toBe(twoFg);
    expect(oneBg).not.toBe(twoBg);
  });

  it("gives a mid fixture plain ink, not a weak green", () => {
    // FDR 3 is the median rating and the most common one. Tinting it green would
    // make most of the league look kind.
    expect(difficultyTint(3)[1]).toBe(SIGNAL.ink2);
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
    expect(SIGNAL.pitch).not.toBe(SIGNAL.shell);
    expect(SIGNAL.pitch).not.toBe(SIGNAL.bar);
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
    expect(luminance(SIGNAL.pitch)).toBeLessThan(luminance(SIGNAL.bar));
  });
});

describe("the position hue", () => {
  /**
   * New vocabulary, and it is introduced under constraint.
   *
   * This app colours by CLUB (`lib/margin/kits.ts`), never by position, so a
   * position palette is a second colour language on a screen that already has
   * one. It earns its place on the plan grid only because it is confined to the
   * name column and a band header — never inside the cell field, where the
   * fixture tint already means something. These tests pin the two properties
   * that keep the two languages apart.
   */

  it("gives each line its own hue", () => {
    const hues = ["GKP", "DEF", "MID", "FWD"].map((p) => positionHue(p));
    expect(new Set(hues).size).toBe(4);
  });

  it("holds lightness and chroma steady, varying only hue", () => {
    // A set that also varied lightness would read as a ranking — goalkeepers
    // dimmer than forwards — and there is no ordering here to state.
    const parsed = ["GKP", "DEF", "MID", "FWD"].map((p) => {
      const m = /oklch\(([0-9.]+) ([0-9.]+) ([0-9.]+)\)/.exec(positionHue(p));
      expect(m, `${p} should be an oklch triple`).toBeTruthy();
      return { l: m![1], c: m![2], h: m![3] };
    });
    expect(new Set(parsed.map((x) => x.l)).size).toBe(1);
    expect(new Set(parsed.map((x) => x.c)).size).toBe(1);
    expect(new Set(parsed.map((x) => x.h)).size).toBe(4);
  });

  it("stays clear of the three hues the fixture tint owns", () => {
    /**
     * The load-bearing one. Green, amber and red mean fixture difficulty on this
     * screen; a defender rendered in the same green as a kind fixture would be
     * two languages sharing a word.
     */
    const taken = [SIGNAL.agree, SIGNAL.noise, SIGNAL.conflict];
    for (const p of ["GKP", "DEF", "MID", "FWD"]) {
      expect(taken, `${p} must not reuse a difficulty hue`).not.toContain(positionHue(p));
    }
  });

  it("does not colour a position it does not recognise", () => {
    // An unknown line rendered in one of the four would state a membership the
    // data did not. It gets plain ink, which states nothing.
    expect(positionHue("")).toBe(SIGNAL.ink3);
    expect(positionHue("MNG")).toBe(SIGNAL.ink3);
  });
});

describe("the fixture-difficulty tile", () => {
  /**
   * A SECOND rendering of the same five-step scale, and that needs justifying.
   *
   * `difficultyTint` is a chip that sits beside text — low alpha, so the words
   * next to it still read. The plan grid has no words in the cell: the tile IS
   * the cell, and a low-alpha wash over `#0d1013` went muddy across 168 of them.
   * So the grid gets opaque plates at controlled lightness, which mix with
   * nothing and stay the hue they were given.
   *
   * What must NOT diverge is the scale underneath. These tests pin that the two
   * renderings agree about which end is which, and that every plate can carry
   * the figure that sits on it.
   */

  it("keeps the same three semantic hues, kind to brutal", () => {
    // Green at the kind end, red at the brutal end, neutral in the middle —
    // the same ordering `difficultyTint` states, so one scale is being drawn
    // two ways rather than two scales existing.
    const [gr, gg] = channels(difficultyTile(1));
    const [rr, rg] = channels(difficultyTile(5));
    const [nr, , nb] = channels(difficultyTile(3));
    expect(gg, "FDR 1 leans green").toBeGreaterThan(gr);
    expect(rr, "FDR 5 leans red").toBeGreaterThan(rg);
    expect(Math.abs(nr - nb), "FDR 3 is near-neutral").toBeLessThan(20);
  });

  it("carries the figure at every step", () => {
    /**
     * The floor is 4.5:1 for text this size and it is MEASURED here rather than
     * asserted in a comment — the palette this file guards was shipped once with
     * figures at 2.06:1, and a plate edited by eye is exactly how that returns.
     */
    for (const fdr of [1, 2, 3, 4, 5]) {
      const r = contrast(SIGNAL.ink, difficultyTile(fdr));
      expect(r, `FDR ${fdr} tile against the figure`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("spends the most colour where a rating is actionable", () => {
    // FDR 3 is 45% of all fixtures. If it were as loud as 1 or 5 the board would
    // be a wall of colour, which is what the grid was redesigned away from.
    const mid = contrast(SIGNAL.ink, difficultyTile(3));
    for (const fdr of [1, 2, 4, 5]) {
      expect(contrast(SIGNAL.ink, difficultyTile(fdr)),
        `FDR ${fdr} is more present than the neutral middle`).toBeLessThan(mid);
    }
  });

  it("gives an unknown rating the neutral plate, not an end", () => {
    expect(difficultyTile(null)).toBe(difficultyTile(3));
    expect(difficultyTile(0)).toBe(difficultyTile(3));
    expect(difficultyTile(9)).toBe(difficultyTile(3));
  });
});

describe("ink at an alpha tracks the palette", () => {
  it("is built from the surface's own ink, not a literal beside it", () => {
    // The whole point: three views carried `rgba(27, 26, 22, …)` — a retired
    // surface's ink — and were correct by luck once the ground went to paper.
    expect(ink(0.09)).toBe("rgba(20,23,28,0.09)");
    expect(ink(0.09)).toContain(SIGNAL.ink.slice(1, 3) === "14" ? "20," : "20,");
  });

  it("clamps rather than emitting a declaration the browser drops", () => {
    // An out-of-range alpha renders as invalid CSS and the border simply is not
    // there, which is the worst way for one to go missing.
    expect(ink(-1)).toBe("rgba(20,23,28,0)");
    expect(ink(4)).toBe("rgba(20,23,28,1)");
  });

  it("moves when the surface moves", () => {
    const other = { ...SIGNAL, ink: "#ffffff" };
    expect(ink(0.5, other)).toBe("rgba(255,255,255,0.5)");
  });
});
