/**
 * The capture endpoint's guards.
 *
 * This is the boundary between a browser form and an optimiser that spends a
 * £100m budget. Like the scan trigger beside it, most of these tests are about
 * refusing, because the dangerous failure is accepting: a squad of fourteen reads
 * downstream as a free slot and the bank gets spent on it, and a capture for the
 * owner's advisory team would imply a proposal that never arrives.
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("refusing", () => {
  it("refuses the owner's own team, which no agent decides for", async () => {
    const response = await POST(post(body({ entryId: MINE })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("advisory only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown entry", async () => {
    const response = await POST(post(body({ entryId: 999999 })));
    expect(response.status).toBe(400);
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

  it("reports 503 without a Supabase configuration, rather than claiming success", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const response = await POST(post(body()));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("not stored");
  });

  it("reports 502 when the store rejects the write, and claims nothing", async () => {
    fetchMock.mockResolvedValue(new Response("no", { status: 400 }));
    const response = await POST(post(body()));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("Nothing was saved");
  });
});

describe("accepting", () => {
  it("stores a valid capture for each bot", async () => {
    for (const entryId of [RONNY, WAZZA]) {
      fetchMock.mockClear();
      const response = await POST(post(body({ entryId })));
      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload.status).toBe("saved");
      expect(payload.recorded).toMatchObject({ entryId, gameweek: 2, players: 15 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("sends tenths in the payload and millions in the columns", async () => {
    await POST(post(body({ bank: 35 })));
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.payload.bank).toBe(35);
    expect(sent.bank).toBe(3.5);
    expect(sent.squad_value).toBe(100.5);
    expect(sent.source).toBe("owner_captured");
  });

  it("stamps captured_at on the server, ignoring anything the caller sends", async () => {
    const forged = "1999-01-01T00:00:00.000Z";
    const response = await POST(post(body({ captured_at: forged, capturedAt: forged })));
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.captured_at).not.toBe(forged);
    expect((await response.json()).capturedAt).toBe(sent.captured_at);
    // The agent compares this against FPL's price-change boundary, so a clock the
    // caller controls could make an expired capture look fresh.
    expect(Date.parse(sent.captured_at)).toBeGreaterThan(Date.parse("2026-01-01"));
  });

  it("accepts an absent purchasePrices, which the agent flags as uncertain", async () => {
    const response = await POST(post(body()));
    expect(response.status).toBe(201);
    expect((await response.json()).recorded.pricesSupplied).toBe(0);
  });

  it("keys each capture uniquely, so a correction does not overwrite the record", async () => {
    await POST(post(body()));
    const first = JSON.parse(String(fetchMock.mock.calls[0][1].body)).snapshot_key;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await POST(post(body({ bank: 40 })));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1].body)).snapshot_key;
    expect(second).not.toBe(first);
  });
});
