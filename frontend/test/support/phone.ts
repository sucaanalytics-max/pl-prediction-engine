import { vi } from "vitest";

/**
 * Makes `matchMedia("(max-width: 767px)")` answer `matches`, for `useIsPhone`.
 *
 * jsdom has no `matchMedia`, so every page test written before the phone layouts
 * existed runs the desktop branch. A phone test calls this before mounting and
 * `unstubPhone` after.
 */
export function stubPhone(matches = true): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("767px") ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

export function unstubPhone(): void {
  vi.unstubAllGlobals();
}
