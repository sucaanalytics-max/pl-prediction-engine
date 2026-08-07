"use client";

/**
 * The player watchlist — element ids the user has starred.
 *
 * ## Why the writes are guarded
 *
 * The read was already inside a `try`, and the write was not. That asymmetry is
 * a crash: `localStorage.setItem` throws on a quota overrun, in Safari's private
 * mode, and anywhere storage is disabled by policy. The star is rendered inside
 * a table row, so the exception propagated out of the click handler and took the
 * whole page down through `ErrorBoundary` — losing the rankings, the season
 * table and everything else, because a preference could not be saved.
 *
 * So a failed write now degrades to "starred for this session". The in-memory
 * state is updated first and unconditionally: the UI must respond to the click
 * whether or not the value survives a reload.
 *
 * `bump()` exists so a page can tell the user the starring is not persisting,
 * rather than letting them discover it after a refresh.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "suca-fpl-watchlist-v1";

/** Reads the stored list, or an empty one. Never throws. */
function readStored(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => Number.isInteger(value));
  } catch {
    // Unavailable, disabled, or corrupt. All three mean "no watchlist".
    return [];
  }
}

/** Persists the list. Returns whether it actually stuck. */
function writeStored(ids: readonly number[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

export interface Watchlist {
  readonly watched: readonly number[];
  readonly toggle: (elementId: number) => void;
  /**
   * True when a write has failed, so starring works but will not survive a
   * reload. Surfaced rather than silent: a preference that silently fails to
   * save is worse than one that says it did not.
   */
  readonly persisted: boolean;
}

export function usePlayerWatchlist(): Watchlist {
  const [watched, setWatched] = useState<number[]>([]);
  const [persisted, setPersisted] = useState(true);

  useEffect(() => {
    setWatched(readStored());
  }, []);

  const toggle = useCallback((elementId: number) => {
    setWatched((current) => {
      const next = current.includes(elementId)
        ? current.filter((value) => value !== elementId)
        : [...current, elementId];
      // Deliberately outside the try: the click must register in the UI even
      // when nothing can be written.
      if (!writeStored(next)) setPersisted(false);
      return next;
    });
  }, []);

  return { watched, toggle, persisted };
}
