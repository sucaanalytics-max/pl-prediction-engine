/**
 * The board is opened early on a deadline night and watched. Nothing on it refetches.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRefetchOnReturn, RETURN_FLOOR_MS } from "@/lib/data/useRefetchOnReturn";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state, configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setVisibility("visible");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("returning to the tab", () => {
  it("re-reads when the reader comes back", () => {
    const reload = vi.fn();
    renderHook(() => useRefetchOnReturn(reload));

    act(() => { setVisibility("hidden"); });
    expect(reload).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the way out, only on the way back", () => {
    const reload = vi.fn();
    renderHook(() => useRefetchOnReturn(reload));
    act(() => { setVisibility("hidden"); });
    expect(reload).not.toHaveBeenCalled();
  });

  it("treats two switches in a moment as one return", () => {
    // Alt-tabbing twice in five seconds is one return, not two.
    const reload = vi.fn();
    renderHook(() => useRefetchOnReturn(reload));
    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    act(() => { setVisibility("hidden"); setVisibility("visible"); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("re-reads again once the floor has passed", () => {
    const reload = vi.fn();
    renderHook(() => useRefetchOnReturn(reload));
    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("calls the latest reload, not the one it mounted with", () => {
    /* The reload functions come from hooks that rebuild them; subscribing to the first
       one would refetch a stale closure for the life of the page. */
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useRefetchOnReturn(fn), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the page unmounts", () => {
    const reload = vi.fn();
    const { unmount } = renderHook(() => useRefetchOnReturn(reload));
    unmount();
    act(() => { vi.advanceTimersByTime(RETURN_FLOOR_MS + 1); setVisibility("visible"); });
    expect(reload).not.toHaveBeenCalled();
  });
});
