"use client";

/**
 * Loading registry artifacts from a client component.
 *
 * Replaces `PredictionsContext`, which fetched five files whether or not a page
 * used them and exposed one `loading` and one `error` for all of them — so any
 * single failure blanked every consumer. Rule 2 says each section owns its state,
 * and a shared context cannot express that.
 *
 * Every artifact starts `absent` with a "loading" reason rather than as `null`,
 * so a page never has an `undefined` phase to forget about. There is no separate
 * `loading` boolean for the same reason there is no separate `error` one: the
 * state is on the artifact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classify, proven, type Artifact } from "@/lib/data/artifact";
import { load, type LoadOptions } from "@/lib/data/load";
import type { Descriptor } from "@/lib/data/registry";

/** The pre-fetch value: absent, and saying why. */
function pending<T>(descriptor: Descriptor<T>, now: Date): Artifact<T> {
  return classify<T>({
    path: descriptor.path,
    source: "none",
    raw: undefined,
    narrow: descriptor.narrow,
    now,
    fetchError: "loading",
  });
}

export interface UseArtifactResult<T> {
  /**
   * This fetch's honest result. Never rewritten to look better than it was: if
   * the reload came back `absent`, this says `absent`.
   */
  readonly artifact: Artifact<T>;
  /**
   * The last artifact that carried a value, kept so a later failure does not
   * blank the screen.
   *
   * There are no empty states and no loading ceremony: a section renders the
   * last known answer with its age stated, and a pending or failed refresh
   * changes the age line and nothing else. `ok`, `empty` and `stale` all carry
   * their own value, so this matters for exactly two states — `absent` and
   * `unreadable` — where the payload is gone and the screen would otherwise
   * fall back to a skeleton.
   *
   * Deliberately NOT folded into `artifact`. Returning a retained value under a
   * state of `ok` would make the state lie about the fetch that just happened,
   * and every honest-refusal mechanism in this data layer depends on that state
   * being true. Callers render `proven(artifact) ?? proven(retained)` and take
   * the age from whichever one they used.
   *
   * Null until something has been proven at least once — which is Rule 1's one
   * genuine exception, data that has never been computed at all.
   */
  readonly retained: Artifact<T> | null;
  /**
   * True only during the very first fetch.
   *
   * NOT for a skeleton — Rule 1 forbids one. It exists so a caller can tell
   * "still loading" from "genuinely absent", which are the same `absent` state
   * but very different sentences to put on a screen.
   */
  readonly initialising: boolean;
  readonly reload: () => void;
}

/**
 * Fetches that have started but not finished, keyed by path.
 *
 * Three components on `/` each resolve their own week and each asked for
 * `fpl/xp_public_gw01.json` independently: measured in a production build, that
 * artifact was requested **three times at 53.4KB each**, and `agent_status.json`
 * three times as well — about 107KB of pure duplication per load, before the
 * 377KB `/api/fpl/state` call. `useCurrentGameweek` is itself a `useArtifact`
 * caller, so every surface that resolves a week adds another copy.
 *
 * This is coalescing, NOT a cache. The entry is deleted the moment the fetch
 * settles, so a later mount fetches again and Rule 1's age line stays true. A
 * cache keyed by path would quietly serve a stale payload under a fresh `ok`,
 * which is the one thing this data layer must never do.
 *
 * Callers that pass `now`, `remote` or `signal` opt out and fetch alone: those
 * three change what the result MEANS — the first two shift staleness
 * classification, and a shared fetch that one caller can abort is a fetch the
 * other caller cannot rely on.
 */
const inFlight = new Map<string, Promise<Artifact<unknown>>>();

/**
 * The coalescing key: the descriptor's identity, never its path.
 *
 * Two descriptors can share a path while narrowing it differently, and keying the
 * in-flight map on the path serves one descriptor's narrowed value to the other.
 *
 * The case that proved it is gone with the routes it involved: `REGISTRY.latest`
 * and `matchDetailDescriptor(id)` both read `latest.json`, so a path key handed
 * the navigation's already-narrowed `Latest` to `/matches/[id]` as a
 * `MatchDetail`. Its narrower never ran, every number on the route fell to the
 * error boundary, and because the navigation fetched on every page the route
 * raced itself on load. Two ids collided the same way, serving one match's
 * detail for another's.
 *
 * None of those exist now, and the key stays identity anyway: nothing prevents
 * the collision from returning the next time two descriptors read one file, and
 * the failure it produces is a screenful of wrong numbers rather than an error.
 *
 * The cost is that one file can be fetched twice when two descriptors want it —
 * the behaviour before coalescing existed, and a duplicated fetch is worth
 * incomparably less than a correct payload. Coalescing the raw bytes and
 * narrowing per descriptor would recover it, and needs `load` split into fetch
 * and narrow first.
 */
function identityOf<T>(descriptor: Descriptor<T>): string {
  return descriptor.key;
}

/** Visible only so a test can assert the map does not leak. */
export function inFlightCount(): number {
  return inFlight.size;
}

function shareable(options: LoadOptions): boolean {
  return options.now === undefined
    && options.remote === undefined
    && options.signal === undefined;
}

function loadShared<T>(
  descriptor: Descriptor<T>,
  options: LoadOptions,
  fresh: boolean,
): Promise<Artifact<T>> {
  if (!shareable(options)) return load(descriptor, options);

  // A reload must not be answered by a request that was already in the air, or
  // the button would appear to work while showing the same fetch's result.
  const identity = identityOf(descriptor);

  if (fresh) inFlight.delete(identity);
  else {
    const existing = inFlight.get(identity);
    if (existing) return existing as Promise<Artifact<T>>;
  }

  const started = load(descriptor, options)
    .finally(() => { inFlight.delete(identity); });
  inFlight.set(identity, started as Promise<Artifact<unknown>>);
  return started;
}

export function useArtifact<T>(
  descriptor: Descriptor<T>,
  options: LoadOptions = {},
): UseArtifactResult<T> {
  // Lazy initialiser: `pending` allocates and `new Date()` is a fresh value every
  // render, so passing the result directly would rebuild it on each one.
  const [artifact, setArtifact] = useState<Artifact<T>>(
    () => pending(descriptor, options.now ?? new Date()),
  );
  const [initialising, setInitialising] = useState(true);
  const [nonce, setNonce] = useState(0);

  // A ref, not state: retention must never itself cause a render, and the
  // `setArtifact` beside it already schedules one. Keyed to the descriptor path
  // so switching gameweek does not show the previous week's numbers as this
  // week's — a retained value is only honest for the thing it was fetched for.
  const retainedRef = useRef<{ identity: string; artifact: Artifact<T> } | null>(null);

  // Kept in a ref so a caller passing an inline options object does not restart
  // the fetch on every render. Only the descriptor path and the nonce should.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const path = descriptor.path;
  /**
   * The hook's own identity, for the same reason the map above uses it.
   *
   * The effect used to depend on `path`, with a comment reasoning that `descriptor` is
   * a stable module constant. Factory descriptors are not: `matchDetailDescriptor(id)`
   * is built per render and its path is the constant `latest.json`, so navigating from
   * one match to another never re-ran the effect and the page kept the previous
   * match's narrowed value under the new id. Depending on the key fixes that, and
   * keying retention on it stops a value narrowed for one id being retained for
   * another.
   */
  const identity = descriptor.key;

  /**
   * Whether to fetch at all.
   *
   * Added for one shape that had no honest answer without it: a descriptor built
   * from a value that may not be known yet. `/stats` reads
   * `xp_public_gw{NN}.json` for one of its three tabs, and hooks cannot be called
   * conditionally — so with no resolved gameweek the choice was to fetch week
   * `00`, which 404s on every render forever, or to withhold two tabs that never
   * needed the week at all.
   *
   * Default true, so no existing caller changes behaviour. When false the hook
   * settles immediately into the descriptor's `absent` state with a reason,
   * because "we did not ask" and "we asked and there was nothing" are different
   * facts and only the second one is a statement about the data.
   */
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setInitialising(false);
      return () => {};
    }
    let cancelled = false;
    loadShared(descriptor, optionsRef.current, nonce > 0).then((result) => {
      // A resolved fetch for a screen the user has left must not set state.
      if (cancelled) return;
      setArtifact(result);
      setInitialising(false);
      if (proven(result) !== null) {
        retainedRef.current = { identity, artifact: result };
      }
    });
    return () => { cancelled = true; };
    // Identity AND path: the key is what makes the narrowed value what it is, and the
    // path is included so a registry mistake that moved a file without changing its key
    // still refetches. Neither is `descriptor` itself, which an inline factory rebuilds
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, path, nonce, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const retained =
    retainedRef.current && retainedRef.current.identity === identity
      ? retainedRef.current.artifact
      : null;

  return useMemo(
    () => ({ artifact, retained, initialising, reload }),
    [artifact, retained, initialising, reload],
  );
}
