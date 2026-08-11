/**
 * Qualification and relegation zones for the league table.
 *
 * This module exists because the obvious signature was the bug. `/table`
 * previously asked `getZone(pos)`, and it renders all 20 clubs as Champions
 * League. There are **two different mechanisms**, one live and one waiting, and
 * only a table-level check survives both:
 *
 * 1. *Today's committed file* has `position: 0` on all 20 rows. `pos <= 4` is
 *    therefore true for every club.
 * 2. *The next real run* will not. `fpl_api.py:345` assigns positions via
 *    `enumerate(table, start=1)`, so a fresh pre-season file has `position` 1-20
 *    over a sort whose key is identically zero — the order is alphabetical, and
 *    *Arsenal, Aston Villa, Bournemouth, Brentford* take the European places.
 *
 * So **fixing the artifact does not fix the bug**, it only changes which clubs
 * are wrongly highlighted. A correct pre-season file has exactly this shape; it
 * is not corrupt, and the check cannot live in the writer.
 *
 * It also cannot be `position !== 0`, and that is the subtle part: that predicate
 * *works today* — every position is 0, so it correctly reports "unranked" — and
 * silently stops working the moment the current writer runs. A guard that passes
 * its test on today's data and fails in production next week is worse than no
 * guard, because it will be trusted.
 *
 * Matches played is the only evidence that a standing exists. The fix is to make
 * the wrong question unaskable: a zone is a property of a row *within a table*,
 * so the function takes the table.
 */

export type Zone = "champions" | "europa" | "conference" | "relegation";

/**
 * The minimum a row must have for a zone to be decided.
 *
 * Structural rather than the legacy `TeamStanding`, for two reasons: the narrowed
 * `Standing` is `readonly` throughout and would not satisfy a mutable interface,
 * and naming only the two fields this actually reads makes it obvious that a zone
 * depends on matches played and position — nothing else.
 */
export interface RankableRow {
  readonly position: number;
  readonly played?: number;
}

/**
 * Whether the table has earned the right to describe zones at all.
 *
 * Matches played is the evidence that a standing exists. Summing rather than
 * testing any single row: a mid-season table where one club has a game in hand
 * is still ranked, and a single `played > 0` is enough to establish that the
 * season has started.
 */
export function tableIsRanked(table: readonly RankableRow[]): boolean {
  return table.reduce((total, row) => total + (row.played ?? 0), 0) > 0;
}

/**
 * Zone for one row, in the context of the whole table, or null for none.
 *
 * Returns null for every row of an unranked table — not because the positions
 * are missing, but because they carry no information.
 */
export function deriveZone(
  club: RankableRow,
  table: readonly RankableRow[],
): Zone | null {
  if (!tableIsRanked(table)) return null;
  const pos = club.position;
  if (pos <= 4) return "champions";
  if (pos === 5) return "europa";
  if (pos === 6) return "conference";
  if (pos >= 18) return "relegation";
  return null;
}
