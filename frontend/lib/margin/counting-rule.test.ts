/**
 * Any surface that prints a squad total must say how it was counted.
 *
 * `/now` once printed 48.20 while `/margin` printed 54.9 for the same eleven and the
 * same artifact — one summed the XI bare, the other added the captain's projection
 * again — and neither screen said which it was. Both were arithmetically defensible,
 * which is exactly why a reader could not tell them apart.
 *
 * `projectedTotal` fixed the arithmetic. This fixes the labelling, and is a scan
 * rather than a habit: the planner's 24px figure, the number a reader is most likely
 * to quote, shipped for weeks with no rule on it at all while the other two carried
 * one each in their own words.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COUNTING_RULE } from "@/lib/margin/planner";

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const FILES = ["app", "components", "lib"].flatMap((d) => sources(d));

/**
 * Files that RENDER a squad total, as opposed to computing one.
 *
 * Only `app/` and `components/` — `lib/` is arithmetic and prints nothing, so a
 * module there may call `projectedTotal` without carrying the rule. The rule belongs
 * on whatever puts the number in front of a reader.
 */
const RENDERS_A_TOTAL = FILES.filter((path) => {
  if (!path.startsWith("app/") && !path.startsWith("components/")) return false;
  const source = readFileSync(path, "utf8");
  if (!/\.toFixed\(|toLocaleString\(/.test(source)) return false;
  // One way in now. The second route was reading `XiTotal.total`, a type that
  // `lib/control-room/model.ts` filled from this same function for the deleted
  // control room's Ledger; both are gone, and a clause matching a type name no
  // module declares would read as coverage this scan does not have.
  return source.includes("projectedTotal(");
});

describe("the counting rule travels with the number", () => {
  it("finds the surfaces that print a total, so this scan cannot go quiet", () => {
    // If this drops to zero the scan below passes trivially.
    expect(RENDERS_A_TOTAL.length).toBeGreaterThan(0);
  });

  it("has every one of them state the rule", () => {
    const silent = RENDERS_A_TOTAL.filter(
      (path) => !readFileSync(path, "utf8").includes("COUNTING_RULE"),
    );
    expect(silent, "prints a squad total without saying how it was counted")
      .toEqual([]);
  });

  it("has none of them retype the phrase, so the three cannot drift apart", () => {
    /* The original defect was three screens each wording their own caveat. A typed
       copy would let one of them be edited alone. */
    const retyped = FILES.filter((path) => {
      if (path.endsWith("lib/margin/planner.ts")) return false;
      return readFileSync(path, "utf8").includes(COUNTING_RULE);
    });
    expect(retyped, `retypes "${COUNTING_RULE}" instead of importing it`).toEqual([]);
  });
});
