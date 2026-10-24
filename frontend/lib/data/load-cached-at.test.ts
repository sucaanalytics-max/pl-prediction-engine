/**
 * What `load()` does with the service worker's `x-sw-cached-at` stamp.
 *
 * The stamp is the only thing that tells a page its bytes came from a stored copy.
 * It has to reach `provenance.cachedAt` when the response carries a real one, and
 * it has to be absent — not guessed — when it does not, because a surface that
 * labels live data "cached" is as wrong as the reverse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { load } from "@/lib/data/load";
import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import type { Descriptor } from "@/lib/data/registry";
import { getCachedAt, resetCachedAt } from "@/lib/sw-cache-age";

const NOW = new Date("2026-10-24T12:00:00Z");

function narrow(raw: unknown): NarrowResult<{ value: number }> {
  if (typeof raw !== "object" || raw === null || !("value" in raw) || typeof raw.value !== "number") {
    return malformed(["value is not a number"]);
  }
  return narrowed({ value: raw.value });
}

const DESCRIPTOR: Descriptor<{ value: number }> = {
  key: "cached-at-test",
  path: "test.json",
  owner: "daily",
  describes: "a test artifact",
  freshnessBudgetMs: null,
  narrow,
};

const respond = (headers: Record<string, string>, status = 200, body = '{"value":1}') =>
  vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;

afterEach(() => resetCachedAt());

describe("load() and x-sw-cached-at", () => {
  it("records the stamp on provenance and in the age store", async () => {
    const stamp = "2026-10-24T09:30:00.000Z";
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: respond({ "x-sw-cached-at": stamp }),
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.cachedAt).toBe(stamp);
    expect(artifact.provenance.source).toBe("local");
    expect(getCachedAt()).toBe(stamp);
  });

  it("records the stamp from a Supabase hit too", async () => {
    const stamp = "2026-10-24T08:00:00.000Z";
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: "https://p.supabase.co/storage/v1/object/public/predictions",
      fetchImpl: respond({ "x-sw-cached-at": stamp }),
    });
    expect(artifact.provenance.source).toBe("supabase");
    expect(artifact.provenance.cachedAt).toBe(stamp);
  });

  it("leaves cachedAt null and the store untouched for a live response", async () => {
    const artifact = await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: respond({}) });
    expect(artifact.provenance.cachedAt).toBeNull();
    expect(getCachedAt()).toBeNull();
  });

  it("ignores a stamp that is not a timestamp", async () => {
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: respond({ "x-sw-cached-at": "yesterday-ish" }),
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.cachedAt).toBeNull();
    expect(getCachedAt()).toBeNull();
  });

  it("does not carry a stamp onto an absent artifact", async () => {
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null,
      fetchImpl: respond({ "x-sw-cached-at": "2026-10-24T09:30:00.000Z" }, 404, "<html>404</html>"),
    });
    expect(artifact.state).toBe("absent");
    expect(artifact.provenance.cachedAt).toBeNull();
    expect(getCachedAt()).toBeNull();
  });

  it("keeps the OLDEST stamp when several artifacts are cached", async () => {
    await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: respond({ "x-sw-cached-at": "2026-10-24T10:00:00.000Z" }) });
    await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: respond({ "x-sw-cached-at": "2026-10-24T07:15:00.000Z" }) });
    await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: respond({ "x-sw-cached-at": "2026-10-24T11:00:00.000Z" }) });
    expect(getCachedAt()).toBe("2026-10-24T07:15:00.000Z");
  });
});
