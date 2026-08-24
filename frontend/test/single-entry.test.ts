/**
 * One entry, so no label to choose.
 *
 * ENTRY_LABELS existed because the pipeline decided for two bot entries and the
 * portal rendered both, which is how a screen came to show two disagreeing
 * "Projected" figures by design. The bots moved to their own project on
 * 2026-08-24.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionDescriptor } from "@/lib/data/narrow";

describe("single entry", () => {
  it("builds a decision path from a gameweek alone", () => {
    expect(decisionDescriptor(2).path).toBe(
      "fpl/decision_public_gw02_owner.json",
    );
  });

  it("pads the gameweek", () => {
    expect(decisionDescriptor(11).path).toContain("gw11");
  });

  it("has no ENTRY_LABELS left anywhere", () => {
    const narrow = readFileSync(
      join(process.cwd(), "lib", "data", "narrow.ts"), "utf8",
    );
    expect(narrow).not.toContain("ENTRY_LABELS");
    expect(narrow).not.toContain("EntryLabel");
    expect(narrow).not.toContain('"weekly"');
  });
});
