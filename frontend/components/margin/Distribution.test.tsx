/**
 * Emphasis is the whole trick — and it has to be opt-in to be worth anything.
 *
 * The two automated teams read ONE identical projection and reach opposite
 * conclusions. The season team ranks on the median and prices spread as a cost;
 * the weekly team ranks on the right tail and prices spread as the instrument.
 * So the same marks on the same scale carry different weight, and a diff of the
 * two never needs a second chart type.
 *
 * That only holds while `neutral` stays neutral. The tail first shipped ungated,
 * which put a 3px bar over the 1px whisker on every glyph in the app while
 * q10–q25 stayed a hairline — so every projection everywhere read right-heavy,
 * which is the weekly conclusion drawn on the season surfaces. Hence two kinds of
 * assertion below: that the emphasised marks MOVE, and that the neutral glyph is
 * the shipped one, mark for mark.
 *
 * The first kind asserts on geometry rather than appearance, because the claim is
 * that the marks move and a snapshot would pass while the emphasis did nothing.
 * The second kind pins literals on purpose: it is a compatibility pin protecting
 * five live call sites, and a literal is what makes an accidental change fail.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Distribution } from "@/components/margin/Marks";
import { SCALE_HI, SCALE_LO } from "@/lib/margin/distribution";
import { PAPER } from "@/lib/margin/tokens";

const FERNANDES = { q10: 2, q25: 4, q50: 6, q75: 9, q90: 14, mean: 6.66, mode: 5 };

function marks(emphasis?: "neutral" | "median" | "tail") {
  const { container } = render(
    <Distribution of={FERNANDES} surface={PAPER} emphasis={emphasis} />,
  );
  const root = container.firstElementChild as HTMLElement;
  const byTitle = (t: string) =>
    container.querySelector(`[title="${t}"]`) as HTMLElement | null;
  return {
    tail: byTitle("right tail, q75 to q90"),
    median: byTitle("median"),
    box: byTitle("interquartile range, q25 to q75"),
    root,
    // The whisker and the mode notch carry no title, so the marks are counted as
    // well as named: a count is what catches a mark being ADDED.
    children: [...root.children] as HTMLElement[],
  };
}

afterEach(() => cleanup());

describe("the glyph under each emphasis", () => {
  it("draws every measured mark in the neutral case", () => {
    const m = marks();
    expect(m.median).not.toBeNull();
    expect(m.box).not.toBeNull();
    // Box, whisker, mode, median, mean. Nothing clamps on this row, so five.
    expect(m.children).toHaveLength(5);
  });

  it("draws no tail mark at neutral or at median emphasis", () => {
    /**
     * The regression this pins.
     *
     * `Planner`, `ResearchView`, `DecideView`, `SquadInterval` and
     * `app/matches/[id]/page.tsx` all render this glyph without an `emphasis`, so
     * an ungated tail was a behaviour change to five live surfaces at once —
     * exactly what the other two behaviour changes in the same commit were gated
     * behind `speaksForUnsolvedWeeks` and `captaincyPlan` to avoid.
     */
    expect(marks().tail).toBeNull();
    expect(marks("neutral").tail).toBeNull();
    expect(marks("median").tail).toBeNull();
  });

  it("renders the neutral glyph exactly as the shipped one did", () => {
    /**
     * The pre-change marks, read off `70092a9^:components/margin/Marks.tsx`.
     *
     * `height` defaults to 14, so `mid` is 6 and every offset here is literal.
     * Widths are asserted only for the three point marks — the box and the
     * whisker are spans whose width is a distance on the scale, which the scale
     * assertion below covers.
     */
    const m = marks("neutral");
    const vert = (el: HTMLElement) => `${el.style.top} ${el.style.height}`;
    expect(m.children.map(vert)).toEqual([
      "3px 7px", // the interquartile box, mid - 3
      "6px 1px", // the q10–q90 whisker, on the axis
      "8px 5px", // the mode notch, below the axis
      "1px 11px", // the median rule, mid - 5
      "4px 5px", // the mean diamond, mid - 2
    ]);
    expect(m.children[2].style.width).toBe("1.5px");
    expect(m.median!.style.width).toBe("1.5px");
    expect(m.children[4].style.width).toBe("5px");
  });

  it("thickens the median under median emphasis", () => {
    expect(parseFloat(marks("median").median!.style.width))
      .toBeGreaterThan(parseFloat(marks("neutral").median!.style.width));
    expect(parseFloat(marks("median").median!.style.height))
      .toBeGreaterThan(parseFloat(marks("neutral").median!.style.height));
  });

  it("adds a filled tail under tail emphasis, and only there", () => {
    const t = marks("tail").tail;
    expect(t).not.toBeNull();
    // Taller than the 1px whisker it is measured along, so it reads as the mark
    // being read rather than as context.
    expect(parseFloat(t!.style.height)).toBeGreaterThan(1);
    // Filled with `surface.ink` — asserted against the mark that carries that
    // fill when IT is the one being read, rather than against a literal colour.
    expect(t!.style.background).toBe(marks("neutral").median!.style.background);
    // Six marks now, not five: the tail is an addition, not a restyling.
    expect(marks("tail").children).toHaveLength(6);
  });

  it("demotes the median under tail emphasis without hiding it", () => {
    const t = marks("tail").median!;
    // Still present — it is the anchor the tail is measured from.
    expect(t).not.toBeNull();
    expect(t.style.background).not.toBe(marks("neutral").median!.style.background);
  });

  it("keeps one scale across emphases, so the two are comparable", () => {
    // The mark that carries the reading changes weight; where it sits does not.
    expect(marks("median").median!.style.left)
      .toBe(marks("neutral").median!.style.left);
    expect(marks("tail").median!.style.left)
      .toBe(marks("neutral").median!.style.left);
    // And the tail starts at q75 on the shared 0–18, which is where the box ends.
    const at = (v: number) => `${((v - SCALE_LO) / (SCALE_HI - SCALE_LO)) * 100}%`;
    expect(marks("tail").tail!.style.left).toBe(at(FERNANDES.q75));
  });

  it("stays one accessible image, however it is emphasised", () => {
    for (const e of ["neutral", "median", "tail"] as const) {
      const root = marks(e).root;
      expect(root.getAttribute("role")).toBe("img");
      expect(root.getAttribute("aria-label")).toMatch(/median/i);
    }
  });
});
