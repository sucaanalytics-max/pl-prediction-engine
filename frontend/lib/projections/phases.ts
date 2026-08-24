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
      out.push({
        teamId: row.teamId,
        team: row.team,
        shortName: row.shortName,
        fromIndex: i,
        toIndex: j,
        fromGameweek: span[0].gameweek,
        toGameweek: span[span.length - 1].gameweek,
        length,
        meanDifficulty: mean(span.map((w) => w.difficulty as number)),
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
      phases: findPhases(row, weeks, options),
      // Over the weeks the club PLAYS. Averaging a blank as zero would rank an
      // idle club as having the kindest month in the league.
      meanDifficulty: played.length === 0 ? null : mean(played),
    };
  });
}

/**
 * The longest phase a club has, then the kindest.
 *
 * Length first because a phase's value is how long you can leave a player
 * alone; mean difficulty breaks ties, since two four-week runs are separated by
 * how soft they are and by nothing else here.
 */
export function bestPhase(club: ClubRow): Phase | null {
  return club.phases.reduce<Phase | null>((best, phase) => {
    if (best === null) return phase;
    if (phase.length !== best.length) return phase.length > best.length ? phase : best;
    return phase.meanDifficulty < best.meanDifficulty ? phase : best;
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
    return y.length - x.length || x.meanDifficulty - y.meanDifficulty;
  });
}

/** Every club's phases in one list, longest and kindest first. */
export function allPhases(clubs: readonly ClubRow[]): Phase[] {
  return clubs
    .flatMap((club) => club.phases)
    .sort((a, b) => b.length - a.length || a.meanDifficulty - b.meanDifficulty);
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
  const clamped = Math.max(KINDEST, Math.min(HARDEST, difficulty));
  // 1 -> steps-1 (brightest), 5 -> 0 (dimmest).
  return Math.round(((HARDEST - clamped) / (HARDEST - KINDEST)) * (steps - 1));
}
