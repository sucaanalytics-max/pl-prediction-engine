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

describe("the counts that decide whether silence is good news", () => {
  it("narrows the shipped artifact", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok).toBe(true);
  });

  it("carries how many players have a claim at all, not only how many resolved", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.withClaims).toBe(19);
    expect(result.ok && result.value.claims).toBe(75);
  });

  it("records that none of them has been resolved, which is the whole point", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.resolved).toBe(0);
    expect(result.ok && result.value.players).toEqual([]);
    // An empty player list with nineteen unresolved claims is "not assessed", not
    // "nothing to report" — the opposite reassurance.
  });

  it("keeps the escalation visible", () => {
    const result = narrowEvidenceView(SHIPPED);
    expect(result.ok && result.value.escalations).toBe(1);
  });

  it("defaults a missing count to zero rather than dropping the artifact", () => {
    const withoutCounts = { ...SHIPPED, counts: {} };
    const result = narrowEvidenceView(withoutCounts);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.withClaims).toBe(0);
  });
});
