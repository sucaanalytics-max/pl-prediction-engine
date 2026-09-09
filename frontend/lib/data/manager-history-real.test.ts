/**
 * The real committed ledger, read through the real narrower and the real
 * arithmetic.
 *
 * ## Why this file exists separately
 *
 * `manager-history.test.ts` uses hand-built maps, which prove the window logic
 * is internally consistent and prove nothing about whether it describes the
 * artifact the producer actually writes. Nothing else closes that loop either:
 * `ManagerHistory.test.tsx` mocks `useArtifact` away, and
 * `real-artifacts.test.ts` reads repo-root `predictions/`, where this file does
 * not live — the producer writes to `frontend/public/predictions/`, which is
 * what the app serves. So that suite passes this descriptor by finding it
 * ABSENT, not by narrowing it.
 *
 * ## Why there is not a single literal in here
 *
 * `real-artifacts.test.ts` says it plainly: counts taken from the artifact on
 * the day the test was written rot, and "a test that breaks whenever real data
 * arrives teaches people to ignore the suite". Last night five tests broke
 * exactly that way when GW3 settled. Bench waste is 27 today and will not be
 * next week, so nothing below pins it. What is asserted is what must remain
 * true in May: the identity, the settled/absent boundary, and the withholding
 * rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_CLEAN_WINDOWS, SPANS, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";
import { narrowManagerHistory } from "@/lib/data/narrow-manager-history";

const FILE = join(
  __dirname, "..", "..", "public", "predictions", "fpl", "manager_history.json",
);

const present = existsSync(FILE);
const result = present
  ? narrowManagerHistory(JSON.parse(readFileSync(FILE, "utf8")))
  : null;

describe("the committed manager history", () => {
  it("is published where the app actually serves it from", () => {
    expect(present, `${FILE} is missing`).toBe(true);
  });

  it("narrows without problems", () => {
    expect(result?.ok, result && !result.ok ? result.problems.join("; ") : "")
      .toBe(true);
  });
});

describe.runIf(result?.ok)("what must stay true in May", () => {
  const history = result!.ok ? result!.value : null!;

  it("carries the producer's identity through to the reader", () => {
    // The producer asserts sum(mult x pts) - cost == credited before writing.
    // This is the same claim checked on the other side of the JSON boundary,
    // so a narrower that silently dropped or renamed a field shows up here.
    for (const week of history.gameweeks) {
      expect(
        week.grossPoints - week.transferCost,
        `GW${week.event} does not reconcile after narrowing`,
      ).toBe(week.points);
    }
  });

  it("settles a contiguous run of gameweeks ending at settled_through", () => {
    const events = history.gameweeks.map((g) => g.event);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    if (events.length > 0) {
      expect(history.settledThrough).toBe(Math.max(...events));
    } else {
      expect(history.settledThrough).toBeNull();
    }
  });

  it("never records a transfer's window beyond what has settled", () => {
    for (const move of history.transfers) {
      for (const gameweek of move.inPointsByGw.keys()) {
        expect(gameweek).toBeLessThanOrEqual(history.settledThrough ?? 0);
        expect(gameweek).toBeGreaterThanOrEqual(move.event);
      }
    }
  });

  it("gives every settled gameweek a multiplier entry, even a null one", () => {
    // The two maps must agree on which gameweeks exist. A gameweek present in
    // one and absent from the other is how "not yet played" and "no longer
    // yours" start reading alike.
    for (const move of history.transfers) {
      expect([...move.inMultiplierByGw.keys()].sort())
        .toEqual([...move.inPointsByGw.keys()].sort());
      expect([...move.outPointsByGw.keys()].sort())
        .toEqual([...move.inPointsByGw.keys()].sort());
    }
  });

  it("marks a window settled exactly when every gameweek in it has settled", () => {
    for (const move of history.transfers) {
      for (const span of SPANS) {
        const window = windowFor(move, span);
        const reaches = move.event + span - 1;
        expect(
          window.settled,
          `GW${move.event} span ${span} reaches GW${reaches}, settled through ${history.settledThrough}`,
        ).toBe(reaches <= (history.settledThrough ?? 0));
        // Never a number for a window that has not settled: a 0 there would
        // read as "this transfer achieved nothing".
        if (!window.settled) {
          expect(window.effective).toBeNull();
          expect(window.raw).toBeNull();
        }
      }
    }
  });

  it("withholds a season rate exactly when the clean windows are too few", () => {
    for (const span of SPANS) {
      const aggregate = transferAggregate(history, span);
      const withheld = aggregate.withheldReason !== null;
      expect(withheld).toBe(aggregate.n < MINIMUM_CLEAN_WINDOWS);
      expect(aggregate.effective === null).toBe(withheld);
    }
  });

  it("totals only what the gameweeks actually carry", () => {
    const totals = seasonTotals(history);
    expect(totals.benchPoints).toBe(
      history.gameweeks.reduce((sum, g) => sum + g.benchPoints, 0),
    );
    expect(totals.hitSpend).toBe(
      history.gameweeks.reduce((sum, g) => sum + g.transferCost, 0),
    );
    // Hindsight cannot be worse than what you did: the best of the fifteen is
    // by construction at least the man you actually captained.
    expect(totals.captaincyCost).toBeGreaterThanOrEqual(0);
  });
});
