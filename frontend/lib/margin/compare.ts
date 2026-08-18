/**
 * Two artifacts, one player, side by side.
 *
 * ## Why a join at all
 *
 * The Players tab reads `xp_public` only — the simulation's view of what a
 * player will do. `player_stats.json` holds what they have already done: 587
 * rows with minutes, goals, assists, xG, xA, price, ownership and form.
 *
 * Those totals are LAST season's, and saying otherwise was shipped here for a
 * day. `build_player_stats` reads FPL's `bootstrap.elements` straight through,
 * and FPL retains the previous season's totals until a gameweek has been
 * played: the committed bootstrap reports 0 of 38 events finished, `form: 0.0`
 * on all 400 players who have minutes, and Haaland at 2,953 minutes and 27
 * goals. A footnote calling that "this season" is a mislabel of exactly the kind
 * this repo keeps hunting — the number is real and the sentence around it was
 * not. Both
 * describe the same 587 players and nothing put them on one screen, so a reader
 * comparing two forwards could see the projection or the underlying numbers but
 * never the disagreement between them, which is the interesting part.
 *
 * The join is exact. `player_stats` carries FPL's own element id, so this is a
 * lookup rather than the accent-folded name matching the app used to do.
 *
 * ## The two derived numbers, and why only two
 *
 * `xGI` and `xA/90` are not in the artifact and are arithmetic on what is:
 * `xg + xa`, and `xa` scaled by minutes. Everything else a compare view might
 * want — xG/90, goals/90 — the producer already publishes, and recomputing a
 * published number here is how two screens start disagreeing about the same
 * player.
 *
 * `xA/90` is guarded by `ratesAreMeaningful`, which the narrower derives because
 * the rate is a trap: the producer's own per-90 divides by `max(minutes/90, .1)`,
 * so a player with four minutes reads as ten times their xA. A fabricated rate
 * in the same column as measured ones is worse than a blank.
 */

import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";

/** One player, as both artifacts see them. */
export interface Compared {
  readonly elementId: number;
  readonly name: string;
  readonly team: string | null;
  readonly position: string | null;
  /** The simulation's view. Null when the projection has no row for them. */
  readonly projection: Projection | null;
  /** What they have actually done. Null when the stats file has no row. */
  readonly stats: PlayerRow | null;
  /** `xg + xa`, when both are known. */
  readonly xgi: number | null;
  /** `xa / minutes * 90`, or null when the minutes cannot support a rate. */
  readonly xaPer90: number | null;
}

/** Expected goal involvement: the pair the artifact publishes separately. */
export function xgi(stats: PlayerRow | null): number | null {
  if (!stats) return null;
  return stats.xg + stats.xa;
}

/**
 * Assists per ninety.
 *
 * The producer publishes `xg_per_90` and not its counterpart, so this is the one
 * rate the view has to compute. It refuses below the narrower's threshold rather
 * than dividing by a floor, because a rate derived from four minutes is not a
 * small sample — it is a different number wearing the same label.
 */
export function xaPer90(stats: PlayerRow | null): number | null {
  if (!stats || !stats.ratesAreMeaningful || stats.minutes <= 0) return null;
  return (stats.xa / stats.minutes) * 90;
}

/**
 * Assemble the comparison for a set of element ids.
 *
 * Order follows `ids`, not either artifact: the reader chose the order by
 * picking the players, and re-sorting a comparison under them is disorienting.
 * An id present in neither artifact is dropped — there is nothing to show and a
 * column of blanks reads as a player who did nothing.
 */
export function compare(
  ids: readonly number[],
  projections: readonly Projection[],
  stats: readonly PlayerRow[],
): readonly Compared[] {
  const byProjection = new Map<number, Projection>();
  for (const p of projections) byProjection.set(p.elementId, p);
  const byStats = new Map<number, PlayerRow>();
  for (const row of stats) {
    if (row.elementId !== null) byStats.set(row.elementId, row);
  }

  const out: Compared[] = [];
  for (const id of ids) {
    const projection = byProjection.get(id) ?? null;
    const row = byStats.get(id) ?? null;
    if (!projection && !row) continue;
    out.push({
      elementId: id,
      // The projection names players as FPL does; the stats file carries a
      // longer form. Either is better than an id, and the projection wins
      // because it is the name the rest of this screen already shows.
      name: projection?.name ?? row?.name ?? `#${id}`,
      team: projection?.team ?? row?.team ?? null,
      position: projection?.position ?? row?.position ?? null,
      projection,
      stats: row,
      xgi: xgi(row),
      xaPer90: xaPer90(row),
    });
  }
  return out;
}

/** One row of the comparison: a label, and how to read it off each player. */
export interface Metric {
  readonly key: string;
  readonly label: string;
  readonly of: (c: Compared) => number | null;
  /** How many decimals to show. Integers for counts, two for rates. */
  readonly dp: number;
  /** True when a bigger number is better, which decides who gets marked. */
  readonly higherIsBetter: boolean;
  /**
   * How to render the number, declared rather than guessed.
   *
   * `prob` is a 0–1 probability and is multiplied by 100 to show; `pct` is
   * already a percentage and is not. The first version inferred this from
   * magnitude — `value <= 1 ? value * 100 : value` — which is right for
   * `p60` and catastrophically wrong for ownership: 312 of the 503 players
   * with an ownership figure sit at or below 1%, so Saliba's real 0.4% was
   * rendered "40.0%" while `/players` printed 0.4% from the same field.
   *
   * Scale is a property of the source, and the source is known here. Nothing
   * about a value's size tells you which unit it is in.
   */
  readonly unit?: "prob" | "pct" | "money";
}

/**
 * What the comparison shows, in reading order.
 *
 * Projection first, then what actually happened, because the question a reader
 * brings is "should I buy him" and the forecast is the answer to it — the
 * underlying numbers are the argument for or against trusting it.
 */
export const METRICS: readonly Metric[] = [
  { key: "xp", label: "xP", of: (c) => c.projection?.xp ?? null, dp: 2, higherIsBetter: true },
  { key: "mode", label: "most likely", of: (c) => c.projection?.mode ?? null, dp: 0, higherIsBetter: true },
  { key: "q90", label: "ceiling (q90)", of: (c) => c.projection?.q90 ?? null, dp: 1, higherIsBetter: true },
  { key: "q10", label: "floor (q10)", of: (c) => c.projection?.q10 ?? null, dp: 1, higherIsBetter: true },
  { key: "mins", label: "xMins", of: (c) => c.projection?.eMinutes ?? null, dp: 0, higherIsBetter: true },
  { key: "p60", label: "P(60+)", of: (c) => c.projection?.p60 ?? null, dp: 0, higherIsBetter: true, unit: "prob" },

  { key: "minutes", label: "minutes played", of: (c) => c.stats?.minutes ?? null, dp: 0, higherIsBetter: true },
  { key: "goals", label: "goals", of: (c) => c.stats?.goals ?? null, dp: 0, higherIsBetter: true },
  { key: "assists", label: "assists", of: (c) => c.stats?.assists ?? null, dp: 0, higherIsBetter: true },
  { key: "xg", label: "xG", of: (c) => c.stats?.xg ?? null, dp: 2, higherIsBetter: true },
  { key: "xa", label: "xA", of: (c) => c.stats?.xa ?? null, dp: 2, higherIsBetter: true },
  { key: "xgi", label: "xGI", of: (c) => c.xgi, dp: 2, higherIsBetter: true },
  { key: "xa90", label: "xA per 90", of: (c) => c.xaPer90, dp: 2, higherIsBetter: true },

  { key: "price", label: "price", of: (c) => c.stats?.fpl_price ?? null, dp: 1, higherIsBetter: false, unit: "money" },
  { key: "owned", label: "owned by", of: (c) => c.stats?.fpl_ownership ?? null, dp: 1, higherIsBetter: false, unit: "pct" },
  { key: "form", label: "form", of: (c) => c.stats?.form ?? null, dp: 1, higherIsBetter: true },
];


/**
 * Metrics the producer has not populated, judged across the whole population.
 *
 * FPL zeroes `form` between seasons, so `player_stats.json` carries `0.0` for all 590
 * players — and Compare rendered it in the same format as the measured columns, with
 * `leaders` treating it as a 590-way tie for best. Nothing on screen separated "no returns
 * in thirty days", which is information, from "the season has not started", which is a
 * default.
 *
 * The test has to be population-level, because per-row it is undecidable: a real form of
 * zero is meaningful in October and this must not hide it. One player at zero is a fact
 * about that player; every player at zero is a fact about the feed. So this reads the
 * FULL player list rather than the two or three being compared — on a pair, two players
 * who both happened to score nothing would look identical to an unpopulated column.
 *
 * Only the metrics that live on `PlayerRow` can be judged; the projection-derived ones
 * (xGI, xA per 90) are computed here and cannot be a producer default.
 */
const POPULATION_FOR_DEFAULT_DETECTION = 20;

/** Metric key to the field it reads, for the metrics a producer supplies directly. */
const POPULATION_FIELD: Record<string, (row: PlayerRow) => number | null> = {
  goals: (r) => r.goals,
  assists: (r) => r.assists,
  xg: (r) => r.xg,
  xa: (r) => r.xa,
  price: (r) => r.fpl_price,
  owned: (r) => r.fpl_ownership,
  form: (r) => r.form,
};

export function unpublishedMetrics(
  population: readonly PlayerRow[],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (population.length < POPULATION_FOR_DEFAULT_DETECTION) return out;

  for (const [key, read] of Object.entries(POPULATION_FIELD)) {
    let seen = 0;
    let allZero = true;
    for (const row of population) {
      const value = read(row);
      if (value === null || value === undefined) continue;
      seen += 1;
      if (value !== 0) { allZero = false; break; }
    }
    if (allZero && seen >= POPULATION_FOR_DEFAULT_DETECTION) out.add(key);
  }
  return out;
}

/**
 * Which of the compared players leads on a metric.
 *
 * Returns the element ids that tie for best, so a two-way tie marks neither as
 * the winner by an accident of ordering. Nulls never win: a player the producer
 * has no number for has not beaten one it does.
 */
export function leaders(metric: Metric, rows: readonly Compared[]): ReadonlySet<number> {
  const scored = rows
    .map((row) => ({ id: row.elementId, value: metric.of(row) }))
    .filter((entry): entry is { id: number; value: number } => entry.value !== null);
  if (scored.length < 2) return new Set();

  const best = scored.reduce(
    (winner, entry) =>
      metric.higherIsBetter
        ? Math.max(winner, entry.value)
        : Math.min(winner, entry.value),
    metric.higherIsBetter ? -Infinity : Infinity,
  );
  const tied = scored.filter((entry) => entry.value === best);
  // Everyone level is nobody ahead.
  return tied.length === scored.length ? new Set() : new Set(tied.map((e) => e.id));
}
