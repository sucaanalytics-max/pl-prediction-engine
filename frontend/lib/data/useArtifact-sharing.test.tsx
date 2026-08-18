/**
 * One path, one request.
 *
 * Measured in a production build of `/`: `fpl/xp_public_gw01.json` was fetched three
 * times at 53.4KB each and `agent_status.json` three times, because three surfaces
 * each resolved their own week and `useCurrentGameweek` is itself a `useArtifact`
 * caller. That is about 107KB of duplication per load.
 *
 * These tests pass NO options, unlike the retention suite, because passing `now`
 * deliberately opts a caller out of sharing.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proven } from "@/lib/data/artifact";
import type { Descriptor } from "@/lib/data/registry";
import { inFlightCount, useArtifact } from "@/lib/data/useArtifact";
import { matchDetailDescriptor } from "@/lib/data/match-detail";
import { REGISTRY } from "@/lib/data/narrow";

interface Payload { readonly value: number }

function descriptor(path: string): Descriptor<Payload> {
  return {
    key: path, path, owner: "daily", describes: "a number, for a test",
    freshnessBudgetMs: 60_000,
    narrow: (raw) =>
      raw && typeof raw === "object" && typeof (raw as Payload).value === "number"
        ? { ok: true, value: raw as Payload }
        : { ok: false, problems: ["not a payload"] },
    producedAtOf: () => null,
  };
}

/** Resolves on demand, so two hooks can be in flight at the same moment. */
function deferredFetch() {
  const release: Array<() => void> = [];
  const impl = vi.fn().mockImplementation(() => new Promise((resolve) => {
    release.push(() => resolve({
      ok: true, status: 200,
      json: async () => ({ value: 42 }),
      text: async () => JSON.stringify({ value: 42 }),
    }));
  }));
  vi.stubGlobal("fetch", impl);
  return { impl, releaseAll: () => { for (const r of release.splice(0)) r(); } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("in-flight sharing", () => {
  it("makes one request when two components ask for the same path at once", async () => {
    const { impl, releaseAll } = deferredFetch();
    const a = renderHook(() => useArtifact(descriptor("t/shared.json")));
    const b = renderHook(() => useArtifact(descriptor("t/shared.json")));

    expect(impl).toHaveBeenCalledTimes(1);

    await act(async () => { releaseAll(); });
    await waitFor(() => expect(proven(a.result.current.artifact)).not.toBeNull());
    await waitFor(() => expect(proven(b.result.current.artifact)).not.toBeNull());

    // Both got the payload, from the one request.
    expect(proven(a.result.current.artifact)?.value).toBe(42);
    expect(proven(b.result.current.artifact)?.value).toBe(42);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("does not conflate two different paths", async () => {
    const { impl, releaseAll } = deferredFetch();
    renderHook(() => useArtifact(descriptor("t/one.json")));
    renderHook(() => useArtifact(descriptor("t/two.json")));
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });

  it("is coalescing and not a cache: a later mount fetches again", async () => {
    const { impl, releaseAll } = deferredFetch();
    const first = renderHook(() => useArtifact(descriptor("t/again.json")));
    await act(async () => { releaseAll(); });
    await waitFor(() => expect(proven(first.result.current.artifact)).not.toBeNull());

    /* A cache keyed by path would serve the old payload under a fresh `ok`, which
       would make Rule 1's age line a lie. */
    renderHook(() => useArtifact(descriptor("t/again.json")));
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });

  it("answers a reload with a new request, not one already in the air", async () => {
    const { impl, releaseAll } = deferredFetch();
    const hook = renderHook(() => useArtifact(descriptor("t/reload.json")));
    expect(impl).toHaveBeenCalledTimes(1);

    // Reload while the first request is still open: the button must do something.
    await act(async () => { hook.result.current.reload(); });
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });

  it("lets a caller passing `now` fetch alone, because it classifies differently", async () => {
    const { impl, releaseAll } = deferredFetch();
    const now = new Date("2026-08-18T12:00:00Z");
    renderHook(() => useArtifact(descriptor("t/opt-out.json")));
    renderHook(() => useArtifact(descriptor("t/opt-out.json"), { now }));
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });

  it("empties the map once everything settles, so it cannot grow unbounded", async () => {
    const { impl, releaseAll } = deferredFetch();
    const hooks = ["t/a.json", "t/b.json", "t/c.json"]
      .map((p) => renderHook(() => useArtifact(descriptor(p))));
    expect(inFlightCount()).toBe(3);

    await act(async () => { releaseAll(); });
    for (const h of hooks) {
      await waitFor(() => expect(proven(h.result.current.artifact)).not.toBeNull());
    }
    await waitFor(() => expect(inFlightCount()).toBe(0));
    expect(impl).toHaveBeenCalledTimes(3);
  });
});

describe("two descriptors that share a path", () => {
  /**
   * `REGISTRY.latest` and `matchDetailDescriptor(id)` both read `latest.json` with
   * different narrowers. Coalescing on the path handed the navigation's narrowed
   * `Latest` to `/matches/[id]` as a `MatchDetail`, so its narrower never ran and the
   * whole route fell to its error boundary — and the navigation fetches on every page,
   * so the route raced itself on load.
   */
  it("is the real collision: same path, different keys", () => {
    expect(matchDetailDescriptor("ars-che").path).toBe(REGISTRY.latest.path);
    expect(matchDetailDescriptor("ars-che").key).not.toBe(REGISTRY.latest.key);
  });

  it("does not serve one descriptor's narrowed value to the other", async () => {
    const { impl, releaseAll } = deferredFetch();
    const nav = renderHook(() => useArtifact(REGISTRY.latest));
    const page = renderHook(() => useArtifact(matchDetailDescriptor("ars-che")));

    // Two identities, so two fetches. The duplicate byte cost is the price of a
    // correct payload.
    expect(impl).toHaveBeenCalledTimes(2);

    await act(async () => { releaseAll(); });
    /* The collision's actual symptom: both hooks were handed the SAME promise, so both
       held the same Artifact object — one narrowed by `narrowLatest` and handed to the
       consumer expecting a MatchDetail. Two distinct objects is the proof each ran its
       own narrower. */
    expect(nav.result.current.artifact).not.toBe(page.result.current.artifact);
  });

  it("does not serve one match's detail for another's id", async () => {
    const { impl, releaseAll } = deferredFetch();
    renderHook(() => useArtifact(matchDetailDescriptor("ars-che")));
    renderHook(() => useArtifact(matchDetailDescriptor("man-liv")));
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });

  it("still shares when it IS the same descriptor", async () => {
    // The optimisation must survive the fix: two consumers of one descriptor still
    // make one request.
    const { impl, releaseAll } = deferredFetch();
    renderHook(() => useArtifact(REGISTRY.latest));
    renderHook(() => useArtifact(REGISTRY.latest));
    expect(impl).toHaveBeenCalledTimes(1);
    await act(async () => { releaseAll(); });
  });

  it("refetches when the id changes, because identity is the dependency", async () => {
    /* The effect used to depend on the path, which is the constant `latest.json` for
       every match — so navigating from one match to another never re-ran it and the
       page kept the previous match's value under the new id. */
    const { impl, releaseAll } = deferredFetch();
    const hook = renderHook(
      ({ id }: { id: string }) => useArtifact(matchDetailDescriptor(id)),
      { initialProps: { id: "ars-che" } },
    );
    await act(async () => { releaseAll(); });
    expect(impl).toHaveBeenCalledTimes(1);

    await act(async () => { hook.rerender({ id: "man-liv" }); });
    expect(impl).toHaveBeenCalledTimes(2);
    await act(async () => { releaseAll(); });
  });
});
