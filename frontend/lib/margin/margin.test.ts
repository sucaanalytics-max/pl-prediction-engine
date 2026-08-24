/**
 * The four pure decisions behind Margin, and one guard over the whole surface.
 *
 * The rendering was asserted in `app/margin/page.test.tsx`, which went with the
 * route; the views themselves are now mounted on `/`, `/players` and `/evidence`
 * and tested per component. Everything here is a
 * function with an input and an output, and each case below is a claim the
 * screen makes that would be invisible if it were wrong: a mark drawn at the
 * wrong end of a scale still looks like a mark, a countdown that says "passed"
 * when the date is unparseable still looks like a countdown, and a squad joined
 * to the wrong player still shows a number beside every name.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { geometry, meanOverMode, SCALE_HI } from "@/lib/margin/distribution";
import {
  clockLabel, countdown, countdownLong, describeMode, modeOf, reasonWithoutCountdown,
  remainingMs,
  tickPeriodMs,
} from "@/lib/margin/mode";
import { findTwins } from "@/lib/margin/twins";
import { fold, hasLineup, inReadingOrder, joinProjections } from "@/lib/margin/squad";
import type { AgentStatus } from "@/lib/data/agent-status";
import type { Projection } from "@/lib/data/projections";
import type { SquadPlayer } from "@/lib/data/heuristics";

// ─────────────────────────────────────────────────────────────────────────────

function projection(over: Partial<Projection> = {}): Projection {
  return {
    elementId: 1, name: "Player", team: "Arsenal", position: "MID",
    xp: 6.4, xpSd: 2.4, mode: 2, pAppears: 0.96, p60: 0.91, eMinutes: 82,
    pGoal: 0.34, pCleanSheet: 0.28, pGe5: 0.61, pGe10: 0.07,
    q10: 1, q25: 2, q50: 5, q75: 8, q90: 12, nFixtures: 1, blank: false, decomposition: null,
    ...over,
  };
}

function squadPlayer(over: Partial<SquadPlayer> = {}): SquadPlayer {
  return {
    name: "Player", position: "MID", team: "ARS", price: 10.6,
    elementId: 1, bench: undefined, role: undefined, fixture: "BUR (H)", fixtures: [],
    ...over,
  };
}

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    phase: "idle", gameweek: 1, deadline: "2026-08-21T17:30:00+00:00",
    secondsToDeadline: 718235, reason: "GW1 deadline in 199.5h; nothing due yet",
    agentRan: false, generatedAt: "2026-08-13T09:59:24Z",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the distribution glyph draws only what was published", () => {
  it("places the whisker across q10 to q90 on the shared scale", () => {
    const g = geometry({ q10: 0, q90: SCALE_HI });
    expect(g.whisker).toEqual({ from: 0, to: 100 });
  });

  it("omits the whisker when either end is missing", () => {
    // Drawing q10-to-mean because q90 was absent would report a NARROWER
    // interval than the one measured, which is the flattering direction.
    expect(geometry({ q10: 2, q90: null, mean: 6 }).whisker).toBeNull();
    expect(geometry({ q10: null, q90: 12, mean: 6 }).whisker).toBeNull();
  });

  it("keeps the mean and the mode as separate marks", () => {
    const g = geometry({ mean: 6.4, mode: 2 });
    expect(g.mean?.at).toBeGreaterThan(g.mode?.at ?? 0);
  });

  it("omits a mark rather than defaulting it to the mean", () => {
    // A missing median drawn at the mean would assert a symmetric distribution,
    // which is the opposite of what FPL points do.
    const g = geometry({ q10: 1, q90: 12, mean: 6.4, q50: null });
    expect(g.median).toBeNull();
    expect(g.mean).not.toBeNull();
  });

  it("flags a clamped mark rather than silently pinning it", () => {
    const g = geometry({ mean: 40 });
    expect(g.mean).toEqual({ at: 100, clamped: true });
  });

  it("draws the interquartile box only when both ends resolve", () => {
    // A half-box is a narrower claim than a whole one, and the design derives
    // the missing end from the standard deviation — a shape invented from a
    // spread, drawn at the weight of a measurement.
    expect(geometry({ q25: 2, q75: 8 }).box).not.toBeNull();
    expect(geometry({ q25: 2 }).box).toBeNull();
    expect(geometry({ q75: 8 }).box).toBeNull();
  });

  it("orders the box inside the whisker", () => {
    const g = geometry({ q10: 1, q25: 3, q75: 9, q90: 14 });
    expect(g.box!.from).toBeGreaterThan(g.whisker!.from);
    expect(g.box!.to).toBeLessThan(g.whisker!.to);
  });

  it("reports blank when nothing at all was published", () => {
    expect(geometry({}).blank).toBe(true);
    expect(geometry({ mean: 3 }).blank).toBe(false);
  });

  it("refuses a degenerate scale instead of dividing by zero", () => {
    // `at: Infinity` would render as a mark somewhere off the row rather than
    // as an error anyone would notice.
    expect(geometry({ mean: 3 }, 5, 5).blank).toBe(true);
  });

  it("returns null rather than 0 when either side of the skew is unknown", () => {
    expect(meanOverMode(6.4, 2)).toBeCloseTo(4.4);
    expect(meanOverMode(6.4, null)).toBeNull();
    expect(meanOverMode(null, 2)).toBeNull();
  });
});

describe("the mode is derived from the phase resolver", () => {
  it("reads deadline mode only when the agent actually ran", () => {
    expect(modeOf(status({ agentRan: true }))).toBe("deadline");
    expect(modeOf(status({ agentRan: false }))).toBe("idle");
  });

  it("reads locked from the phase, not from the deadline having passed", () => {
    expect(modeOf(status({ phase: "locked", agentRan: true }))).toBe("locked");
  });

  it("distinguishes unknown from idle", () => {
    // The whole point. Rendering a failed fetch as "the engine has not run"
    // puts a confident claim on screen on the strength of no evidence.
    expect(modeOf(null)).toBe("unknown");
    expect(describeMode("unknown", null)).toMatch(/not the same as/);
  });

  it("labels the clock by what it is measuring", () => {
    expect(clockLabel("deadline")).toBe("Deadline in");
    expect(clockLabel("idle")).toBe("Next gate in");
  });
});

describe("the countdown", () => {
  const now = new Date("2026-08-14T00:00:00Z");

  it("shows seconds only inside the last day", () => {
    expect(countdown(1000 * (3600 + 47 * 60 + 12))).toBe("01:47:12");
    expect(countdown(1000 * 86_400 * 5.9)).toBe("5d 21h");
  });

  it("says passed rather than counting backwards", () => {
    expect(countdown(-1)).toBe("passed");
  });

  it("returns null for an unparseable deadline instead of NaN", () => {
    // `Date.parse("")` is NaN and NaN arithmetic propagates silently — the exact
    // mechanism that made every expired proposal in this app read "ready".
    expect(remainingMs("", now)).toBeNull();
    expect(remainingMs("not a date", now)).toBeNull();
    expect(remainingMs(null, now)).toBeNull();
    expect(countdown(null)).toBe("—");
  });

  it("measures against the injected clock", () => {
    expect(remainingMs("2026-08-14T01:00:00Z", now)).toBe(3_600_000);
  });

  /**
   * The long form, for a masthead whose clock ticks per minute outside the last
   * day. `countdown` drops to `3d 8h` there, and a display whose smallest unit is
   * an hour gives a per-minute tick nothing to change.
   */
  it("keeps the minutes visible beyond a day", () => {
    expect(countdownLong(1000 * (3 * 86_400 + 8 * 3600 + 43 * 60))).toBe("3d 08h 43m");
  });

  it("agrees with the short form inside the last day", () => {
    const inside = 1000 * (3600 + 47 * 60 + 12);
    expect(countdownLong(inside)).toBe(countdown(inside));
  });

  it("shares the short form's answers at the edges", () => {
    expect(countdownLong(-1)).toBe("passed");
    expect(countdownLong(null)).toBe("—");
    expect(countdownLong(Number.NaN)).toBe("—");
  });

  it("ticks per second only inside the last day", () => {
    // Seconds six days out are motion dressed as urgency, and 86,400 re-renders
    // for a digit nobody is watching.
    expect(tickPeriodMs(1000 * 3600)).toBe(1_000);
    expect(tickPeriodMs(1000 * 86_400 * 3)).toBe(60_000);
    expect(tickPeriodMs(null)).toBe(60_000);
    expect(tickPeriodMs(-1)).toBe(60_000);
  });
});

describe("the same-mean pair is found, not written down", () => {
  it("prefers the widest spread gap among players the mean cannot separate", () => {
    const pair = findTwins([
      projection({ elementId: 1, name: "Steady", xp: 6.4, xpSd: 2.4 }),
      projection({ elementId: 2, name: "Volatile", xp: 6.42, xpSd: 5.9 }),
      projection({ elementId: 3, name: "Alone", xp: 1.1, xpSd: 0.2 }),
    ]);
    expect(pair?.steady.name).toBe("Steady");
    expect(pair?.volatile.name).toBe("Volatile");
    expect(pair?.meanGap).toBeCloseTo(0.02);
  });

  it("returns null rather than the least bad two", () => {
    // A panel headed "same mean, different asset" over two interchangeable
    // players discredits the argument on the one screen making it.
    expect(findTwins([
      projection({ elementId: 1, xp: 6.4, xpSd: 2.4 }),
      projection({ elementId: 2, xp: 6.4, xpSd: 2.5 }),
    ])).toBeNull();
    expect(findTwins([])).toBeNull();
  });

  it("ignores players the model has no view on", () => {
    expect(findTwins([
      projection({ elementId: 1, xp: 6.4, xpSd: null }),
      projection({ elementId: 2, xp: 6.4, xpSd: 5.9 }),
    ])).toBeNull();
  });

  it("ignores blanks, whose zero is not a projection", () => {
    expect(findTwins([
      projection({ elementId: 1, xp: 0, xpSd: 0, blank: true }),
      projection({ elementId: 2, xp: 0, xpSd: 4, blank: true }),
    ])).toBeNull();
  });
});

describe("the squad joins to the projection on the id", () => {
  it("matches on element id when the route sent one", () => {
    const join = joinProjections(
      [squadPlayer({ elementId: 426, name: "B.Fernandes" })],
      [projection({ elementId: 426, name: "Bruno Fernandes" })],
    );
    expect(join.matchedById).toBe(1);
    expect(join.rows[0].projection?.elementId).toBe(426);
  });

  it("falls back to the folded name when there is no id", () => {
    const join = joinProjections(
      [squadPlayer({ elementId: undefined, name: "F.Kadıoğlu", position: "DEF" })],
      [projection({ elementId: 113, name: "F.Kadioglu", position: "DEF" })],
    );
    expect(join.matchedByName).toBe(1);
    expect(join.rows[0].matchedBy).toBe("name");
  });

  it("refuses an ambiguous name rather than guessing", () => {
    // FPL has six Wilsons. Putting another player's distribution on yours is
    // worse than showing nothing.
    const join = joinProjections(
      [squadPlayer({ elementId: undefined, name: "Wilson", position: "FWD" })],
      [
        projection({ elementId: 10, name: "Wilson", position: "FWD" }),
        projection({ elementId: 11, name: "Wilson", position: "FWD" }),
      ],
    );
    expect(join.rows[0].projection).toBeNull();
    expect(join.unmatched).toBe(1);
  });

  it("folds the Turkish dotless i, which does not decompose", () => {
    expect(fold("F.Kadıoğlu")).toBe("f.kadioglu");
    expect(fold("Ødegaard")).toBe(fold("Ødegaard"));
  });

  it("sinks players with no projection to the bottom of their line", () => {
    const rows = inReadingOrder(joinProjections(
      [
        squadPlayer({ elementId: 1, name: "Low", position: "MID" }),
        squadPlayer({ elementId: 2, name: "Unknown", position: "MID" }),
        squadPlayer({ elementId: 3, name: "High", position: "MID" }),
        squadPlayer({ elementId: 4, name: "Keeper", position: "GKP" }),
      ],
      [
        projection({ elementId: 1, xp: 2 }),
        projection({ elementId: 3, xp: 9 }),
        projection({ elementId: 4, xp: 3 }),
      ],
    ).rows);
    expect(rows.map((r) => r.player.name)).toEqual([
      "Keeper", "High", "Low", "Unknown",
    ]);
  });

  it("reports no lineup when nobody said which eleven start", () => {
    // An all-undefined bench flag is "nobody has solved an XI", and splitting
    // the list anyway would invent a lineup out of an array order.
    const unknown = joinProjections([squadPlayer({ bench: undefined })], []).rows;
    expect(hasLineup(unknown)).toBe(false);
    const known = joinProjections([squadPlayer({ bench: false })], []).rows;
    expect(hasLineup(known)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

describe("no number survived from the prototype", () => {
  /**
   * The failure this file exists to prevent.
   *
   * Margin is implemented from a design prototype whose numbers are written by
   * hand — a 59.6 point projection, a `±15.6` interval, `P(≥60) 47.9%`, an
   * eight-week grid of starts and sales, four named runner-up plans with
   * margins. They are plausible, they are specific, and on screen they are
   * indistinguishable from a measurement.
   *
   * This app has already shipped that exact failure once: `lib/fpl-portal.ts`
   * was 205 lines of hand-typed fake data feeding four sections of the old
   * homepage, including a six-gameweek captaincy plan carrying `confidence: 91`
   * for picks nobody computed. It was deleted, and nothing prevents its return
   * except a test that reads the source.
   *
   * So: the prototype's literals must not appear in any Margin module. A number
   * that has to come from an artifact cannot be typed into a component, and
   * typing one is the only way to fail this.
   */
  const LITERALS = [
    "59.6", "15.6", "47.9", "58.9", "58.4", "58.1", "56.2",
    "12.42", "0.66", "6.49", "460.0", "43.9", "54.2", "61.4",
    "+12.42", "±15.6",
  ];

  /**
   * Comments stripped before matching.
   *
   * The distinction is the whole test. A prototype number quoted in a docstring
   * to explain why the screen does NOT draw it is the documentation this repo
   * wants; the same number in an expression is the defect. Scanning raw text
   * cannot tell them apart and would push authors to delete the explanation to
   * get to green, which is the worst outcome available.
   *
   * `//` is only treated as a line comment when it is not preceded by a colon,
   * so a `https://` inside a string survives.
   */
  function withoutComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  function marginSources(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = [];
    // `app/margin` is deleted with the route cut; the views it composed live on
    // under `components/margin` and are mounted on `/`, `/players` and `/evidence`,
    // so the surface this guard protects moved rather than went away.
    const dirs = [
      join(process.cwd(), "lib", "margin"),
      join(process.cwd(), "components", "margin"),
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

  it("finds the Margin sources at all", () => {
    // Guards the guard: an empty list makes every assertion below vacuous.
    expect(marginSources().length).toBeGreaterThan(6);
  });

  it("strips comments without stripping code", () => {
    // The other way this guard could rot into decoration: a stripper that ate
    // everything would report green over any literal at all.
    const stripped = withoutComments(
      "/* 59.6 in a block */\nconst x = 59.6; // 59.6 in a line\nconst u = 'https://x';",
    );
    expect(stripped).toContain("const x = 59.6;");
    expect(stripped).toContain("https://x");
    expect(stripped).not.toContain("in a block");
    expect(stripped).not.toContain("in a line");
  });

  for (const literal of LITERALS) {
    it(`does not contain the prototype's ${literal}`, () => {
      const offenders = marginSources()
        .filter((source) => source.text.includes(literal))
        .map((source) => source.file);
      expect(
        offenders,
        `${literal} is a number from the design prototype. Every value on this `
          + "surface has to come from a published artifact; a literal here is the "
          + "fpl-portal.ts failure returning.",
      ).toEqual([]);
    });
  }

  it("reaches its data through the artifact envelope, never a bare fetch", () => {
    // `res.json() as T` is Rule 4, and the two places it was broken in this app
    // both turned a shape change into a blank page instead of a message.
    for (const source of marginSources()) {
      expect(source.text, `${source.file} casts a response`).not.toMatch(/as\s+\w*Projections?\b/);
      expect(source.text, `${source.file} fetches directly`).not.toContain("await fetch(");
    }
  });
});

describe("the locked phase is BEFORE the deadline, not after", () => {
  /**
   * `pipeline/learning/schedule.py:288` emits this phase when
   * `remaining <= LOCKOUT_BEFORE_DEADLINE`, where `LOCKOUT_BEFORE_DEADLINE` is 30 minutes
   * and `remaining` is time UNTIL the deadline. So it is the last half hour before it,
   * and it can never be emitted after.
   *
   * The copy said "The deadline has passed and this gameweek is settled. Nothing below is
   * actionable." — exactly backwards, in the only thirty minutes where being wrong about
   * it costs a team, because the reader can still change theirs.
   */
  const locked = {
    schemaVersion: 1,
    generatedAt: "2026-08-21T17:05:00Z",
    phase: "locked",
    gameweek: 1,
    deadline: "2026-08-21T17:30:00Z",
    secondsToDeadline: 1500,
    reason: null,
    agentRan: true,
  } as unknown as AgentStatus;

  it("does not tell the reader the deadline has passed", () => {
    const copy = describeMode("locked", locked);
    expect(copy).not.toMatch(/deadline has passed/i);
    expect(copy).not.toMatch(/settled/i);
  });

  it("does not tell the reader their team is beyond changing", () => {
    expect(describeMode("locked", locked)).not.toMatch(/nothing below is actionable/i);
  });

  it("says what is actually locked — the agent, not the owner", () => {
    const copy = describeMode("locked", locked);
    expect(copy).toMatch(/agent/i);
    expect(copy).toMatch(/still yours to change|until the deadline/i);
  });

  it("keeps the clock counting down to the deadline, not up from it", () => {
    // "Locked since" put the deadline in the past and the countdown beside it in the
    // future, on the same line.
    expect(clockLabel("locked")).toBe("Deadline in");
  });

  it("still prefers the producer's own reason when it sends one", () => {
    const withReason = { ...locked, reason: "within 30 minutes of the GW1 deadline" };
    expect(describeMode("locked", withReason as AgentStatus))
      .toBe("within 30 minutes of the GW1 deadline");
  });
});

describe("one clock for one deadline", () => {
  /**
   * `schedule.py:362` writes `GW1 deadline in 71.0h; nothing due yet`, stamped when the
   * agent ran. The board rendered that beside a countdown recomputed from the same
   * deadline on every tick, so hours later the screen showed a frozen "71.0h" next to a
   * live "2d 23h" — two clocks for one deadline, one of them wrong.
   */
  it("drops the frozen duration and keeps the producer's explanation", () => {
    expect(reasonWithoutCountdown("GW1 deadline in 71.0h; nothing due yet"))
      .toBe("Nothing due yet");
  });

  it("handles the days-away form the same way", () => {
    expect(reasonWithoutCountdown("GW3 deadline is 9 days away")).toBeNull();
  });

  it("returns null when the duration was the whole sentence", () => {
    // schedule.py:315 and :324 write exactly this, with no clause after it.
    expect(reasonWithoutCountdown("GW1 deadline in 3.2h")).toBeNull();
  });

  it("leaves a reason of any other shape untouched", () => {
    // It trims a known prefix; it does not try to parse prose.
    for (const reason of [
      "GW1 is already sealed",
      "GW2 is settled but not scored",
      "within 30 minutes of the GW1 deadline",
    ]) {
      expect(reasonWithoutCountdown(reason)).toBe(reason);
    }
  });

  it("passes null through, so an absent reason stays absent", () => {
    expect(reasonWithoutCountdown(null)).toBeNull();
  });

  it("agrees with the shipped artifact, which is what prompted this", () => {
    expect(reasonWithoutCountdown("GW1 deadline in 71.0h; nothing due yet"))
      .not.toMatch(/71/);
  });
});
