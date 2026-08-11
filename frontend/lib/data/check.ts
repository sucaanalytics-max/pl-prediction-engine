/**
 * Narrowing primitives: collect-then-report, never throw.
 *
 * Mirrors `pipeline/fpl/artifacts.py::validate_xp_artifact` on the Python side —
 * the same collect-every-problem discipline, so a drift report reads the same from
 * either end of the contract.
 *
 * ## The rule these encode
 *
 * **Strict about what pages branch on, permissive about the rest.**
 *
 * A narrower that rejects a whole artifact because one cosmetic field changed
 * type is worse than the drift it caught: the drift loses a column, the rejection
 * loses the page. So required fields are the ones a page's control flow depends
 * on, and everything else is tolerated with a default and no complaint.
 *
 * The counter-discipline is that a *load-bearing* field must be required even
 * when tolerating it would be easy. `deadline` was absent from every published
 * decision, and because the consumer read `String(source.deadline ?? "")` the
 * whole freshness state machine silently collapsed to "ready" — a tolerant read
 * of the one field that decides whether advice is safe to act on.
 */

/** Accumulates problems so all of them are reported, not just the first. */
export class Problems {
  private readonly found: string[] = [];

  add(message: string): void {
    this.found.push(message);
  }

  get any(): boolean {
    return this.found.length > 0;
  }

  get all(): readonly string[] {
    return this.found;
  }

  /** Scope subsequent messages, e.g. `predictions[3]`. */
  at(prefix: string): Problems {
    const child = new Problems();
    const parent = this;
    // Delegating rather than nesting keeps one flat list in source order, which
    // is what a reader debugging a drift actually wants.
    child.add = (message: string) => parent.add(`${prefix}.${message}`);
    return child;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required object. Returns null and records a problem if it is not one. */
export function reqRecord(
  raw: unknown, field: string, problems: Problems,
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    problems.add(`${field} is ${describe(raw)}, expected an object`);
    return null;
  }
  return raw;
}

/** A required array. Returns null and records a problem if it is not one. */
export function reqArray(
  raw: unknown, field: string, problems: Problems,
): unknown[] | null {
  if (!Array.isArray(raw)) {
    problems.add(`${field} is ${describe(raw)}, expected an array`);
    return null;
  }
  return raw;
}

export function reqString(
  raw: unknown, field: string, problems: Problems,
): string | null {
  if (typeof raw !== "string") {
    problems.add(`${field} is ${describe(raw)}, expected a string`);
    return null;
  }
  return raw;
}

/**
 * A required finite number.
 *
 * NaN and Infinity are rejected as hard as a string would be. `Date.parse("")`
 * returning NaN and flowing onward as though it were a time is the exact shape of
 * the `/decisions` bug, and a NaN that reaches a chart axis renders as nothing at
 * all with no error.
 */
export function reqNumber(
  raw: unknown, field: string, problems: Problems,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.add(`${field} is ${describe(raw)}, expected a finite number`);
    return null;
  }
  return raw;
}

// ── Optional readers. These never record a problem; that is the point. ────────

export function optString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/** Optional finite number. A non-finite value degrades to null, not to NaN. */
export function optNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function optBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * Optional number with a floor of zero.
 *
 * For counters the writer may emit as null, where a page will do arithmetic. The
 * `player_stats` audit found `fouls_committed`, `fouls_per_90` and `fpl_ownership`
 * arriving as null on some rows while typed `number`, and a null flowing into a
 * sum makes the whole total null rather than skipping the row.
 */
export function countOr0(raw: unknown): number {
  return optNumber(raw) ?? 0;
}

/** Optional array. Missing or malformed becomes empty, never null. */
export function optArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/**
 * Map an array, dropping elements that fail to narrow, and say how many.
 *
 * Parse-don't-drop-silently: one bad row must not take the other nineteen with
 * it, but a page that quietly renders 19 of 20 rows is lying about its coverage.
 * `lib/fpl-messages.ts` already established this discipline for the message feed;
 * this generalises it.
 */
export function mapKept<T>(
  items: readonly unknown[],
  field: string,
  problems: Problems,
  one: (raw: unknown, index: number) => T | null,
): T[] {
  const kept: T[] = [];
  let dropped = 0;
  items.forEach((raw, index) => {
    const value = one(raw, index);
    if (value === null) dropped += 1;
    else kept.push(value);
  });
  if (dropped > 0) {
    problems.add(
      `${field} dropped ${dropped} of ${items.length} malformed element(s)`,
    );
  }
  return kept;
}

/** A short, safe description of an unexpected value, for a problem message. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? `the number ${value}` : `the number ${value}`;
  }
  if (typeof value === "string") {
    const clipped = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `the string "${clipped}"`;
  }
  return `a ${typeof value}`;
}
