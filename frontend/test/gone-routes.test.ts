/**
 * The deleted routes announce that they are gone, not missing.
 *
 * 22 path prefixes cover 23 deleted route files: `/matches/[id]` has no entry of
 * its own because the middleware also matches on the first path segment.
 *
 * 410 rather than 404 because these were real pages with bookmarks and a service
 * worker that precached several of them: "intentionally gone" is the true
 * statement, and it stops a crawler retrying forever.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

const GONE = [
  "/now", "/margin", "/decide", "/decisions", "/control-room",
  "/inbox", "/accuracy", "/health",
  "/bet", "/markets", "/bankroll", "/matches", "/h2h",
  "/captaincy", "/optimizer", "/planner", "/transfers",
  "/rankings", "/projections", "/intelligence", "/table", "/value-bets",
];

describe("gone routes", () => {
  it("names every deleted route", () => {
    for (const route of GONE) {
      expect(source, `${route} must be listed as gone`).toContain(`"${route}"`);
    }
  });

  it("returns 410, not 404 or a redirect", () => {
    expect(source).toContain("410");
    expect(source).not.toContain("NextResponse.redirect");
  });

  it("does not intercept a surviving route", () => {
    const surviving = readdirSync(join(process.cwd(), "app"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory() && e.name !== "api")
      .map((e) => `/${e.name}`);
    for (const route of surviving) {
      expect(GONE, `${route} still exists and must not be gone`).not.toContain(route);
    }
  });
});
