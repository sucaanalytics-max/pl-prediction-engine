/**
 * Fixture phases — the runs of kind fixtures worth hopping on and off for.
 *
 * A phase is a string of consecutive gameweeks in which a club's fixtures are all
 * at or below a difficulty threshold. It answers the question a manager asks when
 * a transfer is worth two weeks of patience: not "who is good this week" but
 * "whose next month is soft enough to buy into now".
 *
 * ## The number here is FPL's, and it is not a projection
 *
 * `difficulty` is FPL's own 1–5 rating for THIS club in this fixture — 1 kind, 5
 * unkind. It is not a model output, it is not calibrated against anything this
 * repo has measured, and it is not expected points. What earns it a screen is
 * that a fixture list is the one part of a horizon that is KNOWN rather than
 * forecast: the schedule is published, and the only judgement in it is FPL's.
 *
 * So nothing in this file produces or implies a points forecast. A phase says
 * "these weeks are soft"; the projection grid says what a player is worth in
 * them. Combining the two into a single "expected return from this phase" would
 * be a forecast nobody simulated, and it is deliberately absent.
 *
 * ## Two things break a phase, and neither is a bad fixture
 *
 * A BLANK gameweek breaks it. A club with no fixture cannot be hopped on for that
 * week, and treating a blank as kind — which a naive "difficulty is absent, so
 * not above the threshold" check does — invents the softest possible week out of
 * a week that does not exist.
 *
 * A DOUBLE gameweek qualifies only if EVERY fixture in it is within the
 * threshold, and the week's difficulty is the worst of them. A double of one kind
 * and one brutal fixture is not a kind week, and taking the kinder of the two
 * would make the hardest weeks in the season look like the softest.
 */

import type { FixtureMatrixRow } from "@/lib/data/heuristics";

/** FPL's scale. 1 is the kindest fixture, 5 the unkindest. */
export const HARDEST = 5;
export const KINDEST = 1;

/** The run lengths the screen offers. Three is the shortest thing worth a plan. */
export const RUN_LENGTHS = [3, 4, 5] as const;
export type RunLength = (typeof RUN_LENGTHS)[number];

/**
 * The thresholds the screen offers, as FPL's own numbers.
 *
 * Labelled by what they mean rather than by a count of clubs: FPL assigns these
 * per fixture, not by ranking the league, so "the top four" is a claim about
 * league position that a difficulty rating does not make.
 */
export const THRESHOLDS = [
  { max: 2, label: "kind (FDR 1–2)" },
  { max: 3, label: "not hard (FDR 1–3)" },
] as const;

/**
 * The threshold the screen opens on.
 *
 * Named rather than taken as `THRESHOLDS[0]`, because the array is ordered
 * kindest-first — which is the right order for a toggle and the wrong one for a
 * default. Opening on the strictest setting meant opening on an empty screen:
 * measured against the published 2026/27 list over its eight-week horizon,
 * FDR <= 2 yields exactly ONE qualifying run in the entire league, and the reader
 * arrives at a matrix that appears broken.
 *
 * That is a fact about the fixture list rather than about the code. FPL never
 * assigns a 1, and FDR 3 is 45% of all fixtures (2:44, 3:72, 4:36, 5:8 over 160),
 * so "every week at 2 or kinder for three straight weeks" is close to the rarest
 * thing the schedule contains. FDR <= 3 yields seventeen runs, which is a board
 * worth reading — and relief is what separates them, so the wider gate no longer
 * costs the discrimination it used to: a run of flat 3s scores near zero and sorts
 * to the bottom on its own.
 */
export const DEFAULT_MAX_DIFFICULTY = 3;

export interface PhaseWeek {
  readonly gameweek: number;
  /** Every fixture the club plays that week, as FPL labels them. */
  readonly labels: readonly string[];
  /** The worst difficulty of the week's fixtures. Null when the club is idle. */
  readonly difficulty: number | null;
  readonly blank: boolean;
  readonly doubleGameweek: boolean;
}

export interface Phase {
  readonly teamId: number;
  readonly team: string;
  readonly shortName: string;
  /** Indices into the club's week list, inclusive. */
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromGameweek: number;
  readonly toGameweek: number;
  readonly length: number;
  /** Mean of the weeks' difficulties. Lower is kinder. */
  readonly meanDifficulty: number;
  /** The hardest week inside the run. A mean hides one brutal week; this does not. */
  readonly worstDifficulty: number;
  /**
   * How much easier than an average fixture this run is, summed over its weeks.
   *
   * `sum(leagueMean - difficulty)`, in FDR points. This is the figure that ranks a
   * phase, and it exists because length alone ranked them wrongly. Measured on the
   * published 2026/27 list at the screen's default settings, nineteen pairs had a
   * LONGER run outranking one kinder by more than half a point of FDR — the worst
   * being Man United's GW5-8 `[3,3,3,3]` above Fulham's GW6-8 `[2,2,2]`. Four weeks
   * at exactly the league average is not an edge, and relief says so: it scores
   * +0.20 against Fulham's +3.15.
   *
   * It trades length against kindness the way a manager does, because a week only
   * adds to it by being easier than average. A run of average fixtures, however
   * long, approaches zero rather than accumulating.
   */
  readonly relief: number;
  readonly weeks: readonly PhaseWeek[];
}

export interface ClubRow {
  readonly teamId: number;
  readonly team: string;
  readonly shortName: string;
  readonly weeks: readonly PhaseWeek[];
  readonly phases: readonly Phase[];
  /** Mean difficulty across every week the club actually plays. */
  readonly meanDifficulty: number | null;
}

/**
 * One club's gameweeks, in order, with doubles folded into a single week.
 *
 * `gameweeks` is passed in rather than derived from the club's own fixtures so
 * that every row spans the same columns: a club with a blank in GW5 must still
 * have a GW5 cell, or its later fixtures shift left and every row after it lines
 * up under the wrong week.
 */
export function clubWeeks(
  row: FixtureMatrixRow, gameweeks: readonly number[],
): PhaseWeek[] {
  return gameweeks.map((gameweek) => {
    const played = row.fixtures.filter((f) => f.gameweek === gameweek);
    return {
      gameweek,
      labels: played.map((f) => f.label),
      difficulty: played.length === 0
        ? null
        : Math.max(...played.map((f) => f.difficulty)),
      blank: played.length === 0,
      doubleGameweek: played.length > 1,
    };
  });
}

/** The gameweeks the matrix spans: every week any club has a fixture in. */
export function matrixGameweeks(rows: readonly FixtureMatrixRow[]): number[] {
  const seen = new Set<number>();
  for (const row of rows) for (const f of row.fixtures) seen.add(f.gameweek);
  return [...seen].sort((a, b) => a - b);
}

export interface PhaseOptions {
  readonly minLength: RunLength;
  /** Inclusive: a week qualifies when its worst fixture is at most this. */
  readonly maxDifficulty: number;
  /**
   * The difficulty a run is scored against, normally the league's own mean.
   *
   * Measured rather than assumed: `buildClubRows` computes it from the fixtures it
   * was given. On the published 2026/27 list it is 3.05, because FPL's ratings are
   * not uniform over 1-5 — the observed spread is 2:44, 3:72, 4:36, 5:8 and a 1 is
   * never assigned at all. Hardcoding the scale's midpoint of 3 would call an
   * average fixture a small relief, and a whole season of them a large one.
   */
  readonly reference?: number;
}

/**
 * The mean difficulty across every published fixture in the matrix.
 *
 * The yardstick a phase's relief is measured against. Derived from the data so a
 * kinder or harsher season moves it, rather than fixed at the scale's midpoint.
 */
export function leagueMeanDifficulty(rows: readonly FixtureMatrixRow[]): number {
  const all = rows.flatMap((row) => row.fixtures.map((f) => f.difficulty));
  return all.length === 0 ? 3 : mean(all);
}

/** Every qualifying phase in one club's week list. */
export function findPhases(
  row: FixtureMatrixRow, weeks: readonly PhaseWeek[], options: PhaseOptions,
): Phase[] {
  const kind = (week: PhaseWeek) =>
    week.difficulty !== null && week.difficulty <= options.maxDifficulty;

  /**
   * Consecutive GAMEWEEKS, not consecutive columns.
   *
   * The two are the same only when the matrix has a column for every week, which
   * is true of a full twenty-club fixture list and false of a partial one: with
   * GW3 missing entirely, GW2 and GW4 become neighbours in the array and a run
   * would be claimed across a week nobody has a fixture for. Checking the numbers
   * makes the result independent of which columns happen to exist.
   */
  const adjacent = (a: PhaseWeek, b: PhaseWeek) => b.gameweek === a.gameweek + 1;

  const out: Phase[] = [];
  let i = 0;
  while (i < weeks.length) {
    if (!kind(weeks[i])) { i += 1; continue; }
    let j = i;
    while (j + 1 < weeks.length && kind(weeks[j + 1]) && adjacent(weeks[j], weeks[j + 1])) {
      j += 1;
    }
    const length = j - i + 1;
    if (length >= options.minLength) {
      const span = weeks.slice(i, j + 1);
      const difficulties = span.map((w) => w.difficulty as number);
      // Falls back to the scale's midpoint only when no reference was supplied,
      // which is the direct-call case in tests; `buildClubRows` always measures it.
      const reference = options.reference ?? 3;
      out.push({
        teamId: row.teamId,
        team: row.team,
        shortName: row.shortName,
        fromIndex: i,
        toIndex: j,
        fromGameweek: span[0].gameweek,
        toGameweek: span[span.length - 1].gameweek,
        length,
        meanDifficulty: mean(difficulties),
        worstDifficulty: Math.max(...difficulties),
        relief: difficulties.reduce((sum, d) => sum + (reference - d), 0),
        weeks: span,
      });
    }
    i = j + 1;
  }
  return out;
}

/** Every club, with its weeks and its phases. */
export function buildClubRows(
  rows: readonly FixtureMatrixRow[], options: PhaseOptions,
): ClubRow[] {
  const gameweeks = matrixGameweeks(rows);
  // One reference for the whole matrix, so two clubs' phases are comparable.
  const scored: PhaseOptions = {
    ...options,
    reference: options.reference ?? leagueMeanDifficulty(rows),
  };
  return rows.map((row) => {
    const weeks = clubWeeks(row, gameweeks);
    const played = weeks
      .map((w) => w.difficulty)
      .filter((d): d is number => d !== null);
    return {
      teamId: row.teamId,
      team: row.team,
      shortName: row.shortName,
      weeks,
      phases: findPhases(row, weeks, scored),
      // Over the weeks the club PLAYS. Averaging a blank as zero would rank an
      // idle club as having the kindest month in the league.
      meanDifficulty: played.length === 0 ? null : mean(played),
    };
  });
}

/**
 * The phase that buys the most relief, then the longest.
 *
 * This used to rank on length first with mean difficulty as a tiebreak, and that
 * was wrong in a way the fixture list makes obvious. Length only helps if the
 * weeks are actually easier than average: measured on the published 2026/27 list
 * at the screen's defaults, Man United's four-week `[3,3,3,3]` outranked Fulham's
 * three-week `[2,2,2]`, and four weeks at exactly the league average is not a run
 * worth planning around.
 *
 * Relief already contains length — it is a sum over weeks — so ordering by it
 * trades the two against each other instead of letting one dominate. Length
 * survives only as the tiebreak between runs that buy the same total.
 */
export function bestPhase(club: ClubRow): Phase | null {
  return club.phases.reduce<Phase | null>((best, phase) => {
    if (best === null) return phase;
    if (phase.relief !== best.relief) return phase.relief > best.relief ? phase : best;
    return phase.length > best.length ? phase : best;
  }, null);
}

export type PhaseOrder = "phase" | "kindest" | "name";

/** Clubs ordered for the matrix. Clubs with no phase sort last under "phase". */
export function orderClubs(clubs: readonly ClubRow[], order: PhaseOrder): ClubRow[] {
  const copy = clubs.slice();
  if (order === "name") return copy.sort((a, b) => a.team.localeCompare(b.team));
  if (order === "kindest") {
    return copy.sort((a, b) =>
      (a.meanDifficulty ?? HARDEST + 1) - (b.meanDifficulty ?? HARDEST + 1));
  }
  return copy.sort((a, b) => {
    const [x, y] = [bestPhase(a), bestPhase(b)];
    if (x === null && y === null) return a.team.localeCompare(b.team);
    if (x === null) return 1;
    if (y === null) return -1;
    return y.relief - x.relief || y.length - x.length;
  });
}

/** Every club's phases in one list, most relief first. */
export function allPhases(clubs: readonly ClubRow[]): Phase[] {
  return clubs
    .flatMap((club) => club.phases)
    .sort((a, b) => b.relief - a.relief || b.length - a.length);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The heat band for a difficulty, on the same five-step ramp as the grid.
 *
 * INVERTED against the grid on purpose, and this is the one place the two screens
 * disagree about what bright means. In the grid, bright is a high projection. Here
 * bright is a LOW difficulty, because the quantity is a cost rather than a return.
 * Both screens label their scale for exactly this reason.
 */
export function difficultyBand(difficulty: number | null, steps: number): number | null {
  if (difficulty === null) return null;
  const clamped = Math.round(Math.max(KINDEST, Math.min(HARDEST, difficulty)));

  /*
   * Mapped onto the values that OCCUR, not the values the scale defines.
   *
   * FPL's scale runs 1 to 5, and across a whole published fixture list it never
   * once assigns a 1 — the observed distribution is 2:44, 3:72, 4:36, 5:8 over
   * 160 fixtures. A linear 1-to-5 map therefore spends its brightest band on a
   * rating that never happens, and squeezes the four that do into the dimmer
   * four fifths of the ramp. Forty-five percent of the matrix landed on one band.
   *
   * So the ramp has FOUR stops for the four values that occur, and every colour
   * on it appears on screen. FDR 1 shares the top stop with FDR 2: nothing is
   * kinder than the kindest thing on the board, and if FPL ever does publish a 1
   * it reads correctly rather than needing a fifth colour.
   *
   * What this does NOT do is flatten the distribution. FDR 3 is 45% of all
   * fixtures and still lands 45% of the matrix on one colour — because that is
   * the league, not the scale. A ramp fitted to even out those counts would be
   * telling the reader the fixture list is more varied than it is.
   */
  const BY_RATING: Record<number, number> = { 1: 3, 2: 3, 3: 2, 4: 1, 5: 0 };
  const band = BY_RATING[clamped] ?? 2;
  // Scaled if the ramp is ever a different length than the four it is drawn for.
  return steps === 4 ? band : Math.round((band / 3) * (steps - 1));
}
