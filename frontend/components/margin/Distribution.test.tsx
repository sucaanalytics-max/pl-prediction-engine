/**
 * Emphasis is the whole trick.
 *
 * The two automated teams read ONE identical projection and reach opposite
 * conclusions. The season team ranks on the median and prices spread as a cost;
 * the weekly team ranks on the right tail and prices spread as the instrument.
 * So the same marks on the same scale carry different weight, and a diff of the
 * two never needs a second chart type.
 *
 * These assert on geometry rather than appearance, because the claim under test
 * is that the marks MOVE — a snapshot would pass while the emphasis did nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Distribution } from "@/components/margin/Marks";
import { PAPER } from "@/lib/margin/tokens";

const FERNANDES = { q10: 2, q25: 4, q50: 6, q75: 9, q90: 14, mean: 6.66, mode: 5 };

function marks(emphasis?: "neutral" | "median" | "tail") {
  const { container } = render(
    <Distribution of={FERNANDES} surface={PAPER} emphasis={emphasis} />,
  );
  const byTitle = (t: string) =>
    container.querySelector(`[title="${t}"]`) as HTMLElement | null;
  return {
    tail: byTitle("right tail, q75 to q90"),
    median: byTitle("median"),
    box: byTitle("interquartile range, q25 to q75"),
    root: container.firstElementChild as HTMLElement,
  };
}

afterEach(() => cleanup());

describe("the glyph under each emphasis", () => {
  it("draws every measured mark in the neutral case", () => {
    const m = marks();
    expect(m.tail).not.toBeNull();
    expect(m.median).not.toBeNull();
    expect(m.box).not.toBeNull();
  });

  it("thickens the median under median emphasis", () => {
    expect(parseFloat(marks("median").median!.style.width))
      .toBeGreaterThan(parseFloat(marks("neutral").median!.style.width));
    expect(parseFloat(marks("median").median!.style.height))
      .toBeGreaterThan(parseFloat(marks("neutral").median!.style.height));
  });

  it("fills and thickens the tail under tail emphasis", () => {
    expect(parseFloat(marks("tail").tail!.style.height))
      .toBeGreaterThan(parseFloat(marks("neutral").tail!.style.height));
  });

  it("demotes the median under tail emphasis without hiding it", () => {
    const t = marks("tail").median!;
    // Still present — it is the anchor the tail is measured from.
    expect(t).not.toBeNull();
    expect(t.style.background).not.toBe(marks("neutral").median!.style.background);
  });

  it("keeps one scale across emphases, so the two are comparable", () => {
    // The mark that carries the reading moves; where it sits does not.
    expect(marks("tail").tail!.style.left).toBe(marks("neutral").tail!.style.left);
    expect(marks("median").median!.style.left).toBe(marks("neutral").median!.style.left);
  });

  it("stays one accessible image, however it is emphasised", () => {
    for (const e of ["neutral", "median", "tail"] as const) {
      const root = marks(e).root;
      expect(root.getAttribute("role")).toBe("img");
      expect(root.getAttribute("aria-label")).toMatch(/median/i);
    }
  });
});
