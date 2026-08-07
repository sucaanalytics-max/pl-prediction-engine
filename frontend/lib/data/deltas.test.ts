/**
 * The delta feed narrower.
 *
 * The first JSONL artifact in the app, and the format is a trap: `res.json()`
 * throws on the second line of a newline-delimited body, so the loader has to read
 * it as text. `format: "jsonl"` on the descriptor is what says so, and the
 * narrower asserts it received text rather than a parsed object.
 *
 * The feed carries two record kinds because the delta is computed in two stages —
 * the 15-minute poller can resolve claims (pure stdlib) but cannot solve the MILP
 * (numpy + scipy), so the decision half arrives later as its own append-only
 * record. A change awaiting its impact is a real state the UI must render, not a
 * loading state to hide.
 */
import { describe, expect, it } from "vitest";
import { classify, chartable, proven } from "@/lib/data/artifact";
import { REGISTRY, narrowDeltas, type DeltaFeed } from "@/lib/data/narrow";

const NOW = new Date("2026-08-06T12:00:00Z");

const CHANGE = {
  schema_version: 1,
  kind: "resolution_change",
  delta_id: "abc123",
  observed_at: "2026-08-06T11:45:00Z",
  gameweek: 1,
  element_id: 521,
  player_name: "Kulusevski",
  club: "Spurs",
  claim_type: "chance_of_playing",
  before: 75,
  after: 25,
  why_material: "75% -> 25%",
  rule_applied: "asymmetric_override",
  trigger: {
    source: "manual:De Zerbi presser",
    source_tier: 2,
    claimed_at: "2026-08-06T11:00:00Z",
    quote: "He is a couple of weeks away",
    url: "https://hayters.com/x",
  },
};

const IMPACT = {
  schema_version: 1,
  kind: "decision_impact",
  delta_id: "abc123",
  observed_at: "2026-08-06T12:00:00Z",
  gameweek: 1,
  entry_label: "season",
  xp_moved: [{ element_id: 521, before: 5.4, after: 1.2 }],
  root_move: { before: "hold", after: "[521] -> [9]", flipped: true },
  captain: { before: 100, after: 200 },
  ev_cost_of_inaction: 1.8,
  note: "",
};

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function ok(raw: unknown): DeltaFeed {
  const result = narrowDeltas(raw);
  expect(result.ok, result.ok ? "" : `narrow failed: ${result.problems}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

describe("format", () => {
  it("refuses a parsed object — JSONL must arrive as text", () => {
    // The bug this prevents: a loader that called res.json() would either throw on
    // the second line or, with a single-line file, silently hand over an object.
    const result = narrowDeltas(CHANGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join()).toMatch(/expected text/);
  });

  it("the descriptor declares the format so the loader knows", () => {
    expect(REGISTRY.deltas.format).toBe("jsonl");
    expect(REGISTRY.deltas.path.endsWith(".jsonl")).toBe(true);
  });

  it("reads an empty body as an empty feed, not an error", () => {
    expect(ok("").records).toEqual([]);
  });

  it("tolerates a missing trailing newline", () => {
    const feed = ok(JSON.stringify(CHANGE));
    expect(feed.records).toHaveLength(1);
  });

  it("ignores blank lines", () => {
    expect(ok(`\n${JSON.stringify(CHANGE)}\n\n`).records).toHaveLength(1);
  });
});

describe("resolution_change records", () => {
  const feed = ok(jsonl(CHANGE));

  it("carries the change and why it was material", () => {
    const record = feed.records[0];
    expect(record.player_name).toBe("Kulusevski");
    expect(record.before).toBe(75);
    expect(record.after).toBe(25);
    expect(record.why_material).toBe("75% -> 25%");
  });

  it("names the rule that produced it", () => {
    // R4, the asymmetric override: a tier-2 source may push availability DOWN but
    // never up. Showing the rule is what makes the change auditable rather than
    // asking the reader to trust a number.
    expect(feed.records[0].rule_applied).toBe("asymmetric_override");
  });

  it("carries the trigger as checkable evidence", () => {
    const trigger = feed.records[0].trigger;
    expect(trigger?.source_tier).toBe(2);
    expect(trigger?.quote).toBe("He is a couple of weeks away");
    expect(trigger?.url).toBe("https://hayters.com/x");
    // claimed_at, not observed_at: when the SOURCE said it.
    expect(trigger?.claimed_at).toBe("2026-08-06T11:00:00Z");
  });

  it("survives a record with no trigger", () => {
    const feed = ok(jsonl({ ...CHANGE, trigger: null }));
    expect(feed.records[0].trigger).toBeNull();
  });
});

describe("decision_impact records", () => {
  const feed = ok(jsonl(CHANGE, IMPACT));

  it("both kinds coexist in one feed", () => {
    expect(feed.records.map((r) => r.kind)).toEqual([
      "resolution_change", "decision_impact",
    ]);
  });

  it("shares a delta_id with the change it enriches", () => {
    expect(new Set(feed.records.map((r) => r.delta_id))).toEqual(
      new Set(["abc123"]),
    );
  });

  it("reports the flip and the cost of inaction", () => {
    const impact = feed.records[1];
    expect(impact.root_move_before).toBe("hold");
    expect(impact.root_move_after).toBe("[521] -> [9]");
    expect(impact.flipped).toBe(true);
    expect(impact.ev_cost_of_inaction).toBe(1.8);
  });

  it("keeps xp_moved nullable rather than defaulting to zero", () => {
    const partial = ok(jsonl({
      ...IMPACT,
      xp_moved: [{ element_id: 521, before: 5.4, after: null }],
    }));
    const row = partial.records[0].xp_moved[0];
    expect(row.before).toBe(5.4);
    expect(row.after).toBeNull();
    // 0.0 would read as a total collapse rather than as "unknown".
    expect(row.after).not.toBe(0);
  });

  it("drops an xp row with no element id rather than inventing one", () => {
    const feed = ok(jsonl({ ...IMPACT, xp_moved: [{ before: 1, after: 2 }] }));
    expect(feed.records[0].xp_moved).toEqual([]);
  });
});

describe("awaitingImpact", () => {
  it("lists changes the agent has not yet assessed", () => {
    const feed = ok(jsonl(CHANGE));
    expect(feed.awaitingImpact).toEqual(["abc123"]);
  });

  it("clears once the impact record arrives", () => {
    const feed = ok(jsonl(CHANGE, IMPACT));
    expect(feed.awaitingImpact).toEqual([]);
  });

  it("does not count an impact for a different change", () => {
    const feed = ok(jsonl(CHANGE, { ...IMPACT, delta_id: "other" }));
    expect(feed.awaitingImpact).toEqual(["abc123"]);
  });
});

describe("malformed lines", () => {
  it("skips a corrupt line and keeps the rest", () => {
    const raw = `{"broken\n${JSON.stringify(CHANGE)}\n`;
    const result = narrowDeltas(raw);
    // Reported, not fatal: a shortened delta log costs a duplicate notification,
    // whereas a shortened claim history silently changes a projection — which is
    // why the Python evidence store raises and this does not.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.records).toHaveLength(1);
  });

  it("skips a record with an unknown kind", () => {
    const feed = ok(jsonl({ ...CHANGE, kind: "something_else" }));
    expect(feed.records).toEqual([]);
  });

  it("skips a record with no delta_id, which could never be joined", () => {
    const feed = ok(jsonl({ ...CHANGE, delta_id: null }));
    expect(feed.records).toEqual([]);
  });

  it("skips a bare array line", () => {
    const feed = ok(jsonl([1, 2, 3]));
    expect(feed.records).toEqual([]);
  });
});

describe("as an artifact", () => {
  function load(raw: unknown) {
    return classify<DeltaFeed>({
      path: REGISTRY.deltas.path,
      source: "local",
      raw,
      narrow: REGISTRY.deltas.narrow,
      isEmpty: REGISTRY.deltas.isEmpty,
      freshnessBudgetMs: REGISTRY.deltas.freshnessBudgetMs,
      now: NOW,
    });
  }

  it("an empty feed is `empty`, which is the normal state", () => {
    // Most of the season nothing has changed since you last looked. That must not
    // render as a broken page.
    expect(load("").state).toBe("empty");
  });

  it("a feed with records is ok", () => {
    expect(load(jsonl(CHANGE)).state).toBe("ok");
  });

  it("a missing file is absent, distinct from empty", () => {
    // Absent = the poller has never run. Empty = it ran and nothing happened.
    expect(load(undefined).state).toBe("absent");
  });

  it("refuses to chart an empty feed", () => {
    expect(chartable(load(""), (v) => v.records)).toBeNull();
  });

  it("charts a populated one", () => {
    expect(chartable(load(jsonl(CHANGE, IMPACT)), (v) => v.records)).toHaveLength(2);
  });

  it("exposes the records through proven, never a raw property", () => {
    const artifact = load(jsonl(CHANGE));
    expect(proven(artifact)?.records).toHaveLength(1);
    expect("value" in (artifact as unknown as Record<string, unknown>)).toBe(false);
  });
});
