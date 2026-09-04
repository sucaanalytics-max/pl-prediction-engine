/**
 * The team_metrics.json narrower, against the committed artifact.
 *
 * This repo's pattern: a narrower is tested against the real file, because the
 * naive predicate is wrong in a specific way for almost every artifact and the
 * reason is never obvious from the type. `narrow.ts` records the drift it found
 * that way — nulls on all 564 rows of one column, an absent-but-legal field on
 * all 20 rows of another.
 *
 * The state this file is in RIGHT NOW is the state that matters most: twenty
 * clubs, two matches each, **every rank null** because the threshold is three.
 * A narrower that treats a null rank as malformed would drop all twenty rows and
 * render the section unreadable on the one day it most needs to say "not yet".
 * So that is asserted directly rather than left to a fixture someone invents.
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

  it("keeps all twenty clubs even though every rank is null", () => {
    const out = narrowTeamMetrics(real());
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

  it("marks every club below the threshold, since all have played two", () => {
    const out = narrowTeamMetrics(real());
    if (!out.ok) throw new Error(out.problems.join("; "));
    expect(out.value.teams.every((t) => t.belowThreshold)).toBe(true);
    expect(out.value.teams.every((t) => t.matches === 2)).toBe(true);
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
