/**
 * Rule 1: there are no empty states and no loading ceremony.
 *
 * A section renders the last known answer with its age stated; a pending or
 * failed refresh changes the age line and nothing else. `ok`, `empty` and
 * `stale` all carry their own payload, so retention matters for exactly the two
 * states where it is gone — `absent` and `unreadable`. Before this, a reload that
 * 404'd blanked a screen that had been showing a perfectly good answer a second
 * earlier.
 *
 * The load path is exercised for real (fetch is stubbed, `load` is not mocked),
 * because the property under test is how classify's states interact with
 * retention, and mocking `load` would assert my own idea of them instead.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proven } from "@/lib/data/artifact";
import type { Descriptor } from "@/lib/data/registry";
import { useArtifact } from "@/lib/data/useArtifact";

interface Payload { readonly value: number; readonly generated_at?: string }

function descriptor(path: string): Descriptor<Payload> {
  return {
    key: path,
    path,
    owner: "daily",
    describes: "a number, for a test",
    freshnessBudgetMs: 60_000,
    narrow: (raw) =>
      raw && typeof raw === "object" && typeof (raw as Payload).value === "number"
        ? { ok: true, value: raw as Payload }
        : { ok: false, problems: ["not a payload"] },
    producedAtOf: (v) => v.generated_at ?? null,
  };
}

/** Queue of responses, consumed one per fetch. */
function stubFetch(queue: Array<{ status: number; body?: unknown }>) {
  const calls = [...queue];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
    const next = calls.shift() ?? { status: 404 };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    };
  }));
}

const NOW = new Date("2026-08-18T12:00:00Z");
const FRESH = { value: 42, generated_at: "2026-08-18T11:59:30Z" };

afterEach(() => vi.unstubAllGlobals());

describe("a later failure does not blank a good answer", () => {
  it("retains the value across a reload that 404s", async () => {
    stubFetch([{ status: 200, body: FRESH }, { status: 404 }]);
    const { result } = renderHook(() =>
      useArtifact(descriptor("t/first.json"), { now: NOW }),
    );

    await waitFor(() => expect(proven(result.current.artifact)?.value).toBe(42));

    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.artifact.state).toBe("absent"));

    // The fetch's own verdict stays truthful...
    expect(result.current.artifact.state).toBe("absent");
    expect(proven(result.current.artifact)).toBeNull();
    // ...and the answer is still available to render.
    expect(proven(result.current.retained)?.value).toBe(42);
  });

  it("retains across a reload that returns unreadable garbage", async () => {
    stubFetch([{ status: 200, body: FRESH }, { status: 200, body: { nope: true } }]);
    const { result } = renderHook(() =>
      useArtifact(descriptor("t/second.json"), { now: NOW }),
    );
    await waitFor(() => expect(proven(result.current.artifact)?.value).toBe(42));

    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.artifact.state).toBe("unreadable"));

    expect(proven(result.current.retained)?.value).toBe(42);
    // The reason survives, so a caller can name the failure in one quiet line.
    expect(result.current.artifact.reason).toBeTruthy();
  });
});

describe("what retention refuses to do", () => {
  it("never rewrites the state to look better than the fetch was", async () => {
    stubFetch([{ status: 200, body: FRESH }, { status: 404 }]);
    const { result } = renderHook(() =>
      useArtifact(descriptor("t/third.json"), { now: NOW }),
    );
    await waitFor(() => expect(result.current.artifact.state).toBe("ok"));
    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.artifact.state).toBe("absent"));

    // Folding the retained value into `artifact` would make this say "ok", and
    // every honest-refusal mechanism here depends on the state being true.
    expect(result.current.artifact.state).not.toBe("ok");
  });

  it("is null until something has been proven — Rule 1's one exception", async () => {
    stubFetch([{ status: 404 }]);
    const { result } = renderHook(() =>
      useArtifact(descriptor("t/never.json"), { now: NOW }),
    );
    await waitFor(() => expect(result.current.initialising).toBe(false));
    expect(result.current.artifact.state).toBe("absent");
    // Data never computed at all is the one thing that may read as missing.
    expect(result.current.retained).toBeNull();
  });

  it("does not serve one artifact's value as another's", async () => {
    stubFetch([{ status: 200, body: FRESH }]);
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useArtifact(descriptor(path), { now: NOW }),
      { initialProps: { path: "t/gw01.json" } },
    );
    await waitFor(() => expect(proven(result.current.retained)?.value).toBe(42));

    // Switching gameweek must not show last week's numbers as this week's.
    stubFetch([{ status: 404 }]);
    rerender({ path: "t/gw02.json" });
    await waitFor(() => expect(result.current.artifact.state).toBe("absent"));
    expect(result.current.retained).toBeNull();
  });
});

describe("initialising distinguishes loading from absent", () => {
  it("is true before the first result and false after", async () => {
    stubFetch([{ status: 404 }]);
    const { result } = renderHook(() =>
      useArtifact(descriptor("t/loading.json"), { now: NOW }),
    );
    // Both are `absent`; only `initialising` separates "still loading" from
    // "genuinely nothing there", which are very different sentences on a screen.
    expect(result.current.initialising).toBe(true);
    await waitFor(() => expect(result.current.initialising).toBe(false));
    expect(result.current.artifact.state).toBe("absent");
  });
});
