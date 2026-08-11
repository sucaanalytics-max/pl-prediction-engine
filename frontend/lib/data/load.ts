/**
 * Fetching a registry artifact and returning it as an {@link Artifact}.
 *
 * One function, driven by the descriptor. Pages never name a path, never call
 * `fetch`, and never see a raw payload — they get the five-state envelope, and the
 * only ways into it are `proven()` and `chartable()`.
 *
 * ## What is preserved from the old loader, and why
 *
 * `predictions.ts` fetched Supabase Storage when `NEXT_PUBLIC_SUPABASE_URL` was
 * set and **fell back to local `/predictions/` on any failure**. CLAUDE.md says to
 * keep that fallback and it is kept here, with one addition: which source won is
 * recorded on `provenance.source`. A local hit during normal operation means the
 * remote is failing silently, and previously nothing said so.
 *
 * ## What is fixed
 *
 * The old path ended in `return await res.json()` inside `fetchWithFallback<T>` —
 * an implicit cast that checks nothing, and the reason `HealthData` drifted to a
 * producer emitting no metrics with no error anywhere. Here the body goes to the
 * descriptor's narrower, and a shape mismatch becomes `unreadable` with every
 * problem named rather than `undefined` flowing into a chart.
 *
 * ## The 404-is-HTML trap
 *
 * Measured against the live deployment: a missing artifact returns **30KB of
 * Next.js 404 HTML, not JSON**. So `res.json()` on a 404 throws a parse error
 * rather than failing cleanly, and a naive `catch` would report a *missing* file as
 * a *corrupt* one. The status is therefore checked before the body is read, and
 * `absent` and `unreadable` stay distinct.
 */

import {
  classify, type Artifact, type ClassifyInput,
} from "@/lib/data/artifact";
import type { Descriptor } from "@/lib/data/registry";

/** Milliseconds before the remote is abandoned for the local copy. */
export const REMOTE_TIMEOUT_MS = 5_000;

export const LOCAL_BASE = "/predictions";

/**
 * Where artifacts are read from.
 *
 * Supabase Storage when configured, local otherwise. Read at call time rather
 * than module scope so a test can vary it.
 */
export function remoteBase(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  return `${url}/storage/v1/object/public/predictions`;
}

type Fetcher = typeof fetch;

export interface LoadOptions {
  readonly now?: Date;
  readonly fetchImpl?: Fetcher;
  /** Overrides the environment. For tests and for the local-only build. */
  readonly remote?: string | null;
  readonly signal?: AbortSignal;
}

interface Fetched {
  readonly raw: unknown;
  readonly source: "supabase" | "local" | "none";
  readonly error: string | null;
}

/**
 * One request. Returns the parsed body, or an error, never throws.
 *
 * `format` decides how the body is read: JSON goes through `res.json()`, JSONL is
 * read as **text** because `res.json()` throws on its second line. Getting that
 * wrong turns a working feed into `unreadable`.
 */
async function attempt(
  url: string,
  format: "json" | "jsonl",
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<{ raw: unknown; error: string | null }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store", signal });
  } catch (error) {
    return { raw: undefined, error: describeError(error) };
  }

  // Status first. A 404 here serves 30KB of HTML, and reading the body before
  // checking would report a missing file as a corrupt one.
  if (response.status === 404) {
    return { raw: undefined, error: null };
  }
  if (!response.ok) {
    return { raw: undefined, error: `HTTP ${response.status}` };
  }

  try {
    const raw = format === "jsonl" ? await response.text() : await response.json();
    return { raw, error: null };
  } catch (error) {
    return { raw: undefined, error: `unparseable body: ${describeError(error)}` };
  }
}

async function fetchArtifact(
  path: string,
  format: "json" | "jsonl",
  options: LoadOptions,
): Promise<Fetched> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const remote = options.remote === undefined ? remoteBase() : options.remote;

  if (remote) {
    // A hung remote must not hold the page. The timeout is per attempt, so a slow
    // Supabase still leaves the local copy reachable.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const { raw, error } = await attempt(
        `${remote}/${path}`, format, fetchImpl, controller.signal,
      );
      if (error === null && raw !== undefined) {
        return { raw, source: "supabase", error: null };
      }
      // A 404 upstream still falls through to local: the remote may simply not
      // have this artifact yet, and the committed copy is a real answer.
    } finally {
      clearTimeout(timer);
    }
  }

  const { raw, error } = await attempt(
    `${LOCAL_BASE}/${path}`, format, fetchImpl, options.signal,
  );
  if (raw === undefined) {
    return { raw: undefined, source: "none", error };
  }
  return { raw, source: "local", error: null };
}

/**
 * Load one registered artifact.
 *
 * Never throws and never rejects. Every failure mode is a state on the returned
 * artifact, because a page that has to try/catch its data is a page that will
 * eventually render a caught error as a blank section.
 */
export async function load<T>(
  descriptor: Descriptor<T>,
  options: LoadOptions = {},
): Promise<Artifact<T>> {
  const now = options.now ?? new Date();
  const { raw, source, error } = await fetchArtifact(
    descriptor.path, descriptor.format ?? "json", options,
  );

  const input: ClassifyInput<T> = {
    path: descriptor.path,
    source,
    raw,
    narrow: descriptor.narrow,
    producedAtOf: descriptor.producedAtOf,
    producerVersionOf: descriptor.producerVersionOf,
    isEmpty: descriptor.isEmpty,
    freshnessBudgetMs: descriptor.freshnessBudgetMs,
    now,
    fetchError: error,
  };
  return classify<T>(input);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // An aborted request is a timeout, and saying so is more useful than
    // "AbortError" in a state card a human reads.
    if (error.name === "AbortError") {
      return `no response within ${REMOTE_TIMEOUT_MS / 1000}s`;
    }
    return error.message;
  }
  return String(error);
}
