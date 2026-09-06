/**
 * The masthead, and the week it is silent about.
 *
 * `planningGameweek` deliberately shows the week you can still ACT on — once a
 * deadline passes it advances — and `lib/data/gameweek.ts` exists because that
 * resolver disagreeing with the page's own once put "GW1" over GW2's
 * projections. None of that changes here.
 *
 * What changes is that a planner opened during a gameweek's matches said nothing
 * about them. On a Sunday with eight of ten GW3 fixtures underway, every surface
 * read GW4 — correct, and no acknowledgement that the eleven you already
 * committed were on the pitch.
 *
 * Stubs the live hook the way `AgentMessages.test.tsx` stubs the artifact layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const PAST = "2026-09-04T17:30:00Z";

/**
 * Built through `classify`, not hand-rolled.
 *
 * An artifact keeps its value under a SYMBOL key, so a stub with a plain
 * `value:` field reads as empty to `proven()` — every assertion about absence
 * then passes for the wrong reason, and the one about presence is the only thing
 * that catches it. This went through that exact loop once.
 */
async function draw(event: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("next/navigation", () => ({ usePathname: () => "/" }));

  const { classify } = await import("@/lib/data/artifact");
  const artifact = classify({
    path: "api/fpl/state",
    source: "local" as const,
    raw: { event, entry: { id: 20945, teamName: "Jay's Team" } },
    narrow: (raw: unknown) => ({ ok: true as const, value: raw as never }),
    producedAtOf: () => null,
    isEmpty: () => false,
    now: new Date("2026-09-06T02:00:00Z"),
  });

  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({ artifact }),
  }));
  const { default: Navigation } = await import("@/components/Navigation");
  return render(<Navigation />);
}

describe("the gameweek being played", () => {
  afterEach(() => {
    cleanup();
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/data/useHeuristics");
  });

  it("names the live gameweek beside the one being planned", async () => {
    await draw({ id: 3, deadlineTime: PAST, phase: "live" });
    const live = screen.getByTestId("masthead-live");
    expect(live.textContent).toMatch(/GW3/);
    expect(live.textContent).toMatch(/live/i);
    // The planning badge still says which week you act on: GW3's deadline has
    // passed, so that is GW4.
    expect(screen.getByText("GW4")).toBeInTheDocument();
  });

  it("shows nothing when no week is being played", async () => {
    await draw({ id: 3, deadlineTime: PAST, phase: "finished" });
    expect(screen.queryByTestId("masthead-live")).toBeNull();
  });

  it("does not infer live from a deadline that has passed", async () => {
    /**
     * The trap worth a test. EVERY finished week has a passed deadline, so
     * inferring "live" from the clock would hang a LIVE badge over a gameweek
     * that ended a month ago. It appears on the route's own `phase` or not at
     * all.
     */
    await draw({ id: 3, deadlineTime: PAST, phase: null });
    expect(screen.queryByTestId("masthead-live")).toBeNull();
  });
});
