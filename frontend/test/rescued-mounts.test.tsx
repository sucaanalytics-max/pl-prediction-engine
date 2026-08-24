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

  it("mounts the agent's message feed and its idle line on /evidence", () => {
    /**
     * The same class of defect one layer down, and it did happen: `/inbox` was
     * deleted and `REGISTRY.messages` was left narrowed with no consumer, so
     * `_deliver`'s "ONLY channel" — including the critical "GW{n} was never
     * sealed" announcement — reached no screen. `agentRan` and `reason` were in
     * the same state, which is how "idle by design" and "broken" came to look
     * identical on the page built to tell them apart.
     */
    const source = read("app", "evidence", "page.tsx");
    expect(source).toContain("AgentMessages");
    expect(source).toContain("AgentIdleNotice");
  });

  it("links /capture from /, since the navs deliberately do not", () => {
    // The write path's own reachability, asserted beside the read path's.
    expect(read("app", "page.tsx")).toContain('href="/capture"');
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
