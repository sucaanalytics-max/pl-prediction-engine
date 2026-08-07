/**
 * The heuristic engine's output, narrowed to what the app actually renders.
 *
 * ## What this is, and what it is not
 *
 * `lib/fpl-ranking-engine.ts` produces transfer shortlists, a captaincy plan and
 * ranked player lists from live FPL fields. It is **not a model**. Its six tests
 * contain zero accuracy assertions, and it carries around twenty untested
 * constants, the worst of which projects minutes as
 *
 *     Math.min(90, Math.max(45, (minutes / Math.max(1, totalPoints)) * 4.5))
 *
 * — minutes divided by *points*, which is dimensionally meaningless and rewards
 * low-scoring players with more projected minutes. The clamp bounds the damage;
 * it does not make it a projection.
 *
 * It is rendered anyway, because until a gameweek seals there is nothing else,
 * and a blank screen is not more honest than a labelled guess. Everything here
 * therefore travels behind a `HEURISTIC` badge, and the plan retires it once
 * four gameweeks have sealed and `decision_public_*` has a record.
 *
 * ## Why a view type rather than `FplLiveState`
 *
 * `FplLiveState` is a large interface and `FplLiveContext` cast into it with
 * `res.json() as FplLiveResponse` — Rule 4's exact hazard, and how `HealthData`
 * drifted silently. Narrowing the whole thing would be a schema validator
 * nobody maintains, so this narrows only the fields that reach the screen. A
 * field not listed here is a field no page can read.
 */

import {
  isRecord, mapKept, optArray, optNumber, optString, Problems, reqArray,
  reqNumber, reqRecord, reqString,
} from "@/lib/data/check";
import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";

/**
 * The ranked lists the engine emits, in the order they are shown.
 *
 * Ported from `/rankings`, which had all eight as tabs. Keeping every one means
 * the retiring route loses nothing.
 */
export const RANKING_CATEGORIES = [
  { key: "overall", label: "Overall" },
  { key: "captaincy", label: "Captaincy" },
  { key: "value", label: "Value" },
  { key: "differentials", label: "Differentials" },
  { key: "goalkeepers", label: "GKP" },
  { key: "defenders", label: "DEF" },
  { key: "midfielders", label: "MID" },
  { key: "forwards", label: "FWD" },
] as const;

export type RankingCategory = (typeof RANKING_CATEGORIES)[number]["key"];

/** One upcoming fixture's projection, as `/projections` showed per column. */
export interface HeuristicGameweek {
  readonly gameweek: number;
  readonly fixture: string;
  readonly difficulty: number;
  readonly projectedPoints: number;
}

export interface HeuristicPlayer {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
  readonly position: string;
  readonly price: number;
  readonly ownership: number;
  readonly status: string;
  readonly news: string;
  readonly expectedMinutes: number;
  readonly projected4: number;
  readonly projected6: number;
  readonly captainScore: number;
  readonly valueScore: number;
  readonly differentialScore: number;
  /** Per-gameweek breakdown. Empty when the engine produced none. */
  readonly gameweeks: readonly HeuristicGameweek[];
}

/**
 * A multi-transfer plan, ported off `/optimizer`.
 *
 * Kept because the plan calls for **N distinct plans rather than one** — one
 * recommendation with no alternatives hides how close the second-best was, and
 * closeness is the honest signal about whether the choice matters.
 */
export interface HeuristicPlan {
  readonly rank: number;
  readonly transferCount: number;
  readonly moves: ReadonlyArray<{
    readonly playerOut: HeuristicPlayer;
    readonly playerIn: HeuristicPlayer;
  }>;
  readonly bankAfter: number;
  readonly delta4: number;
  readonly delta6: number;
  readonly confidence: number;
  readonly flags: readonly string[];
}

export interface HeuristicTransfer {
  readonly rank: number;
  readonly playerOut: HeuristicPlayer;
  readonly playerIn: HeuristicPlayer;
  readonly delta4: number;
  readonly delta6: number;
  readonly bankAfter: number;
  readonly confidence: number;
  readonly rationale: readonly string[];
  readonly flags: readonly string[];
}

export interface HeuristicCaptainWeek {
  readonly gameweek: number;
  readonly captain: HeuristicPlayer;
  readonly viceCaptain: HeuristicPlayer;
  readonly captainFixture: string;
  readonly projectedCaptainPoints: number;
  readonly confidence: number;
}

export interface HeuristicView {
  readonly generatedAt: string;
  readonly modelVersion: string;
  /**
   * Who the entry is, for the sidebar's manager card.
   *
   * `id` is nullable so the hardcoded `20945` can go: a fallback entry id in
   * the chrome links a stranger's team when the real one cannot be read.
   */
  readonly entry: {
    readonly id: number | null;
    readonly teamName: string | null;
  };
  readonly event: {
    readonly id: number | null;
    readonly deadlineTime: string | null;
  };
  /** Whether the squad shown is the live one or a captured draft. */
  readonly squadSource: string | null;
  /**
   * `fplreview_csv_snapshot` when a paid export was on disk, `fallback` when it
   * was not. The second is now the normal case; see `lib/fplreview-projections.ts`.
   */
  readonly projectionSource: string;
  readonly projectionSourceLabel: string;
  readonly transfers: readonly HeuristicTransfer[];
  /** Two- and three-transfer plans, from `/optimizer`. */
  readonly plans: readonly HeuristicPlan[];
  readonly captaincy: readonly HeuristicCaptainWeek[];
  /**
   * All eight ranked lists, keyed as the engine emits them.
   *
   * A map rather than eight fields so `RANKING_CATEGORIES` can drive the tab
   * strip: a category added to the engine and not to the UI then shows up as a
   * missing tab, not as data nobody notices is gone.
   */
  readonly rankings: Readonly<Record<RankingCategory, readonly HeuristicPlayer[]>>;
  /**
   * Rows that failed to narrow and were dropped.
   *
   * Surfaced rather than swallowed: one bad row must not take the others with
   * it, but a page silently rendering 19 of 20 is lying about its coverage.
   */
  readonly droppedRows: number;
}

/** Counts drops without failing the whole narrow. */
class DropCount extends Problems {
  count = 0;
  add = (_message: string) => {
    this.count += 1;
  };
}

function narrowPlayer(raw: unknown): HeuristicPlayer | null {
  const problems = new Problems();
  const record = reqRecord(raw, "player", problems);
  if (record === null) return null;

  const elementId = reqNumber(record.elementId, "elementId", problems);
  const name = reqString(record.name, "name", problems);
  if (elementId === null || name === null) return null;

  return {
    elementId,
    name,
    team: optString(record.team) ?? "—",
    position: optString(record.position) ?? "UNK",
    price: optNumber(record.price) ?? 0,
    ownership: optNumber(record.ownership) ?? 0,
    status: optString(record.status) ?? "a",
    news: optString(record.news) ?? "",
    // Numeric scores default to 0 rather than null: every consumer sorts on
    // them, and a null in a comparator silently reorders the whole list.
    expectedMinutes: optNumber(record.expectedMinutes) ?? 0,
    projected4: optNumber(record.projected4) ?? 0,
    projected6: optNumber(record.projected6) ?? 0,
    captainScore: optNumber(record.captainScore) ?? 0,
    valueScore: optNumber(record.valueScore) ?? 0,
    differentialScore: optNumber(record.differentialScore) ?? 0,
    gameweeks: narrowGameweeks(record.gameweekProjections),
  };
}

function narrowGameweeks(raw: unknown): HeuristicGameweek[] {
  if (!Array.isArray(raw)) return [];
  const kept: HeuristicGameweek[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const gameweek = optNumber(entry.gameweek);
    const projectedPoints = optNumber(entry.projectedPoints);
    // A column with no gameweek and no number is not a projection worth a cell.
    if (gameweek === null || projectedPoints === null) continue;
    kept.push({
      gameweek,
      fixture: optString(entry.fixture) ?? "—",
      difficulty: optNumber(entry.difficulty) ?? 0,
      projectedPoints,
    });
  }
  return kept;
}

function narrowPlan(raw: unknown): HeuristicPlan | null {
  const problems = new Problems();
  const record = reqRecord(raw, "plan", problems);
  if (record === null) return null;

  const rawMoves = Array.isArray(record.moves) ? record.moves : [];
  const moves: Array<{ playerOut: HeuristicPlayer; playerIn: HeuristicPlayer }> = [];
  for (const move of rawMoves) {
    if (!isRecord(move)) continue;
    const playerOut = narrowPlayer(move.playerOut);
    const playerIn = narrowPlayer(move.playerIn);
    if (playerOut === null || playerIn === null) continue;
    moves.push({ playerOut, playerIn });
  }
  // A plan whose every leg failed to narrow is not a plan; showing its headline
  // delta with no moves under it would be a number with nothing behind it.
  if (moves.length === 0) return null;

  return {
    rank: optNumber(record.rank) ?? 0,
    transferCount: optNumber(record.transferCount) ?? moves.length,
    moves,
    bankAfter: optNumber(record.bankAfter) ?? 0,
    delta4: optNumber(record.delta4) ?? 0,
    delta6: optNumber(record.delta6) ?? 0,
    confidence: optNumber(record.confidence) ?? 0,
    flags: narrowStrings(record.flags),
  };
}

function narrowStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function narrowTransfer(raw: unknown): HeuristicTransfer | null {
  const problems = new Problems();
  const record = reqRecord(raw, "transfer", problems);
  if (record === null) return null;

  const playerOut = narrowPlayer(record.playerOut);
  const playerIn = narrowPlayer(record.playerIn);
  // A transfer missing either side is not a partial transfer; it is not one.
  if (playerOut === null || playerIn === null) return null;

  return {
    rank: optNumber(record.rank) ?? 0,
    playerOut,
    playerIn,
    delta4: optNumber(record.delta4) ?? 0,
    delta6: optNumber(record.delta6) ?? 0,
    bankAfter: optNumber(record.bankAfter) ?? 0,
    confidence: optNumber(record.confidence) ?? 0,
    rationale: narrowStrings(record.rationale),
    flags: narrowStrings(record.flags),
  };
}

function narrowCaptainWeek(raw: unknown): HeuristicCaptainWeek | null {
  const problems = new Problems();
  const record = reqRecord(raw, "captainWeek", problems);
  if (record === null) return null;

  const gameweek = reqNumber(record.gameweek, "gameweek", problems);
  const captain = narrowPlayer(record.captain);
  const viceCaptain = narrowPlayer(record.viceCaptain);
  if (gameweek === null || captain === null || viceCaptain === null) return null;

  return {
    gameweek,
    captain,
    viceCaptain,
    captainFixture: optString(record.captainFixture) ?? "—",
    projectedCaptainPoints: optNumber(record.projectedCaptainPoints) ?? 0,
    confidence: optNumber(record.confidence) ?? 0,
  };
}

/**
 * Narrow `/api/fpl/state`'s payload into the heuristic view.
 *
 * Fails only on the fields without which nothing can be rendered. Individual
 * malformed rows are dropped and counted, because a single bad player must not
 * blank a shortlist.
 */
export function narrowHeuristics(raw: unknown): NarrowResult<HeuristicView> {
  const problems = new Problems();
  const root = reqRecord(raw, "state", problems);
  if (root === null) return malformed(problems.all);

  const generatedAt = reqString(root.generatedAt, "generatedAt", problems);
  const entry = isRecord(root.entry) ? root.entry : {};
  const event = isRecord(root.event) ? root.event : {};
  const freshness = isRecord(root.freshness) ? root.freshness : {};
  const recommendations = reqRecord(root.recommendations, "recommendations", problems);
  const rankings = reqRecord(root.rankings, "rankings", problems);
  const projections = reqRecord(root.projections, "projections", problems);

  if (
    generatedAt === null || recommendations === null ||
    rankings === null || projections === null
  ) {
    return malformed(problems.all);
  }

  const drops = new DropCount();

  const transfers = mapKept(
    reqArray(recommendations.transfers4, "transfers4", problems) ?? [],
    "transfers4", drops, narrowTransfer,
  );
  const captaincy = mapKept(
    reqArray(recommendations.captaincyPlan, "captaincyPlan", problems) ?? [],
    "captaincyPlan", drops, narrowCaptainWeek,
  );
  // Optional: the engine has emitted these only sometimes, and an absent plan
  // list is "no alternatives were computed", not a broken response.
  const plans = mapKept(
    optArray(recommendations.multiTransferPlans4), "multiTransferPlans4",
    drops, narrowPlan,
  );
  // Every declared category is read. A list the engine stops emitting becomes a
  // required-field problem here rather than an empty tab nobody questions.
  const lists = {} as Record<RankingCategory, readonly HeuristicPlayer[]>;
  for (const { key } of RANKING_CATEGORIES) {
    lists[key] = mapKept(
      reqArray(rankings[key], key, problems) ?? [], key, drops, narrowPlayer,
    );
  }

  if (problems.any) return malformed(problems.all);

  return narrowed({
    generatedAt,
    modelVersion: optString(recommendations.modelVersion) ?? "unknown",
    entry: { id: optNumber(entry.id), teamName: optString(entry.teamName) },
    event: {
      id: optNumber(event.id),
      deadlineTime: optString(event.deadlineTime),
    },
    squadSource: optString(freshness.squad),
    projectionSource: optString(projections.source) ?? "unknown",
    projectionSourceLabel: optString(projections.sourceLabel) ?? "unknown source",
    transfers,
    plans,
    captaincy,
    rankings: lists,
    droppedRows: drops.count,
  });
}

/**
 * Nothing to act on.
 *
 * All four lists empty means the engine ran and produced no shortlist — a real
 * pre-season state, not a failure, and it must not render as blank tables.
 */
export function heuristicsAreEmpty(view: HeuristicView): boolean {
  return (
    view.transfers.length === 0 &&
    view.plans.length === 0 &&
    view.captaincy.length === 0 &&
    RANKING_CATEGORIES.every(({ key }) => view.rankings[key].length === 0)
  );
}
