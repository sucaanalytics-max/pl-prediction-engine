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

/**
 * Roles that mean "this is ours to press, or ours to follow".
 *
 * `components/data/DeltaFeed.tsx` (the source link) and `components/FixtureMatrix.tsx`
 * (the sort toggle) were pinned here and are deleted: their only importers were
 * `app/now` and `app/matches`. `components/margin/WatchView.tsx` renders the delta
 * ledger on `/evidence` now and is not held to this list — it should be, and is not
 * added here because it has never been read against the identity/verdict split.
 */
/**
 * A stylesheet cannot be read whole, so an entry may name the rule to read.
 *
 * `app/globals.css` DEFINES `--accent` and spends it correctly in a dozen places —
 * the textarea focus ring, the verdict tints. Scanning the file for `var(--accent)`
 * therefore says nothing about the button. `selector` narrows the read to one
 * declaration block, which is the only scope at which "did this role regress" is a
 * real question.
 */
interface Role {
  readonly path: string;
  /** What the role is, for the failure message. */
  readonly role: string;
  /** For a stylesheet: the rule whose block is the subject. */
  readonly selector?: string;
}

const IDENTITY: readonly Role[] = [
  // `app/globals.css` rather than a component: the button a user presses is the
  // `.primary-action` CLASS (app/offline, the nav skip link), not a React
  // component. This entry used to name `components/ui/Button.tsx`, which no route
  // imported — so the guard passed while the live button sat on the lime
  // `--chrome-accent`, which is precisely the regression this file forbids. A guard
  // aimed at an unreachable file is worse than no guard: it reports a clean sweep.
  { path: "app/globals.css", role: "the primary button", selector: ".primary-action" },
  { path: "components/ErrorBoundary.tsx", role: "the retry button" },
  { path: "components/MinutesConflicts.tsx", role: "the read-the-post link" },
];

/**
 * The declaration block for `selector`, or the whole file when there is none.
 *
 * Matches the rule where the selector stands ALONE — `.primary-action {` — and not
 * where it appears in a group (`.primary-action,\n.secondary-action {`, the shared
 * geometry) or as a descendant (`.decision-card textarea + .primary-action`). Those
 * carry no colour and would dilute the subject.
 */
function subject({ path, selector }: Role): string {
  const css = read(path);
  if (!selector) return css;
  const rule = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, "m");
  const found = rule.exec(css);
  if (!found) throw new Error(`${selector} has no standalone rule in ${path}`);
  return found[1];
}

describe("identity takes the brand hue", () => {
  for (const entry of IDENTITY) {
    it(`${entry.role} in ${entry.path} uses --brand`, () => {
      expect(subject(entry), entry.role).toContain("var(--brand");
    });
  }

  it("leaves no identity role on the agreement hue", () => {
    const regressed = IDENTITY
      .filter((entry) => /var\(--accent[),]/.test(subject(entry)))
      .map((entry) => entry.selector ?? entry.path);
    expect(regressed, "an identity role fell back to the semantic hue").toEqual([]);
  });

  it("leaves no identity role on the chrome hue either", () => {
    // The drift that actually happened was onto `--chrome-accent`, not `--accent`,
    // so the original check would have missed it even aimed at the right file.
    const regressed = IDENTITY
      .filter((entry) => /var\(--chrome-accent[),]/.test(subject(entry)))
      .map((entry) => entry.selector ?? entry.path);
    expect(regressed, "an identity role took the chrome accent").toEqual([]);
  });

  it("names a rule that exists, so a renamed selector fails loudly", () => {
    // `subject` throws on a missing rule. Without this, deleting `.primary-action`
    // would turn every assertion above into an error nobody reads as a role gap.
    for (const entry of IDENTITY) expect(() => subject(entry)).not.toThrow();
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
