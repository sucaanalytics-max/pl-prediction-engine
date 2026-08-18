/**
 * A provenance notice must be derived, never narrated.
 *
 * The squad panel's notices asserted, unconditionally, that "Player EV and
 * expected minutes use the private FPLReview premium snapshot exported on
 * 4 Aug 2026". That export is gitignored (`.gitignore:68`), so it is absent
 * from every deployment: production claimed a premium source it did not have,
 * for a projection that had silently fallen back to a fixture-difficulty
 * estimate, with a date that was wrong even on the machine that had the file.
 *
 * The file's own comment already recorded this exact failure for the capture
 * date one line above — "a stale provenance note on the exact panel whose job
 * is to say how stale the squad is". The same fault was sitting beneath it.
 *
 * These tests read the source rather than rendering, because the defect is a
 * hardcoded sentence and the thing worth forbidding is the sentence existing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "fpl-live-server.ts"), "utf8");

describe("the FPLReview notice is derived, not narrated", () => {
  it("states no hardcoded export date", () => {
    // Any literal month-year in a notice is a date that cannot track its source.
    const hardcoded = SOURCE.match(
      /"[^"]*exported on \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}[^"]*"/g,
    );
    expect(hardcoded, `hardcoded export date(s): ${hardcoded?.join(" | ")}`).toBeNull();
  });

  it("never claims the premium snapshot unconditionally", () => {
    // The claim must sit inside a branch on the snapshot actually being loaded.
    const claims = SOURCE.match(/"[^"]*FPLReview[^"]*premium[^"]*"/g) ?? [];
    for (const claim of claims) {
      const at = SOURCE.indexOf(claim);
      const preceding = SOURCE.slice(Math.max(0, at - 400), at);
      expect(
        preceding.includes("projectionSnapshot"),
        `unconditional premium claim: ${claim}`,
      ).toBe(true);
    }
  });

  it("carries an explicit line for the absent case", () => {
    // Absence must be stated, not left to a silently-degraded number.
    expect(SOURCE).toMatch(/No FPLReview export is available/);
  });

  it("branches the notice on the snapshot, not only on picks", () => {
    const noticeBlock = SOURCE.slice(
      SOURCE.indexOf("const notices"),
      SOURCE.indexOf("const notices") + 1800,
    );
    expect(noticeBlock).toContain("projectionSnapshot");
  });
});
