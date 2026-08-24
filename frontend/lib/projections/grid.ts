/**
 * The projection grid: every player a row, the next eight gameweeks the columns.
 *
 * This is the screen the references put front and centre, and the arithmetic is
 * deliberately thin — a cell is a published number and a total is a sum of
 * published numbers. Nothing here fits, solves or infers.
 *
 * ## What a cell is, and is not
 *
 * The first column is the current gameweek's `xp` from `xp_public`, simulated on
 * the decision's draw count. Every later column comes from that file's `horizon`
 * block, simulated with fewer draws. They are the same machinery at different
 * precision, so a row is comparable across itself — but a total that spans both
 * is a mixed-precision number and {@link gridSummary} says so out loud rather
 * than letting the grid imply one uniform measurement.
 *
 * A cell is NOT a start, a bench or a sale. That distinction is the one this file
 * must not blur: `PlanGrid` draws the solved schedule from the decision
 * artifact's own horizon, and a schedule assembled here by sorting per-week
 * projections would be the most convincing fabrication in the app — laid out with
 * a solver's authority by something that never solved anything. The run marker
 * below is a statement about a player's own cells and says nothing about whether
 * he is in anybody's eleven.
 *
 * ## Absence is not zero
 *
 * A player can be missing from a horizon week: the producer publishes a view for
 * the players it projected, and `Horizon`'s own contract is that an absent player
 * has no view rather than a zero. Summing a missing week as zero understates a
 * player who simply was not priced that week; dropping the week and dividing by
 * fewer weeks overstates him against a rival who played them all. So a total
 * carries {@link GridRow.weeksCounted}, and a row short of its span is marked
 * partial for the screen to render differently. Neither number is invented.
 */

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import type { Horizon, Projection } from "@/lib/data/projections";
import { HEAT } from "@/lib/margin/tokens";

/**
 * How many bands the heat ramp has, taken from the ramp itself.
 *
 * Derived rather than declared so the two cannot drift: a `findRuns` threshold
 * computed from a stale step count would mark runs against bands that no longer
 * exist, and the grid would look plausible while measuring nothing.
 */
export const HEAT_STEPS = HEAT.length;

/** How many gameweeks the grid can show. The fixture matrix publishes eight. */
export const GRID_WEEKS = 8;

/** The spans the total column can cover. Two is the shortest useful question. */
export const SPANS = [2, 3, 4, 5, 6, 7, 8] as const;
export type Span = (typeof SPANS)[number];

/**
 * The ceiling the absolute heat scale measures against.
 *
 * Seven points in one gameweek is roughly a goal from a midfielder plus the
 * appearance, and in practice the top of the projected range: the highest single
 * cell in the GW2 artifact is under seven. Fixed rather than derived from the
 * rows on screen, because a per-row or per-page maximum makes every list look
 * equally strong — a page of defenders would light up as brightly as a page of
 * strikers, and the colour would be measuring the filter rather than the player.
 */
export const ABSOLUTE_CEILING = 7;

/** A band index into the heat ramp, or null when the week has no view. */
export type Band = number | null;

export interface GridCell {
  readonly gameweek: number;
  /** Projected points, or null when this player has no view for the week. */
  readonly xp: number | null;
  /** e.g. `COV (H)`, from FPL's own fixture list. Null when unknown. */
  readonly fixture: string | null;
  /** FPL's 1–5 rating for THIS club in this fixture. Not a model output. */
  readonly difficulty: number | null;
  /** True when the club plays twice; the label carries both. */
  readonly doubleGameweek: boolean;
  /** True when the club is idle — a blank, which is different from a zero. */
  readonly blank: boolean;
}

export interface GridRow {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
  readonly position: string;
  readonly cells: readonly GridCell[];
  /** Sum of the cells inside the chosen span. Null when none had a view. */
  readonly total: number | null;
  /** How many of the span's weeks actually contributed to `total`. */
  readonly weeksCounted: number;
  /** `weeksCounted < span` — the total covers less than it is labelled. */
  readonly partial: boolean;
  /** P(≥10) for the current gameweek, the one tail the artifact publishes. */
  readonly pGe10: number | null;
  /** In the squad currently on file. */
  readonly owned: boolean;
  /** Index pairs, inclusive, of runs of three or more strong weeks. */
  readonly runs: readonly (readonly [number, number])[];
}

/**
 * The fixture label and difficulty for one club, by gameweek.
 *
 * Keyed on the club name as `xp_public` spells it, with the short name as a
 * second key: the projection says `Man Utd` where a fixture row may say
 * `Manchester United`, and a join that silently misses leaves a whole club's
 * column blank — which reads as "no fixture" rather than "not joined".
 */
export function fixtureIndex(
  matrix: readonly FixtureMatrixRow[],
): ReadonlyMap<string, ReadonlyMap<number, GridCell[]>> {
  const out = new Map<string, Map<number, GridCell[]>>();
  for (const row of matrix) {
    const byWeek = new Map<number, GridCell[]>();
    for (const fixture of row.fixtures) {
      const list = byWeek.get(fixture.gameweek) ?? [];
      list.push({
        gameweek: fixture.gameweek,
        xp: null,
        fixture: fixture.label,
        difficulty: fixture.difficulty,
        doubleGameweek: false,
        blank: false,
      });
      byWeek.set(fixture.gameweek, list);
    }
    for (const key of [row.team, row.shortName]) {
      if (key) out.set(key.toLowerCase(), byWeek);
    }
  }
  return out;
}

/** The gameweeks the grid covers, current first. */
export function gridWeeks(current: number, horizon: Horizon | null): number[] {
  const weeks = [current];
  for (const week of horizon?.weeks ?? []) {
    if (week.gameweek > current && weeks.length < GRID_WEEKS) {
      weeks.push(week.gameweek);
    }
  }
  return weeks;
}

/**
 * Runs of three or more consecutive strong weeks.
 *
 * "Strong" is the top two bands of whatever scale is in force, which is why the
 * bands are the input rather than the raw points: under the per-week scale a run
 * means three weeks of being among the best available, and under the absolute
 * scale it means three weeks above roughly four points. Those are different
 * claims, and the caller chooses which one the screen is making.
 *
 * A week with no view breaks a run rather than extending it. A player who is not
 * projected for a gameweek has not been shown to be strong in it.
 */
export function findRuns(bands: readonly Band[], steps: number): (readonly [number, number])[] {
  // `steps` is the ramp's LENGTH, and bands are zero-indexed, so the top two are
  // `steps - 2` and `steps - 1`. Naming this parameter `topBand` once made the
  // threshold `steps - 1`, which is the top band alone — a stricter rule than the
  // one documented above, and one that hid runs the screen promises to show.
  const strong = (i: number) => bands[i] !== null && (bands[i] as number) >= steps - 2;
  const out: (readonly [number, number])[] = [];
  let i = 0;
  while (i < bands.length) {
    if (!strong(i)) { i += 1; continue; }
    let j = i;
    while (j + 1 < bands.length && strong(j + 1)) j += 1;
    if (j - i + 1 >= 3) out.push([i, j] as const);
    i = j + 1;
  }
  return out;
}

/** The band a value falls in, on a ramp of `steps` against `ceiling`. */
export function bandOf(xp: number | null, ceiling: number, steps: number): Band {
  if (xp === null) return null;
  const t = Math.max(0, Math.min(1, xp / (ceiling || 1)));
  return Math.min(steps - 1, Math.floor(t * steps));
}

export interface GridInput {
  readonly players: readonly Projection[];
  readonly horizon: Horizon | null;
  readonly currentGameweek: number;
  readonly fixtures: readonly FixtureMatrixRow[];
  /** Element ids in the squad on file, for the "my squad" filter. */
  readonly ownedIds: ReadonlySet<number>;
  readonly span: Span;
}

/**
 * One row per projected player, cells filled from the artifact.
 *
 * Unsorted and unfiltered: sorting depends on the span and filtering on controls
 * the caller owns, and both are cheap to apply over the result. What is expensive
 * and worth doing once is the fixture join.
 */
export function buildGridRows(input: GridInput): GridRow[] {
  const weeks = gridWeeks(input.currentGameweek, input.horizon);
  const byWeek = new Map<number, ReadonlyMap<number, number>>();
  for (const week of input.horizon?.weeks ?? []) byWeek.set(week.gameweek, week.xp);
  const fixtures = fixtureIndex(input.fixtures);

  return input.players.map((player) => {
    const clubFixtures =
      fixtures.get((player.team ?? "").toLowerCase()) ?? new Map<number, GridCell[]>();

    const cells: GridCell[] = weeks.map((gameweek, index) => {
      const xp = index === 0
        ? player.xp
        : byWeek.get(gameweek)?.get(player.elementId) ?? null;
      const played = clubFixtures.get(gameweek) ?? [];
      return {
        gameweek,
        xp,
        fixture: played.length === 0
          ? null
          : played.map((f) => f.fixture).filter(Boolean).join(" · "),
        // The kindest of a double is not the fixture; the pair is. Difficulty is
        // only meaningful for a single, so a double reports none rather than an
        // average of two ratings FPL never averaged.
        difficulty: played.length === 1 ? played[0].difficulty : null,
        doubleGameweek: played.length > 1,
        blank: played.length === 0,
      };
    });

    const inSpan = cells.slice(0, input.span);
    const counted = inSpan.filter((cell) => cell.xp !== null);
    const total = counted.length === 0
      ? null
      : counted.reduce((sum, cell) => sum + (cell.xp as number), 0);

    return {
      elementId: player.elementId,
      name: player.name ?? `#${player.elementId}`,
      team: player.team ?? "—",
      position: player.position ?? "—",
      cells,
      total,
      weeksCounted: counted.length,
      partial: counted.length < inSpan.length,
      pGe10: player.pGe10,
      owned: input.ownedIds.has(player.elementId),
      runs: [],
    };
  });
}

/**
 * The provenance line under the controls.
 *
 * Names both draw counts because the total column mixes them. A reader comparing
 * two players over eight weeks is comparing sums that are each part
 * high-precision and part low-precision, and that is fine — but it has to be
 * visible, not inferred from a docstring nobody on the screen can read.
 */
export function gridSummary(
  shown: number, pool: number, nDraws: number | null, horizonDraws: number | null,
  current: number, weeks: readonly number[],
): string {
  const span = weeks.length > 1
    ? `GW${current} on ${fmt(nDraws)} draws, GW${weeks[1]}–${weeks[weeks.length - 1]} on ${fmt(horizonDraws)}`
    : `GW${current} on ${fmt(nDraws)} draws`;
  return `${shown} of ${pool} · ${span}`;
}

function fmt(value: number | null): string {
  return value === null ? "an unstated number of" : value.toLocaleString("en-GB");
}
