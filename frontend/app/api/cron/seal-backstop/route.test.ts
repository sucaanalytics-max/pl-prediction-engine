/**
 * The Vercel seal backstop's guards.
 *
 * This endpoint dispatches a CI job that seals a forecast and commits to `main`,
 * and the deployment is reachable by URL. So, as with the x-scan trigger, most
 * tests are refusals: no secret, the wrong secret, outside the band, sealed, busy.
 * The ones that permit check what is sent — `dry_run: "false"`, because the
 * workflow's input defaults to a dry run that seals nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const SECRET = "cron-secret-for-tests";
const DEADLINE = "2026-10-10T10:00:00Z";
const IN_BAND = new Date("2026-10-10T08:00:00Z");
const OUTSIDE_BAND = new Date("2026-10-07T08:00:00Z");

function cron(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return new Request("http://localhost/api/cron/seal-backstop", { headers });
}

interface Upstream {
  ledger?: number;
  runs?: unknown[];
  runsStatus?: number;
  dispatch?: Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function upstream({ ledger = 404, runs = [], runsStatus = 200, dispatch }: Upstream = {}) {
  fetchMock.mockImplementation(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("bootstrap-static")) {
      return new Response(JSON.stringify({
        events: [
          { id: 5, deadline_time: "2026-09-19T10:00:00Z" },
          { id: 6, deadline_time: DEADLINE },
          { id: 7, deadline_time: "2026-10-17T10:00:00Z" },
        ],
      }), { status: 200 });
    }
    if (href.includes("/contents/")) return new Response(null, { status: ledger });
    if (href.includes("/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: runs }), { status: runsStatus });
    }
    // 204 must carry a null body; `new Response("", {status:204})` throws.
    if (href.includes("/dispatches")) return dispatch ?? new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${href}`);
  });
}

function calls(fragment: string) {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes(fragment));
}

function githubCalls() {
  return calls("api.github.com");
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.GITHUB_DISPATCH_TOKEN = "github_pat_test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(IN_BAND);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  upstream();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.GITHUB_DISPATCH_TOKEN;
});

describe("GET /api/cron/seal-backstop — who may call it", () => {
  it("refuses a request without the cron secret, and touches nothing", async () => {
    const response = await GET(cron({}));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const response = await GET(cron({ authorization: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the bare secret without the Bearer scheme", async () => {
    const response = await GET(cron({ authorization: SECRET }));
    expect(response.status).toBe(401);
  });

  it("FAILS CLOSED when CRON_SECRET is not configured", async () => {
    // "Bearer undefined" must not be a password.
    delete process.env.CRON_SECRET;
    expect((await GET(cron({ authorization: "Bearer undefined" }))).status).toBe(401);
    expect((await GET(cron({ authorization: "Bearer " }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/seal-backstop — when it does nothing", () => {
  it("outside the band it reads FPL's calendar and makes no GitHub call", async () => {
    vi.setSystemTime(OUTSIDE_BAND);
    const response = await GET(cron());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("outside-band");
    expect(body.gameweek).toBe(6);
    expect(body.band).toEqual({ opens: "2026-10-10T06:00:00.000Z", closes: "2026-10-10T09:30:00.000Z" });
    expect(githubCalls()).toHaveLength(0);
  });

  it("outside the band says whether a token is configured, never the token", async () => {
    vi.setSystemTime(OUTSIDE_BAND);
    const text = await (await GET(cron())).text();
    expect(JSON.parse(text).tokenConfigured).toBe(true);
    expect(text).not.toContain("github_pat_test");
    expect(text).not.toContain(SECRET);
  });

  it("inside the lockout it does nothing: the agent would refuse to write", async () => {
    vi.setSystemTime(new Date("2026-10-10T09:40:00Z"));
    const body = await (await GET(cron())).json();
    expect(body.action).toBe("outside-band");
    expect(githubCalls()).toHaveLength(0);
  });

  it("does nothing once the gameweek is sealed on main", async () => {
    upstream({ ledger: 200 });
    const body = await (await GET(cron())).json();
    expect(body.action).toBe("sealed");
    expect(calls("/contents/predictions/fpl/ledger/gw06/forecast.jsonl?ref=main")).toHaveLength(1);
    expect(calls("/dispatches")).toHaveLength(0);
  });

  it("leaves a run already in flight to finish", async () => {
    upstream({ runs: [{ id: 9, status: "in_progress", created_at: "2026-10-10T07:30:00Z" }] });
    const body = await (await GET(cron())).json();
    expect(body.action).toBe("busy");
    expect(body.reason).toBe("run 9 is in_progress");
    expect(calls("/dispatches")).toHaveLength(0);
  });

  it("leaves a run started minutes ago alone, even if it finished", async () => {
    upstream({ runs: [{ id: 10, status: "completed", created_at: "2026-10-10T07:55:00Z" }] });
    const body = await (await GET(cron())).json();
    expect(body.action).toBe("busy");
    expect(calls("/dispatches")).toHaveLength(0);
  });
});

describe("GET /api/cron/seal-backstop — failing loudly", () => {
  it("inside the band without a token it answers 503, so the cron log shows a failure", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const response = await GET(cron());
    expect(response.status).toBe(503);
    expect((await response.json()).action).toBe("no-token");
    expect(githubCalls()).toHaveLength(0);
  });

  it("an unreadable FPL calendar is a 502, not a silent 'outside the band'", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const response = await GET(cron());
    expect(response.status).toBe(502);
    expect(githubCalls()).toHaveLength(0);
  });

  it("an unexpected ledger status is a 502, not a dispatch", async () => {
    upstream({ ledger: 401 });
    const response = await GET(cron());
    expect(response.status).toBe(502);
    expect((await response.json()).reason).toContain("401");
    expect(calls("/dispatches")).toHaveLength(0);
  });

  it("an unreadable run list is a 502, not a dispatch", async () => {
    upstream({ runsStatus: 500 });
    const response = await GET(cron());
    expect(response.status).toBe(502);
    expect(calls("/dispatches")).toHaveLength(0);
  });

  it("relays GitHub's reason when the dispatch is refused", async () => {
    upstream({ dispatch: new Response("Resource not accessible by personal access token", { status: 403 }) });
    const response = await GET(cron());
    expect(response.status).toBe(502);
    // The sentence names the fix: a token without Actions: write.
    expect((await response.json()).reason).toContain("Resource not accessible");
  });

  it("a network failure reaching GitHub is a 502 with a reason, not an unhandled throw", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes("bootstrap-static")) {
        return new Response(JSON.stringify({ events: [{ id: 6, deadline_time: DEADLINE }] }), { status: 200 });
      }
      throw new TypeError("fetch failed");
    });
    const response = await GET(cron());
    expect(response.status).toBe(502);
    expect((await response.json()).reason).toContain("fetch failed");
  });

  it("logs every outcome that is not routine, failures as errors", async () => {
    upstream({ ledger: 200 });
    await GET(cron());
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"action":"sealed"'));

    delete process.env.GITHUB_DISPATCH_TOKEN;
    await GET(cron());
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"action":"no-token"'));
  });

  it("stays quiet outside the band, where every ten minutes all season is routine", async () => {
    vi.setSystemTime(OUTSIDE_BAND);
    await GET(cron());
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/seal-backstop — dispatching", () => {
  it("dispatches a SEALING run when the band is open, nothing is sealed and nothing runs", async () => {
    upstream({ runs: [{ id: 8, status: "completed", created_at: "2026-10-10T06:30:00Z" }] });
    const response = await GET(cron());
    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("dispatched");

    const dispatch = calls("/actions/workflows/fpl_agent.yml/dispatches");
    expect(dispatch).toHaveLength(1);
    const init = dispatch[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.ref).toBe("main");
    // A string, as GitHub's dispatch API takes inputs; the workflow's default is true.
    expect(body.inputs).toEqual({ dry_run: "false" });
  });

  it("authenticates to GitHub with the dispatch token", async () => {
    await GET(cron());
    expect(githubCalls()).toHaveLength(3);
    for (const [, init] of githubCalls()) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer github_pat_test" });
    }
  });
});

describe("vercel.json", () => {
  const config = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "vercel.json"), "utf8"));
  const job = config.crons?.find((c: { path: string }) => c.path === "/api/cron/seal-backstop");

  it("schedules this route", () => {
    expect(job).toBeDefined();
  });

  it("checks every ten minutes: many chances per band, and no faster than the run guard", () => {
    // Every ten minutes gives a 3.5-hour band ~21 checks. Faster than RECENT_RUN
    // would only find the run it just dispatched and stand down.
    expect(job.schedule).toBe("*/10 * * * *");
  });
});
