/**
 * The two rules that made this board unreadable, enforced instead of remembered.
 *
 * The control room shipped with labels, band counts, provenance lines and absence
 * glyphs set between 8.5px and 10px in `ink3` and `ink4`. Measured against their own
 * ground: `ink3` was 3.17:1 on paper and 3.82:1 on ink; `ink4` was 2.06:1 and 2.71:1.
 * WCAG's floor is 4.5:1 for text under 18.66px and 3:1 for large text and UI, so every
 * one of those figures was below the line — and two of them below the line for ANY size.
 *
 * Floodlit collapsed the two surfaces into one and the bands did not move for a long
 * while: ink 16.37:1, ink2 6.34:1, ink3 3.21:1, ink4 2.14:1. Two of those were
 * failures rather than choices. ink3 was the second most common text colour on the
 * call screen, at 3.22:1 and mostly at 9.5px, where 1.4.3's 3:1 large-text allowance
 * does not apply — that needs 24px, or 18.66px bold. It is now 0.55 alpha / 5.50:1,
 * and ink2 0.72 / 8.73:1.
 *
 * ink4 was deliberately NOT raised. It is a border tone; one that cleared the text
 * floor would stop being one, and rule 2 below would lose its premise. The places
 * painting text with it moved to ink3 instead.
 *
 * All of it is still measured below rather than read off this paragraph, because a
 * palette edit that quietly drops a tier is exactly what this file exists to catch.
 *
 * The rules:
 *   1. Nothing that carries meaning is set below 11px.
 *   2. `ink4` is a border tone. It never paints text.
 *
 * Both are scanned rather than trusted, because both were violated by code written to a
 * document that stated the contrast requirement correctly.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "@/test/support/comments";

import { FLOODLIT, surfaceIsLight, type MarginSurface } from "@/lib/margin/tokens";

/**
 * The floor for anything that carries meaning.
 *
 * Only the floor is enforced, not a full scale. The display tier in use (13 to 46) is
 * not yet a single system, and a "scale" test wide enough to admit every value already
 * shipped would enforce nothing while generating churn. Unifying the display sizes is a
 * separate piece of work; letting 8.5px labels back onto the board is not.
 */
const FLOOR = 11;

/**
 * One surface, kept as a list.
 *
 * There were two entries; the redesign left one. The loop stays a loop so that a
 * surface added later gets these three contrast assertions without anyone
 * remembering to write them — which is the failure mode worth guarding, since an
 * unchecked second surface is where a sub-3:1 label tone would hide.
 */
const SURFACES: ReadonlyArray<readonly [string, MarginSurface]> = [
  ["FLOODLIT", FLOODLIT],
];

/**
 * What is left of the board.
 *
 * The board itself — `app/control-room`, `components/control-room` — went with the
 * route cut, and the kit primitives under `components/squad` went with it in the same
 * sweep: `components/squad/SquadRow.tsx` was `KitMark`'s only importer, so the whole
 * directory became unreachable. `components/margin/Provenance.tsx` went the same way.
 *
 * `Marks.tsx` is what survived, and it is the file the rule was really about: it draws
 * every distribution glyph on `/`, `/players` and `/evidence`, labels included. The
 * contrast assertions below are over the tokens and hold regardless.
 *
 * The rest of `components/margin` — ScoreView, Planner, ResearchView, WatchView,
 * NewsView — carries sizes below this floor. That is a real backlog and it is
 * deliberately not in scope here: a test that fails on dozens of pre-existing
 * violations gets skipped rather than fixed. Add them when one of those pages is
 * next opened.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every screen and component, the shared type scale, plus the stylesheet.
 *
 * `lib` is here because the type scale is there. Scanning only `components` and
 * `app` missed the largest single offender in the tree: `EYEBROW` is defined in
 * `lib/margin/type.ts` and SPREAD into eight of Eleven's column headers, one of
 * them inside `COLUMNS.map`, so nine labels rendered at 9px while every explicit
 * literal in that file was accounted for. A scale that lives outside the scan is a
 * hole the size of every file that imports it.
 */
const FILES = [
  ...walk("components"),
  ...walk("app"),
  ...walk("lib"),
  "app/globals.css",
];

/**
 * Sizes below the floor that were already shipped. THE MAP IS EMPTY, and that is the
 * point of having built it as a ratchet.
 *
 * It held 22 files and 113 occurrences. Every one is gone: 123 sites raised across 21
 * components plus the stylesheet, and four of the stylesheet's ten were in rules with no
 * renderer at all — `.badge`, `.skeleton`, `.vice-captain` and a `.decision-card textarea`
 * for a textarea this app does not contain — so deleting them cleared the floor without a
 * rendered pixel changing.
 *
 * ## What made the burn-down possible was a measurement, not a decision
 *
 * The reason this backlog sat here was a belief that raising a 9px tracked label to 11px
 * would overflow the grid tracks it sits in — `Pos` lives in a 34px column. Rendered in
 * the browser with the page's own Archivo, that is false, because tracking costs more
 * width than size does:
 *
 *     Pos       23.1px at 9px/.15em   ->  23.3px at 11px/.04em
 *     Mins      28.1px                ->  27.8px
 *     Own       26.1px                ->  27.0px
 *     BENCH     39.6px                ->  40.1px
 *     TEMPLATE  59.7px                ->  59.8px
 *
 * So every tracked uppercase label could clear the floor for free by trading .15em of
 * tracking for 2px of size. That is what was done, and it is why `EYEBROW` — previously
 * the ONE argued exemption in this file — is 11px now and there are no exemptions left.
 *
 * If a size below the floor reappears, this map is where a reason goes. An entry needs to
 * say what the element is and why the floor does not bind on it; the EYEBROW argument
 * ("redundant with the figure beneath it") is available but was not needed once the width
 * question was settled by measurement rather than by estimate.
 */
const ALLOWED = new Map<string, number>([]);

// ── contrast ────────────────────────────────────────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function parse(colour: string, ground: readonly [number, number, number]) {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    return [0, 2, 4].map((o) => parseInt(hex[1].slice(o, o + 2), 16)) as
      unknown as [number, number, number];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/
    .exec(colour.trim());
  if (rgba) {
    const [r, g, b] = [1, 2, 3].map((i) => Number(rgba[i]));
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    // Composited over the ground, which is how the browser paints it.
    return [0, 1, 2].map((i) =>
      Math.round([r, g, b][i] * a + ground[i] * (1 - a))) as unknown as
      [number, number, number];
  }
  return null;
}
function ratio(colour: string, surface: MarginSurface): number | null {
  const ground = parse(surface.shell, [0, 0, 0]);
  if (!ground) return null;
  const fg = parse(colour, ground);
  if (!fg) return null;
  const [hi, lo] = [luminance(fg), luminance(ground)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the tones this board paints text with", () => {
  for (const [name, surface] of SURFACES) {
    it(`${name}: ink and ink2 clear 4.5:1, so body text can use them`, () => {
      for (const tone of ["ink", "ink2"] as const) {
        const r = ratio(surface[tone], surface)!;
        expect(r, `${name}.${tone} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: ink3 now clears 4.5:1, so it may carry body text too`, () => {
      // This assertion is inverted from what it was, and the old docstring
      // anticipated it: "if ink3 ever clears 4.5 this rule can relax". It has.
      //
      // ink3 was 0.38 alpha at 3.22:1 and FAILED 1.4.3 for normal text — 89 nodes
      // on the call screen, mostly at 9.5px, where the 3:1 large-text allowance is
      // categorically unavailable. At 0.55 it measures 5.50:1 and the tier is
      // usable for the absence states, provenance lines and column headers that
      // were already using it.
      const r = ratio(surface.ink3, surface)!;
      expect(r, `${name}.ink3 is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: ink4 fails 3:1, which is why it may not paint text`, () => {
      // Asserted, not assumed: this is the premise the scan below depends on.
      expect(ratio(surface.ink4, surface)!).toBeLessThan(3);
    });
  }

  it("agrees with the surface helper about which ground this is", () => {
    // The ratios above are computed against `shell` as the ground, and `hatch`
    // picks its stroke from `surfaceIsLight` reading that same field. If the two
    // disagreed, the hatch would be drawn to show against a ground these
    // contrast figures were never measured on.
    expect(surfaceIsLight(FLOODLIT)).toBe(false);
  });
});

/**
 * The stylesheet's own text tiers, which are the ones the browser actually paints.
 *
 * Everything above measures `FLOODLIT`, a TypeScript object. But two thirds of the
 * text in this app is coloured by `var(--text-3)` from `app/globals.css` — 67
 * occurrences against 10 for `--text-2` — and nothing read those declarations. So
 * the raise that took `--text-2` from .60 to .72 and `--text-3` from .38 to .55 was
 * unguarded on the half that ships: reverting both blocks to the measured WCAG
 * failure (3.22:1) left the full suite green at 1154 passing tests.
 *
 * This closes it from the other side: parse the declarations out of BOTH `:root`
 * and `.dark` — the file's own comment promises they carry the same values — and
 * require each to equal its `FLOODLIT` twin and clear the same floor. Spelling is
 * normalised because the two sources disagree cosmetically and always have:
 * `rgba(233, 238, 245, 0.55)` in CSS against `rgba(233,238,245,.55)` in the token.
 */
const TIERS = [
  ["--text-1", "ink", 4.5],
  ["--text-2", "ink2", 4.5],
  ["--text-3", "ink3", 4.5],
  // ink4 is a border tone; rule 2 forbids it on text. 3:1 is the graphical floor.
  ["--text-4", "ink4", 0],
] as const;

/** Collapse whitespace and `0.55`/`.55` so the two spellings compare equal. */
const canonical = (colour: string) =>
  colour.replace(/\s+/g, "").replace(/(^|[^0-9])0\./g, "$1.").toLowerCase();

/** One CSS block's body, by selector. */
function blockBody(css: string, selector: string): string {
  const m = new RegExp(`^${selector}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(css);
  if (!m) throw new Error(`no ${selector} block in app/globals.css`);
  return m[1];
}

/** A custom property's value. Tolerates a missing final semicolon. */
function declared(body: string, token: string): string {
  const m = new RegExp(`${token}\\s*:\\s*([^;}\\n]+)`).exec(body);
  if (!m) throw new Error(`${token} is not declared`);
  return m[1].trim();
}

describe("the stylesheet's text tiers match the tokens they mirror", () => {
  const css = readFileSync("app/globals.css", "utf8");

  for (const selector of [":root", "\\.dark"] as const) {
    const label = selector === ":root" ? ":root" : ".dark";

    it(`${label} declares the same four tones as FLOODLIT`, () => {
      const body = blockBody(css, selector);
      for (const [token, tone] of TIERS) {
        expect(canonical(declared(body, token)), `${token} vs FLOODLIT.${tone}`)
          .toBe(canonical(FLOODLIT[tone]));
      }
    });

    it(`${label} clears the contrast floor on the tones that carry text`, () => {
      // Measured on the CSS value, not the token — so this still fails if the two
      // are made to agree by lowering BOTH.
      const body = blockBody(css, selector);
      for (const [token, , floor] of TIERS) {
        if (floor === 0) continue;
        const r = ratio(declared(body, token), FLOODLIT)!;
        expect(r, `${token} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor);
      }
    });
  }

  /**
   * The CHROME tier, which has its own ground and was invisible to every guard.
   *
   * The masthead, the PWA prompt and the mobile nav are painted from
   * `--chrome-ink-*` over `--chrome` (#14181d), not over the shell — so neither the
   * FLOODLIT measurements above nor the `--text-*` parity check could see them. They
   * still held .60 and .38, the exact two alphas the page tiers were raised off, in
   * a commit whose message said the raise left nothing able to drift.
   */
  it("measures the chrome tier against the chrome ground, not the shell", () => {
    const body = blockBody(css, ":root");
    const ground = declared(body, "--chrome");
    const chrome = { ...FLOODLIT, shell: ground };
    for (const token of ["--chrome-ink", "--chrome-ink-2", "--chrome-ink-3"]) {
      const r = ratio(declared(body, token), chrome)!;
      expect(r, `${token} is ${r.toFixed(2)}:1 on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps ink4 under the text floor, so rule 2 still has a reason", () => {
    const r = ratio(declared(blockBody(css, ":root"), "--text-4"), FLOODLIT)!;
    expect(r, `--text-4 is ${r.toFixed(2)}:1`).toBeLessThan(3);
  });
});

/**
 * A CSS length in px. A bare number in a React style object IS px.
 *
 * Units matter because the guard is a numeric comparison: `font-size: 0.5rem` is
 * 8px and `font-size: 8pt` is 10.67px, and a pattern matching only `px` passed
 * both. Probed on the real tree before this existed — injected `text-[0.5rem]` and
 * `font-size: 8pt` and the suite stayed green.
 */
const PER_UNIT: Readonly<Record<string, number>> = {
  "": 1, px: 1, pt: 96 / 72, rem: 16, em: 16,
};

/**
 * Every declared type size in a source file, in px.
 *
 * Five shapes, each of which shipped a sub-floor size past an earlier version of
 * this scan:
 *
 * 1. `fontSize:` / `font-size:` — the object and stylesheet spellings, with the
 *    value optionally quoted in any of the three JS quote characters. The backtick
 *    is not pedantry: a template literal is how an interpolated size is written.
 * 2. `size={n}` — the prop form.
 * 3. `size = n` — the DEFAULT form, which is how the worst offender hid: the eight
 *    facet labels took `Label`'s `size = 9.5` default, so no scan looking for an
 *    explicit size could see the smallest text on the page.
 * 4. `text-[…]` — Tailwind's arbitrary value. 17 usages across six files were
 *    invisible to a green test.
 * 5. `font:` — the SHORTHAND. `.masthead-gw` carried `font: 500 9px var(--font-mono)`
 *    and `.masthead-team span` carried `font: 400 8px …`; both are live global chrome
 *    rendered by `Navigation.tsx` on every screen, and neither was visible here.
 * 6. `fontSize={9}` — the SVG ATTRIBUTE form, which is an `=` and not a `:`. Every
 *    pattern above wanted a colon, so the Scatter's axis ticks and both axis titles sat
 *    at 9px through the whole burn-down and were caught only by measuring the rendered
 *    page. An SVG `<text>` is text; the floor binds on it exactly as on a `<span>`.
 */
function* matchSizes(source: string): Generator<{ px: number; text: string }> {
  const patterns: readonly RegExp[] = [
    /(?:fontSize|font-size)\s*:\s*["'`]?([0-9.]+)(px|pt|rem|em)?/g,
    // The SVG attribute form: `fontSize={9}` or `font-size="9"`. No colon.
    /fontSize=\{([0-9.]+)\}()/g,
    /font-size="([0-9.]+)"()/g,
    /size=\{([0-9.]+)\}()/g,
    /\bsize = ([0-9.]+)()/g,
    /text-\[([0-9.]+)(px|pt|rem|em)\]/g,
    /font:\s*[^;{}]*?([0-9.]+)(px|pt|rem|em)/g,
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      const scale = PER_UNIT[m[2] ?? ""] ?? 1;
      yield { px: Number(m[1]) * scale, text: m[0].trim() };
    }
  }
}

/**
 * A size this scan cannot evaluate, which must fail rather than pass.
 *
 * `clamp()` and `calc()` have no single value, so a numeric floor cannot be
 * applied — and silently passing is the worse of the two failures, because it
 * makes `font-size: clamp(7px, 1vw, 9px)` the way to get under the floor.
 */
const UNSCANNABLE = /(?:fontSize|font-size)\s*:\s*["'`]?(?:clamp|calc)\(/g;

describe("rule 1 — nothing meaningful below 11px", () => {
  it("finds no size under the floor anywhere on the board", () => {
    const offenders: string[] = [];
    const stale: string[] = [];
    for (const path of FILES) {
      /*
       * Comments stripped, for the reason rule 3 already records: a rule this specific
       * attracts prose about itself, and a raw scan cannot tell a declaration apart
       * from a sentence describing one. This rule flagged `type.tsx` the moment that
       * file grew a docstring containing the words "inline `fontSize: 9`" — a note
       * explaining why three components no longer do that.
       */
      const source = withoutComments(readFileSync(path, "utf8"));
      const sizes = [...matchSizes(source)];
      const found = sizes.filter((m) => m.px < FLOOR).length;
      const allowance = ALLOWED.get(path) ?? 0;
      if (found > allowance) {
        offenders.push(
          `${path}: ${found} below ${FLOOR}px, ${allowance} allowed`,
        );
      }
      if (found < allowance) {
        // The ratchet. Fixing sizes without lowering the allowance leaves room
        // for them to come back, which is how an allowlist becomes a floor.
        stale.push(`${path}: now ${found}, allowance still ${allowance} — lower it`);
      }
    }
    expect(offenders, `below the ${FLOOR}px floor`).toEqual([]);
    expect(stale, "allowances that no longer match reality").toEqual([]);
  });

  it("refuses a size it cannot evaluate", () => {
    const unscannable = FILES.flatMap((path) =>
      [...withoutComments(readFileSync(path, "utf8")).matchAll(UNSCANNABLE)]
        .map((m) => `${path}: ${m[0].trim()}`));
    expect(
      unscannable,
      "a clamp() or calc() font-size has no single value to compare — state one",
    ).toEqual([]);
  });
});

describe("rule 3 — no container opacity behind a figure", () => {
  it("never dims a cell that holds text", () => {
    /*
     * `opacity` on a container multiplies the fill AND the text inside it, and on a
     * heat cell the text is the thing being compared. HeatGrid dimmed out-of-span
     * cells to 0.34 and every band landed between 1.71:1 and 2.62:1 — below even the
     * 3:1 graphical floor — with the two BRIGHTEST bands worst, because a light
     * figure and a lightening ground converge as both fade toward the shell. An 8px
     * label inside carried a second 0.75 and compounded to 2.11:1.
     *
     * The fix is to dim the BACKGROUND and leave the ink alone, so this scans for
     * the shape of the mistake rather than trusting the fix to stay. Measured after:
     * out-of-span cells run 5.70:1 to 14.82:1.
     */
    /*
     * EVERY file, not just the heat grid.
     *
     * This scanned one path, and three captions on `/players` were dimming `S.ink`
     * with a container opacity the whole time — measured in the browser at 5.50:1,
     * 2.91:1 and 4.05:1, so two of the three failed 1.4.3 and one failed even the
     * 3:1 graphical floor. A rule aimed at one file is a rule about that file, not
     * about the practice.
     */
    const offenders: string[] = [];
    for (const path of FILES) {
      /*
       * Comments stripped, and `@keyframes` bodies with them.
       *
       * Both matter for the same reason `test/support/comments.ts` exists: a rule
       * this specific attracts explanatory prose, and a raw scan cannot tell a
       * declaration apart from a note about one — this rule flagged its own
       * docstrings the moment it was widened past a single file.
       *
       * A keyframe is a different exemption on the merits. `opacity: 0 -> 1` in a
       * reveal is not dimming text; it is text arriving. The end state is what a
       * reader reads, and the end state is 1.
       */
      const source = withoutComments(readFileSync(path, "utf8"))
        .replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, " ");
      /*
       * The PROPERTY, not the value. The regex here used to be
       * `/opacity:\s*(?!1\b)[0-9.]+/`, which requires a literal number — so it
       * could not match the line it was written to forbid. The removed line was
       * `opacity: index < span ? 1 : 0.34`, a CONDITIONAL: after `opacity:` comes
       * `index`, the lookahead sees no `1`, and `[0-9.]+` has nothing to match. Put
       * that exact line back into the surviving cell container and the test passes.
       *
       * So: flag any `opacity` in this file whose value is not exactly 1, plus the
       * Tailwind form. The file has no legitimate use for one — dimming is done with
       * `color-mix` against the shell — which is why a blanket rule is right here
       * rather than a value test.
       */
      for (const m of source.matchAll(/opacity:\s*(?!1\s*[,}])[^,}\n]+/g)) {
        offenders.push(`${path}: ${m[0].trim()}`);
      }
      for (const m of source.matchAll(/\bopacity-\[?[0-9.]/g)) {
        offenders.push(`${path}: ${m[0].trim()}`);
      }
    }
    expect(
      offenders,
      "dim the background with color-mix, never the container that holds the figure",
    ).toEqual([]);
  });
});

describe("rule 2 — ink4 is a border tone", () => {
  it("never paints text with it", () => {
    /* `color: surface.ink4` and `tone={S.ink4}` are the two ways this board sets a text
       colour. A border, a background or a gradient stop is fine — those are not read. */
    const offenders: string[] = [];
    for (const path of FILES) {
      const source = readFileSync(path, "utf8");
      /*
       * Every position that paints TEXT with ink4, not just the two idioms that
       * happened to exist when the rule was written. Each pattern below was probed
       * against the real tree by injecting the shape and confirming the suite went
       * red; the first two were the only ones that ever did.
       */
      const patterns = [
        // The object and prop spellings. `[^,}\n]*?` reaches THROUGH a conditional:
        // `color: bad ? S.ink4 : S.ink` is the dominant idiom in this tree and the
        // anchored `\s*\w+\.ink4` form could not see any of it.
        /(?:color:|tone=\{)[^,}\n]*?\bink4\b/g,
        // Both spellings of the CSS variable. The quote is not optional cosmetics:
        // a plain stylesheet writes `color: var(--text-4);` and an inline React
        // style writes `color: "var(--text-4)"` — and a template literal writes it
        // in backticks, which `["']?` silently skipped.
        /color:\s*["'`]?var\(--text-4\)/g,
        // Tailwind's arbitrary colour, which is live in this tree.
        /text-\[var\(--text-4\)\]/g,
        // SVG text and the WebKit fill property. `<text fill={S.ink4}>` paints a
        // glyph exactly as `color` does; nothing in the old pattern set saw it.
        /(?:fill|WebkitTextFillColor)\s*[:=]\s*\{?[^,}\n]*?\bink4\b/g,
      ];
      for (const pattern of patterns) {
        for (const m of source.matchAll(pattern)) {
          offenders.push(`${path}: ${m[0].trim()}`);
        }
      }
    }
    expect(
      offenders,
      "ink4 measures 2.14:1 on this surface — use it for a border, never for text",
    ).toEqual([]);
  });
});
