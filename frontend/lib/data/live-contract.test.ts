/**
 * `/api/fpl/state` must not compute what nothing reads.
 *
 * ## Why this exists
 *
 * The route is not a published file, so `paths.test.ts` cannot see it and Rule 3
 * does not apply. It is computed per request, which makes the opposite failure
 * possible: not a fetched path with no writer, but a **written field with no
 * reader**. Nobody notices, because the cost is paid on the server and the
 * symptom is only latency and payload.
 *
 * Measured before this test was written, the route was serialising per request:
 *
 * * `projections.players` — every ranked player duplicated, roughly 600 rows of
 *   fourteen fields, read by nothing. The ranked lists come from `rankings`.
 * * `evidence` — a scan of every flagged element, building a view object per
 *   player, read by nothing. `/evidence` reads `evidence_view.json`, which
 *   carries the claim tree and every losing claim; this duplicate carried
 *   neither.
 * * `recommendations.transfers6`, `multiTransferPlans6`, `captaincyPool` —
 *   three more solver passes over the whole player pool, read by nothing.
 *
 * All of it was live code doing real work on every request for no consumer.
 *
 * ## The rule
 *
 * Every key the contract declares is either narrowed by `narrowHeuristics` — so
 * something renders it — or listed in `INTENTIONALLY_UNREAD` with a reason. The
 * allowlist is the point: adding a key there is a deliberate, reviewable act,
 * where leaving it out of both lists fails.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { narrowHeuristics } from "@/lib/data/heuristics";

const LIB = join(__dirname, "..");

/**
 * Keys the route may emit without a reader, each for a stated reason.
 *
 * "It might be useful later" is not one of them — that is how the three blocks
 * above survived. A key belongs here only if it is genuinely live data whose
 * absence would be a contract break for a consumer outside this app, or scaffolding
 * the response cannot be parsed without.
 */
const INTENTIONALLY_UNREAD: Record<string, string> = {
  schemaVersion: "Version marker. A consumer needs it to detect a breaking change.",
  season: "Identifies which season the state describes; cheap and unambiguous.",
  squad:
    "The entry's actual picks — genuinely live, and the one block that cannot " +
    "be recovered from any published artifact. Unrendered today; deleting it " +
    "would lose data the FPL API only exposes per gameweek.",
  history:
    "Career rank history from the official API. Small, live, and the only " +
    "record of it outside FPL's own site.",
  notices: "Free-text operational notes; rendered when the sync degrades.",
};

/** Top-level keys declared by `FplLiveState`, read from the source. */
function declaredKeys(): string[] {
  const source = readFileSync(join(LIB, "fpl-live.ts"), "utf8");
  const start = source.indexOf("export interface FplLiveState");
  expect(start, "FplLiveState should be declared in lib/fpl-live.ts")
    .toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}", start));
  const keys: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    // Top-level members only: exactly two spaces of indent.
    const match = /^ {2}([a-zA-Z][a-zA-Z0-9]*)[?]?:/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Keys `narrowHeuristics` actually reaches into, probed rather than parsed. */
function narrowedKeys(): Set<string> {
  const touched = new Set<string>();
  // A Proxy records every property the narrower reads, which is exact where a
  // regex over the source would only be suggestive.
  const probe = new Proxy(
    {
      generatedAt: "2026-08-07T06:00:00Z",
      recommendations: {
        transfers4: [], captaincyPlan: [], multiTransferPlans4: [],
        modelVersion: "x",
      },
      rankings: {
        overall: [], captaincy: [], value: [], differentials: [],
        goalkeepers: [], defenders: [], midfielders: [], forwards: [],
      },
      projections: { source: "fallback", sourceLabel: "y" },
      entry: { id: 1, teamName: "t" },
      event: { id: 7, deadlineTime: "z" },
      freshness: { squad: "live" },
    } as Record<string, unknown>,
    {
      get(target, property) {
        if (typeof property === "string") touched.add(property);
        return Reflect.get(target, property);
      },
      has(target, property) {
        if (typeof property === "string") touched.add(property);
        return Reflect.has(target, property);
      },
    },
  );
  const result = narrowHeuristics(probe);
  expect(result.ok, "the probe payload should narrow cleanly").toBe(true);
  return touched;
}

describe("the live-state contract has no unread fields", () => {
  it("finds the declared keys", () => {
    // Guards the guard: an empty list would make the check below vacuous, which
    // is the failure mode that let three dead blocks survive.
    expect(declaredKeys().length).toBeGreaterThan(6);
  });

  it("every declared key is either read or explicitly allowed", () => {
    const read = narrowedKeys();
    const orphans = declaredKeys().filter(
      (key) => !read.has(key) && !(key in INTENTIONALLY_UNREAD),
    );
    expect(
      orphans,
      "These are computed and serialised on every request and nothing reads " +
        "them. Either render them or delete them; if neither, add them to " +
        "INTENTIONALLY_UNREAD with a reason.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowed key that no longer exists is a comment pretending to be a
    // decision.
    const declared = new Set(declaredKeys());
    const stale = Object.keys(INTENTIONALLY_UNREAD).filter((k) => !declared.has(k));
    expect(stale).toEqual([]);
  });

  it("every allowance carries a reason", () => {
    for (const [key, reason] of Object.entries(INTENTIONALLY_UNREAD)) {
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

describe("the blocks removed in the narrowing stay removed", () => {
  const source = readFileSync(join(LIB, "fpl-live.ts"), "utf8");
  const server = readFileSync(join(LIB, "fpl-live-server.ts"), "utf8");

  it.each([
    ["transfers6", "a second solver pass over the whole pool, unread"],
    ["multiTransferPlans6", "a third solver pass, unread"],
    ["captaincyPool", "the full squad re-sorted, unread"],
    ["FplEvidenceItem", "duplicated evidence_view.json without the claim tree"],
    ["FplProjectionPlayer", "600 rows duplicating `rankings`"],
  ])("%s is gone (%s)", (symbol) => {
    expect(source).not.toContain(symbol);
    expect(server).not.toContain(symbol);
  });

  it("the projections block keeps its provenance", () => {
    // Trimming `players` must not take `source` with it: that field is how the
    // page says no FPLReview export is behind the numbers.
    expect(source).toContain("sourceLabel");
    expect(server).toContain('"fallback"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Charts
//
// The plan's mechanism is that every Recharts mount sits behind `chartable`,
// which refuses `empty` — so "312 lines of chart scaffolding over metrics that
// were never emitted", which `/health` actually shipped, becomes unwritable
// rather than merely discouraged.
//
// It was not enforced. `chartable` was exported, unit-tested, imported by a
// component that never called it, and used by **no page**: `/health` guarded
// its two charts with `.length > 0`, which passes for an artifact whose state
// is `empty` or `unreadable` whenever the array happens to be populated.
// ─────────────────────────────────────────────────────────────────────────────

describe("every charting mount goes through chartable", () => {
  const APP = join(__dirname, "..", "..", "app");
  const COMPONENTS = join(__dirname, "..", "..", "components");

  /** Files that mount Recharts, found rather than listed. */
  function chartingSources(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          if (readFileSync(abs, "utf8").includes("recharts")) found.push(abs);
        }
      }
    };
    walk(APP);
    walk(COMPONENTS);
    return found;
  }

  const mounts = chartingSources();

  it("has no Recharts mount left anywhere in the tree", () => {
    /**
     * Every screen that mounted Recharts — `/health`, `/accuracy`, `/markets`,
     * `/bankroll`, `/h2h` — and the chart components only they reached went with
     * the route cut, so the count is zero. `chartable` itself is untouched.
     *
     * Asserted rather than deleted, because the per-file rule below now has nothing
     * to iterate and a rule that iterates nothing is exactly how this went
     * unenforced the first time. When a chart returns this fails, and whoever adds
     * it has to come here and see the rule it must obey.
     */
    expect(mounts.map((m) => m.split("/frontend/")[1] ?? m)).toEqual([]);
  });

  for (const path of mounts) {
    it(`${path.split("/frontend/")[1] ?? path} calls chartable`, () => {
      const source = readFileSync(path, "utf8");
      expect(
        source.includes("chartable("),
        "This file mounts Recharts. Series must come from `chartable`, which " +
          "refuses an `empty` artifact — a `.length > 0` check does not.",
      ).toBe(true);
    });
  }
});
