import { describe, expect, it } from "vitest";

import { gameweeksFromHeaders } from "./import-fplreview-projections.mjs";

const LEAD = ["Pos", "ID", "Name", "BV", "SV", "Team"];

/** The header row FPLReview writes for a run of consecutive gameweeks. */
function headers(gameweeks) {
  return [...LEAD, ...gameweeks.flatMap((gw) => [`${gw}_xMins`, `${gw}_Pts`]), "Elite%"];
}

const range = (first, count) => Array.from({ length: count }, (_, i) => first + i);

describe("gameweeksFromHeaders", () => {
  it("reads the horizon off the headers rather than assuming ten", () => {
    // The real 2026-09-10 export: six gameweeks, GW4-GW9. A pinned horizon of 10
    // rejected this file as malformed when it was merely shorter.
    expect(gameweeksFromHeaders(headers(range(4, 6)))).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("still accepts the ten-gameweek export", () => {
    expect(gameweeksFromHeaders(headers(range(3, 10)))).toEqual(range(3, 10));
  });

  it("accepts a single gameweek", () => {
    expect(gameweeksFromHeaders(headers([38]))).toEqual([38]);
  });

  it("rejects a run that would spill past the last gameweek", () => {
    expect(() => gameweeksFromHeaders(headers(range(36, 6)))).toThrow(
      /Cannot read a first gameweek/,
    );
  });

  it("rejects a gap, because the index is what carries the gameweek", () => {
    const withGap = [...LEAD, "4_xMins", "4_Pts", "6_xMins", "6_Pts", "Elite%"];
    expect(() => gameweeksFromHeaders(withGap)).toThrow(/not consecutive from GW4/);
  });

  it("rejects an odd number of gameweek columns", () => {
    const odd = [...LEAD, "4_xMins", "4_Pts", "5_xMins", "Elite%"];
    expect(() => gameweeksFromHeaders(odd)).toThrow(/even, non-zero/);
  });

  it("rejects an export with no gameweek columns at all", () => {
    expect(() => gameweeksFromHeaders([...LEAD, "Elite%"])).toThrow(/even, non-zero/);
  });

  it("rejects unexpected leading columns", () => {
    expect(() => gameweeksFromHeaders(["Name", "4_xMins", "4_Pts", "Elite%"])).toThrow(
      /Unexpected leading FPLReview columns/,
    );
  });
});
