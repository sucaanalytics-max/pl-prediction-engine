/**
 * A narrower must not read a field name no writer emits.
 *
 * ## The class of bug
 *
 * There is no runtime coupling between the Python pipeline and this app; the only
 * contract is the shape of the JSON. `pipeline/tests/test_fixture_xg_contract.py`
 * is 616 lines and enforces that contract thoroughly — **in one direction**. It
 * checks that the writer emits a valid artifact. Nothing checked that the reader
 * reads the names the writer actually wrote.
 *
 * Two failures live in that gap, and they differ in how loudly they fail:
 *
 *  * A **required** field under the wrong name makes the artifact `unreadable`, and
 *    `real-artifacts.test.ts` catches it. That is how `narrowFixtureXg` reading
 *    `home_rate ?? home_xg` — neither of which any producer has ever emitted — was
 *    eventually found, after the page had been rendering nothing.
 *  * An **optional** field under the wrong name is silent forever. It narrows to
 *    null, the artifact stays `ok`, and a page shows a zero or a dash where a real
 *    value belongs. Nothing anywhere notices.
 *
 * The second is what this test exists for. It found `goals: countOr0(row.goals)`
 * while the writer emits `goals_scored`: 226 of 577 players had scored, and
 * `/players` rendered 0 for every one of them in a table cell. `xg` and `xa` on the
 * adjacent lines already had the fallback, so nothing looked inconsistent.
 *
 * It also found `fixture_xg.json` carrying no `generated_at`, so `producedAtOf`
 * returned null and that artifact could never be reported as stale — on the file
 * that feeds every clean-sheet and goal probability the optimiser ranks on.
 *
 * ## Why it reads the source text
 *
 * Because the question is about names, and names only exist in the source. Running
 * the narrowers would answer "did it produce a value", which is precisely what an
 * optional field hides.
 *
 * ## The escape hatch, and why it is narrow
 *
 * A read of an absent name is legitimate when it is a documented fallback for a
 * producer that may still be emitting an older shape, or a field known to be
 * legally absent. Those go in `ALLOWED` with a reason. Anything else fails, so
 * adding one is a deliberate act with a note attached rather than a silent
 * accumulation.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "lib", "data");

/**
 * Every loader file, not just narrow.ts.
 *
 * The first version scanned `narrow.ts` alone and reported green — while four
 * descriptors lived in their own files (`accuracy.ts`, `agent-status.ts`,
 * `match-detail.ts`, `news-feed.ts`) and went unchecked. A guard that silently
 * covers a subset is worse than none: the green tick reads as "audited".
 */
function loaderSources(): { file: string; text: string }[] {
  return readdirSync(DATA_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ file: name, text: readFileSync(join(DATA_DIR, name), "utf8") }));
}
const PREDICTIONS = join(process.cwd(), "public", "predictions");
const PIPELINE = join(process.cwd(), "..", "pipeline");

/**
 * Every quoted string the Python side uses as a dict key, gathered once.
 *
 * The committed artifact is a SNAPSHOT; the writer is the contract. Checking only
 * the snapshot made this test fail on a field that had just been added to the
 * producer and would appear on the next pipeline run — a red test whose fix is to
 * wait, which is the kind that gets ignored.
 *
 * A field is therefore legitimate if the artifact has it OR a producer writes it.
 * Coarse on purpose: this is a spell-check against the Python source, not a schema.
 */
function pipelineEmittedKeys(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name === "tests") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".py")) continue;
      // Three forms, because Python writes dict keys all three ways and missing any
      // of them produces a FALSE POSITIVE. The first version matched only the
      // literal form and required three characters, so it reported `n` and
      // `bias_radius` as unwritten when accuracy.py writes both.
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/["']([a-z_][a-z0-9_]{0,40})["']\s*:/g)) out.add(m[1]);
      for (const m of text.matchAll(/\[["']([a-z_][a-z0-9_]{0,40})["']\]/g)) out.add(m[1]);
      for (const m of text.matchAll(/\.get\(["']([a-z_][a-z0-9_]{0,40})["']/g)) out.add(m[1]);
    }
  };
  try { walk(PIPELINE); } catch { /* no pipeline dir in some checkouts */ }
  return out;
}

/**
 * Reads of absent names that are correct.
 *
 * Keyed `artifactKey:field`. Every entry needs a reason, because an unexplained
 * exemption is how this test would rot into decoration.
 */
const ALLOWED: Record<string, string> = {
  // Documented at narrow.ts:23 — absent on all 20 rows, legal by the interface, and
  // never rendered. The optional read is the honest way to express that.
  "table:logo_url": "legitimately absent; documented and unrendered",

  // Deliberate fallbacks kept after the lambda_home/mu_away fix, so an older
  // artifact still on disk narrows rather than going unreadable.
  "fixtureXg:home_rate": "legacy fallback behind lambda_home",
  "fixtureXg:home_xg": "legacy fallback behind lambda_home",
  "fixtureXg:away_rate": "legacy fallback behind mu_away",
  "fixtureXg:away_xg": "legacy fallback behind mu_away",
  "fixtureXg:rows": "legacy fallback behind `fixtures`",
  "fixtureXg:current_gameweek": "not emitted; the artifact carries first_gameweek",

  // The interquartile pair, wired end to end and waiting on a producer that
  // does not compute it. `simulate_gameweek` produces q10/q50/q90/q99 per player
  // — the private `xp_gw01.json` carries exactly those — and `public_xp.CARRIED`
  // passes q10/q50/q90 through. Nothing anywhere computes q25 or q75.
  //
  // The reads stay because the path is complete on this side: four components
  // thread them into the distribution glyph, and `lib/margin/distribution.ts`
  // declines to draw the box rather than deriving it from the standard
  // deviation, which is what the design did and what this repo refuses to do.
  // Adding the two quantiles to the simulation summary and to CARRIED makes the
  // box appear with no frontend change.
  "projections:q25": "no producer computes it; the glyph omits the box rather than deriving it",
  "projections:q75": "no producer computes it; the glyph omits the box rather than deriving it",

  // Fallback behind goals_scored, kept for the same reason.
  "playerStats:goals": "legacy fallback behind goals_scored",
  "playerStats:xg": "first choice, with expected_goals as the working fallback",
  "playerStats:xa": "first choice, with expected_assists as the working fallback",
};

/**
 * Parse an artifact, handling `.jsonl`.
 *
 * A `.jsonl` file is one JSON value per line and an EMPTY one is legitimate —
 * `deltas.jsonl` is 0 bytes until a decision flips. `JSON.parse("")` throws, which
 * made this test fail on a file that was correct.
 */
function parseArtifact(file: string): unknown {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".jsonl")) return text.trim() ? JSON.parse(text) : null;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Every key appearing anywhere in the artifact, to a bounded depth. */
function keysDeep(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4 || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    // A sample is enough: rows are homogeneous, and scanning 600 players to learn
    // the same 21 key names is wasted work.
    for (const item of value.slice(0, 40)) keysDeep(item, out, depth + 1);
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    keysDeep(nested, out, depth + 1);
  }
  return out;
}

interface Narrower {
  readonly fn: string;
  readonly body: string;
  readonly key: string;
  readonly path: string;
}

function narrowers(): Narrower[] {
  const sources = loaderSources();
  const source = sources.map((entry) => entry.text).join("\n");

  // Non-exported helpers included: that is where most field reads live, and a
  // planted typo in `accuracy.ts` (whose reads are all in a helper) went undetected
  // while the suite reported green.
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(
    /(?:export\s+)?function (narrow[A-Za-z0-9_]+)\(([\s\S]*?)\n}/g,
  )) {
    bodies.set(match[1], match[2]);
  }

  const out: Narrower[] = [];
  for (const match of source.matchAll(
    /key:\s*"([A-Za-z0-9_]+)"[\s\S]{0,400}?path:\s*"([^"]+)"[\s\S]{0,600}?narrow:\s*(narrow[A-Za-z0-9_]+)/g,
  )) {
    const [, key, path, fn] = match;
    if (out.some((n) => n.key === key)) continue;

    // Follow the call graph. A narrower delegates row-level reads to helpers, so a
    // check that stops at the entry point audits almost nothing.
    const seen = new Set<string>();
    const collect = (name: string, depth = 0): string => {
      if (depth > 6 || seen.has(name)) return "";
      seen.add(name);
      const inner = bodies.get(name);
      if (!inner) return "";
      const called = [...inner.matchAll(/\b(narrow[A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
      return [inner, ...called.map((c) => collect(c, depth + 1))].join("\n");
    };

    const body = collect(fn);
    if (body) out.push({ fn, body, key, path });
  }

  /**
   * The descriptors built by a function, which the regex above cannot see.
   *
   * Discovery requires `key: "..."` and `path: "..."` as double-quoted string
   * literals. All four factories interpolate the gameweek, entry or fixture into
   * a template literal, so none of them matched and this guard ran over 15 of 19
   * narrowers — missing the two largest FPL artifacts entirely, which is where
   * the phantom reads turned out to be.
   *
   * Listed explicitly and instantiated at a fixed gameweek, exactly as
   * `paths.test.ts` handles the same blind spot for the same four descriptors.
   * The path matters only for reading the artifact off disk; any gameweek with a
   * committed file will do.
   */
  for (const { fn, key, path } of [
    { fn: "narrowProjections", key: "projections", path: "fpl/xp_public_gw01.json" },
    { fn: "narrowPublicDecision", key: "decisionPublic",
      path: "fpl/decision_public_gw01_season.json" },
    { fn: "narrowSensitivity", key: "sensitivity",
      path: "fpl/sensitivity_gw01_season.json" },
    { fn: "narrowMatchDetail", key: "matchDetail", path: "match_detail.json" },
  ]) {
    if (out.some((n) => n.key === key)) continue;
    const seen = new Set<string>();
    const collect = (name: string, depth = 0): string => {
      if (depth > 6 || seen.has(name)) return "";
      seen.add(name);
      const inner = bodies.get(name);
      if (!inner) return "";
      const called = [...inner.matchAll(/\b(narrow[A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
      return [inner, ...called.map((c) => collect(c, depth + 1))].join("\n");
    };
    const body = collect(fn);
    if (body) out.push({ fn, body, key, path });
  }

  return out;
}

/**
 * Field names the narrower reads off a record.
 *
 * Method calls are excluded by the negative lookahead on `(`. `narrowDeltas` calls
 * `raw.split("\n")` on a JSONL string, and reading that as a field name reported
 * `split` as missing from the artifact — a false positive, and the kind that gets a
 * useful test deleted.
 */
function fieldsRead(body: string): string[] {
  return [
    ...new Set(
      [
        ...body.matchAll(
          /\b(?:file|row|raw|item|entry|obj|metadata|decision|plan|source|payload)\.([a-z_][a-z0-9_]*)\b(?!\s*\()/g,
        ),
      ].map((m) => m[1]),
    ),
  ];
}

describe("no narrower reads a field the writer never emits", () => {
  const all = narrowers();
  const emitted = pipelineEmittedKeys();

  it("found narrowers to check at all", () => {
    // Without this the regex silently matching nothing would make every assertion
    // below vacuously true — the failure mode that makes a guard worthless.
    expect(all.length).toBeGreaterThan(5);
  });

  for (const narrower of all) {
    const file = join(PREDICTIONS, narrower.path);

    it(`${narrower.key} (${narrower.path})`, () => {
      /**
       * An absent artifact is not unauditable.
       *
       * Skipping when the file was missing silently exempted every agent-written
       * artifact — `accuracy.json`, `messages.json`, `evidence_view.json` are absent
       * for the ten days before a deadline, and `evidence_view.json` has never been
       * published at all. Those are exactly the narrowers nothing has ever checked.
       * The Python source still says what the producer writes.
       */
      {
        const present = existsSync(file)
          ? keysDeep(parseArtifact(file))
          : new Set<string>();
        const dead = fieldsRead(narrower.body)
          .filter((field) => !present.has(field))
          // A producer writes it, so it will be in the next artifact.
          .filter((field) => !emitted.has(field))
          .filter((field) => !(`${narrower.key}:${field}` in ALLOWED));

        expect(
          dead,
          `${narrower.fn} reads ${dead.join(", ")}, which ${narrower.path} does not ` +
            `contain. Either the writer's name changed, or the read is a typo that ` +
            `narrows to null forever. If the read is a deliberate fallback, add it ` +
            `to ALLOWED with a reason.`,
        ).toEqual([]);
      }
    });
  }
});

describe("the exemptions stay honest", () => {
  it("every allowance carries a reason", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("no allowance is stale", () => {
    /**
     * An exemption for a field the narrower no longer reads is a note about
     * nothing, and it makes the list harder to trust the next time someone adds to
     * it.
     */
    const source = loaderSources().map((entry) => entry.text).join("\n");
    const unused = Object.keys(ALLOWED).filter((entry) => {
      const field = entry.split(":")[1];
      return !new RegExp(`\\.${field}\\b`).test(source);
    });
    expect(unused, "these allowances name fields nothing reads").toEqual([]);
  });
});
