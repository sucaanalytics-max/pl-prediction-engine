/**
 * Per-player points distributions — the model's own projections.
 *
 * ## Why this is not "another ranked list"
 *
 * `/players` already shows the heuristic engine's rankings behind a loud badge.
 * This is the opposite thing: output from the simulation that the optimiser
 * actually solves against, and it leads with a distribution rather than a mean.
 *
 * The published benchmark puts the top six public models within 0.08 RMSE of
 * each other and all near the theoretical ceiling, so a mean is not where the
 * information is. What is decision-relevant is that a player at `xp 6.4` most
 * often returns **2** — the mean is carried by a haul that lands one week in
 * six. Seven of eight competitors publish only the mean.
 *
 * So `mode`, `xp` and `pGe10` travel together and the page is built to show all
 * three at once. `decomposition` answers the other half: 6.4 from appearance
 * points and a clean sheet is a different holding from 6.4 from a one-in-six
 * chance of a haul, and nobody in the category distinguishes them.
 *
 * ## Every field is nullable except the identity
 *
 * Deliberate. The producer omits a field it did not compute rather than writing
 * a zero, and `decomposition` is absent entirely unless the simulation retained
 * positions. A null renders as a dash; a zero would claim the model measured
 * something and got nothing.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, optNumber, optString, Problems, reqArray, reqRecord,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface Decomposition {
  readonly appearance: number;
  readonly goals: number;
  readonly assists: number;
  readonly cleanSheets: number;
  readonly other: number;
}

export interface Projection {
  readonly elementId: number;
  readonly name: string | null;
  readonly team: string | null;
  readonly position: string | null;
  readonly xp: number | null;
  readonly xpSd: number | null;
  /** The most likely single total. Usually far below `xp`. */
  readonly mode: number | null;
  readonly pAppears: number | null;
  readonly p60: number | null;
  readonly eMinutes: number | null;
  readonly pGoal: number | null;
  readonly pCleanSheet: number | null;
  readonly pGe5: number | null;
  readonly pGe10: number | null;
  readonly q10: number | null;
  /**
   * The median.
   *
   * Published by the producer since the first `xp_public` file and narrowed by
   * nobody until the distribution glyph needed it, so every consumer had q10 and
   * q90 and no centre — which makes an interval you cannot tell the skew of. The
   * gap between this and `xp` is the single most decision-relevant fact in the
   * artifact and it was being dropped on the way in.
   */
  readonly q50: number | null;
  readonly q90: number | null;
  readonly nFixtures: number;
  readonly blank: boolean;
  readonly decomposition: Decomposition | null;
}

export interface Projections {
  readonly gameweek: number | null;
  readonly season: string | null;
  readonly generatedAt: string | null;
  /**
   * Draws behind every tail probability.
   *
   * Surfaced because `P(10+) = 0.15` from 2,000 draws and from 10,000 are
   * different claims about precision, and the committed match artifact has
   * already been caught disagreeing with itself about its own draw count.
   */
  readonly nDraws: number | null;
  /**
   * The producing code's version, as the artifact carries it.
   *
   * Emitted as `producer_version` since the first of these files and narrowed by
   * nobody, so every provenance strip over a projection read "version unknown" —
   * the phrase reserved for a writer we cannot vouch for — beside numbers from a
   * writer that names itself. The value is an integer on the wire and a string
   * here, because {@link Provenance.producerVersion} is a label rather than a
   * quantity and nothing should be tempted to compare it numerically.
   */
  readonly producerVersion: string | null;
  readonly players: readonly Projection[];
}

function narrowDecomposition(raw: unknown): Decomposition | null {
  if (!isRecord(raw)) return null;
  const appearance = optNumber(raw.appearance);
  const goals = optNumber(raw.goals);
  const assists = optNumber(raw.assists);
  const cleanSheets = optNumber(raw.clean_sheets);
  const other = optNumber(raw.other);
  // All five or none. A partial decomposition would not sum to `xp`, and a
  // breakdown whose parts do not add up is worse than none at all — a reader
  // who checks once and finds it wrong cannot trust any of the numbers after.
  if (
    appearance === null || goals === null || assists === null ||
    cleanSheets === null || other === null
  ) {
    return null;
  }
  return { appearance, goals, assists, cleanSheets, other };
}

function narrowPlayer(raw: unknown): Projection | null {
  if (!isRecord(raw)) return null;
  const elementId = optNumber(raw.element_id);
  // No id, no row. People make transfers from this table.
  if (elementId === null) return null;
  return {
    elementId,
    name: optString(raw.name),
    team: optString(raw.team),
    position: optString(raw.position),
    xp: optNumber(raw.xp),
    xpSd: optNumber(raw.xp_sd),
    mode: optNumber(raw.mode),
    pAppears: optNumber(raw.p_appears),
    p60: optNumber(raw.p_60),
    eMinutes: optNumber(raw.e_minutes),
    pGoal: optNumber(raw.p_goal),
    pCleanSheet: optNumber(raw.p_clean_sheet),
    pGe5: optNumber(raw.p_ge_5),
    pGe10: optNumber(raw.p_ge_10),
    q10: optNumber(raw.q10),
    q50: optNumber(raw.q50),
    q90: optNumber(raw.q90),
    nFixtures: optNumber(raw.n_fixtures) ?? 0,
    blank: raw.blank === true,
    decomposition: narrowDecomposition(raw.decomposition),
  };
}

export function narrowProjections(raw: unknown): NarrowResult<Projections> {
  const problems = new Problems();
  const file = reqRecord(raw, "projections", problems);
  if (!file) return malformed(problems.all);

  const players = reqArray(file.players, "players", problems);
  if (!players) return malformed(problems.all);

  const kept: Projection[] = [];
  for (const entry of players) {
    const player = narrowPlayer(entry);
    if (player !== null) kept.push(player);
  }

  // Integer on the wire, string here. `optString` alone would drop it.
  const version = optNumber(file.producer_version);

  return narrowed({
    gameweek: optNumber(file.gameweek),
    season: optString(file.season),
    generatedAt: optString(file.generated_at),
    nDraws: optNumber(file.n_draws),
    producerVersion: version === null ? optString(file.producer_version) : String(version),
    players: kept,
  });
}

/**
 * Published, but carrying no projection.
 *
 * Every player blank means the gameweek has no fixtures for anyone — a real
 * state during an international break, and one that must render as "no fixtures
 * this gameweek" rather than as a table of zeros.
 */
export function projectionsAreEmpty(value: Projections): boolean {
  return (
    value.players.length === 0 ||
    value.players.every((p) => p.blank || p.xp === null)
  );
}

/**
 * The rows worth showing first, ranked by upside rather than by mean.
 *
 * Mirrors `public_xp.notable` on the Python side. Sorting on `pGe10` is the
 * point: a weekly-win entry is buying the right tail, which a mean ranking
 * buries. Ties break on `xp` then on id so the order is total and a re-render
 * does not reshuffle the table.
 */
export function notable(
  players: readonly Projection[], limit = 60,
): readonly Projection[] {
  return [...players]
    .filter((p) => !p.blank)
    .sort(
      (a, b) =>
        (b.pGe10 ?? 0) - (a.pGe10 ?? 0) ||
        (b.xp ?? 0) - (a.xp ?? 0) ||
        a.elementId - b.elementId,
    )
    .slice(0, limit);
}

/**
 * How far the mean sits above the most likely outcome.
 *
 * The single number that says "do not read the mean as a forecast". Null when
 * either side is unknown, rather than 0 — which would claim the two agree.
 */
export function skew(player: Projection): number | null {
  if (player.xp === null || player.mode === null) return null;
  return player.xp - player.mode;
}

export function projectionsDescriptor(gameweek: number): Descriptor<Projections> {
  const padded = String(gameweek).padStart(2, "0");
  return {
    key: `projections:${padded}`,
    path: `fpl/xp_public_gw${padded}.json`,
    owner: "agent",
    describes: `per-player points distributions for GW${gameweek}`,
    freshnessBudgetMs: DAY,
    narrow: narrowProjections,
    producedAtOf: (v) => v.generatedAt,
    producerVersionOf: (v) => v.producerVersion,
    isEmpty: projectionsAreEmpty,
  };
}
