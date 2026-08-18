/**
 * The control room's pure decisions, and one guard over the whole surface.
 *
 * The rendering is asserted in `app/control-room/page.test.tsx`. Everything here is
 * a function with an input and an output, and each case is a claim the screen makes
 * that would be invisible if it were wrong: a bank of zero looks exactly like an
 * unknown bank, an availability segment counted wrong still draws a bar, and a
 * calibration counter that guessed still shows a number.
 *
 * The last block is the important one. It reads this surface's own source and fails
 * if any of the design prototype's fabricated numbers appears in it — the same
 * guard `lib/margin/margin.test.ts` keeps over Margin, aimed at the screen whose
 * specification is the most populated and the least sourced.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REQUIRED_CALIBRATED_GAMEWEEKS, TAIL_THRESHOLD, TEAMS, availabilitySplit,
  calibratedWeeks, gatedInSimulation, money, teamFromParam, teamOf, tenths,
  withQuartiles, xiSwap, xiTotal,
} from "@/lib/control-room/model";
import { read } from "@/lib/control-room/read";
import { classify, type Artifact } from "@/lib/data/artifact";
import type { Accuracy } from "@/lib/data/accuracy";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";
import { narrowed } from "@/lib/data/artifact";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function projection(over: Partial<Projection> = {}): Projection {
  return {
    elementId: 1, name: "Player", team: "Arsenal", position: "MID",
    xp: 6.4, xpSd: 2.4, mode: 2, pAppears: 0.96, p60: 0.91, eMinutes: 82,
    pGoal: 0.34, pCleanSheet: 0.28, pGe5: 0.61, pGe10: 0.07,
    q10: 1, q25: 3, q50: 5, q75: 8, q90: 12,
    nFixtures: 1, blank: false, decomposition: null,
    ...over,
  };
}

function pick(over: Partial<SquadPlayer> = {}): SquadPlayer {
  return {
    name: "Player", position: "MID", team: "ARS", price: 6.0,
    bench: false, elementId: 1, fixtures: [],
    ...over,
  };
}

function playerRow(over: Partial<PlayerRow> = {}): PlayerRow {
  return {
    elementId: 1, name: "Player", team: "Arsenal", minutes: 900,
    goals: 1, assists: 1, xg: 0.4, xa: 0.3,
    fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 10, fpl_price: 6, form: 2, position: "MID",
    available: true,
  status: null,
  chanceOfPlaying: null, ratesAreMeaningful: true,
    ...over,
  };
}

function accuracy(over: Partial<Accuracy> = {}): Accuracy {
  return {
    generatedAt: "2026-08-18T06:00:00Z", season: "2627",
    gameweeksSealed: 0, observations: 0,
    perfectModelRmse: 2.24, perfectModelBasis: "simulated spreads",
    measured: null, excessOverCeiling: null,
    predictedXi: { ours: null, benchmark: 0.84, benchmarkSource: "SportMonks" },
    reason: "No gameweek has sealed.",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the three teams", () => {
  it("names the entries the pipeline names", () => {
    // A wrong entry id opens somebody else's team, which this app has shipped.
    expect(TEAMS.map((team) => team.entryId)).toEqual([20945, 2561567, 2561099]);
  });

  it("keeps one human and two bots", () => {
    expect(TEAMS.filter((team) => team.kind === "human")).toHaveLength(1);
    expect(TEAMS.filter((team) => team.kind === "bot")).toHaveLength(2);
  });

  it("gives only the bots a decision path, because only they solve", () => {
  });

  it("states the weekly threshold the producer defaults to", () => {
    // `plan_eval.py` and `run_decide.py` both default `tail_threshold` to 70. The
    // design names 60, which is a rung on the ladder rather than the default, and
    // rendering it would put a threshold on screen that no run has used.
    expect(TAIL_THRESHOLD).toBe(70);
    expect(teamOf("wazza").objective).toBe("P(GW ≥ 70)");
  });

  it("keeps the calibration gate at the pipeline's six", () => {
    expect(REQUIRED_CALIBRATED_GAMEWEEKS).toBe(6);
  });
});

describe("the focused team round-trips through the URL", () => {
  it("accepts the three keys", () => {
    expect(teamFromParam("mine")).toBe("mine");
    expect(teamFromParam("ronny")).toBe("ronny");
    expect(teamFromParam("wazza")).toBe("wazza");
  });

  it("falls back to the human entry on anything else", () => {
    expect(teamFromParam(null)).toBe("mine");
    expect(teamFromParam("")).toBe("mine");
    expect(teamFromParam("nonsense")).toBe("mine");
  });

  it("does not resolve an inherited property to a team", () => {
    // `?view=toString` once resolved to a function on `/margin`, React took it for
    // a state updater, and the page rendered a bar with no panel under it.
    expect(teamFromParam("toString")).toBe("mine");
    expect(teamFromParam("constructor")).toBe("mine");
  });
});

describe("the XI's projected total", () => {
  const projections = [
    projection({ elementId: 426, name: "Captain", xp: 6.66 }),
    projection({ elementId: 379, name: "Forward", xp: 4.35 }),
    projection({ elementId: 173, name: "Benched", xp: 0.91 }),
  ];

  it("sums the starters and leaves the bench out", () => {
    const total = xiTotal([
      pick({ elementId: 426, bench: false, role: "captain" }),
      pick({ elementId: 379, bench: false }),
      pick({ elementId: 173, bench: true }),
    ], projections);
    expect(total?.total).toBeCloseTo(11.01, 2);
  });

  it("does not double the armband", () => {
    // Two screens in this app printed 48.20 and 54.9 for one eleven and one
    // artifact, with neither saying which counting rule it used.
    const total = xiTotal([
      pick({ elementId: 426, bench: false, role: "captain" }),
    ], projections);
    expect(total?.total).toBeCloseTo(6.66, 2);
  });

  it("reports how many of the eleven were matched", () => {
    const total = xiTotal([
      pick({ elementId: 426, bench: false }),
      pick({ elementId: 999, name: "Unknown", bench: false }),
    ], projections);
    expect(total?.matched).toBe(1);
    expect(total?.xiSize).toBe(2);
  });

  it("refuses when the squad does not say which eleven starts", () => {
    // An assumed eleven is a lineup nothing solved.
    expect(xiTotal([pick({ bench: undefined })], projections)).toBeNull();
  });

  it("names the armband from the squad rather than from the projection", () => {
    const total = xiTotal([
      pick({ elementId: 426, name: "Captain", bench: false, role: "captain" }),
      pick({ elementId: 379, name: "Forward", bench: false, role: "vice" }),
    ], projections);
    expect(total?.captain?.name).toBe("Captain");
    expect(total?.vice?.name).toBe("Forward");
  });
});

describe("the availability split", () => {
  it("counts both segments", () => {
    const split = availabilitySplit([
      playerRow({ available: false }), playerRow({ available: false }),
      playerRow({ available: true }), playerRow({ available: true }),
      playerRow({ available: true }),
    ]);
    expect(split).toEqual({ flagged: 2, unflagged: 3, total: 5 });
  });

  it("folds an unstated availability into neither segment", () => {
    // "The provider did not say" is not "the provider said available", and a bar
    // that silently counted it as fit would draw absence of news as fitness.
    const split = availabilitySplit([
      playerRow({ available: null }), playerRow({ available: true }),
    ]);
    expect(split).toEqual({ flagged: 0, unflagged: 1, total: 2 });
  });

  it("refuses an empty catalogue rather than drawing two zeroes", () => {
    expect(availabilitySplit([])).toBeNull();
    expect(availabilitySplit(null)).toBeNull();
    expect(availabilitySplit([playerRow({ available: null })])).toBeNull();
  });
});

describe("the measured quartiles", () => {
  it("counts only players carrying all five", () => {
    // A q25 with no q75 is a half-box, which is a narrower interval than the one
    // measured — the flattering direction to be wrong in.
    expect(withQuartiles([
      projection(),
      projection({ q75: null }),
      projection({ q10: null }),
    ])).toBe(1);
  });

  it("makes the lead's claim self-checking rather than asserted", () => {
    // "with measured quartiles on every one of them" would go on being printed
    // through the first partial run; a count cannot.
    expect(withQuartiles([])).toBe(0);
  });
});

describe("the simulation's availability gate", () => {
  it("counts only the players held out of every draw", () => {
    expect(gatedInSimulation([
      projection({ pAppears: 0 }),
      projection({ pAppears: 0.02 }),
      projection({ pAppears: 1 }),
    ])).toBe(1);
  });

  it("does not count an unpublished appearance probability as a gate", () => {
    expect(gatedInSimulation([projection({ pAppears: null })])).toBe(0);
  });
});

describe("the calibration counter", () => {
  it("reads zero from zero sealed gameweeks", () => {
    // Calibration cannot outrun sealing: a gameweek that has not sealed cannot
    // have been scored, so zero sealed is real evidence of zero calibrated.
    expect(calibratedWeeks(accuracy({ gameweeksSealed: 0 }))).toBe(0);
  });

  it("refuses above zero, where sealing and calibration part company", () => {
    // Three sealed gameweeks say nothing about whether the field model held its
    // band in them, and nothing publishes that history.
    expect(calibratedWeeks(accuracy({ gameweeksSealed: 3 }))).toBeNull();
  });

  it("refuses when the accuracy record could not be read", () => {
    expect(calibratedWeeks(null)).toBeNull();
  });
});

describe("money", () => {
  it("writes one decimal, as FPL reports it", () => {
    expect(money(99.5)).toBe("£99.5m");
    expect(money(0)).toBe("£0.0m");
  });

  it("passes null through rather than printing zero", () => {
    // £0.0m and "unknown" lead to opposite transfer decisions.
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
    expect(money(Number.NaN)).toBeNull();
  });

  it("converts a bank to the tenths FPL holds it in", () => {
    expect(tenths(0.5)).toBe(5);
    expect(tenths(3.1)).toBe(31);
    expect(tenths(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1's one expression
// ─────────────────────────────────────────────────────────────────────────────

interface Payload { readonly stamp: string | null }

function artifactOf(
  raw: unknown, now: Date, fetchError: string | null = null,
): Artifact<Payload> {
  return classify<Payload>({
    path: "fpl/thing.json",
    source: raw === undefined ? "none" : "local",
    raw,
    narrow: (value) => narrowed({
      stamp: (value as { generated_at?: string } | undefined)?.generated_at ?? null,
    }),
    producedAtOf: (value) => value.stamp,
    now,
    fetchError,
  });
}

describe("read() pairs a value with the age of the artifact it came from", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  it("uses this fetch when it carries a value", () => {
    const artifact = artifactOf({ generated_at: "2026-08-18T06:00:00Z" }, now);
    const result = read({ artifact, retained: null, initialising: false },
      (value) => value.stamp, now);
    expect(result.value?.stamp).toBe("2026-08-18T06:00:00Z");
    expect(result.age).toBe("6h old");
  });

  it("falls back to the retained value AND to its age", () => {
    /**
     * The half of this that is easy to get wrong.
     *
     * A retained value shown with the failed fetch's age is a stale figure wearing
     * a current timestamp — worse than either honest option, and invisible.
     */
    const retained = artifactOf({ generated_at: "2026-08-16T06:00:00Z" }, now);
    const artifact = artifactOf(undefined, now, "not found");
    const result = read({ artifact, retained, initialising: false },
      (value) => value.stamp, now);
    expect(result.value?.stamp).toBe("2026-08-16T06:00:00Z");
    // Beyond a day, so an instant rather than a duration the reader cannot check.
    /* The age is what carries "this is not from the fetch you just made" — a boolean
       saying so as well had no reader on any surface, so it went. */
    expect(result.age).toMatch(/^as at /);
  });

  it("separates a first fetch in flight from a genuine absence", () => {
    const artifact = artifactOf(undefined, now, "loading");
    expect(
      read({ artifact, retained: null, initialising: true }, (v) => v.stamp, now)
        .initialising,
    ).toBe(true);
    expect(
      read({ artifact, retained: null, initialising: false }, (v) => v.stamp, now)
        .initialising,
    ).toBe(false);
  });

  it("names the path, so a cell can say what was not written", () => {
    const artifact = artifactOf(undefined, now, "not found");
    const result = read({ artifact, initialising: false }, (v) => v.stamp, now);
    expect(result.path).toBe("fpl/thing.json");
    expect(result.value).toBeNull();
    expect(result.age).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

describe("no number survived from the design", () => {
  /**
   * The failure this whole screen was at risk of.
   *
   * §4 of the build document is spec'd to the pixel and populated to the penny:
   * Ronny at 54 with `q10 40 · q90 70`, Wazza at 53 with `q10 31 · q90 84`,
   * `£96.9m · £3.1m`, `£96.1m · £0.0m`, `Thomas → Senesi`, `Thomas → Kroupi Jr`,
   * both last runs at `06:12` and `06:16`, `39 of 587`. §9 then says the sample
   * proposals and every quantile in every design file are fabricated — and they
   * are: no `decision_public_*` file has ever been written for either entry.
   *
   * On screen a fabricated figure is indistinguishable from a measured one, and
   * this app has already shipped that exact failure: `lib/fpl-portal.ts` was 205
   * lines of hand-typed data feeding four sections of the old homepage, including
   * a captaincy plan carrying `confidence: 91` for picks nobody computed.
   *
   * So the design's literals must not appear in this surface's source. A comment
   * quoting one to explain why the screen does NOT draw it is the documentation
   * this repo wants, so comments are stripped before matching — scanning raw text
   * cannot tell an explanation from a defect and would push an author to delete
   * the explanation to get to green.
   */
  const LITERALS = [
    // The two bots' squad values and banks.
    "96.9", "96.1", "96.5", "3.1m", "3.5m",
    // The two sample proposals.
    "Senesi", "Kroupi",
    // Both bots' last-run times.
    "06:12", "06:14", "06:16",
    // The fabricated squad-total quantiles and the roster split.
    "12.6", "587", "548",
  ];

  function withoutComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  function sources(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = [];
    const dirs = [
      join(process.cwd(), "lib", "control-room"),
      join(process.cwd(), "components", "control-room"),
      join(process.cwd(), "app", "control-room"),
    ];
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
        if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
        out.push({
          file: join(dir, name),
          text: withoutComments(readFileSync(join(dir, name), "utf8")),
        });
      }
    }
    return out;
  }

  it("finds the control room's sources at all", () => {
    // Guards the guard: an empty list makes every assertion below vacuous.
    expect(sources().length).toBeGreaterThan(4);
  });

  it("strips comments without stripping code", () => {
    const stripped = withoutComments(
      "/* 96.9 in a block */\nconst x = 96.9; // 96.9 in a line\nconst u = 'https://x';",
    );
    expect(stripped).toContain("const x = 96.9;");
    expect(stripped).toContain("https://x");
    expect(stripped).not.toContain("in a block");
    expect(stripped).not.toContain("in a line");
  });

  for (const literal of LITERALS) {
    it(`does not contain the design's ${literal}`, () => {
      const offenders = sources()
        .filter((source) => source.text.includes(literal))
        .map((source) => source.file);
      expect(
        offenders,
        `${literal} is a figure from the design's fabricated sample. Every value on `
        + "this board has to come from a published artifact; a literal here is the "
        + "fpl-portal.ts failure returning.",
      ).toEqual([]);
    });
  }

  it("reaches its data through the artifact envelope, never a bare fetch", () => {
    for (const source of sources()) {
      expect(source.text, `${source.file} casts a response`)
        .not.toMatch(/as\s+\w*Projections?\b/);
      expect(source.text, `${source.file} fetches directly`)
        .not.toContain("await fetch(");
    }
  });

  it("offers no approve, reject or defer handler", () => {
    // §4: the board is read-only, and acting happens on the team's own screen. A
    // handler is how that erodes — one button, added because it seemed helpful.
    for (const source of sources()) {
      for (const word of ["onApprove", "onReject", "onDefer", "approveDecision"]) {
        expect(source.text, `${source.file} carries ${word}`).not.toContain(word);
      }
    }
  });
});

describe("the lineup change the board was silent about", () => {
  /**
   * The `call` cell printed "No move proposed" for the owner while the model's own
   * arithmetic had a better legal eleven inside the fifteen he already owns.
   *
   * Verified independently against the shipped artifact before this was written: drafted
   * XI 43.5046, best legal XI 48.2030, in Szoboszlai and F.Kadıoğlu, out Palestra and
   * Schade, gain 4.6984 — both bench players outscoring two starters.
   */
  const squad = (rows: Array<[number, string, string, boolean]>) =>
    rows.map(([elementId, name, position, bench]) => ({
      elementId, name, position, team: "ARS", price: 5, bench, fixtures: [],
    })) as never[];

  /** A legal 3-4-3 with two bench players worth more than two starters. */
  const FIFTEEN = squad([
    [1, "GK1", "GKP", false], [2, "GK2", "GKP", true],
    [3, "D1", "DEF", false], [4, "D2", "DEF", false], [5, "D3", "DEF", false],
    [6, "D4", "DEF", true],
    [7, "M1", "MID", false], [8, "M2", "MID", false], [9, "M3", "MID", false],
    [10, "M4", "MID", false], [11, "M5", "MID", true],
    [12, "F1", "FWD", false], [13, "F2", "FWD", false], [14, "F3", "FWD", false],
    [15, "F4", "FWD", true],
  ]);

  const projections = (byId: Record<number, number>) =>
    Object.entries(byId).map(([id, xp]) => ({
      elementId: Number(id), xp, blank: false,
    })) as never[];

  it("finds the swap and states both totals", () => {
    // D4 (bench, 9) beats D1 (starting, 1); everyone else flat.
    const proj = projections({
      1: 4, 2: 4, 3: 1, 4: 4, 5: 4, 6: 9, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4,
      12: 4, 13: 4, 14: 4, 15: 4,
    });
    const swap = xiSwap(FIFTEEN, proj)!;
    expect(swap.bringIn.map((p) => p.name)).toEqual(["D4"]);
    expect(swap.takeOut.map((p) => p.name)).toEqual(["D1"]);
    expect(swap.gain).toBeCloseTo(8, 5);
    expect(swap.to - swap.from).toBeCloseTo(swap.gain, 5);
  });

  it("says nothing when the drafted eleven is already the best one", () => {
    // Every bench player worse than every starter.
    const proj = projections({
      1: 5, 2: 1, 3: 5, 4: 5, 5: 5, 6: 1, 7: 5, 8: 5, 9: 5, 10: 5, 11: 1,
      12: 5, 13: 5, 14: 5, 15: 1,
    });
    expect(xiSwap(FIFTEEN, proj)).toBeNull();
  });

  it("ignores a gain too small to act on, so rounding is not advice", () => {
    const proj = projections({
      1: 5, 2: 1, 3: 5, 4: 5, 5: 5, 6: 5.005, 7: 5, 8: 5, 9: 5, 10: 5, 11: 1,
      12: 5, 13: 5, 14: 5, 15: 1,
    });
    expect(xiSwap(FIFTEEN, proj)).toBeNull();
  });

  it("refuses when the squad does not say who starts", () => {
    // `bench: undefined` is unknown, and an assumed eleven would be a lineup nothing
    // solved — the same rule `xiTotal` follows.
    const unknown = FIFTEEN.map((p) => ({ ...(p as object), bench: undefined })) as never[];
    expect(xiSwap(unknown, projections({ 1: 5 }))).toBeNull();
  });

  it("refuses when no projection exists at all", () => {
    expect(xiSwap(FIFTEEN, [])).toBeNull();
  });

  it("keeps the eleven legal — it never proposes an illegal shape", () => {
    // Make every keeper huge: a naive "best eleven by xP" would start two.
    const proj = projections({
      1: 20, 2: 20, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1,
      12: 1, 13: 1, 14: 1, 15: 1,
    });
    const swap = xiSwap(FIFTEEN, proj);
    if (swap) {
      const started = new Set(FIFTEEN.filter((p) => (p as { bench: boolean }).bench === false)
        .map((p) => (p as { name: string }).name));
      for (const p of swap.takeOut) expect(started.has(p.name)).toBe(true);
      // Exactly one keeper may start, so GK2 can only come in if GK1 goes out.
      const inGk = swap.bringIn.filter((p) => p.position === "GKP").length;
      const outGk = swap.takeOut.filter((p) => p.position === "GKP").length;
      expect(inGk).toBe(outGk);
    }
  });
});
