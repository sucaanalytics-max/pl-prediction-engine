/**
 * Which fixture a player's club plays in a given week of the plan.
 *
 * The plan grid knows element ids; the fixture matrix knows clubs. This is the
 * one hop between them, and it is deliberately the only thing in this file.
 *
 * ## What it does not do
 *
 * It does not fold doubles, keep blanks aligned, or choose a colour.
 * `lib/projections/phases.ts` already does the first two — `clubWeeks` collapses
 * a double to its worst rating and gives an idle club a cell anyway — and
 * `difficultyBand` with the `TRAFFIC` ramp already does the third, with a
 * measured argument for four stops instead of five. `/phases` is built on all
 * three. Re-deriving any of them for the squad grid would be a second answer to
 * a question already answered, and the copy that drifts is always the one nobody
 * is looking at.
 *
 * ## The state this does add
 *
 * `PhaseWeek` can say "blank" but not "I have never heard of this club".
 * `weekFor` returns `null` for that, and the two must not be collapsed: a blank
 * is a claim about the schedule, an unknown club is a claim about our own data.
 * Rendering the second as the first puts a fixture chip under a number whose
 * fixture nobody looked up.
 *
 * Team names join on FPL's own spelling. `xp_public` and `/api/fpl/state` both
 * use it and agree on all twenty, verified against the live route; the only
 * mismatch in the tree is `player_stats.json` ("Man United", "Tottenham"), and a
 * consumer that reaches for that one gets null rather than a wrong fixture.
 */

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import { clubWeeks, type PhaseWeek } from "@/lib/projections/phases";

/** Club name → gameweek → that club's week. */
export type ClubWeekIndex = ReadonlyMap<string, ReadonlyMap<number, PhaseWeek>>;

/**
 * Build the lookup for exactly the weeks the grid draws.
 *
 * `gameweeks` is passed in rather than derived from the matrix so the index
 * covers the plan's columns even where a club has no fixture in one of them —
 * the same reason `clubWeeks` takes it.
 */
export function indexClubWeeks(
  rows: readonly FixtureMatrixRow[], gameweeks: readonly number[],
): ClubWeekIndex {
  const index = new Map<string, ReadonlyMap<number, PhaseWeek>>();
  for (const row of rows) {
    const weeks = new Map<number, PhaseWeek>();
    for (const week of clubWeeks(row, gameweeks)) weeks.set(week.gameweek, week);
    index.set(row.team, weeks);
  }
  return index;
}

/**
 * One club's week, or null when the club or the week is not in the index.
 *
 * Null covers three genuinely different absences — no matrix was readable, this
 * club is not in it, this week was not asked for — and they are one value here
 * on purpose: every one of them means "nothing is known", which is what the cell
 * has to say. A blank fixture is NOT one of them; it comes back as a `PhaseWeek`
 * with `blank: true`.
 */
export function weekFor(
  index: ClubWeekIndex, team: string | null | undefined, gameweek: number,
): PhaseWeek | null {
  if (!team) return null;
  return index.get(team)?.get(gameweek) ?? null;
}
