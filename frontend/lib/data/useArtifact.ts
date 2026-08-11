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
import { classify, type Artifact } from "@/lib/data/artifact";
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
  readonly artifact: Artifact<T>;
  /** True only during the very first fetch, for a skeleton. */
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
    });
    return () => { cancelled = true; };
    // `descriptor` is a stable module constant; `path` is the honest dependency
    // and using it keeps an inline descriptor from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(
    () => ({ artifact, initialising, reload }),
    [artifact, initialising, reload],
  );
}
