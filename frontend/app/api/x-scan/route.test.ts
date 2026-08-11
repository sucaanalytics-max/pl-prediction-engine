/**
 * The scan trigger's guards.
 *
 * This endpoint starts a CI job that pushes to `main`. The app has no auth by
 * design — it is a private tool — but the deployment is reachable by URL, so an
 * open trigger is a way for a stranger to spend runner minutes and land commits.
 *
 * Every test here is about refusing, because the dangerous failure is permitting.
 * The happy path is one test; the rest are the ways it must say no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const SECRET = "correct-horse-battery";

function post(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x-scan", { method: "POST", headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.GITHUB_DISPATCH_TOKEN = "ghp_test";
  process.env.X_SCAN_TRIGGER_SECRET = SECRET;
  process.env.X_SCAN_COOLDOWN_MINUTES = "10";

  fetchMock = vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/runs?")) {
      // No previous run, so the cooldown cannot bind unless a test says so.
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    }
    // 204 must carry a null body; `new Response("", {status:204})` throws.
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_DISPATCH_TOKEN;
  delete process.env.X_SCAN_TRIGGER_SECRET;
  delete process.env.X_SCAN_COOLDOWN_MINUTES;
});

describe("POST /api/x-scan — refusing", () => {
  it("refuses without the secret header", async () => {
    const response = await POST(post());
    expect(response.status).toBe(401);
    // And crucially, no dispatch was attempted.
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/dispatches")),
    ).toHaveLength(0);
  });

  it("refuses a wrong secret", async () => {
    const response = await POST(post({ "x-scan-secret": "wrong" }));
    expect(response.status).toBe(401);
  });

  it("refuses a secret that is merely a prefix of the real one", async () => {
    // The length check is what makes the constant-time compare safe to enter.
    const response = await POST(post({ "x-scan-secret": SECRET.slice(0, 5) }));
    expect(response.status).toBe(401);
  });

  it("FAILS CLOSED when no secret is configured", async () => {
    /**
     * The most important test here.
     *
     * A missing variable must not silently produce an open endpoint. The tempting
     * implementation — "if no secret is set, skip the check" — is exactly how an
     * unauthenticated CI trigger reaches production, and it would pass every other
     * test in this file.
     */
    delete process.env.X_SCAN_TRIGGER_SECRET;
    const response = await POST(post());
    expect(response.status).toBe(501);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/dispatches")),
    ).toHaveLength(0);
  });

  it("refuses when the GitHub token is absent", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const response = await POST(post({ "x-scan-secret": SECRET }));
    expect(response.status).toBe(501);
  });

  it("enforces the cooldown", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { id: 1, status: "completed", conclusion: "success",
                created_at: new Date(Date.now() - 60_000).toISOString(),
                html_url: "https://example.test/run/1" },
            ],
          }),
          { status: 200 },
        );
      }
      // 204 must carry a null body; `new Response("", {status:204})` throws.
    return new Response(null, { status: 204 });
    });

    const response = await POST(post({ "x-scan-secret": SECRET }));
    expect(response.status).toBe(429);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/dispatches")),
    ).toHaveLength(0);
  });

  it("allows a run once the cooldown has passed", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes("/runs?")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { id: 1, status: "completed", conclusion: "success",
                created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
                html_url: "https://example.test/run/1" },
            ],
          }),
          { status: 200 },
        );
      }
      // 204 must carry a null body; `new Response("", {status:204})` throws.
    return new Response(null, { status: 204 });
    });

    const response = await POST(post({ "x-scan-secret": SECRET }));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/x-scan — dispatching", () => {
  it("dispatches with the right ref and NO inputs", async () => {
    const response = await POST(post({ "x-scan-secret": SECRET }));
    expect(response.status).toBe(200);

    const dispatch = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/dispatches"),
    );
    expect(dispatch).toBeDefined();

    const body = JSON.parse(String((dispatch?.[1] as RequestInit).body));
    expect(body.ref).toBe("main");
    // The workflow accepts no inputs; sending any would mean a request value
    // reaching a shell in CI.
    expect(body.inputs).toBeUndefined();
  });

  it("relays GitHub's own reason when the dispatch is refused", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes("/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      return new Response("Resource not accessible by integration", { status: 403 });
    });

    const response = await POST(post({ "x-scan-secret": SECRET }));
    expect(response.status).toBe(502);
    const body = await response.json();
    // The upstream sentence names the fix — a token without actions:write. A bare
    // "dispatch failed" sends someone looking in the wrong place.
    expect(body.reason).toContain("Resource not accessible");
  });

  it("does not claim the scan finished", async () => {
    // A dispatch returns 204 with no run id and the scan takes about a minute.
    const response = await POST(post({ "x-scan-secret": SECRET }));
    const body = await response.json();
    expect(body.reason).toBe("scan queued");
    expect(body.reason).not.toContain("complete");
  });
});

describe("GET /api/x-scan", () => {
  it("reports not-configured rather than erroring", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(false);
    expect(body.reason).toContain("x_scan.sh");
  });

  it("never leaks the secret or the token", async () => {
    const body = await (await GET()).json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("ghp_test");
  });

  it("reports the last run", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 42, status: "completed", conclusion: "success",
              created_at: "2026-08-11T09:21:45Z",
              html_url: "https://example.test/run/42" },
          ],
        }),
        { status: 200 },
      ),
    );
    const body = await (await GET()).json();
    expect(body.lastRun.id).toBe(42);
    expect(body.lastRun.conclusion).toBe("success");
  });
});
