/**
 * The FPLReview export must never be a build dependency again.
 *
 * ## Why this file exists
 *
 * A single line — `import snapshotJson from "@/data/fplreview-projections.json"`
 * — made the entire site unbuildable from a clean checkout, and it took a
 * measurement to notice: five routes returned 404 in production, and the cause
 * was that a *tracked* module imported an *untracked* 128KB paid export. CI,
 * Vercel and every fresh clone hit
 *
 *     Module not found: Can't resolve '@/data/fplreview-projections.json'
 *
 * The file has never been in git history and never will be — it is a
 * competitor's licensed product. So the only durable fix is that its absence is
 * an ordinary runtime state, and these tests pin that.
 *
 * The important one is `an absent export is not an error`. Everything else here
 * is detail; that assertion is the build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forwardProjection,
  getFplReviewProjection,
  getFplReviewSnapshot,
  resetFplReviewSnapshotForTests,
} from "@/lib/fplreview-projections";

let dir: string;
const ORIGINAL = process.env.FPLREVIEW_SNAPSHOT_PATH;

function pointAt(filename: string) {
  process.env.FPLREVIEW_SNAPSHOT_PATH = join(dir, filename);
  resetFplReviewSnapshotForTests();
}

function write(filename: string, contents: string) {
  writeFileSync(join(dir, filename), contents, "utf8");
}

const VALID = JSON.stringify({
  schemaVersion: 1,
  source: "fplreview",
  sourceFile: "export.csv",
  exportedAt: "2026-08-04T09:00:00Z",
  checksum: "abc",
  gameweeks: [1, 2, 3],
  rawRecordCount: 2,
  recordCount: 1,
  excludedSyntheticRows: 1,
  players: [
    {
      elementId: 427,
      name: "Salah",
      team: "LIV",
      position: "MID",
      buyValue: 14.5,
      sellValue: 14.5,
      eliteOwnership: 61.2,
      expectedMinutes: [88, 88, 80],
      projectedPoints: [6.4, 5.9, 5.1],
    },
  ],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fplreview-"));
  resetFplReviewSnapshotForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL === undefined) delete process.env.FPLREVIEW_SNAPSHOT_PATH;
  else process.env.FPLREVIEW_SNAPSHOT_PATH = ORIGINAL;
  resetFplReviewSnapshotForTests();
  vi.restoreAllMocks();
});

describe("an absent export is not an error", () => {
  it("returns null rather than throwing", () => {
    pointAt("does-not-exist.json");
    expect(() => getFplReviewSnapshot()).not.toThrow();
    expect(getFplReviewSnapshot()).toBeNull();
  });

  it("returns null for every player lookup", () => {
    pointAt("does-not-exist.json");
    expect(getFplReviewProjection(427)).toBeNull();
  });

  it("says nothing on the console — absence is the normal case", () => {
    // A warning per request in production would be noise about a file that is
    // never supposed to be there.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pointAt("does-not-exist.json");
    getFplReviewSnapshot();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not re-read the missing file on every lookup", () => {
    pointAt("does-not-exist.json");
    getFplReviewSnapshot();
    // 600-odd elements × one failed syscall each would be the cost of caching
    // only successes. `null` is a resolved answer and is kept.
    for (let i = 0; i < 50; i += 1) getFplReviewProjection(i);
    expect(getFplReviewSnapshot()).toBeNull();
  });
});

describe("a present export is read", () => {
  it("loads the snapshot", () => {
    write("ok.json", VALID);
    pointAt("ok.json");
    expect(getFplReviewSnapshot()?.exportedAt).toBe("2026-08-04T09:00:00Z");
  });

  it("indexes players by element id", () => {
    write("ok.json", VALID);
    pointAt("ok.json");
    expect(getFplReviewProjection(427)?.name).toBe("Salah");
  });

  it("returns null for a player not in the export", () => {
    write("ok.json", VALID);
    pointAt("ok.json");
    expect(getFplReviewProjection(1)).toBeNull();
  });
});

describe("present but unusable is distinguished from absent", () => {
  it("a corrupt file warns, because somebody put it there and it did not work", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("bad.json", "{ not json");
    pointAt("bad.json");
    expect(getFplReviewSnapshot()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("a wrong-shaped file is rejected rather than cast", () => {
    // Runtime narrowing, not `as FplReviewSnapshot`. A cast here would surface
    // as `undefined.slice` deep inside the live-state builder.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("shape.json", JSON.stringify({ exportedAt: 42, players: [] }));
    pointAt("shape.json");
    expect(getFplReviewSnapshot()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("rejects a file whose players are not shaped like players", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("players.json", JSON.stringify({
      exportedAt: "2026-08-04T09:00:00Z",
      gameweeks: [1],
      players: [{ name: "no element id" }],
    }));
    pointAt("players.json");
    expect(getFplReviewSnapshot()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("neither corrupt case throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    write("bad.json", "{ not json");
    pointAt("bad.json");
    expect(() => getFplReviewProjection(427)).not.toThrow();
  });
});

describe("forwardProjection", () => {
  // The 2026-09-10 export, GW4-GW9, being read on 2026-09-23 while GW6 is planned.
  const snapshot = { exportedAt: "2026-09-10T21:03:42Z", gameweeks: [4, 5, 6, 7, 8, 9] };
  const review = {
    elementId: 154, name: "Palmer", team: "CHE", position: "MID" as const,
    buyValue: 9.6, sellValue: 9.6, eliteOwnership: 35.8,
    expectedMinutes: [85, 80, 78, 77, 74, 72],
    projectedPoints: [7.53, 4.94, 5.76, 4.83, 5.24, 4.77],
  };

  it("starts at the gameweek being planned, not at the first one exported", () => {
    const forward = forwardProjection(review, snapshot, 6);
    expect(forward?.gameweeks.map((week) => week.gameweek)).toEqual([6, 7, 8, 9]);
    // GW6's own numbers, not GW4's shifted along by two.
    expect(forward?.gameweeks[0]).toEqual({ gameweek: 6, expectedMinutes: 78, projectedPoints: 5.76 });
  });

  it("keeps the whole window when nothing has been played yet", () => {
    expect(forwardProjection(review, snapshot, 4)?.gameweeks).toHaveLength(6);
  });

  it("is absent when every exported week has been played", () => {
    // Null, so the page falls back to the heuristic and says so, rather than
    // labelling an empty projection as FPLReview's.
    expect(forwardProjection(review, snapshot, 10)).toBeNull();
  });

  it("carries the fields the ranking engine reads", () => {
    const forward = forwardProjection(review, snapshot, 6);
    expect(forward).toMatchObject({
      exportedAt: snapshot.exportedAt, eliteOwnership: 35.8, buyValue: 9.6, sellValue: 9.6,
    });
  });
});
