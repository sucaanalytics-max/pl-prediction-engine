/**
 * The team_metrics.json narrower, against the committed artifact.
 *
 * This repo's pattern: a narrower is tested against the real file, because the
 * naive predicate is wrong in a specific way for almost every artifact and the
 * reason is never obvious from the type. `narrow.ts` records the drift it found
 * that way — nulls on all 564 rows of one column, an absent-but-legal field on
 * all 20 rows of another.
 *
 * ## What changed, and the rule it taught
 *
 * This file used to assert the state the artifact was in on the day it was
 * written: twenty clubs, two matches each, every rank null. That was deliberate
 * and it expired the moment GW3 finished — the producer published three matches
 * and twenty ranks, and four assertions here failed on data that was perfectly
 * correct.
 *
 * So the real-file assertions below are INVARIANTS that hold in September and in
 * May: twenty clubs survive narrowing, `belowThreshold` agrees with the match
 * count and the threshold, both directions of every rate are carried. The one
 * claim that genuinely needs a withheld rank — that a null does not drop the row,
 * which would render the section unreadable on the one day it most needs to say
 * "not yet" — is a fixture, because it must be testable in a month when no rank
 * is null at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { narrowTeamMetrics } from "@/lib/data/narrow";

const real = () =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), "..", "predictions", "team_metrics.json"),
      "utf8",
    ),
  );

describe("narrowTeamMetrics against the committed artifact", () => {
  it("narrows the real file", () => {
    const out = narrowTeamMetrics(real());
    expect(out.ok).toBe(true);
  });

  it("keeps all twenty clubs, whatever state the ranks are in", () => {
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.teams).toHaveLength(20);
  });

  it("drops no row for a withheld rank, which is the unreadable-section case", () => {
    /* A fixture, not the live file. The producer withholds a rank below three
       matches, and a narrower treating that as malformed would drop all twenty
       rows on the one day the section most needs to say "not yet". That has to
       stay testable in May, when nothing is withheld. */
    const raw = real();
    const withheld = {
      ...raw,
      teams: (raw.teams as Record<string, unknown>[]).map((t) => ({
        ...t, attack_rank: null, defence_rank: null, matches: 2,
        below_match_threshold: true,
      })),
    };
    const out = narrowTeamMetrics(withheld);
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.teams).toHaveLength(20);
    expect(out.value.teams.every((t) => t.attackRank === null)).toBe(true);
  });

  it("carries the honesty fields the section renders from", () => {
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.minMatchesForRank).toBe(3);
    expect(out.value.shrinkageK).toBe(6);
    expect(out.value.modelInput).toBe(false);
    expect(out.value.source).toContain("understat");
  });

  it("agrees with itself about who is below the threshold", () => {
    /* The RULE rather than this week's answer: a club is below the threshold
       exactly when it has played fewer matches than the rank needs. True in
       September with two, true in May with thirty-eight. */
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    const floor = out.value.minMatchesForRank;
    // Asserted, not assumed: the rule below is meaningless without a threshold,
    // and a null one would silently pass every comparison rather than fail.
    expect(floor, "the file states no rank threshold").not.toBeNull();
    if (floor === null) return;
    for (const team of out.value.teams) {
      expect(team.belowThreshold, `${team.team} at ${team.matches} matches`)
        .toBe(team.matches < floor);
    }
  });

  it("withholds a rank exactly when the club is below the threshold", () => {
    // The other half of the same rule, and the one the section renders from.
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    for (const team of out.value.teams) {
      if (team.belowThreshold) {
        expect(team.attackRank, `${team.team} is below the threshold`).toBeNull();
      } else {
        expect(team.attackRank, `${team.team} is above it`).not.toBeNull();
      }
    }
  });

  it("reads both the raw and the shrunk rate, and they differ", () => {
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    const t = out.value.teams.find((x) => x.team === "Chelsea");
    expect(t).toBeDefined();
    // Raw 3.21 shrinks to 2.04 at n=2, k=6. Asserting they are not equal is the
    // point: a narrower that read one field into both would look fine.
    expect(t!.npxgForPerMatch).not.toEqual(t!.npxgForShrunk);
    expect(t!.npxgForShrunk).toBeLessThan(t!.npxgForPerMatch!);
  });
});

describe("narrowTeamMetrics on malformed input", () => {
  it("rejects a non-object", () => {
    expect(narrowTeamMetrics("nope").ok).toBe(false);
    expect(narrowTeamMetrics(null).ok).toBe(false);
  });

  it("rejects a file with no teams array", () => {
    expect(narrowTeamMetrics({ generated_at: "x" }).ok).toBe(false);
  });

  it("drops a row with no team name rather than the whole file", () => {
    const out = narrowTeamMetrics({
      ...real(),
      teams: [{ matches: 2 }, ...real().teams],
    });
    // Problems are recorded, so this narrows malformed rather than silently
    // publishing 20 of 21 rows — the drift narrow.ts exists to make loud.
    expect(out.ok).toBe(false);
  });

  it("accepts a null metric without inventing a zero", () => {
    const file = real();
    file.teams[0].ppda = null;
    const out = narrowTeamMetrics(file);
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.teams[0].ppda).toBeNull();
  });
});

describe("the conceded side, which is what a defence question needs", () => {
  it("carries goals and deep completions in both directions", () => {
    /* Both directions present and numeric for every club. This pinned Arsenal's
       0 goals conceded over the first two matches — a fact with a shelf life of
       one gameweek, and it expired in GW3. What a defence question actually needs
       is that the conceded side EXISTS, not that one club's happened to be zero;
       the zero-versus-absent distinction is asserted below on a fixture. */
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    for (const team of out.value.teams) {
      expect(typeof team.goalsAgainstPerMatch, team.team).toBe("number");
      expect(typeof team.goalsForPerMatch, team.team).toBe("number");
      expect(team.npxgAgainstPerMatch, team.team).not.toBeNull();
      expect(team.deepAgainstPerMatch, team.team).not.toBeNull();
    }
  });

  it("keeps a zero conceded distinct from an absent one", () => {
    // 0 goals against is a real measurement; null is "not reported". A narrower
    // that collapsed them would make a clean sheet look like missing data.
    const file = real();
    file.teams[0].goals_against_per_match = null;
    const out = narrowTeamMetrics(file);
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.teams[0].goalsAgainstPerMatch).toBeNull();
  });
});
