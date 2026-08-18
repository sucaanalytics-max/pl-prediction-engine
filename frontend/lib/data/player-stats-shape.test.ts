/**
 * `available` is not "available", and the file could not grow old.
 *
 * `pipeline/data/fpl_api.py:270` is `df["available"] = df["status"].isin(["a", "d"])`,
 * with the comment "available or doubtful" beside it. So a 75% doubt has always read as
 * fit on `/players` and survived an "Available only" filter, and the control room's
 * availability split counted it as clear.
 *
 * The producer now also exports FPL's own `status` letter and `chance_of_playing`, and
 * wraps the list in an envelope so the figures derived from it can carry an age.
 *
 * Both shapes must narrow. The deployed frontend reads a file the daily pipeline writes,
 * so for one run the code and the artifact disagree about which shape is current — a
 * narrower that accepted only the new one would blank the players table until the next
 * run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { narrowPlayerStats, playerStatsProducedAt, type PlayerRow } from "@/lib/data/narrow";
import { classify, proven } from "@/lib/data/artifact";

const ROW = {
  player_id: 1, name: "A Player", web_name: "Player", team: "ARS", position: "MID",
  minutes: 900, goals_scored: 3, assists: 2, expected_goals: 2.5, expected_assists: 1.5,
  fpl_price: 7.5, fpl_ownership: 12.3, form: 0, available: true,
};

describe("both shapes narrow", () => {
  it("reads the legacy bare list", () => {
    const result = narrowPlayerStats([ROW]);
    expect(result.ok && result.value).toHaveLength(1);
  });

  it("reads the enveloped shape", () => {
    const result = narrowPlayerStats({ generated_at: "2026-08-19T06:00:00Z", players: [ROW] });
    expect(result.ok && result.value).toHaveLength(1);
  });

  it("finds the producer's timestamp only on the envelope", () => {
    expect(playerStatsProducedAt({ generated_at: "2026-08-19T06:00:00Z", players: [] }))
      .toBe("2026-08-19T06:00:00Z");
    // The bare list carries none, which is exactly why the availability figure on the
    // board could never be marked stale.
    expect(playerStatsProducedAt([ROW])).toBeNull();
  });

  it("still rejects a payload that is neither", () => {
    expect(narrowPlayerStats({ nope: true }).ok).toBe(false);
  });
});

describe("a doubt is not a clean bill of health", () => {
  it("carries FPL's own status letter and published chance", () => {
    const result = narrowPlayerStats([{ ...ROW, status: "d", chance_of_playing: 75 }]);
    expect(result.ok && result.value[0].status).toBe("d");
    expect(result.ok && result.value[0].chanceOfPlaying).toBe(75);
  });

  it("keeps `available` true for a doubt, which is what it has always meant", () => {
    /* Not a bug to fix here — it is FPL's own `status in {a,d}` and other code reads it.
       The fix is that callers now have something finer to ask. */
    const result = narrowPlayerStats([{ ...ROW, status: "d", chance_of_playing: 25 }]);
    expect(result.ok && result.value[0].available).toBe(true);
    expect(result.ok && result.value[0].chanceOfPlaying).toBe(25);
  });

  it("leaves both null on a file written before the producer exported them", () => {
    // Null is "the producer did not say", which is a different claim from "fit".
    const result = narrowPlayerStats([ROW]);
    expect(result.ok && result.value[0].status).toBeNull();
    expect(result.ok && result.value[0].chanceOfPlaying).toBeNull();
  });

  it("agrees with the shipped artifact today", () => {
    const raw = JSON.parse(readFileSync("public/predictions/player_stats.json", "utf8"));
    const result = narrowPlayerStats(raw);
    expect(result.ok).toBe(true);
    // The committed file predates the producer change, so it is the bare list with no
    // status. This flips when the pipeline next runs, which is the point.
    expect(result.ok && result.value.length).toBeGreaterThan(500);
  });
});

describe("the availability figure can finally grow old", () => {
  /**
   * `producedAtOf` receives the NARROWED value, and this artifact narrows to a bare array
   * — so its `generated_at` had nowhere to survive and the control room's availability
   * split was the only artifact-derived number on the board with no way to be stale.
   *
   * `producedAtOfRaw` reads the envelope instead. Additive, so no other descriptor
   * changed, and the alternative — widening the narrowed type and every consumer of it —
   * is not forced on an artifact whose four consumers all want the array.
   */
  it("reports the envelope's timestamp through classify", () => {
    const artifact = classify<readonly PlayerRow[]>({
      path: "player_stats.json",
      source: "local",
      raw: { generated_at: "2026-08-19T06:00:00Z", players: [ROW] },
      narrow: narrowPlayerStats,
      producedAtOfRaw: playerStatsProducedAt,
      now: new Date("2026-08-19T12:00:00Z"),
      freshnessBudgetMs: 2 * 24 * 60 * 60 * 1000,
    });
    expect(artifact.provenance.producedAt).toBe("2026-08-19T06:00:00Z");
    expect(proven(artifact)).toHaveLength(1);
  });

  it("still says nothing for the legacy bare list, rather than inventing a time", () => {
    const artifact = classify<readonly PlayerRow[]>({
      path: "player_stats.json",
      source: "local",
      raw: [ROW],
      narrow: narrowPlayerStats,
      producedAtOfRaw: playerStatsProducedAt,
      now: new Date("2026-08-19T12:00:00Z"),
    });
    expect(artifact.provenance.producedAt).toBeNull();
    expect(proven(artifact)).toHaveLength(1);
  });

  it("goes stale once the envelope's timestamp is old enough", () => {
    const artifact = classify<readonly PlayerRow[]>({
      path: "player_stats.json",
      source: "local",
      raw: { generated_at: "2026-08-10T06:00:00Z", players: [ROW] },
      narrow: narrowPlayerStats,
      producedAtOfRaw: playerStatsProducedAt,
      now: new Date("2026-08-19T12:00:00Z"),
      freshnessBudgetMs: 2 * 24 * 60 * 60 * 1000,
    });
    // Nine days against a two-day budget. Before this it could never reach `stale`.
    expect(artifact.state).toBe("stale");
  });
});
