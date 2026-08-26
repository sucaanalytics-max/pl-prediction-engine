/**
 * The club mark, and the two things a dark ground does to it.
 *
 * Recovered with the module. The original was written for two surfaces and pinned
 * the paper muting; that surface is gone, and the dark ground has its own two
 * failures which the surviving comment explicitly denied ("needs no equivalent").
 * Measured, it needed two. These pin them.
 *
 * Contrast is recomputed here with the WCAG relative-luminance formula rather than
 * quoted, so a colour edited in `kits.ts` fails here rather than on a screenshot.
 */
import { describe, expect, it } from "vitest";

import {
  KITS,
  KIT_CEILING,
  KIT_OUTLINE,
  kitFor,
  kitStripe,
  kitTone,
  type Kit,
} from "@/lib/margin/kits";
import { FLOODLIT } from "@/lib/margin/tokens";

const SHELL: RGB = [13, 16, 19]; // #0d1013
const INK: RGB = [233, 238, 245]; // #e9eef5

type RGB = readonly [number, number, number];

function hex(value: string): RGB {
  const h = value.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ] as const;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite an rgba() over a ground, for the outline. */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ] as const;
}

const ALL = Object.values(KITS) as readonly Kit[];

describe("the map covers the league as the artifacts spell it", () => {
  it("has twenty clubs", () => {
    expect(ALL).toHaveLength(20);
  });

  it("keys every entry by its own code", () => {
    for (const [key, kit] of Object.entries(KITS)) expect(kit.code).toBe(key);
  });

  it("includes the promoted sides", () => {
    // A missing entry leaves a player with no mark at all, and promotion is the
    // one predictable way this map goes stale.
    for (const code of ["COV", "HUL", "IPS"]) expect(KITS[code]).toBeDefined();
  });
});

describe("no shirt is louder than the player's own name", () => {
  const inkVsShell = ratio(INK, SHELL);

  it("the ink sets the ceiling at 16.37:1", () => {
    expect(inkVsShell).toBeCloseTo(16.37, 1);
  });

  it("clamps the three white clubs, which would otherwise beat it", () => {
    // Fulham, Leeds and Spurs are #ffffff — 19.08:1, brighter than type. That
    // inverts the hierarchy the mark exists to support.
    for (const code of ["FUL", "LEE", "TOT"]) {
      expect(ratio(hex(KITS[code].primary), SHELL)).toBeGreaterThan(inkVsShell);
      expect(kitTone(KITS[code].primary)).toContain("color-mix");
    }
  });

  it("leaves every other club alone", () => {
    for (const kit of ALL) {
      if (kit.primary.toLowerCase() === "#ffffff") continue;
      expect(kitTone(kit.primary)).toBe(kit.primary);
      expect(ratio(hex(kit.primary), SHELL)).toBeLessThan(inkVsShell);
    }
  });

  it("mixes in oklab, because sRGB darkens unevenly across hues", () => {
    expect(kitTone("#ffffff")).toContain("in oklab");
  });

  it("keeps the ceiling above the next brightest club", () => {
    // 0.84 lands white at about 13.1:1; Coventry is 11.23:1. If the ceiling fell
    // below Coventry the ordering between shirts would invert.
    const coventry = ratio(hex(KITS.COV.primary), SHELL);
    expect(coventry).toBeLessThan(13.2);
    expect(KIT_CEILING).toBeGreaterThan(0.8);
    expect(KIT_CEILING).toBeLessThan(0.9);
  });
});

describe("no shirt is a hole in the page", () => {
  it("names the two clubs that vanish without an outline", () => {
    // Villa claret and Newcastle near-black. Recorded so a palette edit that
    // "fixes" them by brightening has to argue with this test.
    expect(ratio(hex(KITS.AVL.primary), SHELL)).toBeLessThan(1.6);
    expect(ratio(hex(KITS.NEW.primary), SHELL)).toBeLessThan(1.3);
  });

  it("gives every shirt an outline that clears the 3:1 graphical floor", () => {
    // The original used the surface hairline at 0.075 alpha — 1.18:1, an invisible
    // outline around an invisible shirt.
    const match = /rgba\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)[, ]+([\d.]+)\s*\)/.exec(KIT_OUTLINE);
    expect(match).not.toBeNull();
    const [, r, g, b, a] = match as RegExpExecArray;
    const composite = over([Number(r), Number(g), Number(b)], Number(a), SHELL);
    expect(ratio(composite, SHELL)).toBeGreaterThanOrEqual(3);
  });
});

describe("the reds are separated by pattern and secondary, not by hue", () => {
  it("has seven of them, not the six the original docstring claimed", () => {
    const reds = ALL.filter((k) => {
      const [r, g, b] = hex(k.primary);
      return r > 150 && g < 90 && b < 90;
    });
    // The recovered docstring listed six and omitted Bournemouth, whose #da291c is
    // byte-identical to Man United's. It reads as a stripe rather than a red shirt,
    // which is presumably why — but by hue it is a red, and the count matters
    // because it is the argument for encoding pattern at all.
    expect(reds.map((k) => k.code).sort()).toEqual(
      ["ARS", "BOU", "BRE", "LIV", "MUN", "NFO", "SUN"].sort(),
    );
  });

  it("admits that Liverpool and Man United are not separable, as in life", () => {
    // Both plain reds. The mark narrows to a family; the three-letter code in the
    // row is what settles it, and this test exists so nobody "fixes" it by
    // inventing a colour neither club wears.
    expect(KITS.LIV.pattern).toBe("plain");
    expect(KITS.MUN.pattern).toBe("plain");
  });

  it("separates the striped reds from the plain ones", () => {
    expect(KITS.BOU.pattern).toBe("stripes");
    expect(KITS.BRE.pattern).toBe("stripes");
    expect(KITS.SUN.pattern).toBe("stripes");
    expect(KITS.ARS.pattern).toBe("plain");
    expect(KITS.NFO.pattern).toBe("plain");
  });
});

describe("a pattern needs area, and degenerates without it", () => {
  it("uses a two-stop split for a narrow rule instead", () => {
    // A 3px repeat inside a 4px bar renders as one arbitrary colour, so a striped
    // club would read as a plain one — and as a DIFFERENT plain one under rounding.
    const stripe = kitStripe(KITS.NEW);
    expect(stripe).not.toContain("repeating");
    expect(stripe).toContain("180deg");
  });

  it("still returns a GRADIENT for a plain club, because the caller paints an image", () => {
    // This asserted a flat colour and so pinned a real defect: `background-image`
    // silently drops a bare hex, so the club rule rendered for the four striped
    // clubs and vanished for the eleven plain ones. Four of fifteen rows.
    expect(kitStripe(KITS.CHE)).toContain("linear-gradient");
    expect(kitStripe(KITS.CHE)).toContain(KITS.CHE.primary);
  });

  it("gives every one of the twenty clubs a paintable rule", () => {
    for (const kit of ALL) {
      expect(kitStripe(kit), `${kit.code} must be a gradient`).toContain("gradient");
    }
  });

  it("keeps both of a two-tone club's colours in the narrow rule", () => {
    // A sash club is the case that proves the split is not cosmetic: AVL's claret
    // is 1.54:1 on this ground, so dropping the pale blue leaves a near-invisible
    // bar rather than a two-tone one.
    const stripe = kitStripe(KITS.AVL);
    expect(stripe).toContain(KITS.AVL.primary);
    expect(stripe).toContain(KITS.AVL.secondary);
  });
});

describe("an unknown club is refused, never guessed", () => {
  it.each([null, undefined, "", "ZZZ"])("returns null for %s", (code) => {
    expect(kitFor(code as string)).toBeNull();
  });

  it("accepts a lowercase code, since callers vary", () => {
    expect(kitFor("mun")).toBe(KITS.MUN);
  });
});

describe("the outline tracks the palette rather than copying it", () => {
  it("IS ink3, not a literal that once equalled it", () => {
    // It shipped as `rgba(233, 238, 245, 0.38)` under a docstring calling it "a
    // fixed ink3 outline at 3.21:1". Three commits later ink3 was raised to .55 and
    // the literal silently stopped being ink3, while the docstring went on citing a
    // certification that no longer applied to it. An identity assertion is the only
    // thing that makes "fixed" mean "fixed to the token".
    expect(KIT_OUTLINE).toBe(FLOODLIT.ink3);
  });

  it("clears the 3:1 graphical floor on the shell it is drawn against", () => {
    // The outline is the whole reason AVL (1.54:1) and NEW (1.17:1) are visible at
    // all, so this is the assertion the mark's legibility actually rests on. Read
    // the alpha off the token rather than restating it — restating it is exactly how
    // the literal drifted.
    const alpha = Number(/,\s*\.?([0-9.]+)\s*\)$/.exec(KIT_OUTLINE)![1].replace(/^\./, "0."));
    expect(alpha, "could not read the outline's alpha").toBeGreaterThan(0);
    expect(ratio(over(INK, alpha, SHELL), SHELL)).toBeGreaterThanOrEqual(3);
  });
});

describe("the rule survives a CSS parser, not just Chrome's", () => {
  it("keeps the declaration when set through element.style", () => {
    // Both `0` and `0%` are valid CSS and Chrome paints both, so the bare form
    // rendered correctly in production and no test could see it: jsdom's parser
    // rejects the unitless length and drops the WHOLE declaration, so
    // `style.backgroundImage` came back as "". Every club is checked, because the
    // two patterns build their stop lists differently.
    const element = document.createElement("div");
    const dropped: string[] = [];
    for (const kit of ALL) {
      element.style.backgroundImage = "";
      element.style.backgroundImage = kitStripe(kit);
      if (element.style.backgroundImage === "") dropped.push(kit.code);
    }
    expect(dropped, "a parser dropped these clubs' rules entirely").toEqual([]);
  });
});
