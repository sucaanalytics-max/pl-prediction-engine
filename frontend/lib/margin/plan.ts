/**
 * The solved horizon as a grid: one row per player, one column per gameweek.
 *
 * ## Where this comes from, and why the screen said it did not exist
 *
 * `ScoreView` shipped with the headline *"There is no eight-week plan, and this
 * screen will not draw one."* That was true of every artifact anyone had looked
 * at, and false of the one it was already reading.
 *
 * `pipeline/decide/horizon.py` solves the squad over `eval_horizon` weeks and
 * plans transfers for the first `transfer_horizon` — eight and six by default —
 * and `run_decide.py` puts the result straight into `decision_public`:
 * `decision.plan` is week 0, `horizon.provisional[]` is the rest, each carrying
 * `squad`, `xi`, `captain`, `vice`, `transfers_in`, `transfers_out`, `hits`,
 * `bank_after` and `free_transfers_after`. `strip_for_publication` drops the
 * runners-up and the selection stream and keeps all of it.
 *
 * So this is the same class of defect as the phantom design tokens and the
 * dropped narrower fields: **published, and never read.** Nothing here is
 * derived from a solve that did not happen.
 *
 * ## What is still not drawn
 *
 * The design carries `mean, simulated` and `sd` rows across the top and bottom.
 * The producer publishes a per-week `objective`, which is a MILP objective value
 * — bench-weighted, vice-weighted, carrying the banked-free-transfer credit, and
 * summed across the horizon. It is not a simulated mean and the two are not
 * interchangeable, so those rows render their absence rather than an objective
 * relabelled as points.
 *
 * `autosub_risk` is likewise not published, so the design's amber under-dot has
 * no source and is not drawn.
 */

import type { Horizon, HorizonWeek } from "@/lib/data/narrow";
import type { Horizon as XpHorizon, Projection } from "@/lib/data/projections";

/** What one player does in one gameweek. */
export interface Cell {
  readonly gameweek: number;
  readonly captain: boolean;
  readonly vice: boolean;
  /** In the XI and not the captain — the filled square. */
  readonly start: boolean;
  readonly bench: boolean;
  /**
   * Not in the squad that week.
   *
   * The hatch, never an empty cell. An empty cell reads as "picked, and scored
   * nothing", which is the opposite of what a sale means.
   */
  readonly off: boolean;
  readonly enter: boolean;
  readonly exit: boolean;
  /**
   * Expected points for this player in this week, or null.
   *
   * Null is never zero. Zero is a forecast of nothing; null is the absence of a
   * forecast, and the two are a transfer decision apart. The horizon block drops
   * weeks it has no readable players for, so absence is a state the producer
   * emits on purpose.
   */
  readonly xp: number | null;
}

export interface PlanRow {
  readonly elementId: number;
  /** From the projection, or `#id` when the projection has no view of them. */
  readonly name: string;
  readonly position: string;
  readonly cells: readonly Cell[];
  /** `4/8` — weeks started, over weeks in the horizon. */
  readonly starts: string;
}

/**
 * One column's footer.
 *
 * `xp` is the plain sum of the ELEVEN, with no captain doubling and no bench.
 * That is what makes it checkable: a reader can add the column up and get this
 * number. The producer's own per-week `objective` is bench-weighted,
 * vice-weighted and carries the banked-free-transfer credit, so it is a
 * different quantity — printing it here under a points heading is the
 * relabelling this file has always refused.
 *
 * `missing` is published beside it because a total two players short is a wrong
 * number, not a partial one, and only the footer can say which it is.
 */
export interface WeekTotal {
  readonly gameweek: number;
  readonly xp: number;
  readonly counted: number;
  readonly missing: number;
}

export interface PlanGridModel {
  readonly weeks: readonly HorizonWeek[];
  readonly rows: readonly PlanRow[];
  /** Weeks transfers were planned into, of the total evaluated. */
  readonly transferHorizon: number;
  readonly evalHorizon: number;
  /** Rows whose name could not be resolved, so the grid can say so. */
  readonly unnamed: number;
  /** One per week, in the same order as `weeks`. */
  readonly totals: readonly WeekTotal[];
}

/** GK → DEF → MID → FWD, as every FPL surface reads. */
const ORDER: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

/**
 * Where a cell's number comes from, given the player and the week.
 *
 * A function rather than a table, because the two sources are not
 * interchangeable: the decided gameweek's number is the projection row's own,
 * simulated at the decision's draw count, and every later week comes off the
 * horizon block at its own lower count. {@link xpResolver} builds the one this
 * grid uses; `cellsFor` stays agnostic so its own tests need no artifact.
 */
export type XpFor = (elementId: number, gameweek: number) => number | null;

/**
 * The number for one player in one week, from the right producer.
 *
 * The first week is the decided one and takes the projection's `xp`.
 * `lib/data/projections.ts` states why the horizon block deliberately omits it:
 * "two numbers for the same player in the same week would be indistinguishable
 * on screen", and the row's own is the higher-fidelity of the two.
 *
 * Later weeks join on GAMEWEEK, never on column index. An index join reads
 * correctly whenever the horizon starts where the plan starts, and shifts every
 * number one column the moment it does not — a wrong number under a right
 * heading, which is the shape of mistake nobody re-checks.
 */
export function xpResolver(
  weeks: readonly HorizonWeek[],
  projections: readonly Projection[],
  xpHorizon: XpHorizon | null,
): XpFor {
  const own = new Map<number, number | null>();
  for (const p of projections) own.set(p.elementId, p.xp);

  const later = new Map<number, ReadonlyMap<number, number>>();
  for (const week of xpHorizon?.weeks ?? []) later.set(week.gameweek, week.xp);

  const decided = weeks[0]?.gameweek ?? null;
  return (elementId, gameweek) =>
    gameweek === decided
      ? own.get(elementId) ?? null
      : later.get(gameweek)?.get(elementId) ?? null;
}

export function cellsFor(
  elementId: number, weeks: readonly HorizonWeek[], xpFor: XpFor = () => null,
): readonly Cell[] {
  return weeks.map((week) => {
    const captain = week.captain === elementId;
    const inXi = week.xi.includes(elementId);
    const bench = week.bench.includes(elementId);
    return {
      gameweek: week.gameweek,
      captain,
      vice: week.vice === elementId,
      // The captain gets a ring and nothing else. A ring over a filled square
      // is two marks for one fact and reads as a different state.
      start: inXi && !captain,
      bench,
      off: !inXi && !bench,
      enter: week.transfers_in.includes(elementId),
      exit: week.transfers_out.includes(elementId),
      xp: xpFor(elementId, week.gameweek),
    };
  });
}

/**
 * Every player who appears in any week, in reading order.
 *
 * The union rather than week 0's squad: a player bought in GW5 belongs on the
 * grid from the row's start as a hatched run, and one sold in GW3 belongs on it
 * to the end. Showing only the current fifteen would hide exactly the transfers
 * the screen exists to plan.
 */
export function buildPlanGrid(
  horizon: Horizon,
  projections: readonly Projection[],
  xpHorizon: XpHorizon | null = null,
): PlanGridModel {
  const byId = new Map<number, Projection>();
  for (const p of projections) byId.set(p.elementId, p);

  const ids = new Set<number>();
  for (const week of horizon.weeks) for (const id of week.squad) ids.add(id);

  const xpFor = xpResolver(horizon.weeks, projections, xpHorizon);

  let unnamed = 0;
  const rows: PlanRow[] = [...ids].map((elementId) => {
    const projection = byId.get(elementId);
    if (!projection?.name) unnamed += 1;
    const cells = cellsFor(elementId, horizon.weeks, xpFor);
    const started = cells.filter((c) => c.start || c.captain).length;
    return {
      elementId,
      // `#412` rather than a guessed name. `decision_public` publishes ids and
      // the name table lives in the projection; when the two disagree about a
      // player the honest render is the id, not another player's name.
      name: projection?.name ?? `#${elementId}`,
      position: projection?.position ?? "",
      cells,
      starts: `${started}/${horizon.weeks.length}`,
    };
  });

  rows.sort((a, b) => {
    const line = (ORDER[a.position] ?? 9) - (ORDER[b.position] ?? 9);
    if (line !== 0) return line;
    return a.name.localeCompare(b.name);
  });

  return {
    weeks: horizon.weeks,
    rows,
    transferHorizon: horizon.transferHorizon,
    evalHorizon: horizon.evalHorizon,
    unnamed,
    totals: horizon.weeks.map((week) => totalFor(week, xpFor)),
  };
}

/**
 * One week's XI total.
 *
 * Rounded to four places on the way out. The summands arrive already rounded by
 * the producer, so adding eleven of them accumulates binary float error into a
 * tail the reader can see — 13.750000000000002 under a heading that claims to
 * be checkable by eye.
 */
export function totalFor(week: HorizonWeek, xpFor: XpFor): WeekTotal {
  let xp = 0;
  let counted = 0;
  for (const elementId of week.xi) {
    const value = xpFor(elementId, week.gameweek);
    if (value === null) continue;
    xp += value;
    counted += 1;
  }
  return {
    gameweek: week.gameweek,
    xp: Math.round(xp * 1e4) / 1e4,
    counted,
    missing: week.xi.length - counted,
  };
}

/**
 * The transfers made in a week, as names.
 *
 * Kept beside the grid because the cell marks say *that* a move happened and
 * not *what* it was, and a plan you cannot read the moves out of is a picture
 * rather than a plan.
 */
export function movesFor(
  week: HorizonWeek, rows: readonly PlanRow[],
): { readonly out: readonly string[]; readonly in: readonly string[] } {
  const name = (id: number) =>
    rows.find((r) => r.elementId === id)?.name ?? `#${id}`;
  return {
    out: week.transfers_out.map(name),
    in: week.transfers_in.map(name),
  };
}
