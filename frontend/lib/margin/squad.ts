/**
 * Putting the model's projection next to the squad it is about.
 *
 * ## Joining on the id, and what it replaces
 *
 * `SquadBoard` matches its fifteen against the published projection by **name
 * and position**, folds accents on both sides so `Kadıoğlu` meets `Kadioglu`,
 * and refuses the match when two players collide — FPL has six Wilsons. That was
 * the right call while the narrowed squad carried no id. It does now
 * (`SquadPlayer.elementId`), and the id is FPL's own, which is the same key the
 * projection is written under.
 *
 * So the id is tried first and the folded name is kept as the fallback, because
 * a captured draft can still arrive without one. The two paths are reported
 * separately in {@link SquadJoin} rather than blended: a squad matched entirely
 * on names is a weaker claim than one matched on ids, and the rail says which it
 * got.
 *
 * ## Ambiguity is refused, never guessed
 *
 * Unchanged from the board's rule, and it matters more here because this list is
 * read under a clock. Two projections matching one name yields no projection and
 * the row shows `—`. Putting another player's distribution on yours is worse
 * than showing nothing, and it is the same rule the news extractor applies to
 * its ambiguous surname keys.
 */

import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

export interface SquadRow {
  readonly player: SquadPlayer;
  /** Null when absent from the projection, or when the name was ambiguous. */
  readonly projection: Projection | null;
  /** How this row was matched, for the provenance line under the rail. */
  readonly matchedBy: "id" | "name" | null;
}

export interface SquadJoin {
  readonly rows: readonly SquadRow[];
  readonly matchedById: number;
  readonly matchedByName: number;
  readonly unmatched: number;
}

/** Lowercase and strip accents, so one spelling of a name matches another. */
export function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Turkish dotless ı does not decompose, so it needs naming explicitly — the
    // exact character that made an earlier squad match miss F.Kadıoğlu.
    .replace(/ı/g, "i")
    .toLowerCase()
    .trim();
}

export function joinProjections(
  squad: readonly SquadPlayer[],
  projections: readonly Projection[],
): SquadJoin {
  const byId = new Map<number, Projection>();
  for (const projection of projections) byId.set(projection.elementId, projection);

  const rows: SquadRow[] = [];
  let matchedById = 0;
  let matchedByName = 0;

  for (const player of squad) {
    const direct = player.elementId === undefined
      ? undefined
      : byId.get(player.elementId);
    if (direct) {
      matchedById += 1;
      rows.push({ player, projection: direct, matchedBy: "id" });
      continue;
    }

    const name = fold(player.name);
    const position = fold(player.position);
    const hits = projections.filter(
      (p) => fold(p.name ?? "") === name
        && (!position || fold(p.position ?? "") === position),
    );
    if (hits.length === 1) {
      matchedByName += 1;
      rows.push({ player, projection: hits[0], matchedBy: "name" });
      continue;
    }

    rows.push({ player, projection: null, matchedBy: null });
  }

  return {
    rows,
    matchedById,
    matchedByName,
    unmatched: rows.length - matchedById - matchedByName,
  };
}

/**
 * The fifteen in reading order: by line, then by the model's own mean.
 *
 * Ordering by `xp` rather than by FPL's pick position is deliberate. The pick
 * order encodes an XI that nothing here has solved, so presenting it would let
 * the reader infer a lineup from a sort; ordering by the projection presents the
 * one ranking that was computed. Rows with no projection sink to the bottom of
 * their line rather than to the top, which a null-first comparator would do.
 */
const LINES = ["GKP", "DEF", "MID", "FWD"];

export function inReadingOrder(rows: readonly SquadRow[]): readonly SquadRow[] {
  return [...rows].sort((a, b) => {
    const line = LINES.indexOf(a.player.position) - LINES.indexOf(b.player.position);
    if (line !== 0) return line;
    const ax = a.projection?.xp;
    const bx = b.projection?.xp;
    if (ax === null || ax === undefined) return bx === null || bx === undefined ? 0 : 1;
    if (bx === null || bx === undefined) return -1;
    return bx - ax;
  });
}

/**
 * Whether the route told us which eleven start.
 *
 * An all-`undefined` `bench` means nobody has said, which is the normal state
 * before a deadline — `SquadPlayer.bench` is optional precisely so that
 * "unknown" and "starting" stay different facts. Splitting the list anyway
 * would invent a lineup out of an array order.
 */
export function hasLineup(rows: readonly SquadRow[]): boolean {
  return rows.some((row) => row.player.bench !== undefined);
}
