import { describe, expect, it } from "vitest";
import {
  chartable, classify, describeAge, describeProducer, isProven, isStale,
  malformed, narrowed, present, proven,
  type Artifact, type NarrowResult,
} from "@/lib/data/artifact";

const NOW = new Date("2026-08-06T12:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface Row { played: number }
interface Payload {
  rows: Row[];
  produced_at?: string | null;
  version?: string | null;
}

function narrowPayload(raw: unknown): NarrowResult<Payload> {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return malformed(["not an object"]);
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.rows)) problems.push("rows is not an array");
  if (problems.length) return malformed(problems);
  return narrowed({
    rows: source.rows as Row[],
    produced_at: (source.produced_at as string | undefined) ?? null,
    version: (source.version as string | undefined) ?? null,
  });
}

function build(over: Partial<Parameters<typeof classify<Payload>>[0]> = {}) {
  return classify<Payload>({
    path: "table.json",
    source: "local",
    raw: { rows: [{ played: 3 }], produced_at: NOW.toISOString(), version: "4.1.0" },
    narrow: narrowPayload,
    producedAtOf: (v) => v.produced_at,
    producerVersionOf: (v) => v.version,
    isEmpty: (v) => v.rows.length > 0 && v.rows.every((r) => r.played === 0),
    freshnessBudgetMs: DAY,
    now: NOW,
    ...over,
  });
}

describe("classify — the five states", () => {
  it("is ok for fresh, well-formed, informative data", () => {
    const a = build();
    expect(a.state).toBe("ok");
    expect(a.reason).toBeNull();
  });

  it("is absent when nothing was published", () => {
    const a = build({ raw: undefined });
    expect(a.state).toBe("absent");
    expect(proven(a)).toBeNull();
    expect(a.reason).toMatch(/Nothing has been published/);
  });

  it("treats null the same as undefined — a 404 body is not data", () => {
    expect(build({ raw: null }).state).toBe("absent");
  });

  it("reports the fetch error when absence had a cause", () => {
    const a = build({ raw: null, fetchError: "network timeout" });
    expect(a.state).toBe("absent");
    expect(a.reason).toContain("network timeout");
  });

  it("marks source 'none' when absent, so a provenance strip cannot claim a source", () => {
    expect(build({ raw: undefined }).provenance.source).toBe("none");
  });

  it("is unreadable when narrowing fails", () => {
    const a = build({ raw: { rows: "not an array" } });
    expect(a.state).toBe("unreadable");
    expect(proven(a)).toBeNull();
  });

  it("names every narrowing problem, not just the first", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: { rows: 1 }, now: NOW,
      narrow: () => malformed(["rows is not an array", "gameweek missing", "season missing"]),
    });
    expect(a.reason).toContain("rows is not an array");
    expect(a.reason).toContain("gameweek missing");
    expect(a.reason).toContain("season missing");
  });

  it("is empty when the declared predicate fires", () => {
    const rows = Array.from({ length: 20 }, () => ({ played: 0 }));
    const a = build({ raw: { rows, produced_at: NOW.toISOString() } });
    expect(a.state).toBe("empty");
    // The value survives: 20 rows are still worth rendering as "not started".
    expect(proven(a)?.rows).toHaveLength(20);
  });

  it("is stale past its budget", () => {
    const old = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const a = build({ raw: { rows: [{ played: 5 }], produced_at: old } });
    expect(a.state).toBe("stale");
    expect(a.reason).toMatch(/3 days/);
    expect(proven(a)).not.toBeNull();
  });
});

describe("classify — precedence", () => {
  /**
   * absent > unreadable: an absent artifact cannot be asked whether it parses.
   */
  it("prefers absent over unreadable", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: undefined, now: NOW,
      narrow: () => malformed(["would have failed"]),
    });
    expect(a.state).toBe("absent");
  });

  /**
   * unreadable > empty: a value that failed narrowing must not be described by a
   * predicate that ran on it anyway.
   */
  it("prefers unreadable over empty", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: { rows: "bad" }, now: NOW,
      narrow: narrowPayload,
      isEmpty: () => true,
    });
    expect(a.state).toBe("unreadable");
  });

  /**
   * empty > stale, and the reasoning is in the module docs: a three-day-old
   * pre-season table is more usefully "no matches played" than "three days old",
   * because a fresher copy would say exactly the same thing.
   */
  it("prefers empty over stale", () => {
    const rows = Array.from({ length: 20 }, () => ({ played: 0 }));
    const old = new Date(NOW.getTime() - 5 * DAY).toISOString();
    const a = build({ raw: { rows, produced_at: old } });
    expect(a.state).toBe("empty");
  });

  /** ...but staleness is not discarded, only demoted. */
  it("still reports an empty artifact as stale via isStale", () => {
    const rows = Array.from({ length: 20 }, () => ({ played: 0 }));
    const old = new Date(NOW.getTime() - 5 * DAY).toISOString();
    const a = build({ raw: { rows, produced_at: old } });
    expect(a.state).toBe("empty");
    expect(isStale(a)).toBe(true);
    expect(a.provenance.ageMs).toBe(5 * DAY);
  });
});

describe("classify — emptiness is declared, never guessed", () => {
  it("cannot be empty when no predicate is supplied", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: { rows: [] }, now: NOW,
      narrow: narrowPayload,
    });
    // An empty array is NOT automatically "empty": for some artifacts zero rows
    // is the correct, informative answer (no value bets cleared this week).
    expect(a.state).toBe("ok");
  });

  it("respects a predicate that calls zero rows informative", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: { rows: [] }, now: NOW,
      narrow: narrowPayload,
      isEmpty: () => false,
    });
    expect(a.state).toBe("ok");
  });
});

describe("classify — staleness needs proof", () => {
  it("is not stale when the artifact carries no producedAt", () => {
    const a = build({ raw: { rows: [{ played: 1 }] } });
    expect(a.state).toBe("ok");
    expect(a.provenance.ageMs).toBeNull();
    expect(isStale(a)).toBe(false);
  });

  it("is not stale when the artifact has no budget", () => {
    const old = new Date(NOW.getTime() - 400 * DAY).toISOString();
    const a = build({ raw: { rows: [{ played: 1 }], produced_at: old }, freshnessBudgetMs: null });
    expect(a.state).toBe("ok");
    expect(isStale(a)).toBe(false);
  });

  it("does not treat an unparseable producedAt as age zero", () => {
    // Date.parse("") is NaN. The /decisions bug was exactly this: NaN silently
    // became "fine" rather than "unknown".
    const a = build({ raw: { rows: [{ played: 1 }], produced_at: "not-a-date" } });
    expect(a.provenance.ageMs).toBeNull();
    expect(a.state).toBe("ok");
  });

  it("is exactly on the budget without being stale", () => {
    const edge = new Date(NOW.getTime() - DAY).toISOString();
    const a = build({ raw: { rows: [{ played: 1 }], produced_at: edge } });
    expect(a.state).toBe("ok");
  });

  it("is stale one millisecond past the budget", () => {
    const edge = new Date(NOW.getTime() - DAY - 1).toISOString();
    expect(build({ raw: { rows: [{ played: 1 }], produced_at: edge } }).state).toBe("stale");
  });
});

describe("proven", () => {
  it("returns the value for ok, empty and stale", () => {
    expect(proven(build())).not.toBeNull();

    const rows = Array.from({ length: 3 }, () => ({ played: 0 }));
    expect(proven(build({ raw: { rows } }))).not.toBeNull();

    const old = new Date(NOW.getTime() - 3 * DAY).toISOString();
    expect(proven(build({ raw: { rows: [{ played: 2 }], produced_at: old } }))).not.toBeNull();
  });

  it("returns null for absent and unreadable", () => {
    expect(proven(build({ raw: undefined }))).toBeNull();
    expect(proven(build({ raw: { rows: 3 } }))).toBeNull();
  });

  it("is the only way in — .value is not a property of the type", () => {
    const a: Artifact<Payload> = build();
    expect("value" in (a as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("isProven", () => {
  it("is true for the three value-bearing states", () => {
    expect(isProven(build())).toBe(true);
  });
  it("is false for absent", () => {
    expect(isProven(build({ raw: undefined }))).toBe(false);
  });
  it("is false for unreadable", () => {
    expect(isProven(build({ raw: { rows: 0 } }))).toBe(false);
  });
});

describe("chartable", () => {
  it("returns the series for ok", () => {
    expect(chartable(build(), (v) => v.rows)).toHaveLength(1);
  });

  it("returns the series for stale — a stale chart with a provenance strip is honest", () => {
    const old = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const a = build({ raw: { rows: [{ played: 9 }], produced_at: old } });
    expect(chartable(a, (v) => v.rows)).toHaveLength(1);
  });

  /**
   * The defining behaviour. `/health` shipped chart scaffolding over metrics that
   * were never emitted; an axis with no series reads as a broken page, not as
   * "nothing measured yet".
   */
  it("refuses empty, even though proven() would hand the value over", () => {
    const rows = Array.from({ length: 20 }, () => ({ played: 0 }));
    const a = build({ raw: { rows } });
    expect(a.state).toBe("empty");
    expect(proven(a)).not.toBeNull();
    expect(chartable(a, (v) => v.rows)).toBeNull();
  });

  it("refuses absent and unreadable", () => {
    expect(chartable(build({ raw: undefined }), (v) => v.rows)).toBeNull();
    expect(chartable(build({ raw: { rows: 1 } }), (v) => v.rows)).toBeNull();
  });

  it("refuses a zero-length series even when the artifact is ok", () => {
    const a = classify<Payload>({
      path: "x.json", source: "local", raw: { rows: [] }, now: NOW,
      narrow: narrowPayload,
    });
    expect(a.state).toBe("ok");
    expect(chartable(a, (v) => v.rows)).toBeNull();
  });

  it("refuses a selector that resolves to null or undefined", () => {
    // health.calibration?.bins is the real case.
    expect(chartable(build(), () => null)).toBeNull();
    expect(chartable(build(), () => undefined)).toBeNull();
  });
});

describe("provenance", () => {
  it("records the path and the winning source", () => {
    const a = build({ source: "supabase" });
    expect(a.provenance.path).toBe("table.json");
    expect(a.provenance.source).toBe("supabase");
  });

  it("carries the producer version through", () => {
    expect(build().provenance.producerVersion).toBe("4.1.0");
  });

  it("reads 'version unknown' when the writer emits none", () => {
    const a = build({ raw: { rows: [{ played: 1 }], produced_at: NOW.toISOString() } });
    expect(a.provenance.producerVersion).toBeNull();
    expect(describeProducer(a.provenance)).toBe("version unknown");
  });

  it("never reads 'current' for an unknown version", () => {
    const a = build({ raw: { rows: [{ played: 1 }] } });
    expect(describeProducer(a.provenance)).not.toMatch(/current/i);
  });

  it("surfaces the 4.0.0-versus-4.1.0 drift as a visible version", () => {
    // The real health.json case: complete, fresh, and missing every metric.
    const a = build({
      raw: { rows: [{ played: 1 }], produced_at: NOW.toISOString(), version: "4.0.0" },
    });
    expect(a.state).toBe("ok");
    expect(describeProducer(a.provenance)).toBe("4.0.0");
  });

  it("always records fetchedAt, even for absent", () => {
    expect(build({ raw: undefined }).provenance.fetchedAt).toBe(NOW.toISOString());
  });

  it("echoes the budget it was judged against", () => {
    expect(build().provenance.freshnessBudgetMs).toBe(DAY);
  });
});

describe("present — for localStorage and other non-fetched sources", () => {
  it("wraps a value in hand as ok", () => {
    const a = present("bankroll", { rows: [{ played: 1 }] }, NOW);
    expect(a.state).toBe("ok");
    expect(proven(a)).not.toBeNull();
  });

  it("honours an emptiness predicate", () => {
    const a = present("bankroll", { rows: [] as Row[] }, NOW, (v) => v.rows.length === 0);
    expect(a.state).toBe("empty");
    expect(a.reason).toMatch(/Nothing recorded/);
  });

  it("has no producedAt or budget to be judged against", () => {
    const a = present("bankroll", { rows: [] as Row[] }, NOW);
    expect(a.provenance.producedAt).toBeNull();
    expect(a.provenance.freshnessBudgetMs).toBeNull();
    expect(isStale(a)).toBe(false);
  });
});

describe("describeAge", () => {
  it("floors to the largest sensible unit", () => {
    expect(describeAge(30_000)).toBe("under a minute");
    expect(describeAge(60_000)).toBe("1 minute");
    expect(describeAge(5 * 60_000)).toBe("5 minutes");
    expect(describeAge(HOUR)).toBe("1 hour");
    expect(describeAge(5 * HOUR)).toBe("5 hours");
    expect(describeAge(DAY)).toBe("1 day");
    expect(describeAge(3 * DAY)).toBe("3 days");
  });

  it("singularises correctly", () => {
    expect(describeAge(HOUR)).not.toContain("hours");
    expect(describeAge(DAY)).not.toContain("days");
  });

  it("handles a negative age without emitting a minus sign", () => {
    // A producedAt in the future is a clock-skew symptom, not a crash.
    expect(describeAge(-3 * DAY)).toBe("3 days");
  });
});

describe("narrowed / malformed helpers", () => {
  it("narrowed carries the value", () => {
    const r = narrowed({ rows: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rows).toEqual([]);
  });

  it("malformed carries every problem", () => {
    const r = malformed<Payload>(["a", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(["a", "b"]);
  });
});
