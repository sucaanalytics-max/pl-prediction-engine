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
import { REGISTRY, ALL_DESCRIPTORS } from "@/lib/data/narrow";
import type { Descriptor } from "@/lib/data/registry";

const PREDICTIONS = join(__dirname, "..", "..", "..", "predictions");
const NOW = new Date("2026-08-06T12:00:00Z");

function read(path: string): unknown {
  const file = join(PREDICTIONS, path);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
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
   * The live mechanism: `position` is 0 on all 20 rows, so the old gate
   * `if (pos <= 4) return "champions"` is true for every club in the league.
   */
  it("has position 0 on every row, so pos <= 4 held for all 20 clubs", () => {
    const rows = proven(artifact) ?? [];
    expect(rows.every((r) => r.position === 0)).toBe(true);
    expect(rows.filter((r) => r.position <= 4)).toHaveLength(20);
  });

  /**
   * And the reason the tempting alternative gate is a trap rather than a fix.
   *
   * `position !== 0` correctly rejects TODAY's file — which is exactly what makes
   * it dangerous: it would pass review and pass any test written against this
   * fixture. `fpl_api.py:345` assigns 1..20, so the next real run flips it to
   * "ranked" while every counter is still zero.
   */
  it("would be wrongly accepted by a position gate once the writer runs", () => {
    const rows = proven(artifact) ?? [];
    const freshWriter = rows.map((r, i) => ({ ...r, position: i + 1 }));

    // The position gate: passes on today's data, fails here.
    expect(rows.every((r) => r.position !== 0)).toBe(false);        // rejects today
    expect(freshWriter.every((r) => r.position !== 0)).toBe(true);  // accepts tomorrow

    // The played gate is unmoved by the writer change, which is the whole point.
    const relabelled = classify({
      path: "table.json", source: "local", raw: freshWriter, now: NOW,
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
    expect(describeProducer(artifact.provenance)).toBe("4.0.0");
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

  it("is empty, because every fixture predicts home", () => {
    expect(artifact.state).toBe("empty");
    const value = proven(artifact);
    expect(value?.matches.every((m) => m.model_prediction === "home")).toBe(true);
  });

  it("tolerates a null referee without dropping the fixture", () => {
    const value = proven(artifact);
    expect(value?.matches).toHaveLength(10);
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

  it("keeps all 564 rows despite nulls in number-typed fields", () => {
    expect(proven(artifact)).toHaveLength(564);
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

  it("is empty by the explainability predicate", () => {
    // Partial emptiness: the naive checks both pass on this data.
    const value = proven(artifact);
    expect(value?.predictions.length).toBeGreaterThan(0);
    expect(value?.gameweek).not.toBe(0);
    expect(artifact.state).toBe("empty");
  });

  it("has no SHAP features on any prediction", () => {
    const value = proven(artifact);
    expect(value?.predictions.every((p) => p.shap_features.length === 0)).toBe(true);
  });

  it("has no odds comparison on any prediction", () => {
    const value = proven(artifact);
    expect(value?.predictions.every((p) => !p.has_odds_comparison)).toBe(true);
  });

  it("still carries informative probabilities that sum to one", () => {
    const value = proven(artifact);
    for (const p of value?.predictions ?? []) {
      expect(p.prob_home + p.prob_draw + p.prob_away).toBeCloseTo(1, 3);
    }
  });

  it("surfaces the same 4.0.0 drift as health.json", () => {
    expect(describeProducer(artifact.provenance)).toBe("4.0.0");
  });

  describe("value bets — the real-money path", () => {
    const bets = (proven(artifact)?.predictions ?? []).flatMap((p) => p.value_bets);

    it("found the five bets in the committed file", () => {
      expect(bets).toHaveLength(5);
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

describe("the state of the app, stated plainly", () => {
  it("three of six artifacts currently render absence as data", () => {
    const empty = ALL_DESCRIPTORS
      .map((d) => ({ key: d.key, state: load(d).state }))
      .filter((r) => r.state === "empty")
      .map((r) => r.key);
    // table, matches, health, latest and h2h are all `empty` on the committed
    // data. Before this layer existed, every one of them rendered as though it
    // held answers.
    expect(empty).toContain("table");
    expect(empty).toContain("health");
    expect(empty).toContain("matches");
  });

  it("no artifact is unreadable", () => {
    const broken = ALL_DESCRIPTORS
      .map((d) => ({ key: d.key, artifact: load(d) }))
      .filter((r) => r.artifact.state === "unreadable")
      .map((r) => `${r.key}: ${r.artifact.reason}`);
    expect(broken).toEqual([]);
  });
});
