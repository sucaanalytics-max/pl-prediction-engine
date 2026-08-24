/**
 * Understat's shots and creation, as the pipeline publishes them.
 *
 * ## Why this is its own artifact and not part of `player_stats.json`
 *
 * `player_stats.json` is built from FPL's own API and is as reliable as the rest
 * of the pipeline. This is built from a SCRAPED source that may be absent, stale
 * or partially joined on any given day, and it carries a second, independent xG
 * model. Merging the two would produce one file with two different warranties and
 * no way for a screen to tell which half it was reading.
 *
 * So the two warranties stay apart, and this narrower keeps three things the
 * producer went out of its way to publish:
 *
 *   - `coverage.joinFraction` — how well the name match worked. The number to
 *     judge the join by, and the one a screen should show. Distinct from
 *     `leagueFraction`, which is how much of FPL's squad list Understat covers at
 *     all; one game into a season that is inherently low, because Understat lists
 *     players who have PLAYED and FPL lists everyone who could. Conflating them
 *     raised a false alarm the first time the pipeline ran.
 *   - `notAvailable` — the fields this feed does NOT have, named rather than
 *     silently missing, so a screen can grey a column instead of rendering an
 *     empty one and letting the reader guess.
 *   - a withheld per-90. The producer publishes null below 90 minutes rather than
 *     extrapolating an eight-minute substitute to eleven shots per ninety, and
 *     this narrower must not fill that in.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import { isRecord, optNumber, optString, Problems } from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface PlayerEvent {
  readonly elementId: number;
  readonly name: string | null;
  readonly team: string | null;
  readonly minutes: number | null;
  readonly shots: number | null;
  readonly keyPasses: number | null;
  readonly goals: number | null;
  readonly assists: number | null;
  readonly xg: number | null;
  readonly xa: number | null;
  /** Non-penalty xG. The half of a striker's xG that is not a spot kick. */
  readonly npXg: number | null;
  /** Understat's possession-chain measures: involvement short of the shot. */
  readonly xgChain: number | null;
  readonly xgBuildup: number | null;
  /** Null below 90 minutes, by the producer's design. Never inferred here. */
  readonly shotsPer90: number | null;
  readonly keyPassesPer90: number | null;
  readonly xgPer90: number | null;
  readonly xaPer90: number | null;
}

export interface EventCoverage {
  readonly matched: number;
  readonly understatRows: number;
  readonly fplUniverse: number;
  readonly unmatched: number;
  /** matched / rows offered. Judge the join by this. */
  readonly joinFraction: number | null;
  /** matched / FPL's whole squad list. Understat's scope, not our quality. */
  readonly leagueFraction: number | null;
}

export interface PlayerEvents {
  readonly generatedAt: string | null;
  readonly season: string | null;
  readonly source: string | null;
  readonly sourceNote: string | null;
  readonly coverage: EventCoverage;
  /** Fields this feed cannot answer. Rendered as greyed, never as blank. */
  readonly notAvailable: readonly string[];
  readonly players: readonly PlayerEvent[];
}

function narrowRow(raw: unknown): PlayerEvent | null {
  if (!isRecord(raw)) return null;
  const elementId = optNumber(raw.element_id);
  if (elementId === null) return null;
  return {
    elementId,
    name: optString(raw.name),
    team: optString(raw.team),
    minutes: optNumber(raw.minutes),
    shots: optNumber(raw.shots),
    keyPasses: optNumber(raw.key_passes),
    goals: optNumber(raw.goals),
    assists: optNumber(raw.assists),
    xg: optNumber(raw.xg),
    xa: optNumber(raw.xa),
    npXg: optNumber(raw.np_xg),
    xgChain: optNumber(raw.xg_chain),
    xgBuildup: optNumber(raw.xg_buildup),
    shotsPer90: optNumber(raw.shots_per_90),
    keyPassesPer90: optNumber(raw.key_passes_per_90),
    xgPer90: optNumber(raw.xg_per_90),
    xaPer90: optNumber(raw.xa_per_90),
  };
}

export function narrowPlayerEvents(raw: unknown): NarrowResult<PlayerEvents> {
  const problems = new Problems();
  if (!isRecord(raw)) {
    return malformed(["player_events.json is not an object"]);
  }
  const rawPlayers = Array.isArray(raw.players) ? raw.players : [];
  if (!Array.isArray(raw.players)) problems.add("players is not an array");

  const players: PlayerEvent[] = [];
  let dropped = 0;
  for (const row of rawPlayers) {
    const narrowedRow = narrowRow(row);
    if (narrowedRow === null) dropped += 1;
    else players.push(narrowedRow);
  }
  // Reported rather than silent: a feed whose ids stopped arriving would
  // otherwise narrow to an empty list that looks like a quiet Tuesday.
  if (dropped > 0) problems.add(`${dropped} rows carried no element_id`);

  const coverage = isRecord(raw.coverage) ? raw.coverage : {};
  const notAvailable = Array.isArray(raw.not_available)
    ? raw.not_available.filter((f): f is string => typeof f === "string")
    : [];

  if (problems.any) return malformed(problems.all);

  return narrowed({
    generatedAt: optString(raw.generated_at),
    season: optString(raw.season),
    source: optString(raw.source),
    sourceNote: optString(raw.source_note),
    coverage: {
      matched: optNumber(coverage.matched) ?? players.length,
      understatRows: optNumber(coverage.understat_rows) ?? 0,
      fplUniverse: optNumber(coverage.fpl_universe) ?? 0,
      unmatched: optNumber(coverage.unmatched) ?? 0,
      joinFraction: optNumber(coverage.join_fraction),
      leagueFraction: optNumber(coverage.league_fraction),
    },
    notAvailable,
    players,
  });
}

export function playerEventsAreEmpty(value: PlayerEvents): boolean {
  return value.players.length === 0;
}

/**
 * The descriptor.
 *
 * `owner: "daily"` and a two-day budget because the producer caches Understat for
 * 48 hours by design — the site updates after matches, not continuously, and one
 * league-season table per refresh is what keeps a scraped source defensible. A
 * tighter budget would mark a perfectly current file stale.
 */
export const PLAYER_EVENTS: Descriptor<PlayerEvents> = {
  key: "playerEvents",
  // `predictions/player_events.json`, NOT under `fpl/`. `run_pipeline.py` writes
  // it to PREDICTIONS_DIR and the workflow copies it to the same place — unlike
  // `xp_public_gw{NN}.json`, which the FPL agent writes into `fpl/`. Pointing at
  // `fpl/` narrowed a file that was never there; `dead-reads.test.ts` caught it by
  // resolving the descriptor against the published artifact.
  path: "player_events.json",
  owner: "daily",
  describes: "Understat shots and creation",
  freshnessBudgetMs: 2 * DAY,
  narrow: narrowPlayerEvents,
  producedAtOf: (value) => value.generatedAt,
  isEmpty: playerEventsAreEmpty,
};
