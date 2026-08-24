/**
 * Stats — page level.
 *
 * The tab manifest's invariants are covered in `lib/projections/stat-tabs.test.ts`.
 * What is page-level here is the honesty the screen was built for: a tab nothing
 * can fill is struck through and DISABLED rather than absent, the ownership filter
 * actually partitions, and a withheld figure renders as ∅ rather than as a zero.
 *
 * That last one is the assertion worth having. A zero in a per-90 column is a
 * claim about a player; a ∅ is a claim about the data. They look similar and mean
 * opposite things.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function statRow(id: number, over: Record<string, unknown> = {}) {
  return {
    elementId: id, name: `P${id}`, team: "LIV", position: "MID",
    minutes: 180, goals: 2, assists: 1, xg: 1.4, xa: 0.6,
    fouls_committed: null, fouls_per_90: null, fpl_ownership: 12.5,
    fpl_price: 7.5, form: 4.2, available: true, status: "a",
    chanceOfPlaying: null, ratesAreMeaningful: true,
    ...over,
  };
}

async function mountStats({
  gameweek = 7 as number | null,
  stats = [statRow(1), statRow(2)] as unknown[] | null,
  squad = [{ elementId: 1 }] as unknown[],
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
    useHeuristics: () => ok({ squad: { players: squad } }),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) => {
      const key = String(d?.key ?? "");
      if (key === "agentStatus") {
        return ok(gameweek === null ? null : { gameweek });
      }
      if (key === "playerStats") return ok(stats);
      return ok(null);
    },
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/stats/page");
  return render(<Page />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("the table", () => {
  it("renders the season tab from the published stats", async () => {
    await mountStats();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Stats");
    expect(screen.getAllByTestId("stats-row")).toHaveLength(2);
    expect(screen.getByTestId("stats-count").textContent).toBe("2 players");
  });

  it("partitions on ownership, which is the question the page was asked", async () => {
    await mountStats();
    // P1 is in the squad and P2 is not, so the two filters must be complements.
    fireEvent.click(screen.getByRole("button", { name: "my squad" }));
    expect(screen.getAllByTestId("stats-row")).toHaveLength(1);
    expect(screen.getByTestId("stats-row").textContent).toContain("P1");

    fireEvent.click(screen.getByRole("button", { name: "not owned" }));
    expect(screen.getAllByTestId("stats-row")).toHaveLength(1);
    expect(screen.getByTestId("stats-row").textContent).toContain("P2");
  });

  it("switches tab, and the columns change with it", async () => {
    await mountStats();
    expect(screen.getByText("Form")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expected" }));
    // The Expected tab reads xp_public, which this fixture does not publish, so
    // the tab must state the absence rather than show the season columns again.
    expect(screen.queryByText("Form")).not.toBeInTheDocument();
    expect(screen.getByText("nothing is published at this path")).toBeInTheDocument();
  });
});

describe("a tab nothing can fill", () => {
  it("is struck through and disabled, not hidden", async () => {
    // Hidden tells the reader nothing. Struck through tells them the column
    // exists in the game, is not in this app, and why.
    await mountStats();
    const defending = screen.getByRole("button", { name: "Defending" });
    expect(defending).toBeDisabled();
    expect(defending.style.textDecoration).toBe("line-through");
  });

  it("says what feed is missing, in exactly one place", async () => {
    await mountStats();
    /* Exactly one. The claim was briefly rendered twice — the table's footer and
       a page-level list below it — and this assertion was loosened to
       `getAllByText(...).length > 0` to tolerate that. Tolerating it is the wrong
       fix: two copies of a sentence drift, and a reader who finds the second one
       after the first has learned nothing. The page-level list went; the footer
       stayed, because it sits directly under the struck-through tab that raises
       the question. */
    expect(screen.getAllByText(/does not carry\s+them into an artifact yet/i))
      .toHaveLength(1);
  });

  it("names every blocked tab, so none is quietly dropped", async () => {
    await mountStats();
    for (const label of ["Defending", "Set pieces", "Market"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });
});

describe("withheld is not zero", () => {
  it("renders ∅ for a rate the producer refused to compute", async () => {
    // `ratesAreMeaningful` false is the producer saying the per-90 is an artefact
    // of its denominator floor. A 0.00 in that column would be a measurement.
    await mountStats({ stats: [statRow(1, { minutes: 8, ratesAreMeaningful: false })] });
    expect(screen.getByTestId("stats-row").textContent).toContain("∅");
    expect(screen.getByTestId("stats-row").textContent).not.toContain("0.00");
  });

  it("explains the mark rather than leaving it as a glyph", async () => {
    await mountStats();
    expect(screen.getByText(/withheld, not zero/i)).toBeInTheDocument();
  });
});

describe("the page states its own absence", () => {
  it("gives the artifact's reason when the stats file is not published", async () => {
    await mountStats({ stats: null });
    expect(screen.getByText("nothing is published at this path")).toBeInTheDocument();
  });

  it("blocks only the tab that needs a gameweek, not the whole table", async () => {
    /**
     * The two tabs that do not read a weekly file keep working. Season reads
     * `player_stats.json` and Shots reads `player_events.json`; neither is keyed
     * by week, and this page used to withhold both over a number they never use.
     * Expected is the tab that reads `xp_public_gw{NN}.json`, so Expected is the
     * tab that goes dark — and it says why on itself rather than in a line that
     * replaced the screen.
     */
    await mountStats({ gameweek: null });
    expect(screen.getAllByTestId("stats-row").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Expected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Season" })).not.toBeDisabled();
    // And the reader still learns what the screen cannot answer at all.
    expect(screen.getByRole("button", { name: "Defending" })).toBeDisabled();
  });
});
