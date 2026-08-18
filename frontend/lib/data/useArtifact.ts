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
  const retainedRef = useRef<{ path: string; artifact: Artifact<T> } | null>(null);

  // Kept in a ref so a caller passing an inline options object does not restart
  // the fetch on every render. Only the descriptor path and the nonce should.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const path = descriptor.path;

  useEffect(() => {
    let cancelled = false;
    load(descriptor, optionsRef.current).then((result) => {
      // A resolved fetch for a screen the user has left must not set state.
      if (cancelled) return;
      setArtifact(result);
      setInitialising(false);
      if (proven(result) !== null) {
        retainedRef.current = { path: descriptor.path, artifact: result };
      }
    });
    return () => { cancelled = true; };
    // `descriptor` is a stable module constant; `path` is the honest dependency
    // and using it keeps an inline descriptor from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const retained =
    retainedRef.current && retainedRef.current.path === path
      ? retainedRef.current.artifact
      : null;

  return useMemo(
    () => ({ artifact, retained, initialising, reload }),
    [artifact, retained, initialising, reload],
  );
}
