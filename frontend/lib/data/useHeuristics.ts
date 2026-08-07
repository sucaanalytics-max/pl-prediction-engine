"use client";

/**
 * Loading the heuristic engine's output from `/api/fpl/state`.
 *
 * ## Why not `FplLiveContext`
 *
 * The context fetched on mount for every page in the tree whether or not the
 * page used it, exposed one `loading` and one `error` for all consumers, and
 * cast the response with `res.json() as FplLiveResponse`. That is Rule 2 and
 * Rule 4 broken together: a single failure blanks unrelated sections, and the
 * cast is how a shape change becomes a blank page instead of a message.
 *
 * This hook is the {@link useArtifact} shape for a route that is an API call
 * rather than a published file, so a page can hold pipeline artifacts and live
 * heuristics in one envelope and render each section's own state.
 *
 * The route is deliberately *not* in the registry: the registry's paths are
 * published artifacts, and `test/paths.test.ts` asserts every one of them is
 * actually written by a workflow. `/api/fpl/state` is computed per request and
 * has no publisher, so listing it there would make that test lie.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classify, type Artifact } from "@/lib/data/artifact";
import {
  heuristicsAreEmpty, narrowHeuristics, type HeuristicView,
} from "@/lib/data/heuristics";

const PATH = "/api/fpl/state";

/**
 * How old the live state may be before it is stale.
 *
 * The route refreshes on a 15-minute cadence, so 30 minutes means "two refreshes
 * have been missed" rather than "it is a little old" — the same budget the old
 * context used, kept so behaviour does not change silently with the plumbing.
 */
const FRESHNESS_BUDGET_MS = 30 * 60 * 1000;

function build(
  raw: unknown, now: Date, fetchError: string | null,
): Artifact<HeuristicView> {
  return classify<HeuristicView>({
    path: PATH,
    source: raw === undefined || raw === null ? "none" : "local",
    raw,
    narrow: narrowHeuristics,
    producedAtOf: (view) => view.generatedAt,
    producerVersionOf: (view) => view.modelVersion,
    isEmpty: heuristicsAreEmpty,
    freshnessBudgetMs: FRESHNESS_BUDGET_MS,
    now,
    fetchError,
  });
}

export interface UseHeuristicsResult {
  readonly artifact: Artifact<HeuristicView>;
  readonly initialising: boolean;
  readonly reload: () => void;
}

export function useHeuristics(now?: Date): UseHeuristicsResult {
  const [artifact, setArtifact] = useState<Artifact<HeuristicView>>(
    () => build(undefined, now ?? new Date(), "loading"),
  );
  const [initialising, setInitialising] = useState(true);
  const [nonce, setNonce] = useState(0);

  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const at = () => nowRef.current ?? new Date();
      try {
        const response = await fetch(PATH, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const payload: unknown = await response.json();

        // The route wraps success as `{ data }` and failure as `{ error }`.
        // Both are 200-shaped JSON, so `response.ok` alone does not tell them
        // apart — an unwrapped body is a contract break, not a payload.
        const data =
          typeof payload === "object" && payload !== null && "data" in payload
            ? (payload as { data: unknown }).data
            : undefined;

        if (cancelled) return;

        if (data === undefined) {
          const message =
            typeof payload === "object" && payload !== null && "error" in payload
              ? String((payload as { error: unknown }).error)
              : `the route returned ${response.status} with no data`;
          setArtifact(build(undefined, at(), message));
        } else {
          setArtifact(build(data, at(), null));
        }
      } catch (caught) {
        if (cancelled) return;
        setArtifact(
          build(
            undefined, at(),
            caught instanceof Error ? caught.message : "the request failed",
          ),
        );
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();

    return () => { cancelled = true; };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(
    () => ({ artifact, initialising, reload }),
    [artifact, initialising, reload],
  );
}
