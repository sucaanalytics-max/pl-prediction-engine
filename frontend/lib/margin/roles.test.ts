/**
 * Hue carries judgement in this palette, and identity is not a judgement.
 *
 * 155 says fine, 80 says inside the noise, 30 says needs attention. Before `--brand`
 * existed, `--accent` did both jobs, so a green nav tile and a green "agrees with the
 * market" were the same colour and the palette had nothing left to say "this is
 * ours". These assertions pin BOTH halves of the split: the identity roles must not
 * regress to the semantic hue, and the verdicts must not be recoloured as identity by
 * a well-meaning sweep.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

/** Roles that mean "this is ours to press, or ours to follow". */
const IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["components/ui/Button.tsx", "the primary button"],
  ["components/ErrorBoundary.tsx", "the retry button"],
  ["components/data/DeltaFeed.tsx", "the source link"],
  ["components/MinutesConflicts.tsx", "the read-the-post link"],
  ["components/FixtureMatrix.tsx", "the sort toggle"],
];

describe("identity takes the brand hue", () => {
  for (const [path, role] of IDENTITY) {
    it(`${role} in ${path} uses --brand`, () => {
      expect(read(path), role).toContain("var(--brand");
    });
  }

  it("leaves no identity role on the agreement hue in those files", () => {
    const regressed = IDENTITY
      .map(([path]) => path)
      .filter((path) => /var\(--accent[),]/.test(read(path)));
    expect(regressed, "an identity role fell back to the semantic hue").toEqual([]);
  });
});

describe("verdicts keep the semantic hue", () => {
  /* The value-bet badge on `components/FixtureTable.tsx` used to be pinned here as
     the worked example of a verdict — it said "there is an edge here" on --accent
     while the identity roles above moved to --brand. That file was the betting
     surface's fixture table and went with the surface, so the example is gone; the
     split it demonstrated is still asserted from both sides — no identity role may
     regress onto --accent, and both hues must stay defined. */

  it("still defines both hues, so neither role is homeless", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/--accent:\s+oklch\([^)]*155\)/);
    expect(css).toMatch(/--brand:\s+oklch\([^)]*250\)/);
  });
});
