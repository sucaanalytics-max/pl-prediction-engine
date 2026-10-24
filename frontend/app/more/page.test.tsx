import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INSTALL_SHEET_EVENT } from "@/components/PwaManager";

/**
 * Artifacts are served from a fixture through `useArtifact` and `useHeuristics`,
 * with provenance shaped like the real thing; the page's job is to print what the
 * provenance says and nothing else.
 */
function art(producedAt: string | null, over: Record<string, unknown> = {}) {
  return {
    artifact: {
      state: "ok",
      provenance: { producedAt, ageMs: 1000, freshnessBudgetMs: 100_000, ...over },
      reason: null,
    },
  };
}

async function mount(map: Record<string, ReturnType<typeof art>>, live = art("2026-10-24T06:23:00Z")) {
  vi.resetModules();
  vi.doMock("next/navigation", () => ({ usePathname: () => "/more" }));
  vi.doMock("@/lib/data/useHeuristics", () => ({ useHeuristics: () => live }));
  vi.doMock("@/lib/data/gameweek", async (orig) => ({
    ...(await orig<typeof import("@/lib/data/gameweek")>()),
    useCurrentGameweek: () => 9,
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key: string }) => map[d.key] ?? art(null, { ageMs: null }),
  }));
  const { default: Page } = await import("@/app/more/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("next/navigation");
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/gameweek");
  vi.doUnmock("@/lib/data/useArtifact");
});

describe("/more", () => {
  it("lists the three record screens with a line each and the right hrefs", async () => {
    await mount({});
    const record = screen.getByRole("region", { name: "Record" });
    const links = within(record).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/capture", "/evidence", "/review"]);
    expect(links[0].textContent).toContain("Record the squad you actually submitted");
  });

  it("prints each artifact's own producedAt in UTC, and names the week from the resolver", async () => {
    await mount({
      agentStatus: art("2026-10-24T05:50:00Z"),
      "decision:09": art("2026-10-23T19:50:00Z"),
      "projections:09": art("2026-10-23T19:46:00Z"),
    });
    const text = screen.getByRole("region", { name: "Data freshness" }).textContent ?? "";
    expect(text).toContain("times in UTC");
    expect(text).toContain("FPL live state");
    expect(text).toContain("24 Oct, 06:23");
    expect(text).toContain("GW9 decision");
    expect(text).toContain("23 Oct, 19:50");
    expect(text).toContain("GW9 projections");
    expect(text).toContain("24 Oct, 05:50");
  });

  it("never substitutes a fetch time for a missing producedAt, and says so in words", async () => {
    await mount({ playerStats: art(null, { ageMs: null }) });
    const rows = screen.getAllByTestId("freshness-row");
    const stats = rows.find((r) => r.textContent?.includes("Player stats"))!;
    expect(stats.textContent).toContain("no timestamp");
    expect(stats.getAttribute("data-state")).toBe("unstamped");
  });

  it("marks an aged artifact in words, not only in colour", async () => {
    await mount({ playerStats: art("2026-10-23T10:41:00Z", { ageMs: 80_000 }) });
    const stats = screen.getAllByTestId("freshness-row").find((r) => r.textContent?.includes("Player stats"))!;
    expect(stats.getAttribute("data-state")).toBe("ageing");
    expect(stats.textContent).toContain("ageing");
  });

  it("asks PwaManager for the install sheet when Add to home screen is tapped", async () => {
    await mount({});
    const heard = vi.fn();
    window.addEventListener(INSTALL_SHEET_EVENT, heard);
    fireEvent.click(screen.getByRole("button", { name: /Add to home screen/ }));
    window.removeEventListener(INSTALL_SHEET_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
