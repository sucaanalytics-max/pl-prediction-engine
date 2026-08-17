/**
 * Which file the conflicts come from.
 *
 * The narrowing is covered by the pipeline's own tests; this covers the one
 * thing only the consumer can get wrong — asking for the wrong gameweek's file
 * and rendering the answer as if it were this week's.
 */

import { describe, expect, it } from "vitest";

import {
  MINUTES_CONFLICTS, minutesConflictsDescriptor,
} from "@/lib/data/minutes-conflicts";

describe("the path follows the gameweek", () => {
  /**
   * The path was frozen at `gw01` while `run_news.py` writes one file per
   * gameweek. At the first deadline the poller starts writing gw02 and stops
   * touching gw01, so every consumer would keep fetching a file nobody updates —
   * current-looking conflicts for a day, then permanently out of date.
   *
   * It was unreachable until the artifact started being written at all, which is
   * why a path frozen since the file was created only became a bug this week.
   */
  it("asks for the gameweek it was given", () => {
    expect(minutesConflictsDescriptor(2).path).toBe("fpl/minutes_conflicts_gw02.json");
    expect(minutesConflictsDescriptor(38).path).toBe("fpl/minutes_conflicts_gw38.json");
  });

  it("pads a single digit, as the producer does", () => {
    // `f"minutes_conflicts_gw{gameweek:02d}.json"` — gw1 would 404 forever.
    expect(minutesConflictsDescriptor(1).path).toBe("fpl/minutes_conflicts_gw01.json");
  });

  it("keeps everything else the constant declared", () => {
    const made = minutesConflictsDescriptor(7);
    expect(made.key).toBe(MINUTES_CONFLICTS.key);
    expect(made.owner).toBe(MINUTES_CONFLICTS.owner);
    expect(made.freshnessBudgetMs).toBe(MINUTES_CONFLICTS.freshnessBudgetMs);
    expect(made.narrow).toBe(MINUTES_CONFLICTS.narrow);
  });

  it("does not mutate the constant it derives from", () => {
    // Spreading a shared object is one typo away from rewriting it in place.
    minutesConflictsDescriptor(9);
    expect(MINUTES_CONFLICTS.path).toBe("fpl/minutes_conflicts_gw01.json");
  });
});
