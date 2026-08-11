import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FPLReview's exported projections, read at runtime rather than bundled.
 *
 * ## Why this is not a static import
 *
 * It used to be `import snapshotJson from "@/data/fplreview-projections.json"`,
 * and that single line made the whole site unbuildable from a clean checkout.
 * The JSON is a paid competitor's export: 128KB, never committed, and never
 * going to be. A static import turns "the file is missing" into
 *
 *     Module not found: Can't resolve '@/data/fplreview-projections.json'
 *
 * at *compile* time — so CI, Vercel, and every fresh clone fail the build
 * outright rather than simply doing without a comparison feed. It is the
 * difference between an absent input and a broken program, and the whole point
 * of `lib/data/artifact.ts` is that the first must never be rendered as the
 * second.
 *
 * So the file is read from disk on first use, from **outside** the bundle. When
 * it is not there — which is the normal case everywhere except this one
 * machine — `getFplReviewSnapshot()` returns `null` and the projection is
 * simply omitted. Nothing throws, and the build never depends on an export we
 * are not licensed to redistribute.
 *
 * These are a competitor's numbers and are only ever a **comparator** — the
 * same standing `footballbin` has under CLAUDE.md's rule 2. They must not reach
 * a model input, and they must not be presented as ours.
 */

export interface FplReviewProjection {
  elementId: number;
  name: string;
  team: string;
  position: "GKP" | "DEF" | "MID" | "FWD";
  buyValue: number;
  sellValue: number;
  eliteOwnership: number;
  expectedMinutes: number[];
  projectedPoints: number[];
}

export interface FplReviewSnapshot {
  schemaVersion: number;
  source: string;
  sourceFile: string;
  exportedAt: string;
  checksum: string;
  gameweeks: number[];
  rawRecordCount: number;
  recordCount: number;
  excludedSyntheticRows: number;
  players: FplReviewProjection[];
}

/**
 * Where to look. Overridable so the location is not a hardcoded assumption
 * about anyone's working directory.
 */
function snapshotPath(): string {
  return (
    process.env.FPLREVIEW_SNAPSHOT_PATH ??
    join(process.cwd(), "data", "fplreview-projections.json")
  );
}

/**
 * Runtime narrowing, not `as FplReviewSnapshot`.
 *
 * A cast is what let `HealthData` drift silently; the same mistake here would
 * surface as `undefined.slice` deep inside the live-state builder rather than
 * as "the snapshot is unusable". Only the fields actually read are checked —
 * enough to know a well-formed file was loaded, not a schema validator.
 */
function narrowSnapshot(raw: unknown): FplReviewSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.exportedAt !== "string") return null;
  if (!Array.isArray(o.gameweeks) || !o.gameweeks.every((g) => typeof g === "number")) {
    return null;
  }
  if (!Array.isArray(o.players)) return null;
  for (const player of o.players) {
    if (typeof player !== "object" || player === null) return null;
    if (typeof (player as Record<string, unknown>).elementId !== "number") return null;
  }
  return raw as FplReviewSnapshot;
}

/**
 * Resolved once per process. `undefined` means "not yet attempted"; `null`
 * means "attempted and absent", which is a real answer and is not retried —
 * re-reading a missing file on every request would be a syscall per player.
 */
let cached: FplReviewSnapshot | null | undefined;
let index: Map<number, FplReviewProjection> | null = null;

function load(): FplReviewSnapshot | null {
  if (cached !== undefined) return cached;

  let text: string;
  try {
    text = readFileSync(snapshotPath(), "utf8");
  } catch {
    // Absent is the expected state in CI and in production. Not an error.
    cached = null;
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Present but corrupt is different from absent, and worth saying out loud:
    // somebody put a file there and it did not work.
    console.warn("fplreview snapshot is present but unparseable:", error);
    cached = null;
    return cached;
  }

  const snapshot = narrowSnapshot(parsed);
  if (snapshot === null) {
    console.warn("fplreview snapshot did not match the expected shape; ignoring it");
    cached = null;
    return cached;
  }

  cached = snapshot;
  index = new Map(snapshot.players.map((player) => [player.elementId, player]));
  return cached;
}

/** The snapshot, or `null` when no export is available. */
export function getFplReviewSnapshot(): FplReviewSnapshot | null {
  return load();
}

/** One player's projection, or `null` when absent or not in the export. */
export function getFplReviewProjection(
  elementId: number
): FplReviewProjection | null {
  if (load() === null) return null;
  return index?.get(elementId) ?? null;
}

/** Test seam: forget what was loaded so a different fixture can be read. */
export function resetFplReviewSnapshotForTests(): void {
  cached = undefined;
  index = null;
}
