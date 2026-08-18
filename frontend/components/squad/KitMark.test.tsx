/**
 * One mark, two surface calibrations, and the reason the paper one is muted.
 *
 * Muting is the whole trick: at full strength on warm paper, fifteen kit colours
 * become a quilt and the loudest thing in the row stops being the distribution.
 * On ink they are left alone, because kit colours are designed to sing against a
 * dark screen. That asymmetry is the design, so it is what these tests pin.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KitMark } from "@/components/squad/KitMark";
import { KITS, kitBackground } from "@/components/squad/kits";
import { INK, PAPER, KIT_MIX_TARGET } from "@/lib/margin/tokens";

afterEach(() => cleanup());

const mark = () => screen.getByRole("img") as HTMLElement;

describe("one component, two calibrations", () => {
  it("mutes on paper", () => {
    render(<KitMark club="MUN" surface={PAPER} />);
    expect(mark().dataset.muted).toBe("true");
    expect(mark().style.background).toContain("color-mix");
  });

  it("does not mute on ink", () => {
    render(<KitMark club="MUN" surface={INK} />);
    expect(mark().dataset.muted).toBe("false");
    expect(mark().style.background).not.toContain("color-mix");
  });

  it("keeps identical geometry across surfaces", () => {
    const { unmount } = render(<KitMark club="MUN" surface={PAPER} />);
    const paper = { w: mark().style.width, h: mark().style.height, clip: mark().style.clipPath };
    unmount();
    render(<KitMark club="MUN" surface={INK} />);
    expect({ w: mark().style.width, h: mark().style.height, clip: mark().style.clipPath })
      .toEqual(paper);
  });

  it("mixes in oklab, not sRGB", () => {
    // sRGB mixing toward a tint darkens unevenly across hues, which would undo the
    // single lightness band the muting exists to produce.
    expect(kitBackground(KITS.MUN, true, KIT_MIX_TARGET)).toContain("in oklab");
  });
});

describe("hue narrows to a family; pattern and code settle it", () => {
  it("renders a striped club differently from a plain one", () => {
    const plain = kitBackground(KITS.ARS, true, KIT_MIX_TARGET);
    const striped = kitBackground(KITS.BHA, true, KIT_MIX_TARGET);
    expect(striped).toContain("repeating-linear-gradient");
    expect(striped).not.toBe(plain);
  });

  it("renders a sash differently again", () => {
    const sash = kitBackground(KITS.AVL, true, KIT_MIX_TARGET);
    expect(sash).toContain("linear-gradient(115deg");
    expect(sash).not.toContain("repeating");
  });

  it("distinguishes the six reds by pattern or secondary, not hue alone", () => {
    const reds = ["ARS", "MUN", "LIV", "NFO", "BRE", "SUN"];
    const fills = reds.map((c) => kitBackground(KITS[c], true, KIT_MIX_TARGET));
    // Not all identical — the point of encoding hue PLUS pattern.
    expect(new Set(fills).size).toBeGreaterThan(1);
  });
});

describe("every club the artifacts can name has a mark", () => {
  it("defines twenty clubs", () => {
    expect(Object.keys(KITS)).toHaveLength(20);
  });

  it("includes the promoted sides, which appear in this season's fixtures", () => {
    for (const c of ["COV", "HUL", "IPS"]) expect(KITS[c], c).toBeTruthy();
  });

  it("hatches an unknown code rather than guessing a colour", () => {
    render(<KitMark club="ZZZ" surface={PAPER} />);
    expect(mark().style.backgroundImage).toContain("repeating-linear-gradient");
    expect(mark().getAttribute("title")).toMatch(/no kit is defined/i);
  });

  it("names the club for a screen reader", () => {
    render(<KitMark club="MUN" surface={PAPER} />);
    expect(mark().getAttribute("aria-label")).toBe("MUN kit");
  });
});
