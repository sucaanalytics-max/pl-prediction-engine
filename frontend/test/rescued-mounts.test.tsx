/**
 * The four components that only a doomed route imports are mounted elsewhere.
 *
 * ResearchView, NewsView and WatchView are imported by `app/margin/page.tsx` and
 * nothing else; PlanGrid is imported by nothing at all. This asserts each has a
 * new home BEFORE the deletion commit, so "still reachable" is a measured claim.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

describe("rescued mounts", () => {
  it("mounts ResearchView on /players", () => {
    const source = read("app", "players", "page.tsx");
    expect(source).toContain("ResearchView");
    expect(source).toContain("margin/ResearchView");
  });

  it("mounts NewsView and WatchView on /evidence", () => {
    const source = read("app", "evidence", "page.tsx");
    expect(source).toContain("NewsView");
    expect(source).toContain("WatchView");
  });

  it("mounts PlanGrid on /", () => {
    const source = read("app", "page.tsx");
    expect(source).toContain("PlanGrid");
  });

  it("does not reach for the two detached entries", () => {
    for (const page of [
      read("app", "page.tsx"),
      read("app", "players", "page.tsx"),
      read("app", "evidence", "page.tsx"),
    ]) {
      expect(page).not.toContain('"weekly"');
      expect(page).not.toContain("ENTRY_LABELS");
    }
  });
});
