/**
 * The narrower against the producer, in the producer's own source.
 *
 * `PublicDecision`'s distribution block has now been wrong twice in the same
 * direction. First it read `points_sd`, `points_q10`, `prob_at_least` and
 * `autosub_prob` — names nothing in the pipeline has ever written — so the screen
 * rendered an absence over live data and a docstring recorded that absence as a
 * principled refusal. Then, once the names were fixed, it read three of the five
 * quantiles the producer publishes, and the squad glyph drew a whisker with no box.
 *
 * Both times the TypeScript fixture and the TypeScript narrower agreed with each
 * other and described a producer that did not exist. The only thing that catches that
 * class of error is reading the producer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `plan_eval.py` is the single producer of a decision's distribution block. */
const PRODUCER = readFileSync("../pipeline/decide/plan_eval.py", "utf8");
const NARROWER = readFileSync("lib/data/narrow.ts", "utf8");

/**
 * The quantile keys the producer emits, read out of its own comprehension.
 *
 * `f"q{int(q * 100)}"` over a literal tuple of fractions, so the keys are derivable
 * without running Python.
 */
function producedQuantileKeys(): string[] {
  const comprehension = PRODUCER.match(
    /f"q\{int\(q \* 100\)\}": float\(np\.quantile\(totals, q\)\)\s*\n\s*for q in \(([^)]*)\)/,
  );
  expect(comprehension, "the quantile comprehension moved — reread plan_eval.py")
    .not.toBeNull();
  return comprehension![1]
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((fraction) => `q${Math.round(Number(fraction) * 100)}`);
}

/**
 * Keys the glyph has no mark for, so the narrower deliberately does not carry them.
 *
 * Each needs a reason, because this set is the only legitimate way for a published
 * figure to go unread.
 */
const NO_SLOT: Record<string, string> = {
  q99: "the distribution primitive draws q10-q90; there is no q99 mark",
};

describe("the decision narrower reads what plan_eval publishes", () => {
  it("finds the producer's quantile keys", () => {
    expect(producedQuantileKeys()).toEqual(["q10", "q25", "q50", "q75", "q90", "q99"]);
  });

  it("reads every published quantile the glyph can draw", () => {
    const unread = producedQuantileKeys()
      .filter((key) => !(key in NO_SLOT))
      .filter((key) => !NARROWER.includes(`optNumber(quantiles.${key})`));
    expect(
      unread,
      "published by plan_eval.py and dropped by the narrower — the exact defect that "
        + "made the squad glyph a whisker with a hole in it",
    ).toEqual([]);
  });

  it("reads the standard deviation under the producer's own name", () => {
    expect(PRODUCER).toContain('"sd_points"');
    expect(NARROWER).toContain("optNumber(decision.sd_points)");
  });

  it("reads the mean and the draw count under the producer's own names", () => {
    expect(PRODUCER).toContain('"mean_points"');
    expect(PRODUCER).toContain('"n_draws"');
    expect(NARROWER).toContain("optNumber(decision.mean_points)");
  });

  it("keeps the tail keys aligned with the thresholds the producer scores", () => {
    const thresholds = PRODUCER.match(/TAIL_THRESHOLDS = \(([^)]*)\)/);
    expect(thresholds).not.toBeNull();
    const rungs = thresholds![1].split(",").map((s) => Number(s.trim()));
    // 70 is the default the weekly objective solves against; 60 is one rung of six,
    // which is why the design's prototype slider value is not this app's figure.
    expect(rungs).toContain(70);
    expect(rungs).toContain(60);
    expect(PRODUCER).toContain('f"p_ge_{t}"');
  });

  it("gives every unread key a stated reason", () => {
    for (const [key, reason] of Object.entries(NO_SLOT)) {
      expect(producedQuantileKeys(), `${key} is no longer published`).toContain(key);
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(20);
    }
  });
});
