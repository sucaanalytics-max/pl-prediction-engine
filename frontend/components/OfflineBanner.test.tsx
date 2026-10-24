import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfflineBanner, { formatClock, NOTICE_TTL_MS } from "@/components/OfflineBanner";
import { noteCachedAt, resetCachedAt } from "@/lib/sw-cache-age";

const STAMP = "2026-10-24T14:05:00.000Z";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

const region = () => screen.getByTestId("offline-banner");

beforeEach(() => { setOnline(true); resetCachedAt(); });
afterEach(() => { vi.useRealTimers(); setOnline(true); act(() => resetCachedAt()); });

describe("OfflineBanner", () => {
  it("renders an empty polite live region while online", () => {
    render(<OfflineBanner />);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toBeEmptyDOMElement();
  });

  it("says only Offline when no cached time is known", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(region()).toHaveTextContent(/^Offline$/);
  });

  it("gives the time the stored data is as of", () => {
    setOnline(false);
    noteCachedAt(STAMP);
    render(<OfflineBanner />);
    expect(region()).toHaveTextContent(`Offline · showing data as of ${formatClock(STAMP)}`);
  });

  it("reacts to the offline and online events, and drops stale stamps on recovery", () => {
    noteCachedAt(STAMP);
    render(<OfflineBanner />);
    expect(region()).toBeEmptyDOMElement();

    act(() => { setOnline(false); window.dispatchEvent(new Event("offline")); });
    expect(region()).toHaveTextContent("Offline · showing data as of");

    act(() => { setOnline(true); window.dispatchEvent(new Event("online")); });
    expect(region()).toBeEmptyDOMElement();

    act(() => { setOnline(false); window.dispatchEvent(new Event("offline")); });
    expect(region()).toHaveTextContent(/^Offline$/);
  });

  it("shows the oldest stamp when more than one is noted", () => {
    setOnline(false);
    noteCachedAt("2026-10-24T16:00:00.000Z");
    noteCachedAt(STAMP);
    render(<OfflineBanner />);
    expect(region()).toHaveTextContent(formatClock(STAMP));
  });

  it("updates when a stamp arrives while already offline", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(region()).toHaveTextContent(/^Offline$/);
    act(() => noteCachedAt(STAMP));
    expect(region()).toHaveTextContent(formatClock(STAMP));
  });

  it("never claims the data is live: every state names offline or lost connection", () => {
    setOnline(false);
    noteCachedAt(STAMP);
    render(<OfflineBanner />);
    expect(region().textContent).not.toMatch(/live/i);
  });

  it("shows a worker notice while the browser still thinks it is online, then lapses", () => {
    vi.useFakeTimers();
    const listeners = new Set<(e: MessageEvent) => void>();
    const container = {
      addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
    };
    Object.defineProperty(window.navigator, "serviceWorker", { value: container, configurable: true });
    try {
      render(<OfflineBanner />);
      act(() => {
        for (const fn of listeners) {
          fn(new MessageEvent("message", { data: { type: "SW_SERVED_CACHED", kind: "live", cachedAt: STAMP } }));
        }
      });
      expect(region()).toHaveTextContent(`Connection lost · showing data as of ${formatClock(STAMP)}`);
      act(() => { vi.advanceTimersByTime(NOTICE_TTL_MS + 1); });
      expect(region()).toBeEmptyDOMElement();
    } finally {
      // @ts-expect-error restoring the jsdom default, which has no serviceWorker
      delete window.navigator.serviceWorker;
    }
  });

  it("ignores messages that are not the worker's announcement", () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    Object.defineProperty(window.navigator, "serviceWorker", {
      value: {
        addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
      },
      configurable: true,
    });
    try {
      render(<OfflineBanner />);
      act(() => {
        for (const fn of listeners) {
          fn(new MessageEvent("message", { data: { type: "something-else" } }));
          fn(new MessageEvent("message", { data: null }));
        }
      });
      expect(region()).toBeEmptyDOMElement();
    } finally {
      // @ts-expect-error restoring the jsdom default
      delete window.navigator.serviceWorker;
    }
  });
});

describe("OfflineBanner, as drawn", () => {
  it("adds the second line only when there is a time for it to be true about", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(region()).toHaveTextContent(/^Offline$/);
    act(() => noteCachedAt(STAMP));
    expect(region()).toHaveTextContent("Nothing below has refreshed since then");
  });

  it("sits on the warm band", () => {
    setOnline(false);
    act(() => noteCachedAt(STAMP));
    render(<OfflineBanner />);
    const band = region().firstElementChild as HTMLElement;
    expect(band.style.background).toBe("var(--warm)");
  });
});
