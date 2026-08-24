import { NextResponse, type NextRequest } from "next/server";

/**
 * The routes this app used to have, and no longer does.
 *
 * 410 Gone rather than 404 Not Found: these were real destinations, several were
 * precached by `public/sw.js`, and some are bookmarked. "Intentionally removed" is
 * the accurate statement and it stops a crawler retrying indefinitely.
 *
 * `next.config.js` redirects cannot express 410 — only 307/308 — and a `route.ts`
 * per path would be 23 files to avoid 23 files. This is `middleware.ts` and not
 * `proxy.ts` because this app is on Next.js 14.2; the rename landed in Next 16.
 */
const GONE = new Set([
  // Five surfaces that all answered "who do I captain this week".
  "/now", "/margin", "/decide", "/decisions", "/control-room",
  // Absorbed into /evidence.
  "/inbox", "/accuracy", "/health",
  // Betting and match prediction: a different question, and the models still run.
  "/bet", "/markets", "/bankroll", "/matches", "/h2h",
  // Redirect stubs, four of which landed on the same page.
  "/captaincy", "/optimizer", "/planner", "/transfers",
  "/rankings", "/projections", "/intelligence", "/table", "/value-bets",
]);

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/+$/, "") || "/";
  const root = "/" + (path.split("/")[1] ?? "");
  if (GONE.has(path) || GONE.has(root)) {
    return new NextResponse(null, { status: 410 });
  }
  return NextResponse.next();
}

export const config = {
  // Everything except assets, the API and Next's own internals. Matching on the
  // set above rather than here keeps the gone list in one readable place.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
