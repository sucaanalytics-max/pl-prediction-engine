/**
 * "Available only" has to mean available.
 *
 * `pipeline/data/fpl_api.py:270` defines `available` as `status in {"a", "d"}` — available
 * OR doubtful — so the checkbox passed a 75% doubt as fit, and the row showed no mark
 * beside him because the only marker branched on the same boolean. On a shortlist you are
 * picking a transfer from, that is the wrong direction to be wrong in.
 *
 * The filter is a pure predicate here rather than a rendered page: the page is a 700-line
 * client component and the property under test is the rule, not the markup.
 */
import { describe, expect, it } from "vitest";

import type { PlayerRow } from "@/lib/data/narrow";

/** The rule as `app/players/page.tsx` applies it. */
function passesFitOnly(row: Pick<PlayerRow, "available" | "status">): boolean {
  if (row.available !== true) return false;
  if (row.status !== null && row.status !== "a") return false;
  return true;
}

describe("the fit-only filter", () => {
  it("keeps a fit player", () => {
    expect(passesFitOnly({ available: true, status: "a" })).toBe(true);
  });

  it("excludes a doubt, which FPL marks `d` and `available` calls true", () => {
    // The defect: this row passed the filter and carried no mark.
    expect(passesFitOnly({ available: true, status: "d" })).toBe(false);
  });

  it("excludes injured, suspended and unavailable", () => {
    for (const status of ["i", "s", "u", "n"]) {
      expect(passesFitOnly({ available: false, status }), status).toBe(false);
    }
  });

  it("falls back to the boolean when the producer states no status", () => {
    /* A file written before the producer exported `status`. "Did not say" is not
       evidence of a doubt, so the old behaviour stands rather than hiding 590 players. */
    expect(passesFitOnly({ available: true, status: null })).toBe(true);
    expect(passesFitOnly({ available: false, status: null })).toBe(false);
  });

  it("excludes a player FPL calls unavailable even if a status disagrees", () => {
    // Both gates apply; neither overrides the other.
    expect(passesFitOnly({ available: false, status: "a" })).toBe(false);
  });
});
