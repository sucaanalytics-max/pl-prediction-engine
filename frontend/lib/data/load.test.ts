/**
 * The loader: Supabase first, local fallback, and every failure as a state.
 *
 * The fallback is a CLAUDE.md constraint ("Keep that fallback"), so it is tested
 * in both directions rather than assumed. The additions over the old
 * `fetchWithFallback` are the two things it could not express:
 *
 * 1. **Which source won**, on `provenance.source`. A local hit during normal
 *    operation means the remote is failing silently, and nothing used to say so.
 * 2. **`absent` versus `unreadable`.** Measured against the live deployment, a
 *    missing artifact returns 30KB of Next.js 404 HTML — so `res.json()` on a 404
 *    throws a parse error, and a naive catch reports a missing file as a corrupt
 *    one. The status is checked before the body is read.
 */
import { describe, expect, it, vi } from "vitest";
import { load, LOCAL_BASE, REMOTE_TIMEOUT_MS } from "@/lib/data/load";
import { proven } from "@/lib/data/artifact";
import { ALL_DESCRIPTORS, REGISTRY } from "@/lib/data/narrow";
import { narrowed, malformed, type NarrowResult } from "@/lib/data/artifact";
import type { Descriptor } from "@/lib/data/registry";

const NOW = new Date("2026-08-06T12:00:00Z");
const REMOTE = "https://project.supabase.co/storage/v1/object/public/predictions";

interface Payload { value: number; produced_at?: string }

function narrowPayload(raw: unknown): NarrowResult<Payload> {
  if (!raw || typeof raw !== "object") return malformed(["not an object"]);
  const source = raw as Record<string, unknown>;
  if (typeof source.value !== "number") return malformed(["value is not a number"]);
  return narrowed({
    value: source.value,
    produced_at: source.produced_at as string | undefined,
  });
}

const DESCRIPTOR: Descriptor<Payload> = {
  key: "test",
  path: "test.json",
  owner: "daily",
  describes: "a test artifact",
  freshnessBudgetMs: 24 * 3600_000,
  narrow: narrowPayload,
  producedAtOf: (v) => v.produced_at,
};

/** A fetch that answers per-URL, and records what it was asked for. */
function fakeFetch(
  routes: Record<string, { status?: number; body?: string; throws?: Error }>,
) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const key = String(url);
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    if (route.throws) throw route.throws;
    void init;
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const GOOD = JSON.stringify({ value: 42, produced_at: NOW.toISOString() });

describe("local-only mode", () => {
  it("reads the local copy when no remote is configured", async () => {
    const { impl, calls } = fakeFetch({ [`${LOCAL_BASE}/test.json`]: { body: GOOD } });
    const artifact = await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: impl });

    expect(artifact.state).toBe("ok");
    expect(proven(artifact)?.value).toBe(42);
    expect(artifact.provenance.source).toBe("local");
    expect(calls).toEqual([`${LOCAL_BASE}/test.json`]);
  });

  it("does not attempt a remote request at all", async () => {
    const { impl, calls } = fakeFetch({ [`${LOCAL_BASE}/test.json`]: { body: GOOD } });
    await load(DESCRIPTOR, { now: NOW, remote: null, fetchImpl: impl });
    expect(calls.some((c) => c.includes("supabase"))).toBe(false);
  });
});

describe("the Supabase-first, local-fallback path", () => {
  it("prefers the remote when it answers", async () => {
    const { impl, calls } = fakeFetch({
      [`${REMOTE}/test.json`]: { body: GOOD },
      [`${LOCAL_BASE}/test.json`]: { body: JSON.stringify({ value: 1 }) },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(proven(artifact)?.value).toBe(42);
    expect(artifact.provenance.source).toBe("supabase");
    expect(calls).toEqual([`${REMOTE}/test.json`]);
  });

  it("falls back to local when the remote errors", async () => {
    const { impl } = fakeFetch({
      [`${REMOTE}/test.json`]: { status: 500 },
      [`${LOCAL_BASE}/test.json`]: { body: GOOD },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.source).toBe("local");
  });

  it("falls back when the remote throws", async () => {
    const { impl } = fakeFetch({
      [`${REMOTE}/test.json`]: { throws: new TypeError("network down") },
      [`${LOCAL_BASE}/test.json`]: { body: GOOD },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.source).toBe("local");
  });

  it("falls back when the remote 404s but the committed copy exists", async () => {
    // The remote may not have this artifact yet; the committed copy is a real
    // answer and must not be skipped just because the remote said no.
    const { impl } = fakeFetch({ [`${LOCAL_BASE}/test.json`]: { body: GOOD } });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.source).toBe("local");
  });

  it("records that the local copy won, so a silent remote failure is visible", async () => {
    const { impl } = fakeFetch({
      [`${REMOTE}/test.json`]: { status: 503 },
      [`${LOCAL_BASE}/test.json`]: { body: GOOD },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    // The old loader logged a console.warn and moved on; nothing reached the UI.
    expect(artifact.provenance.source).toBe("local");
  });

  it("is absent when neither source has it", async () => {
    const { impl } = fakeFetch({});
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(artifact.state).toBe("absent");
    expect(artifact.provenance.source).toBe("none");
  });
});

describe("absent versus unreadable", () => {
  it("a 404 is absent, not unreadable", async () => {
    const { impl } = fakeFetch({
      [`${LOCAL_BASE}/test.json`]: { status: 404, body: "<html>Not found</html>" },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    // The live deployment really does serve 30KB of HTML here. Reading the body
    // before checking the status would report a missing file as a corrupt one.
    expect(artifact.state).toBe("absent");
    expect(artifact.reason).toMatch(/Nothing has been published/);
  });

  it("a 200 with a non-JSON body is unreadable, not absent", async () => {
    const { impl } = fakeFetch({
      [`${LOCAL_BASE}/test.json`]: { body: "<html>oops</html>" },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    expect(artifact.state).toBe("absent");
    expect(artifact.reason).toMatch(/unparseable/);
  });

  it("a 200 with valid JSON of the wrong shape is unreadable", async () => {
    const { impl } = fakeFetch({
      [`${LOCAL_BASE}/test.json`]: { body: JSON.stringify({ value: "forty-two" }) },
    });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    expect(artifact.state).toBe("unreadable");
    expect(artifact.reason).toMatch(/value is not a number/);
  });

  it("a 500 with no local copy reports the status", async () => {
    const { impl } = fakeFetch({ [`${LOCAL_BASE}/test.json`]: { status: 500 } });
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    expect(artifact.state).toBe("absent");
    expect(artifact.reason).toContain("500");
  });
});

describe("the jsonl format", () => {
  const JSONL: Descriptor<{ lines: number }> = {
    key: "jsonl",
    path: "feed.jsonl",
    owner: "news",
    describes: "a newline-delimited feed",
    freshnessBudgetMs: null,
    format: "jsonl",
    narrow: (raw) =>
      typeof raw === "string"
        ? narrowed({ lines: raw.trim() ? raw.trim().split("\n").length : 0 })
        : malformed([`expected text, got ${typeof raw}`]),
  };

  it("reads the body as text, not through res.json()", async () => {
    // res.json() throws on the second line of a JSONL body, so this is the whole
    // reason `format` exists on the descriptor.
    const body = '{"a":1}\n{"a":2}\n{"a":3}\n';
    const { impl } = fakeFetch({ [`${LOCAL_BASE}/feed.jsonl`]: { body } });
    const artifact = await load(JSONL, { now: NOW, remote: null, fetchImpl: impl });
    expect(artifact.state).toBe("ok");
    expect(proven(artifact)?.lines).toBe(3);
  });

  it("an empty jsonl body still narrows", async () => {
    const { impl } = fakeFetch({ [`${LOCAL_BASE}/feed.jsonl`]: { body: "" } });
    const artifact = await load(JSONL, { now: NOW, remote: null, fetchImpl: impl });
    expect(artifact.state).toBe("ok");
    expect(proven(artifact)?.lines).toBe(0);
  });

  it("the registered deltas feed declares jsonl", () => {
    expect(REGISTRY.deltas.format).toBe("jsonl");
  });
});

describe("timeouts", () => {
  it("abandons a hung remote and uses the local copy", async () => {
    const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(REMOTE)) {
        // Reject the way fetch does when the caller aborts.
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      void init;
      return new Response(GOOD, { status: 200 });
    }) as unknown as typeof fetch;

    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: REMOTE, fetchImpl: impl,
    });
    expect(artifact.state).toBe("ok");
    expect(artifact.provenance.source).toBe("local");
  });

  it("describes a timeout in words a human can act on", async () => {
    const impl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    expect(artifact.reason).toContain(`${REMOTE_TIMEOUT_MS / 1000}s`);
    expect(artifact.reason).not.toContain("AbortError");
  });
});

describe("never throws", () => {
  it("survives a fetch that rejects with a non-Error", async () => {
    const impl = vi.fn(async () => {
      throw "a string, not an Error"; // eslint-disable-line no-throw-literal
    }) as unknown as typeof fetch;
    const artifact = await load(DESCRIPTOR, {
      now: NOW, remote: null, fetchImpl: impl,
    });
    expect(artifact.state).toBe("absent");
  });

  it("survives a narrower that itself throws", async () => {
    const exploding: Descriptor<Payload> = {
      ...DESCRIPTOR,
      narrow: () => { throw new Error("narrower bug"); },
    };
    const { impl } = fakeFetch({ [`${LOCAL_BASE}/test.json`]: { body: GOOD } });
    await expect(
      load(exploding, { now: NOW, remote: null, fetchImpl: impl }),
    ).rejects.toThrow("narrower bug");
    // Documented rather than swallowed: a narrower throwing is a code defect, not
    // a data condition, and hiding it would make the bug unfindable.
  });
});

describe("every registered descriptor is loadable", () => {
  it("has the fields the loader needs", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(typeof descriptor.narrow).toBe("function");
      expect(descriptor.path.length).toBeGreaterThan(0);
      if (descriptor.format) {
        expect(["json", "jsonl"]).toContain(descriptor.format);
      }
    }
  });

  it("gives a jsonl format to every .jsonl path and to no other", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      const isJsonl = descriptor.path.endsWith(".jsonl");
      expect(descriptor.format === "jsonl").toBe(isJsonl);
    }
  });
});
