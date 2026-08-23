/**
 * A column of zeroes is not a column of measurements.
 *
 * FPL zeroes `form` between seasons. `player_stats.json` carries `0.0` for all 590
 * players today, and Compare rendered it in the same format as the measured columns, with
 * `leaders` treating it as a 590-way tie for best. Nothing separated "no returns in thirty
 * days", which is information, from "the season has not started", which is a default.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { METRICS, unpublishedMetrics } from "@/lib/margin/compare";

/** Enough rows for the population test to be evidence rather than coincidence. */
function population(count: number, form: number | null) {
  return Array.from({ length: count }, (_, i) => ({
    elementId: i + 1,
    name: `p${i}`, team: "ARS", minutes: 90,
    // Every other column varies, so the detector has something to leave alone.
    form, goals: i, assists: (i % 3) + 1, xg: 0.5, xa: 0.2,
    fpl_price: 5 + i * 0.1, fpl_ownership: 3 + i,
  })) as never[];
}

describe("a metric the producer has not populated", () => {
  it("finds form when every player carries the same zero", () => {
    expect(unpublishedMetrics(population(50, 0)).has("form")).toBe(true);
  });

  it("does not flag a metric where one player happens to be zero", () => {
    const rows = population(50, 2.5);
    (rows[0] as { form: number }).form = 0;
    expect(unpublishedMetrics(rows).has("form")).toBe(false);
  });

  it("does not flag anything on a two-player comparison", () => {
    /* Two players who both scored nothing is a fact about them, not about the feed —
       and Compare's whole purpose is comparing two players. */
    expect(unpublishedMetrics(population(2, 0)).size).toBe(0);
  });

  it("treats absent as absent, not as zero", () => {
    // A metric nobody publishes at all is already handled by the null path; it must not
    // be reported here as a population of zeroes.
    expect(unpublishedMetrics(population(50, null)).has("form")).toBe(false);
  });

  it("leaves the genuinely measured columns alone", () => {
    const flagged = unpublishedMetrics(population(50, 0));
    expect(flagged.has("xg")).toBe(false);
    expect(flagged.has("price")).toBe(false);
    expect([...flagged]).toEqual(["form"]);
  });

  it("agrees with the shipped artifact, which has since become a measurement", () => {
    const raw = JSON.parse(
      readFileSync("public/predictions/player_stats.json", "utf8"),
    ) as unknown;
    const players = Array.isArray(raw)
      ? raw
      : (raw as { players?: unknown[] }).players ?? [];
    expect(players.length).toBeGreaterThan(100);
    const forms = players
      .map((p) => (p as { form?: number }).form)
      .filter((f): f is number => typeof f === "number");
    expect(forms.length).toBeGreaterThan(100);
    // This assertion used to be `every(f => f === 0)`, with a comment saying "if this
    // ever fails the season has started and the column has become a measurement".
    // The season started. So the assertion is inverted rather than deleted: `form` is
    // now real, which is precisely why `unpublishedMetrics` must not flag it, and the
    // synthetic cases above still guard the all-zero handling for the next pre-season.
    expect(forms.some((f) => f !== 0)).toBe(true);
    expect(unpublishedMetrics(players as never).has("form")).toBe(false);
  });

  it("keeps form in METRICS, because it becomes real once the season starts", () => {
    // The fix is to stop presenting a default as a measurement, not to delete the column.
    expect(METRICS.some((m) => m.key === "form")).toBe(true);
  });
});
