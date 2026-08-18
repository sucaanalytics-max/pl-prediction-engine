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

export interface FixtureMatrixEntry {
  readonly gameweek: number;
  /** e.g. `COV (H)` — opponent short name and venue. */
  readonly label: string;
  /** FPL's own 1–5 rating for THIS club in this fixture, not the opponent's. */
  readonly difficulty: number;
}

export interface FixtureMatrixRow {
  readonly teamId: number;
  readonly team: string;
  readonly shortName: string;
  readonly fixtures: readonly FixtureMatrixEntry[];
  readonly meanDifficulty: number;
  readonly totalDifficulty: number;
}

export interface SquadPlayer {
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly price: number | null;
  /**
   * On the bench for this gameweek.
   *
   * The API has always carried it (`FplLivePlayer.bench`, set by the server from
   * the pick's slot) and this narrower dropped it, so nothing downstream could
   * tell a starter from a substitute — which makes "is your XI the best eleven
   * available?" unanswerable, and that is the single most useful question a
   * one-gameweek projection can answer about a squad you already own.
   *
   * Optional because a squad read from a source that does not distinguish them is
   * still a squad; consumers must treat `undefined` as "unknown", not "starting".
   */
  readonly bench?: boolean;
  /**
   * FPL's own id for the player, when the route sent one.
   *
   * Emitted by `fpl-live-server.ts` on every pick and dropped here until
   * something needed to join on it. The consequence was that `SquadBoard` had to
   * match its fifteen against the published projection **by name and position**,
   * fold accents on both sides to make `Kadıoğlu` meet `Kadioglu`, and refuse the
   * match outright whenever two players collided — FPL has six Wilsons. All of
   * that is a workaround for a key that was in the payload the whole time.
   *
   * Optional for the same reason as `bench`: a pick with no id is still a pick,
   * and it renders with `— xP` rather than with a guessed neighbour's number.
   */
  readonly elementId?: number;
  /**
   * The armband, from the picks themselves.
   *
   * The route folds the pick role and the availability flag into one `status`
   * field, so it can also hold `"monitor"`. Only the two roles are kept here: an
   * injury flag rendered as a captaincy is not a near miss, it is the wrong word
   * on the most consequential pick of the week.
   */
  readonly role?: "captain" | "vice";
  /** Next opponent as FPL labels it, e.g. `BUR (H)`. */
  readonly fixture?: string;
  /**
   * The player's next ten fixtures, with FPL's own difficulty for each.
   *
   * The route has sent these on every pick since `fixtureViews` was written and
   * this narrower kept only the first, so nothing downstream could see past the
   * current gameweek — which makes rotation planning, the single most common
   * reason to look at a squad more than a week out, unanswerable from this app.
   *
   * Empty rather than absent when the route sent none: a player with no
   * scheduled fixtures is a real state during a blank, and the planner hatches
   * it rather than reading it as an easy week.
   */
  readonly fixtures: readonly SquadFixture[];
}

/** One upcoming fixture for one player. */
export interface SquadFixture {
  readonly gameweek: number;
  /** e.g. `BUR (H)`. */
  readonly label: string;
  /** FPL's own 1-5 rating for THIS club in this fixture. */
  readonly difficulty: number;
}

export interface SquadView {
  readonly players: readonly SquadPlayer[];
  /** Total selling value, in millions. */
  readonly value: number | null;
  readonly bank: number | null;
  readonly formation: string | null;
  /** e.g. `captured_authenticated_draft` — never presented as live when it is not. */
  readonly source: string | null;
  /**
   * When the squad itself was read, as opposed to when this view was built.
   *
   * The route has always sent it — `fpl-live-server.ts:535` emits
   * `picks ? now : CAPTURED_DRAFT_AT` — and this narrower dropped it, so every consumer
   * fell back to `HeuristicView.generatedAt`, which is stamped at REQUEST time. The
   * control room therefore printed `squad: 0h old (captured draft)` beside a squad
   * hand-captured on 18 August: a freshness claim, on the one panel whose job is to say
   * how stale the squad is, that was wrong by days and looked like a measurement.
   *
   * Null only if the route sent nothing. When FPL serves real picks this equals the
   * fetch time, which is the honest age for a squad read live.
   */
  readonly capturedAt: string | null;
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
   * The route's own sentences about where this squad came from.
   *
   * `fpl-live-server.ts:658` has emitted these since the file was written and no narrower
   * read them, so every explanation of the captured-versus-live switch was built and
   * thrown away. That includes the one that matters most: when FPL answers for the entry
   * but does not return a fifteen-player squad, the app falls back to the captured draft,
   * and without this the reader is never told it happened.
   */
  readonly notices: readonly string[];
  /**
   * The fifteen, with what they cost.
   *
   * Returned by `/api/fpl/state` all along and dropped by this narrower, so no
   * screen could show the squad the whole app is about. £100.0m committed, £0.0m
   * in the bank, 4-4-2 — facts a manager checks before every deadline and had to
   * open the official site to see.
   */
  readonly squad: SquadView | null;
  /**
   * Every club's next fixtures with FPL's official difficulty, kindest run first.
   *
   * Empty rather than null when unreadable: the grid then renders one line saying so
   * and the rest of the view is unaffected.
   */
  readonly fixtureMatrix: readonly FixtureMatrixRow[];
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

/**
 * The fifteen, or null.
 *
 * Tolerant on purpose: a squad that cannot be read must not take the transfer
 * shortlist and the captaincy plan down with it, because those are still usable
 * without it. Null here renders as one line, not as a blank page.
 */
/**
 * A player's fixture run, dropping any row that cannot be placed on the grid.
 *
 * A fixture with no gameweek has no column to go in, and one with no label has
 * nothing to render — both are dropped rather than rendered as a blank cell,
 * which the planner would read as "no fixture" and hatch. Difficulty defaults to
 * FPL's own midpoint only when the row is otherwise complete, because the
 * planner colours by it and an absent rating is not an easy game.
 */
function narrowSquadFixtures(raw: unknown): SquadFixture[] {
  if (!Array.isArray(raw)) return [];
  const out: SquadFixture[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const gameweek = optNumber(item.gameweek);
    const label = optString(item.label);
    if (gameweek === null || !label) continue;
    out.push({ gameweek, label, difficulty: optNumber(item.difficulty) ?? 3 });
  }
  return out.sort((a, b) => a.gameweek - b.gameweek);
}

function narrowSquad(raw: unknown): SquadView | null {
  if (!isRecord(raw)) return null;
  const players = Array.isArray(raw.players) ? raw.players : [];
  const kept: SquadPlayer[] = [];
  for (const item of players) {
    if (!isRecord(item)) continue;
    const name = optString(item.name);
    if (!name) continue;
    kept.push({
      name,
      position: optString(item.position) ?? "",
      team: optString(item.team) ?? "",
      price: optNumber(item.price),
      // Preserved rather than defaulted: `bench: false` on an unknown would
      // silently promote every substitute into the XI.
      bench: typeof item.bench === "boolean" ? item.bench : undefined,
      elementId: optNumber(item.elementId) ?? undefined,
      // `status` carries either a pick role or an availability flag; only the
      // two roles mean an armband. See `SquadPlayer.role`.
      role: item.status === "captain" || item.status === "vice"
        ? item.status
        : undefined,
      fixture: optString(item.fixture) ?? undefined,
      fixtures: narrowSquadFixtures(item.fixtures),
    });
  }
  if (kept.length === 0) return null;
  return {
    players: kept,
    value: optNumber(raw.value),
    bank: optNumber(raw.bank),
    formation: optString(raw.formation),
    source: optString(raw.source),
    capturedAt: optString(raw.capturedAt),
  };
}

/**
 * The difficulty grid, or an empty list.
 *
 * Every field is required per row, because a row missing its difficulty would render
 * as an uncoloured cell indistinguishable from a blank gameweek — and a blank and an
 * unknown are different facts.
 */
function narrowFixtureMatrix(raw: unknown): readonly FixtureMatrixRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: FixtureMatrixRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const team = optString(item.team);
    const teamId = optNumber(item.teamId);
    const mean = optNumber(item.meanDifficulty);
    if (!team || teamId === null || mean === null) continue;

    const fixtures: FixtureMatrixEntry[] = [];
    for (const entry of Array.isArray(item.fixtures) ? item.fixtures : []) {
      if (!isRecord(entry)) continue;
      const gameweek = optNumber(entry.gameweek);
      const difficulty = optNumber(entry.difficulty);
      const label = optString(entry.label);
      if (gameweek === null || difficulty === null || !label) continue;
      fixtures.push({ gameweek, label, difficulty });
    }
    if (fixtures.length === 0) continue;

    rows.push({
      teamId,
      team,
      shortName: optString(item.shortName) ?? team,
      fixtures,
      meanDifficulty: mean,
      totalDifficulty: optNumber(item.totalDifficulty) ?? 0,
    });
  }
  return rows;
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
    notices: optArray(root.notices).filter((n): n is string => typeof n === "string"),
    squad: narrowSquad(root.squad),
    fixtureMatrix: narrowFixtureMatrix(root.fixtureMatrix),
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
