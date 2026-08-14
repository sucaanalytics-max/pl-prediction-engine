/**
 * A `var(--token)` must name a token that exists.
 *
 * ## The class of bug
 *
 * `var(--danger, #f87171)` reads as "the danger colour, with a sensible
 * fallback". There is no `--danger`. There never was. So every red in this app
 * rendered `#f87171` in light mode and `#f87171` in dark mode, ignoring the
 * theme entirely — and it looked deliberate, because a hand-picked hex always
 * does.
 *
 * The restyle found five of these, all invisible in exactly the same way:
 *
 * | written | defined? | what actually rendered |
 * |---|---|---|
 * | `var(--danger, #f87171)` | no | `#f87171`, both themes |
 * | `var(--surface-2, #0f172a)` | no — it is `--surface2` | a dark navy input on paper |
 * | `var(--accent-contrast, #fff)` | no | white on white when the accent went pale |
 * | `var(--muted, #94a3b8)` | no | slate, against a warm-grey scale |
 * | `var(--shadow-custom)` | no, and no fallback | nothing — an invalid declaration |
 *
 * The last one is the tell for how quiet this is: four elements asked for a
 * shadow, got a parse error, and nobody noticed for as long as the class
 * existed.
 *
 * ## Why a test rather than a careful sweep
 *
 * A fallback is the failure mode. Every one of these renders *something*
 * plausible, so there is no broken page to report and no console warning to
 * read — the design simply stops following the theme in one place, and the next
 * person picks the hex out of the rendered page and matches it, spreading it.
 *
 * ## The escape hatch
 *
 * `ALLOWED` is for variables defined somewhere other than `globals.css` — the
 * `next/font` variables live on the `<html>` element. Anything else needs a
 * definition, not an exemption.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/**
 * Defined outside the stylesheet, with a reason each.
 *
 * `next/font/google` emits these onto `<html>` from `app/layout.tsx`, so they
 * are real at run time and absent from the CSS source.
 */
const ALLOWED: Record<string, string> = {
  "--font-plex-sans": "emitted onto <html> by next/font in app/layout.tsx",
  "--font-plex-mono": "emitted onto <html> by next/font in app/layout.tsx",
};

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // Margin sets its palette inline from `lib/margin/tokens.ts` rather than
      // from CSS, deliberately — see that module. It has no `var()` calls of
      // its own to check.
      if (full.includes(`${join("", "margin", "")}`)) continue;
      out.push(full);
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(join(ROOT, dir));
  // The config files, which are where the first version of this test had its
  // hole: `tailwind.config.js` mapped `font-display` and `font-body` to
  // `var(--font-jakarta)` for a whole release after that token was deleted, so
  // every element using those utilities silently fell back to system-ui. A guard
  // that scans only the component tree audits the place bugs are easiest to see.
  for (const file of ["tailwind.config.js", "postcss.config.js"]) {
    const full = join(ROOT, file);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

function definedTokens(): Set<string> {
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
  return new Set(css.match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);
}

interface Use {
  readonly token: string;
  readonly file: string;
  readonly fallback: string | null;
}

function uses(): Use[] {
  const out: Use[] = [];
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)\s*(?:,([^)]*))?\)/g)) {
      out.push({
        token: match[1],
        file: file.slice(ROOT.length + 1),
        fallback: match[2]?.trim() || null,
      });
    }
  }
  return out;
}

describe("every CSS variable the code references is defined", () => {
  const defined = definedTokens();
  const all = uses();

  it("finds tokens and uses to check at all", () => {
    // Guards the guard. An empty either side makes every assertion vacuous,
    // which is how a green tick starts meaning "not audited".
    expect(defined.size).toBeGreaterThan(20);
    expect(all.length).toBeGreaterThan(20);
  });

  it("references no token that does not exist", () => {
    const phantoms = all.filter(
      (use) => !defined.has(use.token) && !(use.token in ALLOWED),
    );
    const described = phantoms.map(
      (p) => `${p.token} in ${p.file} (renders ${p.fallback ?? "nothing — invalid declaration"})`,
    );
    expect(
      [...new Set(described)],
      "These name a variable defined nowhere, so the fallback renders in BOTH " +
        "themes and the element silently stops following the design. Define the " +
        "token, or use the one that exists.",
    ).toEqual([]);
  });

  it("keeps every allowance honest", () => {
    for (const [token, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${token} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

/**
 * Comments stripped before matching.
 *
 * The docstring at the top of `globals.css` quotes the exact declarations this
 * block forbids, in order to explain why they were removed. Scanning raw text
 * cannot tell an explanation from a rule, and pushes the author to delete the
 * explanation to get to green — the worst outcome available.
 */
function stylesheet(): string {
  return readFileSync(join(ROOT, "app", "globals.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

describe("the design language holds", () => {
  const css = stylesheet();

  it("has no backdrop blur left", () => {
    // The glass is gone. A single surviving blur reads as a rendering artefact
    // next to forty flat panels rather than as an intentional effect.
    expect(css).not.toContain("backdrop-filter");
  });

  it("spends no colour on decoration", () => {
    // The previous palette gave every badge a coloured glow, so `NOT YET
    // MEASURABLE` arrived with the same energy as a live recommendation. Colour
    // now marks agreement, disagreement and noise, and nothing else.
    //
    // A glow is a shadow with a non-zero BLUR — the third length. Matching on
    // `0 0 <n>px` alone also catches `0 0 0 3px`, which is a solid focus ring
    // and the one place a coloured shadow still earns its place: it marks where
    // the keyboard is, which is not decoration.
    const glows = css.match(/box-shadow:\s*\S+\s+\S+\s+[1-9]\d*px[^;]*/g) ?? [];
    expect(glows, "coloured halos are back").toEqual([]);
  });

  it("defines both surfaces from the same token set", () => {
    // Light and dark are one design, not two. A token defined for paper and not
    // for ink is a hole that renders as an inherited value from the other
    // surface — usually invisible until a screenshot in the wrong theme.
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      return new Set(
        (css.slice(start, css.indexOf("}", start)).match(/--[a-z0-9-]+(?=\s*:)/g) ?? []),
      );
    };
    const paper = block(":root {");
    const ink = block(".dark {");
    // The chrome and the fonts are deliberately surface-independent: the sidebar
    // is ink on both, and the typeface does not change with the theme.
    const surfaceIndependent = (t: string) =>
      t.startsWith("--chrome") || t.startsWith("--font") || t.startsWith("--radius")
      || t.startsWith("--shadow") || t.startsWith("--glow");
    const missing = [...paper].filter((t) => !ink.has(t) && !surfaceIndependent(t));
    expect(missing, "defined for paper but not for ink").toEqual([]);
  });
});
