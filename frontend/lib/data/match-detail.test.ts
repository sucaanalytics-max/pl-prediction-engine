/**
 * Narrowing one fixture in full.
 *
 * This narrower exists because `/matches/[id]` used `usePredictions()`, which
 * cast `res.json()` to `PredictionData` and then read about thirty fields off
 * it. Nothing checked any of them. Removing the cast turned up **60 type
 * errors** on that page — every one a field the page dereferenced that the data
 * is allowed not to have, including `expected_goals`, `confidence.entropy` and
 * every clean-sheet and BTTS probability.
 *
 * The tests below pin the distinctions that were invisible under the cast:
 *
 * * **A missing number is a dash, never a zero.** `expected_goals: null`
 *   rendered as `0.0 — 0.0` reads as a predicted goalless draw.
 * * **Pair-valued markets are not scalar ones.** `over_under`, `corners` and
 *   `cards` are `{over, under}`; `correct_score`, `asian_handicap` and `ht_ft`
 *   are plain numbers. Treating all six alike silently empties three of them.
 * * **A distribution with a hole is no distribution.** A chart draws a missing
 *   bucket as a dip to zero, which is a claim the simulation never made.
 */
import { describe, expect, it } from "vitest";
import {
  findMatchDetail, matchDetailDescriptor, narrowMatchDetail,
} from "@/lib/data/match-detail";
import { classify, proven } from "@/lib/data/artifact";

function prediction(over: Record<string, unknown> = {}) {
  return {
    match_id: "ars-che",
    fixture: {
      home_team: "Arsenal", away_team: "Chelsea",
      date: "2026-08-21T19:00:00Z", gameweek: 1,
      referee: null, is_derby: false,
    },
    probabilities: {
      "1x2": { home: 0.52, draw: 0.24, away: 0.24 },
      over_under: { "2.5": { over: 0.58, under: 0.42 } },
      btts: { yes: 0.498, no: 0.502 },
      clean_sheet: { home: 0.3336, away: 0.21 },
      correct_score: { "0-0": 0.0908, "1-0": 0.11 },
      asian_handicap: { "home_-2.5": 0.9686, "away_-0.5": 0.4 },
      ht_ft: { "H/H": 0.1392 },
      corners: { "9.5": { over: 0.51, under: 0.49 } },
      cards: { "3.5": { over: 0.44, under: 0.56 } },
    },
    expected_goals: { home: 1.3766, away: 1.1056 },
    expected_corners: 10.2,
    expected_cards: 3.6,
    n_simulations: 2000,
    model_disagreement: 0.08,
    narrative: "Arsenal edge it.",
    confidence: { entropy: 1.02, home_goals_ci: [0, 3], away_goals_ci: [0, 3] },
    distributions: { goals_home: [0.2, 0.3, 0.3], goals_away: [0.3, 0.4] },
    value_bets: [{ market: "Over 2.5 Goals", edge: 0.056, half_kelly_pct: 0.025 }],
    // The real shape `pipeline/explainability/shap_explain.py:83-88` emits: an
    // input `value`, a `shap_value` contribution and `shap_abs`. The previous
    // fixture had only `value`, so it tested a shape the pipeline never writes —
    // which is why it could not catch the contribution being discarded.
    shap_features: [
      { feature: "elo_diff", value: 133.14, shap_value: -0.0035, shap_abs: 0.0035 },
      { feature: "away_ewm_shots_for_5", value: 0.0, shap_value: -0.077, shap_abs: 0.077 },
    ],
    goalscorer: {
      home_scorers: [
        { web_name: "Gyökeres", position: "FWD", anytime_prob: 0.237, xg_per_90: 0.49 },
      ],
      away_scorers: [],
      match_xg: { home: 1.38, away: 1.11 },
    },
    player_bookings: {
      top_bookings: [
        { web_name: "Mosquera", team: "Arsenal", adjusted_prob: 0.396 },
      ],
    },
    odds_comparison: null,
    ...over,
  };
}

function ok(raw: unknown) {
  const result = narrowMatchDetail(raw);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.value;
}

describe("the fields the page branches on are required", () => {
  it("narrows a complete prediction", () => {
    const m = ok(prediction());
    expect(m.home_team).toBe("Arsenal");
    expect(m.prob_home).toBeCloseTo(0.52);
    expect(m.gameweek).toBe(1);
  });

  it("refuses a prediction with no fixture", () => {
    const raw = prediction();
    delete (raw as Record<string, unknown>).fixture;
    expect(narrowMatchDetail(raw).ok).toBe(false);
  });

  it("refuses one with no team names", () => {
    expect(narrowMatchDetail(prediction({
      fixture: { date: "x", gameweek: 1 },
    })).ok).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(narrowMatchDetail("nope").ok).toBe(false);
    expect(narrowMatchDetail(null).ok).toBe(false);
  });
});

describe("missing numbers stay missing", () => {
  it("expected_goals is null, not a 0-0 forecast", () => {
    const m = ok(prediction({ expected_goals: null }));
    expect(m.expected_goals).toBeNull();
  });

  it("half an expected scoreline is no scoreline", () => {
    // Rendering "1.4 — 0.0" would read as a predicted shut-out.
    const m = ok(prediction({ expected_goals: { home: 1.4 } }));
    expect(m.expected_goals).toBeNull();
  });

  it("entropy and the intervals degrade independently", () => {
    const m = ok(prediction({ confidence: { home_goals_ci: [0, 3] } }));
    expect(m.confidence.entropy).toBeNull();
    expect(m.confidence.home_goals_ci).toEqual([0, 3]);
    expect(m.confidence.away_goals_ci).toEqual([]);
  });

  it("clean sheet and BTTS are nullable per side", () => {
    const m = ok(prediction({
      probabilities: { "1x2": { home: 0.5, draw: 0.3, away: 0.2 }, btts: { yes: 0.5 } },
    }));
    expect(m.markets.btts.yes).toBeCloseTo(0.5);
    expect(m.markets.btts.no).toBeNull();
    expect(m.markets.clean_sheet.home).toBeNull();
  });
});

describe("pair-valued markets are distinguished from scalar ones", () => {
  it("keeps over/under pairs", () => {
    const m = ok(prediction());
    expect(m.markets.over_under["2.5"]).toEqual({ over: 0.58, under: 0.42 });
    expect(m.markets.corners["9.5"].over).toBeCloseTo(0.51);
  });

  it("keeps scalar maps as numbers", () => {
    const m = ok(prediction());
    expect(m.markets.correct_score["0-0"]).toBeCloseTo(0.0908);
    expect(m.markets.asian_handicap["home_-2.5"]).toBeCloseTo(0.9686);
  });

  it("drops a half-priced line rather than inviting the complement", () => {
    const m = ok(prediction({
      probabilities: {
        "1x2": { home: 0.5, draw: 0.3, away: 0.2 },
        over_under: { "2.5": { over: 0.58 } },
      },
    }));
    expect(m.markets.over_under["2.5"]).toBeUndefined();
  });

  it("drops a non-numeric probability rather than parsing it", () => {
    const m = ok(prediction({
      probabilities: {
        "1x2": { home: 0.5, draw: 0.3, away: 0.2 },
        correct_score: { "0-0": "0.09" },
      },
    }));
    expect(m.markets.correct_score["0-0"]).toBeUndefined();
  });
});

describe("distributions are all-or-nothing", () => {
  it("keeps a clean series", () => {
    expect(ok(prediction()).distributions.goals_home).toEqual([0.2, 0.3, 0.3]);
  });

  it("empties a series with a hole rather than charting a dip to zero", () => {
    const m = ok(prediction({
      distributions: { goals_home: [0.2, null, 0.3] },
    }));
    expect(m.distributions.goals_home).toEqual([]);
  });

  it("accepts either spelling the writer has used", () => {
    const m = ok(prediction({
      distributions: { total_corners: [0.1, 0.2], total_cards: [0.3] },
    }));
    expect(m.distributions.corners).toEqual([0.1, 0.2]);
    expect(m.distributions.cards).toEqual([0.3]);
  });
});

describe("scorers, bookings and prices", () => {
  it("narrows scorers", () => {
    const m = ok(prediction());
    expect(m.goalscorers.home[0].web_name).toBe("Gyökeres");
    expect(m.goalscorers.match_xg?.home).toBeCloseTo(1.38);
  });

  it("drops a scorer with no probability", () => {
    const m = ok(prediction({
      goalscorer: { home_scorers: [{ web_name: "Ghost" }], away_scorers: [] },
    }));
    expect(m.goalscorers.home).toEqual([]);
  });

  it("narrows bookings", () => {
    expect(ok(prediction()).bookings[0].team).toBe("Arsenal");
  });

  it("reports absent odds as null, not as an empty book list", () => {
    // Null on 10 of 10 committed predictions: the live-odds stage has never
    // run. An empty map would claim no bookmaker priced the match.
    expect(ok(prediction()).h2hOdds).toBeNull();
  });

  it("keeps a fully priced book and drops a partly priced one", () => {
    const m = ok(prediction({
      odds_comparison: {
        h2h: {
          bet365: { home: 2.1, draw: 3.4, away: 3.8 },
          pinnacle: { home: 2.05, draw: 3.5 },
          // Not a price: inverting 1.0 yields a certainty.
          broken: { home: 1.0, draw: 3.4, away: 3.8 },
        },
      },
    }));
    expect(Object.keys(m.h2hOdds ?? {})).toEqual(["bet365"]);
  });

  it("routes bets through the shared Kelly-safe narrower", () => {
    const m = ok(prediction());
    expect(m.value_bets).toHaveLength(1);
    // The pipeline writes `half_kelly_pct: 0.025` — a fraction, despite the
    // `_pct` name — alongside `half_kelly: 25.0`, which is £25 of a £1,000
    // bank. Reading the wrong one is a 1000x staking error.
    expect(m.value_bets[0].halfKelly).toBeCloseTo(0.025);
  });

  it("refuses a stake outside [0, 1] rather than sizing off it", () => {
    // A currency amount landing in the fraction field. Accepting 25.0 would
    // stake 2,500% of bankroll; null means the page prints "no stake".
    const m = ok(prediction({
      value_bets: [{ market: "Over 2.5 Goals", edge: 0.05, half_kelly_pct: 25.0 }],
    }));
    expect(m.value_bets[0].halfKelly).toBeNull();
  });
});

describe("the descriptor", () => {
  const file = { predictions: [prediction()] };
  const now = new Date("2026-08-21T10:00:00Z");

  const build = (raw: unknown, id: string) => {
    const d = matchDetailDescriptor(id);
    return classify({
      path: d.path, source: "local", raw, narrow: d.narrow,
      isEmpty: d.isEmpty, now,
    });
  };

  it("reads latest.json, not a per-match file", () => {
    expect(matchDetailDescriptor("ars-che").path).toBe("latest.json");
  });

  it("finds the fixture", () => {
    const artifact = build(file, "ars-che");
    expect(artifact.state).toBe("ok");
    expect(proven(artifact)?.away_team).toBe("Chelsea");
  });

  it("an unknown id is empty, not unreadable", () => {
    // The file parsed and is well-formed; it simply says nothing about this
    // fixture. That is a different card from "the file is broken".
    expect(build(file, "nope-nope").state).toBe("empty");
  });

  it("a broken file is unreadable, not 'no such match'", () => {
    // These used to collapse together, so a file whose `predictions` was not a
    // list reported "no such fixture" and sent the reader hunting for an id
    // that was never the problem.
    const artifact = build({ predictions: "not a list" }, "ars-che");
    expect(artifact.state).toBe("unreadable");
    expect(artifact.reason).toContain("predictions is not an array");
  });

  it("no file at all is absent", () => {
    expect(build(undefined, "ars-che").state).toBe("absent");
  });

  it("falls back to team names when the writer omits match_id", () => {
    const raw = prediction();
    delete (raw as Record<string, unknown>).match_id;
    expect(findMatchDetail({ predictions: [raw] }, "Arsenal-Chelsea")).not.toBeNull();
  });
});
