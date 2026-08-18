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
  ["components/XScanButton.tsx", "the scan button"],
];

describe("identity takes the brand hue", () => {
  for (const [path, role] of IDENTITY) {
    it(`${role} in ${path} uses --brand`, () => {
      expect(read(path), role).toContain("var(--brand");
    });
  }

  it("leaves no identity role on the agreement hue in those files", () => {
    // `FixtureTable` is excluded on purpose — see the verdict below.
    const regressed = IDENTITY
      .map(([path]) => path)
      .filter((path) => /var\(--accent[),]/.test(read(path)));
    expect(regressed, "an identity role fell back to the semantic hue").toEqual([]);
  });
});

describe("verdicts keep the semantic hue", () => {
  it("keeps the value-bet badge on --accent, because an edge is a judgement", () => {
    const source = read("components/FixtureTable.tsx");
    /* The badge sits on --success-muted and says "there is an edge here". Recolouring
       it as identity would make the palette silent about the one thing it exists to
       say. */
    expect(source).toContain('color: "var(--accent)"');
    expect(source).toContain('border: "1px solid var(--accent-border)"');
  });

  it("still defines both hues, so neither role is homeless", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/--accent:\s+oklch\([^)]*155\)/);
    expect(css).toMatch(/--brand:\s+oklch\([^)]*250\)/);
  });
});
