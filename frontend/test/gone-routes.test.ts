/**
 * The deleted routes announce that they are gone, not missing.
 *
 * This calls the exported `middleware()` handler directly with real
 * `NextRequest` objects rather than grepping the source text: a handler that
 * 410s every path (or that never checks anything) must fail this suite, and a
 * text-based check cannot tell the difference.
 *
 * 22 path prefixes cover 23 deleted route files: `/matches/[id]` has no entry
 * of its own because the middleware also matches on the first path segment.
 *
 * 410 rather than 404 because these were real pages with bookmarks and a
 * service worker that precached several of them: "intentionally gone" is the
 * true statement, and it stops a crawler retrying forever.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// Imported rather than re-typed: a second, hand-copied GONE list is exactly
// what let the old test pass without ever exercising the handler.
import { GONE, middleware } from "@/middleware";

function requestFor(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://example.com"));
}

function statusFor(path: string): number {
  return middleware(requestFor(path)).status;
}

/** True only for `NextResponse.next()`, which sets this header — not for any 410. */
function passesThrough(path: string): boolean {
  return middleware(requestFor(path)).headers.get("x-middleware-next") === "1";
}

const survivingRoutes = readdirSync(join(process.cwd(), "app"), {
  withFileTypes: true,
})
  .filter((e) => e.isDirectory() && e.name !== "api")
  .map((e) => `/${e.name}`)
  .concat("/"); // the root page has no directory of its own

describe("gone routes", () => {
  it("returns 410 for every deleted prefix", () => {
    for (const route of GONE) {
      expect(statusFor(route), `${route} should be 410`).toBe(410);
    }
  });

  it("returns 410 for a child path via the first-segment rule", () => {
    // /matches/[id] has no entry of its own in GONE — this is the whole reason
    // the middleware checks the first path segment, not just exact matches.
    expect(statusFor("/matches/38")).toBe(410);
  });

  it("is case-insensitive, so a differently-cased retry still gets 410", () => {
    expect(statusFor("/Matches")).toBe(410);
    expect(statusFor("/HEALTH")).toBe(410);
  });

  it("passes every surviving route through instead of intercepting it", () => {
    for (const route of survivingRoutes) {
      expect(GONE, `${route} still exists and must not be gone`).not.toContain(route);
      expect(passesThrough(route), `${route} should pass through`).toBe(true);
    }
  });

  it("passes an asset-shaped path and an API path through untouched", () => {
    expect(passesThrough("/favicon.ico")).toBe(true);
    expect(passesThrough("/api/fpl/state")).toBe(true);
  });
});
