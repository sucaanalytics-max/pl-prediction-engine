/**
 * How old the stored copies the page is showing are.
 *
 * The service worker stamps every artifact and live-state copy it stores with
 * `x-sw-cached-at`. `load()` reads the stamp off a response and the worker also
 * announces it by message when it answers in place of a dead network; both land
 * here, and `OfflineBanner` reads from here. A module-level store rather than
 * React context because the writers are a plain async function and a worker
 * listener, neither of which is inside a component tree.
 *
 * The store keeps the OLDEST stamp seen since the last time the device was
 * online. "Data as of" has to be true of everything on screen, and a screen
 * built from several artifacts is only as fresh as its stalest one.
 */

type Listener = () => void;

let oldestMs: number | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A valid instant as ISO-8601, or null. Anything else is not a timestamp. */
export function parseCachedAt(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Record that a stored copy stamped `value` is, or was, on screen. */
export function noteCachedAt(value: string | null | undefined): void {
  const iso = parseCachedAt(value);
  if (iso === null) return;
  const ms = Date.parse(iso);
  if (oldestMs !== null && ms >= oldestMs) return;
  oldestMs = ms;
  emit();
}

/** The oldest stamp noted since the last reset, or null when none is known. */
export function getCachedAt(): string | null {
  return oldestMs === null ? null : new Date(oldestMs).toISOString();
}

/** Forget every stamp. Called when the device comes back online. */
export function resetCachedAt(): void {
  if (oldestMs === null) return;
  oldestMs = null;
  emit();
}

export function subscribeCachedAt(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The shape of the worker's announcement, narrowed at runtime (rule 4). */
export function narrowServedCached(
  data: unknown,
): { kind: string; cachedAt: string | null } | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("type" in data) || data.type !== "SW_SERVED_CACHED") return null;
  const kind = "kind" in data && typeof data.kind === "string" ? data.kind : "unknown";
  const cachedAt =
    "cachedAt" in data && typeof data.cachedAt === "string"
      ? parseCachedAt(data.cachedAt)
      : null;
  return { kind, cachedAt };
}
