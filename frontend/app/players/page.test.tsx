/**
 * Projections — who scores most over the next few gameweeks.
 *
 * ## What used to be here
 *
 * 763 lines covering three panels: a "Projections" table, a "Ranked players"
 * list that duplicated the transfer shortlist, and a "Season statistics" table
 * built on `player_stats.json`'s per-90 trap (`xg_per_90 = xg / max(minutes / 90,
 * 0.1)`, which reads a 0-minute player as `xg * 10`). All three are gone: this
 * page now mounts the projection grid over `ResearchView`, which carries its own
 * coverage from where it lived until now — `app/margin/page.test.tsx`, and the
 * grid's arithmetic is covered in `lib/projections/grid.test.ts`. What is left to
 * check here is page-level: that both consumers actually mount once the gameweek
 * resolves, and that the page states its own absence in one line, not a panel,
 * when the gameweek cannot be resolved — the same rule every surface built on
 * `useCurrentGameweek` has to follow, since a guessed gameweek here would
 * silently point both of them at the wrong `xp_public` file.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function projection(id: number, over: Record<string, unknown> = {}) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", position: "MID",
    xp: 6.4, xpSd: 3.7, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.5, pGe10: 0.15,
    q10: 1, q25: 2, q50: 6, q75: 9, q90: 13, nFixtures: 1,
    decomposition: null, blank: false,
    ...over,
  };
}

const PROJECTIONS_FILE = { players: [projection(1)], horizon: null, nDraws: 10000 };

/**
 * Mounts the page with `useCurrentGameweek`'s two sources under direct control,
 * the same pattern `app/page.test.tsx` uses for the same resolver. Faking the
 * fetch layer instead would mean fabricating a raw `agent_status.json` shape this
 * suite does not otherwise care about.
 */
async function mountPlayers({
  agentGameweek = 7 as number | null,
  projections = PROJECTIONS_FILE as typeof PROJECTIONS_FILE | null,
} = {}) {
  vi.resetModules();
  const ok = (value: unknown) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { source: "local", producedAt: null, ageMs: null },
      reason: value === null ? "nothing is published at this path" : null,
      value,
    },
  });
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ok(null),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) => {
      const key = String(d?.key ?? "");
      if (key === "agentStatus") {
        return ok(agentGameweek === null ? null : { gameweek: agentGameweek });
      }
      if (key.startsWith("projections")) return ok(projections);
      // playerStats and anything else ResearchView reads: absent, which is Rule
      // 2 — it must cost the section that needs it, not the whole page.
      return ok(null);
    },
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/players/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("the page mounts the grid and ResearchView", () => {
  it("renders the heading and the researched player once the gameweek resolves", async () => {
    await mountPlayers();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Projections");
    // ResearchView shows the selected player a second time in its detail panel,
    // so the row and the panel both say "P1" — asserting there is at least one
    // is the page-mount claim; ResearchView's own suite covers the rest.
    expect((await screen.findAllByText("P1")).length).toBeGreaterThan(0);
  });

  it("passes the resolved gameweek through, not a guessed one", async () => {
    await mountPlayers({ agentGameweek: 7 });
    // Both consumers label with the gameweek they were given — ResearchView its
    // artifact chip, the grid its single column — so more than one match here is
    // the propagation itself rather than a loose assertion.
    expect((await screen.findAllByText("GW7")).length).toBeGreaterThan(0);
  });

  it("draws the grid, with the span control and its provenance line", async () => {
    await mountPlayers();
    expect(screen.getByTestId("grid-summary").textContent)
      .toContain("GW7 on 10,000 draws");
    expect(screen.getByLabelText("Total the next 4 gameweeks")).toBeInTheDocument();
    expect(screen.getAllByTestId("grid-row")).toHaveLength(1);
  });

  it("offers no span the published horizon cannot cover", async () => {
    // This fixture solved no horizon, so only the current week exists. A span of
    // four would total three weeks that were never published.
    await mountPlayers();
    expect(screen.getByLabelText("Total the next 4 gameweeks")).toBeDisabled();
  });

  it("says the horizon is absent rather than drawing eight empty columns", async () => {
    await mountPlayers();
    expect(screen.getByText(/solved no horizon/i)).toBeInTheDocument();
  });
});

describe("the gameweek states its own absence", () => {
  it("is one line, not a panel, when neither source can name a week", async () => {
    await mountPlayers({ agentGameweek: null });
    expect(screen.getByText(/gameweek is unknown/i)).toBeInTheDocument();
  });

  it("does not attempt to render ResearchView while the gameweek is unresolved", async () => {
    await mountPlayers({ agentGameweek: null });
    expect(screen.queryByTestId("margin-research")).not.toBeInTheDocument();
  });
});
