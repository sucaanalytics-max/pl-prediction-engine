/**
 * The narrowers, run against the actual committed artifacts.
 *
 * Every other test in this directory uses hand-built fixtures, which prove the
 * state machine is internally consistent and prove nothing about whether it
 * describes this repo. This one reads `predictions/*.json` off disk.
 *
 * It is the test that would have caught all four original failures, because all
 * four were *correct code applied to real data of an unexpected shape*. A fixture
 * only ever contains what its author already knew.
 *
 * These assertions are deliberately about the CURRENT committed files, and some
 * assert `empty`. When the pipeline next runs for real those will change, and the
 * test is written to say so loudly rather than to silently keep passing.
 *
 * The `table.json`, `latest.json` and `h2h.json` sections are gone with the
 * registry entries they exercised. Those three files were read only by the match
 * and betting screens, and the nav's unrendered value-bet badge; no surface in the
 * app fetches them now, so there is no descriptor left to classify. The files stay
 * in `predictions/` and their narrowers stay exported — restoring the section means
 * restoring the registry entry it loaded.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classify, proven, chartable, describeProducer } from "@/lib/data/artifact";
import { REGISTRY, ALL_DESCRIPTORS, playerStatsRows } from "@/lib/data/narrow";
import type { Descriptor } from "@/lib/data/registry";

const PREDICTIONS = join(__dirname, "..", "..", "..", "predictions");
const NOW = new Date("2026-08-06T12:00:00Z");

function read(path: string): unknown {
  const file = join(PREDICTIONS, path);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The raw file, for asserting relationships rather than remembered sizes.
 *
 * Every count in this file used to be a literal taken from the artifact on the
 * day it was written. `predictions/` is refreshed by the daily pipeline, so
 * those literals rot: `player_stats.json` held 564 rows when this suite was
 * written and 573 by the time CI first ran it, and the failure said nothing
 * about the code. A test that breaks whenever real data arrives teaches people
 * to ignore the suite.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(path: string): any {
  const value = read(path);
  if (value === undefined) throw new Error(`${path} is missing`);
  return value;
}

function load<T>(descriptor: Descriptor<T>) {
  return classify<T>({
    path: descriptor.path,
    source: "local",
    raw: read(descriptor.path),
    narrow: descriptor.narrow,
    producedAtOf: descriptor.producedAtOf,
    producerVersionOf: descriptor.producerVersionOf,
    isEmpty: descriptor.isEmpty,
    freshnessBudgetMs: descriptor.freshnessBudgetMs,
    now: NOW,
  });
}

describe("every registered artifact narrows without being unreadable", () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    it(`${descriptor.key} (${descriptor.path})`, () => {
      const artifact = load(descriptor);
      // `absent` is legitimate — not every artifact is published yet. What must
      // never happen is `unreadable`: that means the narrower and the real file
      // disagree, which is the drift this whole layer exists to surface.
      expect(
        artifact.state,
        `${descriptor.path} failed to narrow: ${artifact.reason}`,
      ).not.toBe("unreadable");
    });
  }
});

describe("health.json — the 4.0.0 producer", () => {
  const artifact = load(REGISTRY.health);

  it("reads as empty or ok, and says which, depending on what has been measured", () => {
    /*
     * This asserted `empty` and broke the morning the pipeline first published
     * metrics — the third time this file has rotted the same way. The version pin
     * broke on a successful release; the matches.json fingerprint broke when the
     * defect it described was fixed; this broke when the producer started working.
     *
     * The invariant is not which state the file is in today. It is that the two
     * states are DISTINGUISHED — a populated file must not read as empty, and an
     * empty one must not read as ok — because conflating them is what makes an
     * absence render as data.
     */
    const metrics = Object.keys(proven(artifact)?.model_metrics ?? {}).length;
    expect(artifact.state).toBe(metrics === 0 ? "empty" : "ok");
  });

  it("names the producer that emitted no metrics", () => {
    // The whole point: the file is complete and fresh FOR ITS VERSION, so only
    // the version reveals why the metrics are missing.
    //
    // The version itself is NOT asserted. It was pinned to "4.0.0" and the
    // producer moved to 4.1.0, so the test failed on a successful release — the
    // same rot as the table snapshot above. What has to hold is that the
    // provenance names *a* producer, because an unattributed empty file is
    // indistinguishable from a broken one.
    const producer = describeProducer(artifact.provenance);
    expect(producer).toBeTruthy();
    expect(producer).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("offers a calibration series only when there is one", () => {
    const bins = proven(artifact)?.calibration_bins;
    const series = chartable(artifact, (h) => h.calibration_bins);
    // `chartable` must refuse an absent series and pass a present one. Asserting
    // it is always null was asserting that the producer never works.
    if (!bins || bins.length === 0) expect(series).toBeNull();
    else expect(series).not.toBeNull();
  });

  it("never reports a metric it did not measure", () => {
    // The original claim, kept: a zero-VALUED metric is a measurement of zero and
    // a missing one is no measurement, and the file must not turn the second into
    // the first. Whatever keys exist must carry a real number.
    for (const [name, value] of Object.entries(proven(artifact)?.model_metrics ?? {})) {
      expect(Number.isFinite(value as number), `${name} is not a number`).toBe(true);
    }
  });
});

describe("matches.json — the flat-prior fingerprint", () => {
  const artifact = load(REGISTRY.matches);

  /**
   * The flat-prior fingerprint: if every fixture calls the same way, the model
   * has told you nothing and the file must not read as answers.
   *
   * The committed artifact no longer shows it — the calls now diverge, which is
   * the model working. So the fingerprint is asserted against a constructed
   * all-home file, and the real artifact is checked for the complementary
   * property. Asserting the defect against live data made this fail the moment
   * the defect was fixed.
   */
  it("treats an all-one-way call sheet as empty", () => {
    const value = proven(artifact);
    const flat = {
      ...value,
      matches: (value?.matches ?? []).map((m) => ({ ...m, model_prediction: "home" })),
    };
    const classified = classify({
      path: "matches.json", source: "local", raw: flat, now: NOW,
      narrow: REGISTRY.matches.narrow,
      isEmpty: REGISTRY.matches.isEmpty,
      producedAtOf: REGISTRY.matches.producedAtOf,
      freshnessBudgetMs: null,
    });
    expect(classified.state).toBe("empty");
  });

  it("classifies the committed file by the rule, whichever way it currently falls", () => {
    /**
     * This asserted the live file had diverse calls and was therefore `ok`. The
     * committed artifact is now four fixtures all called `home`, so the fingerprint
     * fires — CORRECTLY, which is the whole point of it. Asserting the live file's
     * diversity pinned today's fixture list, the same trap as asserting the defect
     * against live data, just from the other side.
     *
     * The rule itself is covered by the constructed cases either side of this one.
     * What is worth checking against real data is only that the two agree.
     */
    const value = proven(artifact);
    const distinct = new Set(value?.matches.map((m) => m.model_prediction)).size;
    expect(artifact.state).toBe(distinct > 1 ? "ok" : "empty");
  });

  it("tolerates a null referee without dropping the fixture", () => {
    const value = proven(artifact);
    expect(value?.matches).toHaveLength(raw("matches.json").matches.length);
    // Null on some, a string on others; both are legal.
    expect(value?.matches.some((m) => m.referee === null)).toBe(true);
  });

  it("becomes ok once the calls diverge", () => {
    const value = proven(artifact);
    const mixed = {
      ...value,
      matches: (value?.matches ?? []).map((m, i) =>
        i === 0 ? { ...m, model_prediction: "away" } : m,
      ),
    };
    const live = classify({
      path: "matches.json", source: "local", raw: mixed, now: NOW,
      narrow: REGISTRY.matches.narrow,
      isEmpty: REGISTRY.matches.isEmpty,
      producedAtOf: REGISTRY.matches.producedAtOf,
      freshnessBudgetMs: null,
    });
    expect(live.state).toBe("ok");
  });
});

describe("player_stats.json — real data, so NOT empty", () => {
  const artifact = load(REGISTRY.playerStats);

  it("is not empty: most rows have real minutes", () => {
    expect(artifact.state).not.toBe("empty");
    const rows = proven(artifact) ?? [];
    expect(rows.filter((r) => r.minutes > 0).length).toBeGreaterThan(100);
  });

  it("drops no row despite nulls in number-typed fields", () => {
    // Against the RAW count, never a hardcoded one. This file is refreshed by
    // the daily pipeline: it held 564 rows when this test was written and 573
    // a week later, and CI failed on the number rather than on anything real.
    // The property that matters is that narrowing loses nothing.
    //
    // Through `playerStatsRows` rather than `.length` directly. Reading the raw
    // value's own length assumed a bare array, which was true until the producer
    // started writing a `{generated_at, players}` envelope — at which point the
    // expected length became `undefined` and the assertion compared 592 against
    // nothing. The narrower already knows where the rows are; ask it.
    const rows = playerStatsRows(raw("player_stats.json")) as unknown[];
    expect(rows.length).toBeGreaterThan(100);
    expect(proven(artifact)).toHaveLength(rows.length);
  });

  it("preserves fouls_committed as null rather than coercing 564 rows to zero", () => {
    const rows = proven(artifact) ?? [];
    // Null on every row in the committed file. Coercing to 0 would report
    // "committed no fouls" for a stat the provider never supplied.
    expect(rows.every((r) => r.fouls_committed === null)).toBe(true);
    expect(rows.every((r) => r.fouls_committed !== 0)).toBe(true);
  });

  it("preserves a partially-null field per row", () => {
    const rows = proven(artifact) ?? [];
    const missing = rows.filter((r) => r.fpl_ownership === null).length;
    expect(missing).toBeGreaterThan(0);
    expect(missing).toBeLessThan(rows.length);
  });

  it("flags which rows may show per-90 rates", () => {
    const rows = proven(artifact) ?? [];
    // xg_per_90 = xg / max(minutes/90, 0.1), so a 0-minute player reads xg * 10.
    expect(rows.every((r) => r.ratesAreMeaningful === (r.minutes >= 90))).toBe(true);
    expect(rows.some((r) => !r.ratesAreMeaningful)).toBe(true);
  });
});

/**
 * fixture_xg.json — the artifact that was silently unreadable.
 *
 * It had no dedicated tests, which is how the drift survived: the narrower read
 * `home_rate ?? home_xg` and no producer has ever emitted either name, so all 80
 * fixtures were dropped as malformed and the page rendered nothing. The generic
 * "no artifact is unreadable" sweep was the only thing that noticed, and it
 * reported one line among ten other failures.
 */
describe("fixture_xg.json — the rates the page shows", () => {
  const artifact = load(REGISTRY.fixtureXg);

  it("narrows without dropping a single fixture", () => {
    expect(artifact.state).not.toBe("unreadable");
    expect(proven(artifact)?.fixtures).toHaveLength(
      (raw("fixture_xg.json") as { fixtures: unknown[] }).fixtures.length,
    );
  });

  it("uses lambda_home / mu_away — the rate the schema says consumers use", () => {
    const first = (raw("fixture_xg.json") as {
      fixtures: Array<Record<string, number>>;
    }).fixtures[0];
    const narrowed = proven(artifact)?.fixtures[0];
    expect(narrowed?.home_rate).toBeCloseTo(first.lambda_home, 6);
    expect(narrowed?.away_rate).toBeCloseTo(first.mu_away, 6);
  });

  it("does NOT show the pre-market-anchor posterior", () => {
    // `lambda_home_dc` is kept so the blend stays auditable, and on the committed
    // file it differs from the consumer rate by ~27%. Showing it would be a
    // visibly wrong number rather than a rounding difference — and the two names
    // are one underscore apart.
    const first = (raw("fixture_xg.json") as {
      fixtures: Array<Record<string, number>>;
    }).fixtures[0];
    const narrowed = proven(artifact)?.fixtures[0];
    expect(first.lambda_home_dc).not.toBeCloseTo(first.lambda_home, 2);
    expect(narrowed?.home_rate).not.toBeCloseTo(first.lambda_home_dc, 6);
  });

  it("carries a positive rate for both sides of every fixture", () => {
    const fixtures = proven(artifact)?.fixtures ?? [];
    expect(fixtures.every((f) => f.home_rate > 0 && f.away_rate > 0)).toBe(true);
  });
});

describe("the state of the app, stated plainly", () => {
  it("still finds artifacts that would have rendered absence as data", () => {
    const empty = ALL_DESCRIPTORS
      .map((d) => ({ key: d.key, state: load(d).state }))
      .filter((r) => r.state === "empty")
      .map((r) => r.key);

    /*
     * This required at least one empty artifact, and broke the morning the last
     * one filled — the same rot as the health.json state above, one level up. Its
     * own comment already said which artifacts are empty "will change all season";
     * so does whether ANY are.
     *
     * What must hold is that the layer can still tell the difference, which is a
     * property of the classifier rather than of today's data. So the mechanism is
     * asserted directly and the live count is only reported.
     */
    const descriptor = REGISTRY.decisionReview;
    const emptyByConstruction = classify({
      path: descriptor.path,
      source: "local",
      raw: {
        generated_at: new Date().toISOString(),
        observations: 0,
        minimum_observations: 6,
        aggregate: null,
        gameweeks: [],
      },
      narrow: descriptor.narrow,
      producedAtOf: descriptor.producedAtOf,
      isEmpty: descriptor.isEmpty,
      now: new Date(),
    });
    expect(emptyByConstruction.state, `live empties: ${empty.join(", ") || "none"}`)
      .toBe("empty");
  });

  it("no artifact is unreadable", () => {
    const broken = ALL_DESCRIPTORS
      .map((d) => ({ key: d.key, artifact: load(d) }))
      .filter((r) => r.artifact.state === "unreadable")
      .map((r) => `${r.key}: ${r.artifact.reason}`);
    expect(broken).toEqual([]);
  });
});
