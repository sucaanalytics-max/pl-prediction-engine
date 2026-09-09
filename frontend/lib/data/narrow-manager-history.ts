/**
 * Runtime narrowing for `fpl/manager_history.json`.
 *
 * ## Why the by-gameweek maps become `Map<number, number | null>`
 *
 * JSON object keys are strings, and three states have to survive the boundary:
 * a key that is **absent** (that gameweek has not settled), a key present with
 * **null** (it settled, but the player had left the squad — the pollution
 * signal), and a key present with a **number**. A `Record<string, number>` with
 * `?? 0` applied anywhere collapses the first two into "scored nothing", which
 * is the opposite conclusion from "not yet played" and from "no longer yours".
 *
 * ## Why `?? 0` is used on some fields and not others
 *
 * The optional readers below return `null` for anything unparseable, and for a
 * *count* — bench points, a multiplier — zero is the right reading of a missing
 * field, because the producer always emits it and a drift should degrade to the
 * neutral value rather than blank the row. For *points* it is not: a player can
 * score −1, and Thiaw did in GW3, so `points` is read with `optNumber` and kept
 * even when negative. `||` would have eaten that; `??` does not.
 */
import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  Problems,
  mapKept,
  optNumber,
  optString,
  reqArray,
  reqNumber,
  reqRecord,
} from "@/lib/data/check";

export interface ManagerPick {
  readonly element: number;
  readonly multiplier: number;
  readonly points: number;
  readonly minutes: number;
}

export interface ManagerAutoSub {
  readonly elementIn: number;
  readonly elementOut: number;
  readonly pointsGained: number;
}

export interface ManagerCaptain {
  readonly element: number;
  readonly multiplier: number;
  readonly points: number;
}

export interface ManagerGameweek {
  readonly event: number;
  readonly points: number;
  readonly grossPoints: number;
  readonly transferCost: number;
  readonly transfersMade: number;
  readonly benchPoints: number;
  readonly averageEntryScore: number | null;
  readonly highestScore: number | null;
  readonly rank: number | null;
  readonly overallRank: number | null;
  readonly value: number | null;
  readonly bank: number | null;
  readonly chip: string | null;
  readonly captain: ManagerCaptain | null;
  readonly autoSubs: readonly ManagerAutoSub[];
  readonly picks: readonly ManagerPick[];
}

export interface ManagerTransfer {
  readonly event: number;
  readonly time: string | null;
  readonly elementIn: number;
  readonly elementInCost: number | null;
  readonly elementOut: number;
  readonly elementOutCost: number | null;
  readonly inPointsByGw: ReadonlyMap<number, number>;
  readonly outPointsByGw: ReadonlyMap<number, number>;
  readonly inMultiplierByGw: ReadonlyMap<number, number | null>;
}

export interface ManagerHistory {
  readonly generatedAt: string | null;
  readonly entryId: number | null;
  readonly settledThrough: number | null;
  readonly gameweeks: readonly ManagerGameweek[];
  readonly transfers: readonly ManagerTransfer[];
}

/** A by-gameweek map. Absent stays absent; null stays null. */
function gwMap(
  raw: unknown, label: string, problems: Problems,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const record = reqRecord(raw, label, problems);
  if (!record) return out;
  for (const [key, value] of Object.entries(record)) {
    const gameweek = Number(key);
    if (!Number.isFinite(gameweek)) {
      problems.add(`${label} has a non-numeric gameweek key ${key}`);
      continue;
    }
    out.set(gameweek, value === null ? null : optNumber(value));
  }
  return out;
}

/** As {@link gwMap}, for maps where null is not a legal value. */
function gwPoints(
  raw: unknown, label: string, problems: Problems,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [gameweek, value] of gwMap(raw, label, problems)) {
    if (value === null) {
      problems.add(`${label} has a null at GW${gameweek}; points are never null`);
      continue;
    }
    out.set(gameweek, value);
  }
  return out;
}

export function narrowManagerHistory(raw: unknown): NarrowResult<ManagerHistory> {
  const problems = new Problems();
  const file = reqRecord(raw, "manager_history", problems);
  if (!file) return malformed(problems.all);

  const gameweekList = reqArray(file.gameweeks, "gameweeks", problems);
  const transferList = reqArray(file.transfers, "transfers", problems);
  if (!gameweekList || !transferList) return malformed(problems.all);

  const gameweeks = mapKept(gameweekList, "gameweeks", problems, (item, i) => {
    const row = reqRecord(item, `gameweeks[${i}]`, problems);
    if (!row) return null;
    const event = reqNumber(row.event, `gameweeks[${i}].event`, problems);
    const points = reqNumber(row.points, `gameweeks[${i}].points`, problems);
    if (event === null || points === null) return null;

    const captainRaw = row.captain;
    const captainRow = captainRaw === null || captainRaw === undefined
      ? null
      : reqRecord(captainRaw, `gameweeks[${i}].captain`, problems);

    const autoSubs = mapKept(
      Array.isArray(row.auto_subs) ? row.auto_subs : [],
      `gameweeks[${i}].auto_subs`, problems,
      (s, j) => {
        const sub = reqRecord(s, `gameweeks[${i}].auto_subs[${j}]`, problems);
        if (!sub) return null;
        return {
          elementIn: optNumber(sub.element_in) ?? 0,
          elementOut: optNumber(sub.element_out) ?? 0,
          pointsGained: optNumber(sub.points_gained) ?? 0,
        } satisfies ManagerAutoSub;
      },
    );

    const picks = mapKept(
      Array.isArray(row.picks) ? row.picks : [],
      `gameweeks[${i}].picks`, problems,
      (p, j) => {
        const pick = reqRecord(p, `gameweeks[${i}].picks[${j}]`, problems);
        if (!pick) return null;
        const element = reqNumber(
          pick.element, `gameweeks[${i}].picks[${j}].element`, problems,
        );
        if (element === null) return null;
        return {
          element,
          multiplier: optNumber(pick.multiplier) ?? 0,
          points: optNumber(pick.points) ?? 0,
          minutes: optNumber(pick.minutes) ?? 0,
        } satisfies ManagerPick;
      },
    );

    return {
      event,
      points,
      grossPoints: optNumber(row.gross_points) ?? points,
      transferCost: optNumber(row.transfer_cost) ?? 0,
      transfersMade: optNumber(row.transfers_made) ?? 0,
      benchPoints: optNumber(row.bench_points) ?? 0,
      averageEntryScore: optNumber(row.average_entry_score),
      highestScore: optNumber(row.highest_score),
      rank: optNumber(row.rank),
      overallRank: optNumber(row.overall_rank),
      value: optNumber(row.value),
      bank: optNumber(row.bank),
      chip: optString(row.chip),
      captain: captainRow === null ? null : {
        element: optNumber(captainRow.element) ?? 0,
        multiplier: optNumber(captainRow.multiplier) ?? 0,
        points: optNumber(captainRow.points) ?? 0,
      },
      autoSubs,
      picks,
    } satisfies ManagerGameweek;
  });

  const transfers = mapKept(transferList, "transfers", problems, (item, i) => {
    const row = reqRecord(item, `transfers[${i}]`, problems);
    if (!row) return null;
    const event = reqNumber(row.event, `transfers[${i}].event`, problems);
    const elementIn = reqNumber(
      row.element_in, `transfers[${i}].element_in`, problems,
    );
    const elementOut = reqNumber(
      row.element_out, `transfers[${i}].element_out`, problems,
    );
    if (event === null || elementIn === null || elementOut === null) return null;
    return {
      event,
      time: optString(row.time),
      elementIn,
      elementInCost: optNumber(row.element_in_cost),
      elementOut,
      elementOutCost: optNumber(row.element_out_cost),
      inPointsByGw: gwPoints(
        row.in_points_by_gw, `transfers[${i}].in_points_by_gw`, problems,
      ),
      outPointsByGw: gwPoints(
        row.out_points_by_gw, `transfers[${i}].out_points_by_gw`, problems,
      ),
      inMultiplierByGw: gwMap(
        row.in_multiplier_by_gw, `transfers[${i}].in_multiplier_by_gw`, problems,
      ),
    } satisfies ManagerTransfer;
  });

  return narrowed({
    generatedAt: optString(file.generated_at),
    entryId: optNumber(file.entry_id),
    settledThrough: optNumber(file.settled_through),
    gameweeks,
    transfers,
  });
}
