/**
 * The glyph's correctness rules, which the design calls non-negotiable.
 *
 * A player is never a single number, and the marks that say so are only worth
 * drawing if every one of them was measured. The two rules under test:
 *
 *   1. Both ends or nothing. A span needs both of its quantiles published.
 *      Deriving `q25 = q50 − sd × 0.5` invents a shape from a spread and draws
 *      it at the same weight as the measured marks — and half a box is a
 *      NARROWER interval than the one measured, which is the flattering
 *      direction to be wrong in.
 *   2. Absent input is `∅`, never a flat glyph. An empty cell reads as "fitted,
 *      and it came out low"; `∅` reads as "nothing was fitted".
 */
import { describe, expect, it } from "vitest";

import {
  DOUBLED_SCALE_HI, DOUBLED_SCALE_LO, SCALE_HI, SCALE_LO,
  SQUAD_SCALE_HI, SQUAD_SCALE_LO, geometry,
} from "@/lib/margin/distribution";

// B.Fernandes as published in xp_public_gw01.json — a real row, not a fixture
// shaped to pass. The producer ships q10/q25/q50/q75/q90 for 590 of 590.
const FERNANDES = { q10: 2, q25: 4, q50: 6, q75: 9, q90: 14, mean: 6.66, mode: 5 };

describe("both ends or nothing", () => {
  it("draws the box when both quartiles are published", () => {
    expect(geometry(FERNANDES).box).not.toBeNull();
  });

  it("refuses the box when q25 alone is missing", () => {
    const { q25, ...rest } = FERNANDES;
    expect(geometry(rest).box).toBeNull();
  });

  it("refuses the box when q75 alone is missing", () => {
    const { q75, ...rest } = FERNANDES;
    expect(geometry(rest).box).toBeNull();
  });

  it("refuses the whisker when either end is missing", () => {
    const { q90, ...rest } = FERNANDES;
    expect(geometry(rest).whisker).toBeNull();
  });

  it("refuses the tail when q90 is missing, even though q75 is present", () => {
    const { q90, ...rest } = FERNANDES;
    expect(geometry(rest).tail).toBeNull();
  });

  it("never widens a refused span into a narrower drawn one", () => {
    // The specific error the rule forbids: falling back to q10..q50 for the box
    // would draw an interval NARROWER than the measured q25..q75.
    const { q75, ...rest } = FERNANDES;
    const g = geometry(rest);
    expect(g.box).toBeNull();
    expect(g.tail).toBeNull();
  });
});

describe("the right tail, which the weekly objective reads", () => {
  it("spans q75 to q90", () => {
    const g = geometry(FERNANDES);
    const at = (v: number) => ((v - SCALE_LO) / (SCALE_HI - SCALE_LO)) * 100;
    expect(g.tail!.from).toBeCloseTo(at(9), 5);
    expect(g.tail!.to).toBeCloseTo(at(14), 5);
  });

  it("is its own span, not inferred from the box and the whisker", () => {
    // Present even when the box is refused, so long as its own ends are there.
    const { q25, ...rest } = FERNANDES;
    const g = geometry(rest);
    expect(g.box).toBeNull();
    expect(g.tail).not.toBeNull();
  });
});

/**
 * A lone tail is not a distribution — the second direction of rule 1.
 *
 * A partial file carrying q75 and q90 and nothing else has an upper tail with
 * nothing to read it against: no median, no mean, no lower end, no interval it is
 * the top of. That is the same "half a box, in the flattering direction" that
 * `span` refuses one level down, committed at the level of the whole glyph — and
 * as rendered it drew a visible bar inside a `role="img"` whose `aria-label` said
 * "no distribution published", because `describeGlyph` names only the pairs and
 * the point marks.
 */
describe("the tail alone does not make a glyph", () => {
  const TAIL_ONLY = { q75: 7, q90: 11 };

  it("reports blank when the tail is the only thing published", () => {
    expect(geometry(TAIL_ONLY).blank).toBe(true);
  });

  it("still measures the tail — blank is about drawing, not about the numbers", () => {
    // The span is honest geometry; what changed is that it is not sufficient.
    expect(geometry(TAIL_ONLY).tail).not.toBeNull();
  });

  it("is not blank once any other mark anchors it", () => {
    // The other direction: a median is enough of a distribution for the tail to
    // be the top OF something, so the glyph draws.
    expect(geometry({ ...TAIL_ONLY, q50: 6 }).blank).toBe(false);
    expect(geometry({ ...TAIL_ONLY, mean: 6.66 }).blank).toBe(false);
    expect(geometry({ ...TAIL_ONLY, mode: 5 }).blank).toBe(false);
    // And q25 turns the lone tail into a measured middle half plus its top.
    expect(geometry({ ...TAIL_ONLY, q25: 4 }).blank).toBe(false);
  });
});

describe("absent input is a fact about the model, not the clock", () => {
  it("reports blank when nothing was fitted", () => {
    expect(geometry({}).blank).toBe(true);
  });

  it("is not blank when even one mark survives", () => {
    expect(geometry({ q50: 6 }).blank).toBe(false);
  });

  it("refuses a degenerate scale rather than placing marks at infinity", () => {
    const g = geometry(FERNANDES, 5, 5);
    expect(g.blank).toBe(true);
    expect(g.median).toBeNull();
  });
});

describe("the scales are fixed, never per-row", () => {
  it("keeps three distinct scales", () => {
    expect([SCALE_LO, SCALE_HI]).toEqual([0, 18]);
    expect([SQUAD_SCALE_LO, SQUAD_SCALE_HI]).toEqual([20, 110]);
    expect([DOUBLED_SCALE_LO, DOUBLED_SCALE_HI]).toEqual([0, 36]);
  });

  it("gives a doubled player room where the per-player scale would clamp", () => {
    const haul = { q10: 6, q25: 10, q50: 14, q75: 20, q90: 28, mean: 15, mode: 12 };
    expect(geometry(haul, SCALE_LO, SCALE_HI).median!.clamped).toBe(false);
    // q90 = 28 clamps hard against 18 but has room against 36.
    expect(geometry(haul, SCALE_LO, SCALE_HI).whisker!.to).toBe(100);
    expect(geometry(haul, DOUBLED_SCALE_LO, DOUBLED_SCALE_HI).whisker!.to).toBeLessThan(100);
  });

  it("marks a clamped value as pinned rather than measured", () => {
    const g = geometry({ q50: 25 }, SCALE_LO, SCALE_HI);
    expect(g.median!.clamped).toBe(true);
    expect(g.median!.at).toBe(100);
  });
});
