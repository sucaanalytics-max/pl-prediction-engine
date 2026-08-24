/**
 * One entry, so no label to choose.
 *
 * ENTRY_LABELS existed because the pipeline decided for two bot entries and the
 * portal rendered both, which is how a screen came to show two disagreeing
 * "Projected" figures by design. The bots moved to their own project on
 * 2026-08-24.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionDescriptor } from "@/lib/data/narrow";
import { OWNER_ENTRY } from "@/lib/entry";

/**
 * Every source file the app SHIPS. Tests are excluded on purpose: the route test
 * has to name the two ids to assert that they are refused, and a scan that
 * forbade that would push the assertion out of the suite to reach green.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const FILES = ["app", "components", "lib"].flatMap((d) =>
  sources(join(process.cwd(), d)),
);

describe("single entry", () => {
  it("builds a decision path from a gameweek alone", () => {
    expect(decisionDescriptor(2).path).toBe(
      "fpl/decision_public_gw02_owner.json",
    );
  });

  it("pads the gameweek", () => {
    expect(decisionDescriptor(11).path).toContain("gw11");
  });

  it("is the entry the pipeline decides for", () => {
    // Mirrors `pipeline/config.py` FPL_ENTRIES, which is the authority. A
    // disagreement here is silent: a capture would be committed to a path
    // `_read_entry` never opens.
    expect(OWNER_ENTRY).toBe(20945);
  });

  it("names the two detached entries nowhere but in the history of why", () => {
    /**
     * This replaces `lib/control-room/model.test.ts`, which pinned
     * `[20945, 2561567, 2561099]` as the app's team list — and that list was
     * still driving the write path after the two bots detached, so
     * `/api/hub/position` accepted them and refused the owner. The module is
     * gone; this is what stops the ids coming back.
     *
     * Comments are allowed to name them: explaining which entries left, and
     * when, is the documentation this repo wants. Code is not.
     */
    const stripped = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const offenders = FILES.filter((file) =>
      /2561567|2561099/.test(stripped(readFileSync(file, "utf8"))),
    ).map((file) => file.replace(process.cwd() + "/", ""));

    expect(offenders, "a detached bot entry id is still in the code").toEqual([]);
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
