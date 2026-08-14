/**
 * Two players the mean cannot tell apart.
 *
 * ## What this panel is arguing
 *
 * Seven of eight products in this category publish one number per player. The
 * claim Margin makes is that the number is not sufficient, and the cheapest
 * proof is a pair with the same mean and different shapes: one a 2.4 standard
 * deviation with a 7% chance of ten or more, the other a 5.9 with 24%. For a
 * season entry you want the first; chasing a rank from behind you want the
 * second. Every product that ships one number per player shows them as equal.
 *
 * ## Why it is searched rather than written down
 *
 * The obvious implementation is two names in a constant, and it would be wrong
 * within a week — the pair that makes this point depends on the fixture list,
 * and a stale example is an example that does not hold when a reader checks it.
 * So the pair is found in the published projection every render, and when no
 * pair in the file makes the point the panel says so instead of showing the
 * least bad two.
 *
 * ## The threshold is a claim, so it is stated
 *
 * `MEAN_TOLERANCE` is how close two means must be before "the mean cannot tell
 * them apart" is a fair thing to say, and `MIN_SD_GAP` is how far apart the
 * spreads must be before the difference is worth a panel. Both are here rather
 * than inline so a reader can disagree with the numbers rather than with the
 * result.
 */

import type { Projection } from "@/lib/data/projections";

/** Means within this many points are, for this panel's purposes, the same. */
export const MEAN_TOLERANCE = 0.05;

/**
 * Below this the two shapes are not different enough to be worth the claim.
 *
 * A pair separated by 0.3 of a standard deviation would let the panel print its
 * headline over two players who really are interchangeable, which discredits the
 * argument on the one screen making it.
 */
export const MIN_SD_GAP = 1.5;

export interface Twins {
  /** The tighter of the two — the season-entry holding. */
  readonly steady: Projection;
  /** The wider one — the rank-chasing holding. */
  readonly volatile: Projection;
  /** How far apart the two means actually are, so the panel can show it. */
  readonly meanGap: number;
}

function eligible(p: Projection): boolean {
  return !p.blank
    && p.xp !== null
    && p.xpSd !== null
    && Number.isFinite(p.xp)
    && Number.isFinite(p.xpSd);
}

/**
 * The most convincing pair in the file, or null.
 *
 * "Most convincing" is the widest gap in spread among pairs whose means agree,
 * with ties going to the higher mean — a pair at 6.4 is a decision a reader
 * might actually face, and a pair at 1.1 is a curiosity.
 *
 * Linear in the sorted list rather than quadratic in the file: sorting by mean
 * makes every candidate partner a short forward scan, which matters because this
 * runs over 581 players on every render of the research view.
 */
export function findTwins(
  players: readonly Projection[],
  tolerance: number = MEAN_TOLERANCE,
  minSdGap: number = MIN_SD_GAP,
): Twins | null {
  const ranked = players
    .filter(eligible)
    .sort((a, b) => (a.xp as number) - (b.xp as number));

  let best: Twins | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < ranked.length; i += 1) {
    const a = ranked[i];
    const aXp = a.xp as number;
    const aSd = a.xpSd as number;

    for (let j = i + 1; j < ranked.length; j += 1) {
      const b = ranked[j];
      const bXp = b.xp as number;
      // Sorted, so once the mean gap exceeds the tolerance every later partner
      // does too.
      if (bXp - aXp > tolerance) break;

      const sdGap = Math.abs((b.xpSd as number) - aSd);
      if (sdGap < minSdGap) continue;

      // Spread gap first, mean second. Weighting the mean lightly is enough to
      // break ties toward the players a reader is actually choosing between,
      // without letting a marginally better mean outrank a much clearer shape.
      const score = sdGap * 10 + (aXp + bXp) / 2;
      if (score > bestScore) {
        bestScore = score;
        const [steady, volatile_] =
          aSd <= (b.xpSd as number) ? [a, b] : [b, a];
        best = { steady, volatile: volatile_, meanGap: Math.abs(bXp - aXp) };
      }
    }
  }

  return best;
}
