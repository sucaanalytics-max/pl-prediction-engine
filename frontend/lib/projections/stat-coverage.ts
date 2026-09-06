/**
 * How much football each source on the stats sheet has actually seen.
 *
 * ## Why this exists
 *
 * The sheet puts FPL's expected goals and Understat's expected goals on one row.
 * Read without a denominator they look like two models disagreeing. They are not:
 * on the day this was written FPL's record was three matches deep and Understat's
 * was one, so Isak read 243 minutes and 2.29 xG in one band and 90 minutes and
 * 1.41 xG in the next. The difference was coverage, and nothing on the screen
 * said so, because nothing in the app knew.
 *
 * ## Derived, never asserted
 *
 * Every figure here comes from a published fact or is withheld:
 *
 *   - Understat states `matches` on each row. The band's reach is the DEEPEST of
 *     them, because a player who missed a game carries fewer and the band's claim
 *     is about the feed rather than about one player.
 *   - FPL's record has no match count in it. It is taken from the gameweek the
 *     app resolved, minus the one not yet played. When no gameweek could be
 *     resolved, the coverage is null and the strip says so — the same discipline
 *     the ∅ mark applies to a cell.
 *   - The simulation covers exactly the week it was generated for.
 *   - The market has no denominator to state; it is whatever FPL published last.
 *
 * A null here must render as an admission, never as a zero. `stat-coverage.test.ts`
 * pins that none of these is ever inferred from a neighbour.
 */

import type { PlayerEvent } from "@/lib/data/player-events";
import type { StatSource } from "@/lib/projections/stat-questions";

export interface SourceCoverage {
  readonly source: StatSource;
  /** One or two words for the strip: "3 matches", "GW4", "live". */
  readonly reach: string | null;
  /** Why the reach is unknown. Null when it is known. */
  readonly unknownBecause: string | null;
}

/** Understat publishes a per-row match count; the feed's reach is the deepest. */
export function understatMatches(players: readonly PlayerEvent[] | null): number | null {
  if (players === null || players.length === 0) return null;
  let deepest: number | null = null;
  for (const player of players) {
    if (player.matches === null) continue;
    if (deepest === null || player.matches > deepest) deepest = player.matches;
  }
  return deepest;
}

function matchWord(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

export function coverageFor(
  source: StatSource,
  input: {
    readonly gameweek: number | null;
    readonly events: readonly PlayerEvent[] | null;
  },
): SourceCoverage {
  switch (source) {
    case "playerStats": {
      // The upcoming gameweek minus the one not yet played. A gameweek of 1 means
      // nothing has been played, which is a real state and reads as "0 matches"
      // rather than as a negative or as unknown.
      if (input.gameweek === null) {
        return {
          source, reach: null,
          unknownBecause: "no gameweek could be resolved, so how many matches this "
            + "record covers cannot be stated",
        };
      }
      return {
        source, reach: matchWord(Math.max(0, input.gameweek - 1)), unknownBecause: null,
      };
    }
    case "playerEvents": {
      const matches = understatMatches(input.events);
      if (matches === null) {
        return {
          source, reach: null,
          unknownBecause: "the feed did not say how many matches its rows cover",
        };
      }
      return { source, reach: matchWord(matches), unknownBecause: null };
    }
    case "projections": {
      if (input.gameweek === null) {
        return {
          source, reach: null,
          unknownBecause: "no gameweek could be resolved, so there is no week to point "
            + "a projection at",
        };
      }
      return { source, reach: `GW${input.gameweek}`, unknownBecause: null };
    }
    case "market":
      return { source, reach: "live", unknownBecause: null };
  }
}

/**
 * Whether two sources on one sheet cover different amounts of football.
 *
 * The warning the strip raises. Only ever compares MATCH counts — a simulation's
 * week and a market's "live" have no denominator, so they cannot disagree with
 * anything and are excluded rather than coerced into a comparison.
 */
export function coverageDiffers(
  covers: readonly SourceCoverage[],
): boolean {
  const counted = covers
    .filter((c) => c.source === "playerStats" || c.source === "playerEvents")
    .map((c) => c.reach)
    .filter((reach): reach is string => reach !== null);
  return new Set(counted).size > 1;
}
