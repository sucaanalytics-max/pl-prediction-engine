"use client";

/**
 * Rule 1, as one expression every section on this screen writes.
 *
 * > There are no empty states and no loading ceremony. The screen always shows the
 * > last known answer for every team, with its age stated plainly.
 *
 * `useArtifact` returns two things for exactly this: `artifact`, which reports
 * this fetch honestly, and `retained`, the last artifact that carried a value. The
 * caller renders `proven(artifact) ?? proven(retained)` and **takes the age from
 * whichever one it used**. Getting the second half wrong is the whole risk — a
 * retained value shown with the fresh fetch's age is a stale figure wearing a
 * current timestamp, which is worse than either honest option.
 *
 * So this returns the value and its age together, from the same artifact, and
 * nothing on the screen has to remember to pair them.
 *
 * `initialising` travels with them because "still loading" and "genuinely absent"
 * are the same `absent` state and very different sentences: one is a fetch in
 * flight, the other is a file no workflow has ever written. Neither gets a
 * skeleton; only the second gets a sentence.
 */

import { isStale, proven, type Artifact } from "@/lib/data/artifact";
import { ageLine } from "@/lib/formats";

/**
 * What both loaders return, structurally.
 *
 * `useArtifact` carries `retained`; `useHeuristics` — the same envelope over an
 * API route rather than a published file — does not, because the route is computed
 * per request and there is no last-good copy to hold. Optional here so one
 * expression serves both rather than the page branching on which loader it used.
 */
export interface Loaded<T> {
  readonly artifact: Artifact<T>;
  readonly retained?: Artifact<T> | null;
  readonly initialising: boolean;
}

export interface Read<T> {
  /** The last known answer, or null when nothing has ever been proven. */
  readonly value: T | null;
  /** `6h old` / `as at Tue 06:30`, from the artifact the value came from. */
  readonly age: string | null;
  /** True while the first fetch is in flight and nothing has been proven yet. */
  readonly initialising: boolean;
  /** Past its freshness budget. Age sits BESIDE the figure; it never dims it. */
  readonly stale: boolean;
  /** The registry path, for a sub-line that names what was not written. */
  readonly path: string;
}

export function read<T>(
  result: Loaded<T>,
  producedAtOf: (value: T) => string | null | undefined,
  now?: Date,
): Read<T> {
  const fresh = proven(result.artifact);
  const source: Artifact<T> | null = fresh !== null
    ? result.artifact
    : result.retained ?? null;
  const value = fresh ?? proven(result.retained);

  return {
    value,
    // The writer's own timestamp in preference to the read time: `producedAt` is
    // what the reader can check against a fixture list or a cron.
    age: value === null
      ? null
      : ageLine(producedAtOf(value) ?? source?.provenance.producedAt, now),
    initialising: result.initialising && value === null,
    stale: source === null ? false : isStale(source),
    path: result.artifact.provenance.path,
  };
}
