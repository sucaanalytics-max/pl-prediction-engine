/**
 * Narrowing `/api/fpl/state` into the heuristic view.
 *
 * Two properties carry the weight, and both are about what happens when the
 * shape is wrong rather than when it is right:
 *
 * * **A malformed row is dropped and counted, not swallowed.** The old context
 *   cast the whole response, so a changed field became a blank page. Dropping
 *   silently would be the same lie in a quieter voice — hence `droppedRows`.
 * * **A missing top-level block fails the narrow.** `recommendations` and
 *   `rankings` are what every section reads; tolerating their absence would
 *   render empty tables that look like "no good transfers this week".
 */
import { describe, expect, it } from "vitest";
import { proven } from "@/lib/data/artifact";
import { classify } from "@/lib/data/artifact";
import {
  heuristicsAreEmpty, narrowHeuristics, type HeuristicView,
} from "@/lib/data/heuristics";

const NOW = new Date("2026-08-07T12:00:00Z");

/** Every declared category, all empty — the pre-season shape. */
const EMPTY_RANKINGS = {
  overall: [], captaincy: [], value: [], differentials: [],
  goalkeepers: [], defenders: [], midfielders: [], forwards: [],
};

function player(over: Record<string, unknown> = {}) {
  return {
    elementId: 427,
    name: "Salah",
    team: "LIV",
    position: "MID",
    price: 14.5,
    ownership: 42.1,
    status: "a",
    news: "",
    expectedMinutes: 88,
    projected4: 24.2,
    projected6: 35.8,
    captainScore: 9.1,
    valueScore: 1.67,
    differentialScore: 0.4,
    ...over,
  };
}

function state(over: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-08-07T11:45:00Z",
    recommendations: {
      transfers4: [
        {
          rank: 1,
          playerOut: player({ elementId: 1, name: "Raya" }),
          playerIn: player(),
          delta4: 3.2,
          delta6: 4.9,
          bankAfter: 0.4,
          confidence: 0.61,
          rationale: ["Fixture swing", "Minutes secure"],
          flags: [],
        },
      ],
      captaincyPlan: [
        {
          gameweek: 1,
          captain: player(),
          viceCaptain: player({ elementId: 2, name: "Haaland" }),
          captainFixture: "LIV v BOU (H)",
          viceFixture: "MCI v WOL (A)",
          projectedCaptainPoints: 11.4,
          confidence: 0.55,
        },
      ],
      modelVersion: "heuristic-only",
    },
    rankings: {
      overall: [player()],
      captaincy: [player()],
      value: [player()],
      differentials: [player({ elementId: 3, name: "Mbeumo" })],
      goalkeepers: [],
      defenders: [],
      midfielders: [player()],
      forwards: [],
    },
    projections: {
      source: "fallback",
      sourceLabel: "No FPLReview export available — official FPL fields only",
    },
    ...over,
  };
}

function narrowOk(raw: unknown): HeuristicView {
  const result = narrowHeuristics(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.problems.join("; ")}`);
  return result.value;
}

describe("a well-formed state", () => {
  it("narrows", () => {
    const view = narrowOk(state());
    expect(view.transfers).toHaveLength(1);
    expect(view.captaincy).toHaveLength(1);
    expect(view.rankings.overall).toHaveLength(1);
    expect(view.droppedRows).toBe(0);
  });

  it("carries the transfer both ways round", () => {
    const [move] = narrowOk(state()).transfers;
    expect(move.playerOut.name).toBe("Raya");
    expect(move.playerIn.name).toBe("Salah");
  });

  it("keeps the rationale, which is the only reason to trust a heuristic at all", () => {
    expect(narrowOk(state()).transfers[0].rationale).toEqual([
      "Fixture swing", "Minutes secure",
    ]);
  });

  it("reports the projection source, so 'fallback' is visible", () => {
    // With no paid export on disk this is the normal case, and the page must be
    // able to say so rather than implying a premium feed is behind the numbers.
    expect(narrowOk(state()).projectionSource).toBe("fallback");
  });
});

describe("malformed rows are dropped and counted", () => {
  it("a transfer missing one side is not a partial transfer", () => {
    const raw = state();
    raw.recommendations.transfers4.push({ rank: 2, playerIn: player() } as never);
    const view = narrowOk(raw);
    expect(view.transfers).toHaveLength(1);
    expect(view.droppedRows).toBe(1);
  });

  it("a player with no element id is dropped from a ranking list", () => {
    const raw = state();
    raw.rankings.overall.push({ name: "nameless" } as never);
    const view = narrowOk(raw);
    expect(view.rankings.overall).toHaveLength(1);
    expect(view.droppedRows).toBe(1);
  });

  it("the surviving rows are still returned", () => {
    // One bad row must not take the other nineteen with it.
    const raw = state();
    raw.rankings.overall = [player(), { junk: true } as never, player({ elementId: 9 })];
    expect(narrowOk(raw).rankings.overall).toHaveLength(2);
  });
});

describe("missing structure fails the narrow", () => {
  it("no recommendations block", () => {
    const raw = state();
    delete (raw as Record<string, unknown>).recommendations;
    const result = narrowHeuristics(raw);
    expect(result.ok).toBe(false);
  });

  it("no rankings block", () => {
    const raw = state();
    delete (raw as Record<string, unknown>).rankings;
    expect(narrowHeuristics(raw).ok).toBe(false);
  });

  it("no generatedAt, because provenance is not optional", () => {
    const raw = state();
    delete (raw as Record<string, unknown>).generatedAt;
    expect(narrowHeuristics(raw).ok).toBe(false);
  });

  it("reports every problem, not just the first", () => {
    const result = narrowHeuristics({});
    if (result.ok) throw new Error("expected failure");
    expect(result.problems.length).toBeGreaterThan(1);
  });

  it("a non-object is refused rather than coerced", () => {
    expect(narrowHeuristics("not a state").ok).toBe(false);
    expect(narrowHeuristics(null).ok).toBe(false);
  });
});

describe("emptiness is declared, not guessed", () => {
  it("all lists empty is empty", () => {
    const raw = state({
      recommendations: { transfers4: [], captaincyPlan: [], modelVersion: "x" },
      rankings: EMPTY_RANKINGS,
    });
    expect(heuristicsAreEmpty(narrowOk(raw))).toBe(true);
  });

  it("a captaincy plan alone is not empty", () => {
    const raw = state({
      recommendations: {
        transfers4: [],
        captaincyPlan: state().recommendations.captaincyPlan,
        modelVersion: "x",
      },
      rankings: EMPTY_RANKINGS,
    });
    // There is still something to act on, so the page must render it.
    expect(heuristicsAreEmpty(narrowOk(raw))).toBe(false);
  });
});

describe("through the envelope", () => {
  const build = (raw: unknown, now = NOW) =>
    classify<HeuristicView>({
      path: "/api/fpl/state",
      source: "local",
      raw,
      narrow: narrowHeuristics,
      producedAtOf: (v) => v.generatedAt,
      producerVersionOf: (v) => v.modelVersion,
      isEmpty: heuristicsAreEmpty,
      freshnessBudgetMs: 30 * 60 * 1000,
      now,
    });

  it("a good payload is ok", () => {
    expect(build(state()).state).toBe("ok");
  });

  it("a broken payload is unreadable, not absent", () => {
    // The distinction matters: absent means nobody published, unreadable means
    // somebody published something we could not use.
    const artifact = build({ generatedAt: "x" });
    expect(artifact.state).toBe("unreadable");
    expect(artifact.reason).toContain("expected");
  });

  it("no payload at all is absent", () => {
    expect(build(undefined).state).toBe("absent");
  });

  it("goes stale past the budget", () => {
    const late = new Date("2026-08-07T13:00:00Z"); // 75 minutes after generatedAt
    const artifact = build(state(), late);
    expect(artifact.state).toBe("stale");
    // Still readable — the last thing we knew beats nothing.
    expect(proven(artifact)).not.toBeNull();
  });

  it("carries the engine version as the producer", () => {
    expect(build(state()).provenance.producerVersion).toBe("heuristic-only");
  });
});
