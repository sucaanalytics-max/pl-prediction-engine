/**
 * The phone breakpoint, and the two small things every phone screen needs.
 *
 * ## Why a hook and not CSS alone
 *
 * `/players` mounts a 609-row grid and a 581-row table. Rendering a phone list
 * beside them and hiding one with `display: none` would put all three in the DOM
 * on every viewport. A media query read in JS mounts exactly one.
 *
 * The server snapshot is `false` (desktop), so the static HTML and the first
 * client render agree; the phone layout takes over right after hydration. Where
 * `matchMedia` does not exist (jsdom, very old webviews) the answer is also
 * `false`, which is the layout every existing test was written against.
 */

import { useSyncExternalStore } from "react";

/** Same edge as `globals.css`'s `max-width: 767px` blocks. */
export const PHONE_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * `23 Oct, 19:46 UTC`, or null when there is no usable timestamp.
 *
 * UTC and labelled as such, because a source line that says when a file was
 * produced must not depend on the reader's timezone. Null rather than a made-up
 * time: the caller says "time unstated", which is a fact, where `Invalid Date`
 * is not.
 */
export function utcStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hh}:${mm} UTC`;
}
