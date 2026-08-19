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
 * These assertions are deliberately about the CURRENT committed files, and three
 * of them assert `empty`. When the pipeline next runs for real those will change,
 * and the test is written to say so loudly rather than to silently keep passing:
 * a table with matches played must NOT be `empty`, and that is asserted too.
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

describe("table.json — the all-Champions-League bug", () => {
  const artifact = load(REGISTRY.table);

  it("is empty, because no match has been played", () => {
    expect(artifact.state).toBe("empty");
  });

  it("still carries all 20 rows for rendering", () => {
    expect(proven(artifact)).toHaveLength(20);
  });

  it("refuses to chart, so no zone can be highlighted", () => {
    expect(chartable(artifact, (rows) => rows)).toBeNull();
  });

  /**
   * The emptiness verdict comes from `played`, and from nothing else.
   *
   * This test used to assert `position === 0` on all 20 rows, which was true of
   * the artifact committed at the time. The writer has since run and assigns
   * 1..20 — so the assertion failed while the design it was defending was
   * working perfectly. A test pinned to a snapshot of a file the pipeline
   * rewrites daily reports a regression every time the pipeline succeeds.
   *
   * What is asserted now is the property that must hold in every season state.
   */
  it("is empty on the count of matches played, whatever the positions say", () => {
    const rows = proven(artifact) ?? [];
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.played === 0)).toBe(true);
    expect(artifact.state).toBe("empty");
  });

  /**
   * The trap, no longer hypothetical.
   *
   * When this was written, `position` was 0 everywhere and the tempting fix
   * `position !== 0` correctly rejected the file — which was precisely what made
   * it dangerous: it would have passed review and passed any test written
   * against that fixture.
   *
   * The writer has now run. The committed file carries real positions 1..20 with
   * every counter still zero, so the position gate would today label Arsenal,
   * Aston Villa, Bournemouth and Brentford as Champions League places on a table
   * where nobody has kicked a ball. The prediction came true; the played gate is
   * unmoved.
   */
  it("would today be wrongly accepted by a position gate", () => {
    const rows = proven(artifact) ?? [];

    // No longer a constructed fixture — this is the live file.
    expect(rows.every((r) => r.position !== 0)).toBe(true);   // the gate accepts
    expect(rows.every((r) => r.played === 0)).toBe(true);     // yet nothing is played

    const relabelled = classify({
      path: "table.json", source: "local", raw: rows, now: NOW,
      narrow: REGISTRY.table.narrow,
      isEmpty: REGISTRY.table.isEmpty,
      freshnessBudgetMs: null,
    });
    expect(relabelled.state).toBe("empty");
  });

  it("becomes non-empty the moment one match is played", () => {
    const rows = proven(artifact) ?? [];
    const withOneGame = rows.map((r, i) => (i === 0 ? { ...r, played: 1 } : r));
    const live = classify({
      path: "table.json", source: "local", raw: withOneGame, now: NOW,
      narrow: REGISTRY.table.narrow,
      isEmpty: REGISTRY.table.isEmpty,
      freshnessBudgetMs: null,
    });
    expect(live.state).toBe("ok");
  });
});

describe("health.json — the 4.0.0 producer", () => {
  const artifact = load(REGISTRY.health);

  it("is empty, because nothing has been measured", () => {
    expect(artifact.state).toBe("empty");
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

  it("has no calibration series to chart", () => {
    expect(chartable(artifact, (h) => h.calibration_bins)).toBeNull();
  });

  it("reports zero metrics rather than zero-valued metrics", () => {
    expect(Object.keys(proven(artifact)?.model_metrics ?? {})).toHaveLength(0);
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

  it("is ok on the committed file, because the calls diverge", () => {
    const value = proven(artifact);
    expect(new Set(value?.matches.map((m) => m.model_prediction)).size)
      .toBeGreaterThan(1);
    expect(artifact.state).toBe("ok");
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

describe("latest.json — probabilities real, explainability absent", () => {
  const artifact = load(REGISTRY.latest);

  /**
   * Partial emptiness: a file can be complete on the naive checks — rows
   * present, gameweek non-zero — and still carry nothing to explain a decision
   * with. That is what the explainability predicate exists to catch.
   *
   * These three tests asserted the absence of SHAP and odds, which was true of
   * the artifact committed at the time and is no longer: the 4.1.0 producer
   * emits both on all ten predictions. Testing for the absence meant the suite
   * went red exactly when explainability started working.
   *
   * The predicate is now asserted in both directions instead — stripped data is
   * empty, real data is not — so it is the rule under test rather than the day's
   * file.
   */
  it("is empty when explainability is stripped, whatever else is present", () => {
    const value = proven(artifact);
    expect(value?.predictions.length).toBeGreaterThan(0);
    expect(value?.gameweek).not.toBe(0);

    // Stripped from the RAW file, not from `proven()`. `has_odds_comparison` is
    // derived by the narrower and does not exist in the artifact, so feeding the
    // narrowed shape back in produced `unreadable` rather than `empty` — a fixture
    // that tests the narrower's tolerance for its own output, which is not the
    // question.
    const rawFile = raw("latest.json") as {
      predictions: Array<Record<string, unknown>>;
    };
    const stripped = {
      ...rawFile,
      predictions: rawFile.predictions.map((p) => ({
        ...p, shap_features: [], odds_comparison: undefined,
      })),
    };
    const classified = classify({
      path: "latest.json", source: "local", raw: stripped, now: NOW,
      narrow: REGISTRY.latest.narrow,
      isEmpty: REGISTRY.latest.isEmpty,
      producedAtOf: REGISTRY.latest.producedAtOf,
      freshnessBudgetMs: null,
    });
    expect(classified.state).toBe("empty");
  });

  it("agrees with the file: explainability present means not empty", () => {
    const value = proven(artifact);
    const explained = (value?.predictions ?? []).filter(
      (p) => p.shap_features.length > 0 || p.has_odds_comparison,
    );
    // Whichever way the current artifact falls, the verdict must follow the data
    // rather than a remembered snapshot of it.
    expect(artifact.state === "empty").toBe(explained.length === 0);
  });

  it("still carries informative probabilities that sum to one", () => {
    const value = proven(artifact);
    for (const p of value?.predictions ?? []) {
      expect(p.prob_home + p.prob_draw + p.prob_away).toBeCloseTo(1, 3);
    }
  });

  it("agrees with health.json about which producer wrote this run", () => {
    // Version drift BETWEEN artifacts is the defect worth catching: it means two
    // files a page joins were written by different code. The absolute version is
    // not — pinning "4.0.0" made this fail on the 4.1.0 release.
    expect(describeProducer(artifact.provenance))
      .toBe(describeProducer(load(REGISTRY.health).provenance));
  });

  describe("value bets — the real-money path", () => {
    const bets = (proven(artifact)?.predictions ?? []).flatMap((p) => p.value_bets);

    it("found the five bets in the committed file", () => {
      // Count from the file, not from memory: odds move daily and so does this.
      expect(bets).toHaveLength(
        raw("latest.json").predictions.flatMap(
          (p: { value_bets?: unknown[] }) => p.value_bets ?? [],
        ).length,
      );
    });

    /**
     * The hazard. `half_kelly` in the file is 25.0 — a CURRENCY stake against a
     * hardcoded 1000.0 bankroll. `half_kelly_pct` is 0.025. Both were typed as
     * bare `number` on ValueBet.
     */
    it("resolves every stake to a fraction, never a currency amount", () => {
      for (const bet of bets) {
        expect(bet.halfKelly).not.toBeNull();
        expect(bet.halfKelly!).toBeGreaterThan(0);
        expect(bet.halfKelly!).toBeLessThanOrEqual(1);
      }
    });

    it("resolves to 0.025, not 25.0", () => {
      for (const bet of bets) {
        expect(bet.halfKelly).toBeCloseTo(0.025, 6);
      }
    });

    it("carries no currency-unit stake field at all", () => {
      for (const bet of bets) {
        // A field that does not exist cannot be rendered by mistake. The
        // pipeline's value is a stake against a bankroll this app does not use.
        expect("half_kelly" in bet).toBe(false);
        expect("full_kelly" in bet).toBe(false);
      }
    });

    /**
     * The drift case, and the one the real file cannot exercise.
     *
     * Every bet in the committed artifact HAS `half_kelly_pct`, so the fallback
     * chain never runs and a mutation that reaches for the currency field instead
     * survives every assertion above. A producer that stops emitting the `_pct`
     * fields — exactly the drift that removed `model_metrics` from `health.json` —
     * is what makes the chain load-bearing.
     *
     * Correct behaviour is **null**, not 25.0: no usable stake could be derived,
     * and a caller must render "no stake" rather than a number.
     */
    it("returns no stake when only the currency field survives", () => {
      const withoutPct = {
        metadata: { gameweek: 1 },
        predictions: [{
          match_id: "x",
          fixture: { home_team: "Arsenal", away_team: "Chelsea" },
          probabilities: { "1x2": { home: 0.5, draw: 0.3, away: 0.2 } },
          value_bets: [{
            market: "Home Win",
            // The _pct fields are gone. Only the currency stakes remain.
            half_kelly: 25.0,
            full_kelly: 50.0,
          }],
        }],
      };
      const result = REGISTRY.latest.narrow(withoutPct);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bet = result.value.predictions[0].value_bets[0];
      expect(bet.halfKelly).toBeNull();
      // And emphatically not the currency amount, which would render as 2500%.
      expect(bet.halfKelly).not.toBe(25.0);
      expect(bet.halfKelly).not.toBe(0.025);
    });

    it("derives half from full when only full_kelly_pct survives", () => {
      const onlyFull = {
        metadata: { gameweek: 1 },
        predictions: [{
          match_id: "x",
          fixture: { home_team: "Arsenal", away_team: "Chelsea" },
          probabilities: { "1x2": { home: 0.5, draw: 0.3, away: 0.2 } },
          value_bets: [{ market: "Home Win", full_kelly_pct: 0.05 }],
        }],
      };
      const result = REGISTRY.latest.narrow(onlyFull);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Halved, because under-staking is recoverable and over-staking is not.
      expect(result.value.predictions[0].value_bets[0].halfKelly)
        .toBeCloseTo(0.025, 10);
    });

    it("rejects a _pct field that is itself out of range", () => {
      // A producer bug that puts a currency amount in the _pct field must not
      // become a stake either.
      const corrupt = {
        metadata: { gameweek: 1 },
        predictions: [{
          match_id: "x",
          fixture: { home_team: "Arsenal", away_team: "Chelsea" },
          probabilities: { "1x2": { home: 0.5, draw: 0.3, away: 0.2 } },
          value_bets: [{ market: "Home Win", half_kelly_pct: 25.0 }],
        }],
      };
      const result = REGISTRY.latest.narrow(corrupt);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.predictions[0].value_bets[0].halfKelly).toBeNull();
    });
  });
});

describe("h2h.json — historical, and empty for this season", () => {
  const artifact = load(REGISTRY.h2h);

  it("narrows 241KB of history without dropping records", () => {
    expect(proven(artifact)?.length ?? 0).toBeGreaterThan(0);
  });

  it("is empty because no record carries a 2627 match", () => {
    expect(artifact.state).toBe("empty");
  });

  it("has no freshness budget, so history is never stale", () => {
    expect(artifact.provenance.freshnessBudgetMs).toBeNull();
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

    // Named individually before, which meant a pipeline run that legitimately
    // filled `matches` broke the test. Which artifacts are empty is a property
    // of today's data and will change all season; that SOME are, and that the
    // layer notices, is the claim worth holding.
    expect(empty.length).toBeGreaterThan(0);

    // The table is the durable case: no gameweek has been played, so it must be
    // empty regardless of what the writer put in `position`.
    expect(empty).toContain("table");
  });

  it("no artifact is unreadable", () => {
    const broken = ALL_DESCRIPTORS
      .map((d) => ({ key: d.key, artifact: load(d) }))
      .filter((r) => r.artifact.state === "unreadable")
      .map((r) => `${r.key}: ${r.artifact.reason}`);
    expect(broken).toEqual([]);
  });
});
