"use client";

/**
 * Re-read the board's artifacts when the reader comes back to the tab.
 *
 * ## Why this exists
 *
 * Nothing on this board refetches. `useArtifact` reads once on mount and
 * `useHeuristics` once per `fetchState` coalescing window; the only thing that moves
 * afterwards is the countdown, which owns its own interval and re-renders nothing but
 * itself.
 *
 * That is invisible for the ten days a gameweek spends idle and badly wrong for the one
 * evening that matters. On a deadline night the board is opened early and watched: the
 * clock runs down to "passed" while the squad, the phase chip, the projection and every
 * age beside them stay frozen at whatever was true when the page loaded. FPL begins
 * serving real picks the moment the deadline passes — the transition this app has never
 * executed — and an open tab would go on showing the captured draft with no sign that it
 * had.
 *
 * ## Why visibility rather than a poll
 *
 * A poll spends requests on a screen nobody is looking at, and the artifacts behind this
 * board move on a 15-minute-to-daily cadence, so most polls would fetch a file that had
 * not changed. Returning to the tab is the moment a reader is about to trust what is on
 * it, which is exactly when it should be true.
 *
 * `visibilitychange` rather than `focus`: focus fires when a devtools panel or an address
 * bar hands control back, which is not a reader returning.
 *
 * ## Why the floor
 *
 * Alt-tabbing twice in five seconds is one return, not two. The floor keeps a flurry of
 * switches from becoming a flurry of fetches, and it is deliberately short — a reader who
 * has been away long enough to care has been away longer than this.
 */

import { useEffect, useRef } from "react";

/** Ignore a return that arrives within this of the last one. */
export const RETURN_FLOOR_MS = 5_000;

export function useRefetchOnReturn(
  reload: () => void,
  { floorMs = RETURN_FLOOR_MS }: { floorMs?: number } = {},
): void {
  // A ref, so changing it never itself causes a render, and so the effect below does not
  // re-subscribe every time a reload function is rebuilt.
  const latest = useRef(reload);
  latest.current = reload;
  const lastRun = useRef(0);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRun.current < floorMs) return;
      lastRun.current = now;
      latest.current();
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [floorMs]);
}
