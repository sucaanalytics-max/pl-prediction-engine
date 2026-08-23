/**
 * The capture endpoint's guards.
 *
 * This is the boundary between a browser form and an optimiser that spends a
 * £100m budget, and it now writes to `main`. Like the scan trigger beside it, most
 * of these tests are about refusing: a squad of fourteen reads downstream as a free
 * slot and the bank gets spent on it, and a capture for the owner's advisory team
 * would imply a proposal that never arrives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const RONNY = 2561567;
const WAZZA = 2561099;
const MINE = 20945;

const SQUAD = Array.from({ length: 15 }, (_, index) => index + 1);

function body(overrides: Record<string, unknown> = {}) {
  return {
    entryId: RONNY,
    gameweek: 2,
    squad: SQUAD,
    bank: 35,
    freeTransfers: 1,
    squadValue: 100.5,
    ...overrides,
  };
}

function post(payload: unknown, raw = false) {
  return new Request("http://localhost/api/hub/position", {
    method: "POST",
    body: raw ? (payload as string) : JSON.stringify(payload),
  });
}

/** The PUT call, i.e. the write rather than the sha lookup. */
function written() {
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
  return {
    url: String(put?.[0]),
    body: JSON.parse(String(put?.[1]?.body)),
  };
}

function decoded(content: string) {
  return JSON.parse(Buffer.from(content, "base64").toString("utf-8"));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.GITHUB_DISPATCH_TOKEN = "ghp_test";
  delete process.env.X_SCAN_REPO;

  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    // No existing file: the first capture creates it, so no sha is sent.
    if (!init?.method || init.method === "GET") {
      return new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ commit: { sha: "abc1234def" } }), { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("refusing", () => {
  it("refuses the owner's own team, which no agent decides for", async () => {
    const response = await POST(post(body({ entryId: MINE })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("advisory only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a short squad, which would read as a free slot", async () => {
    const response = await POST(post(body({ squad: SQUAD.slice(0, 14) })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("15");
  });

  it("refuses a squad with a duplicate", async () => {
    const response = await POST(post(body({ squad: [...SQUAD.slice(0, 14), 1] })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("DISTINCT");
  });

  it("refuses a price for a player who is not in the squad", async () => {
    const response = await POST(post(body({ purchasePrices: { 999: 50 } })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not in the squad");
  });

  it("refuses a fractional bank, because the unit is tenths", async () => {
    const response = await POST(post(body({ bank: 3.5 })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("tenths");
  });

  it.each([0, 39, -1])("refuses gameweek %i", async (gameweek) => {
    expect((await POST(post(body({ gameweek })))).status).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    expect((await POST(post("not json", true))).status).toBe(400);
  });

  it("reports 503 without a token, rather than claiming success", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const response = await POST(post(body()));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("Nothing was saved");
  });

  it("reports 409 when compare-and-swap loses, without overwriting", async () => {
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ sha: "oldsha" }), { status: 200 });
      }
      return new Response("conflict", { status: 409 });
    });
    const response = await POST(post(body()));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("landed first");
  });

  it("reports 502 when the write fails, and claims nothing", async () => {
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return new Response("{}", { status: 404 });
      return new Response("no", { status: 500 });
    });
    const response = await POST(post(body()));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("Nothing was saved");
  });
});

describe("committing", () => {
  it("writes one file per entry, on the path the agent reads", async () => {
    await POST(post(body()));
    expect(written().url).toContain(
      `/repos/sucaanalytics-max/pl-prediction-engine/contents/predictions/fpl/hub/capture/${RONNY}.json`
    );
  });

  it("returns the commit sha as the receipt", async () => {
    const response = await POST(post(body()));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.status).toBe("saved");
    expect(payload.commit).toBe("abc1234def");
    expect(payload.recorded).toMatchObject({ entryId: RONNY, gameweek: 2, players: 15 });
  });

  it("commits the shape hub_state.py reads, in tenths", async () => {
    await POST(post(body({ bank: 35 })));
    const content = decoded(written().body.content);
    expect(content.source).toBe("owner_captured");
    expect(content.bank).toBe(35);
    expect(content.entry_id).toBe(RONNY);
    expect(content.gameweek).toBe(2);
    expect(content.squad).toHaveLength(15);
    expect(content.free_transfers).toBe(1);
  });

  it("sends no sha when creating, so it cannot clobber an unseen file", async () => {
    await POST(post(body()));
    expect(written().body.sha).toBeUndefined();
  });

  it("sends the current sha when replacing, which is the compare-and-swap", async () => {
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ sha: "existing123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ commit: { sha: "newsha" } }), { status: 200 });
    });
    await POST(post(body()));
    expect(written().body.sha).toBe("existing123");
  });

  it("stamps captured_at on the server, ignoring anything the caller sends", async () => {
    const forged = "1999-01-01T00:00:00.000Z";
    const response = await POST(post(body({ captured_at: forged, capturedAt: forged })));
    const content = decoded(written().body.content);
    expect(content.captured_at).not.toBe(forged);
    expect((await response.json()).capturedAt).toBe(content.captured_at);
    // The agent compares this against FPL's price-change boundary, so a clock the
    // caller controls could make an expired capture look fresh.
    expect(Date.parse(content.captured_at)).toBeGreaterThan(Date.parse("2026-01-01"));
  });

  it("accepts both bot entries", async () => {
    for (const entryId of [RONNY, WAZZA]) {
      fetchMock.mockClear();
      const response = await POST(post(body({ entryId })));
      expect(response.status).toBe(201);
      expect(written().url).toContain(`capture/${entryId}.json`);
    }
  });
});
