/**
 * Per-player distributions, and the discipline that makes them honest.
 *
 * The section this feeds is the one that distinguishes the app, so the tests
 * are about the claims it must not make:
 *
 * * **A partial decomposition is no decomposition.** The parts are built to sum
 *   to `xp`; four of five would silently not add up, and a reader who checks
 *   once and finds it wrong cannot trust any of the numbers afterwards.
 * * **`notable` ranks on upside.** A weekly-win entry buys the right tail, and
 *   a mean ranking buries exactly that. The order must also be total, or a
 *   re-render reshuffles the table.
 * * **A blank gameweek is empty, not zero.** Every player blank is a real state
 *   during an international break and must not render as a table of zeros.
 */
import { describe, expect, it } from "vitest";
import { classify, proven } from "@/lib/data/artifact";
import {
  narrowProjections, notable, projectionsAreEmpty, projectionsDescriptor, skew,
  type Projections,
} from "@/lib/data/projections";

function player(id: number, over: Record<string, unknown> = {}) {
  return {
    element_id: id, name: `P${id}`, team: "LIV", position: "MID",
    xp: 6.4, xp_sd: 3.7, mode: 2,
    p_appears: 0.97, p_60: 0.88, e_minutes: 79,
    p_goal: 0.35, p_clean_sheet: 0.31,
    p_ge_5: 0.51, p_ge_10: 0.15, q10: 1, q90: 13,
    n_fixtures: 1, blank: false,
    decomposition: {
      appearance: 1.9, goals: 2.1, assists: 0.6,
      clean_sheets: 0.3, other: 1.5,
    },
    ...over,
  };
}

const FILE = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, gameweek: 7, season: "2627",
  generated_at: "2026-08-07T06:00:00Z", n_draws: 10000,
  players: [player(1)],
  ...over,
});

function ok(raw: unknown): Projections {
  const result = narrowProjections(raw);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.value;
}

describe("narrowing", () => {
  it("keeps the three numbers that travel together", () => {
    const p = ok(FILE()).players[0];
    expect(p.xp).toBeCloseTo(6.4);
    expect(p.mode).toBe(2);
    expect(p.pGe10).toBeCloseTo(0.15);
  });

  it("carries the draw count, because precision is a claim", () => {
    expect(ok(FILE()).nDraws).toBe(10000);
  });

  it("drops a row with no element id", () => {
    const broken = player(1);
    delete (broken as Record<string, unknown>).element_id;
    expect(ok(FILE({ players: [broken, player(2)] })).players).toHaveLength(1);
  });

  it("a missing field is null, never zero", () => {
    const thin = player(1);
    delete (thin as Record<string, unknown>).mode;
    const p = ok(FILE({ players: [thin] })).players[0];
    // Zero would claim the model measured a most-likely return of nil.
    expect(p.mode).toBeNull();
  });

  it("a file with no players array is unreadable", () => {
    expect(narrowProjections({ gameweek: 7 }).ok).toBe(false);
    expect(narrowProjections(null).ok).toBe(false);
  });
});

describe("the decomposition is all-or-nothing", () => {
  it("keeps a complete one", () => {
    const parts = ok(FILE()).players[0].decomposition;
    expect(parts).not.toBeNull();
    expect(parts!.cleanSheets).toBeCloseTo(0.3);
  });

  it("its parts sum to the mean", () => {
    const p = ok(FILE()).players[0];
    const total = Object.values(p.decomposition!).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(p.xp!, 5);
  });

  it("drops a partial one rather than showing parts that do not add up", () => {
    const partial = player(1, {
      decomposition: { appearance: 1.9, goals: 2.1, assists: 0.6 },
    });
    expect(ok(FILE({ players: [partial] })).players[0].decomposition).toBeNull();
  });

  it("drops a non-object", () => {
    const bad = player(1, { decomposition: "lots" });
    expect(ok(FILE({ players: [bad] })).players[0].decomposition).toBeNull();
  });
});

describe("skew", () => {
  it("is the gap between the mean and the most likely return", () => {
    expect(skew(ok(FILE()).players[0])).toBeCloseTo(4.4);
  });

  it("is null rather than zero when either side is unknown", () => {
    // Zero would claim the two agree.
    const p = ok(FILE({ players: [player(1, { mode: null })] })).players[0];
    expect(skew(p)).toBeNull();
  });
});

describe("notable", () => {
  it("ranks on upside, not on the mean", () => {
    const file = ok(FILE({
      players: [
        player(1, { xp: 7.0, p_ge_10: 0.05 }),
        player(2, { xp: 5.0, p_ge_10: 0.30 }),
      ],
    }));
    expect(notable(file.players)[0].elementId).toBe(2);
  });

  it("breaks ties totally so a re-render does not reshuffle", () => {
    const file = ok(FILE({
      players: [
        player(3, { xp: 5, p_ge_10: 0.2 }),
        player(2, { xp: 5, p_ge_10: 0.2 }),
        player(1, { xp: 6, p_ge_10: 0.2 }),
      ],
    }));
    expect(notable(file.players).map((p) => p.elementId)).toEqual([1, 2, 3]);
  });

  it("excludes blanks, which have nothing to project", () => {
    const file = ok(FILE({
      players: [player(1), player(2, { blank: true, n_fixtures: 0 })],
    }));
    expect(notable(file.players)).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const file = ok(FILE({ players: [player(1), player(2, { p_ge_10: 0.9 })] }));
    const before = file.players.map((p) => p.elementId);
    notable(file.players);
    expect(file.players.map((p) => p.elementId)).toEqual(before);
  });
});

describe("emptiness", () => {
  it("no players is empty", () => {
    expect(projectionsAreEmpty(ok(FILE({ players: [] })))).toBe(true);
  });

  it("every player blank is empty, not a table of zeros", () => {
    // A real state during an international break.
    const file = ok(FILE({
      players: [player(1, { blank: true, xp: 0 }), player(2, { blank: true, xp: 0 })],
    }));
    expect(projectionsAreEmpty(file)).toBe(true);
  });

  it("one projected player is not empty", () => {
    const file = ok(FILE({ players: [player(1), player(2, { blank: true })] }));
    expect(projectionsAreEmpty(file)).toBe(false);
  });
});

describe("the descriptor", () => {
  it("pads the gameweek to match the writer's f-string", () => {
    expect(projectionsDescriptor(7).path).toBe("fpl/xp_public_gw07.json");
    expect(projectionsDescriptor(38).path).toBe("fpl/xp_public_gw38.json");
  });

  it("is owned by the agent", () => {
    expect(projectionsDescriptor(7).owner).toBe("agent");
  });

  it("classifies a blank gameweek as empty through the envelope", () => {
    const d = projectionsDescriptor(7);
    const artifact = classify({
      path: d.path, source: "local", narrow: d.narrow, isEmpty: d.isEmpty,
      raw: FILE({ players: [player(1, { blank: true, xp: 0 })] }),
      now: new Date("2026-08-07T07:00:00Z"),
    });
    expect(artifact.state).toBe("empty");
    expect(proven(artifact)).not.toBeNull();
  });
});
