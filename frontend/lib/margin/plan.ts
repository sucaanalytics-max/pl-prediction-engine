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
import type { Projection } from "@/lib/data/projections";

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

export interface PlanGridModel {
  readonly weeks: readonly HorizonWeek[];
  readonly rows: readonly PlanRow[];
  /** Weeks transfers were planned into, of the total evaluated. */
  readonly transferHorizon: number;
  readonly evalHorizon: number;
  /** Rows whose name could not be resolved, so the grid can say so. */
  readonly unnamed: number;
}

/** GK → DEF → MID → FWD, as every FPL surface reads. */
const ORDER: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

export function cellsFor(
  elementId: number, weeks: readonly HorizonWeek[],
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
  horizon: Horizon, projections: readonly Projection[],
): PlanGridModel {
  const byId = new Map<number, Projection>();
  for (const p of projections) byId.set(p.elementId, p);

  const ids = new Set<number>();
  for (const week of horizon.weeks) for (const id of week.squad) ids.add(id);

  let unnamed = 0;
  const rows: PlanRow[] = [...ids].map((elementId) => {
    const projection = byId.get(elementId);
    if (!projection?.name) unnamed += 1;
    const cells = cellsFor(elementId, horizon.weeks);
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
