/**
 * An empty list of contested players is not an all-clear until something has been
 * resolved.
 *
 * `/evidence` printed "Nobody's availability is in question. Every player with claims on
 * file reads as fully available, from an uncontested source." The shipped artifact carries
 * `n_claims: 75` across `n_players_with_claims: 19` with `n_players_resolved: 0` and one
 * escalation — so nothing had been adjudicated, and the page issued an availability
 * all-clear before a deadline on the strength of work the agent had not done.
 *
 * The counts were in the file all along; the narrower read three of the five.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { narrowEvidenceView } from "@/lib/data/narrow";

const SHIPPED = JSON.parse(
  readFileSync("public/predictions/fpl/evidence_view.json", "utf8"),
) as Record<string, unknown>;

/**
 * The shipped counts, read rather than remembered.
 *
 * These assertions used to pin 19 / 0 / 1, the values in the file the day the bug
 * was found. The season started, the artifact moved to 184 / 133 / 12, and the
 * suite went red on numbers rather than on anything real — the exact trap
 * `real-artifacts.test.ts` documents in its own comment. What matters is that the
 * narrower CARRIES each count, not that any count has a particular value.
 */
const COUNTS = (SHIPPED.counts ?? {}) as Record<string, number>;

describe("the counts that decide whether silence is good news", () => {
  it("narrows the shipped artifact", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok).toBe(true);
  });

  it("carries how many players have a claim at all, not only how many resolved", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.withClaims).toBe(COUNTS.n_players_with_claims);
    // Not vacuous: the file must actually carry claims for this to mean anything.
    expect(COUNTS.n_players_with_claims).toBeGreaterThan(0);
    expect(result.ok && result.value.claims).toBe(COUNTS.n_claims);
  });

  it("reports resolved separately from shown, which is what distinguishes the two", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.resolved).toBe(COUNTS.n_players_resolved);
    // The listed players must match the count that says how many are listed. That
    // is the invariant behind the original bug: the page saw an EMPTY list and read
    // it as "nothing to report", when the unresolved count made it "not assessed".
    // Pinning the list to empty pinned the day's data; pinning it to n_players_shown
    // pins the relationship, which is what the page actually reasons about.
    expect(result.ok && result.value.players).toHaveLength(COUNTS.n_players_shown);
  });

  it("keeps the escalation visible", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.escalations).toBe(COUNTS.n_escalations);
  });

  it("defaults a missing count to zero rather than dropping the artifact", () => {
    const withoutCounts = { ...SHIPPED, counts: {} };
    const result = narrowEvidenceView(withoutCounts);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.withClaims).toBe(0);
  });
});
