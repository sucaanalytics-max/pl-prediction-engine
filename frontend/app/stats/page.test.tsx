/**
 * Stats — page level.
 *
 * The manifest's invariants live in `lib/projections/stat-questions.test.ts` and
 * the derivations in `stat-coverage.test.ts`. What is page level here is the
 * honesty the screen was built for: a question's bands each state how much
 * football they have seen, the ownership filter actually partitions, and a
 * withheld figure renders as ∅ rather than as a zero.
 *
 * That last one is the assertion worth having. A zero in a per-90 column is a
 * claim about a player; a ∅ is a claim about the data. They look similar and mean
 * opposite things — and since the sheet went to bands, the same distinction
 * applies to a COVERAGE nobody published.
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
  /** Understat's own age, in days. Its budget is two. */
  eventsAgeDays = 0,
  events = null as unknown,
  projections = null as unknown,
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
      if (key.startsWith("projections:")) return ok(projections);
      if (key === "playerEvents") {
        const ms = eventsAgeDays * 24 * 60 * 60 * 1000;
        return {
          artifact: {
            state: "ok",
            provenance: {
              source: "local",
              producedAt: new Date(Date.now() - ms).toISOString(),
              ageMs: ms,
              freshnessBudgetMs: 2 * 24 * 60 * 60 * 1000,
            },
            reason: null,
            value: events ?? { players: [], coverage: {}, notAvailable: [] },
          },
        };
      }
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
  it("renders the opening question from the published stats", async () => {
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

  it("switches question, and the columns change with it", async () => {
    await mountStats();
    // "Is he playing?" carries minutes and no finishing column.
    expect(screen.queryByText("G − xG")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Is he finishing?" }));
    expect(screen.getByText("G − xG")).toBeInTheDocument();
  });

  it("sorts a column the other way when its header is clicked again", async () => {
    // Descending is only half a sheet. Re-clicking the live column used to set
    // the identical sortKey, which React bails out of, so the order never moved.
    await mountStats({
      stats: [statRow(1, { minutes: 90 }), statRow(2, { minutes: 180 })],
    });
    const names = () =>
      screen.getAllByTestId("stats-row").map((row) => row.textContent?.slice(0, 2));

    const mins = screen.getAllByRole("button", { name: /Mins/ })[0];
    fireEvent.click(mins);
    expect(names()).toEqual(["P2", "P1"]);

    fireEvent.click(mins);
    expect(names()).toEqual(["P1", "P2"]);

    fireEvent.click(mins);
    expect(names()).toEqual(["P2", "P1"]);
  });

  it("opens a column at its useful end, not always descending", async () => {
    // `±` is spread: less of it is better, so its first click must put the
    // steadiest player on top. Every other measured column's good end is high.
    await mountStats({
      stats: [statRow(1, { minutes: 90 }), statRow(2, { minutes: 180 })],
      projections: {
        players: [
          { elementId: 1, name: "P1", team: "LIV", position: "MID", xp: 4, xpSd: 3.5, pGe10: 0.1 },
          { elementId: 2, name: "P2", team: "LIV", position: "MID", xp: 4, xpSd: 1.2, pGe10: 0.1 },
        ],
      },
    });
    const names = () =>
      screen.getAllByTestId("stats-row").map((row) => row.textContent?.slice(0, 2));

    const mins = screen.getAllByRole("button", { name: /Mins/ })[0];
    fireEvent.click(mins);
    expect(mins.getAttribute("aria-label")).toContain("highest first");

    fireEvent.click(screen.getByRole("button", { name: "Is he priced right?" }));
    const spread = screen.getByRole("button", { name: /±/ });
    fireEvent.click(spread);
    // P2 is the steadier of the two, so the low end opens on top.
    expect(spread.getAttribute("aria-label")).toContain("lowest first");
    expect(names()).toEqual(["P2", "P1"]);

    fireEvent.click(spread);
    expect(spread.getAttribute("aria-label")).toContain("highest first");
    expect(names()).toEqual(["P1", "P2"]);
  });

  it("keeps an unmeasured figure at the bottom in both directions", async () => {
    // ∅ is "nobody measured this", not a small number. Floating it to the top
    // on an ascending sort would fill the sheet's first rows with blanks.
    await mountStats({
      stats: [
        statRow(1, { minutes: 90 }),
        statRow(2, { minutes: 180 }),
        statRow(3, { minutes: null }),
      ],
    });
    const names = () =>
      screen.getAllByTestId("stats-row").map((row) => row.textContent?.slice(0, 2));

    const mins = screen.getAllByRole("button", { name: /Mins/ })[0];
    fireEvent.click(mins);
    expect(names()).toEqual(["P2", "P1", "P3"]);

    fireEvent.click(mins);
    expect(names()).toEqual(["P1", "P2", "P3"]);
  });

  it("keeps a derived column inside the band both its halves come from", async () => {
    // P1 has 2 goals against 1.4 xG, both FPL's own. The sheet may state the
    // difference because one denominator produced both.
    await mountStats();
    fireEvent.click(screen.getByRole("button", { name: "Is he finishing?" }));
    expect(screen.getAllByTestId("stats-row")[0].textContent).toContain("+0.60");
  });
});

describe("every band says how much football it has seen", () => {
  it("states a reach for each source the open question reads", async () => {
    await mountStats({ gameweek: 4 });
    const strip = screen.getByTestId("coverage-strip");
    /* Two matches, not three — and the difference is the point. The fixture's
       deepest player has 180 minutes, so the RECORD holds two matches whatever
       gameweek the calendar has reached. This asserted "3 matches" off
       `gameweek - 1`, which is a claim about the season rather than about the
       file on screen; the two part company the moment a deadline passes and no
       minute of the new week has been played. */
    expect(strip.textContent).toContain("2 matches");
    expect(strip.textContent).toContain("GW4");
  });

  it("prints ∅ for a coverage nobody published, not a zero", async () => {
    /* The same discipline the cells use. Understat publishes `matches` per row;
       this fixture serves no events at all, so the feed's reach is unstated and
       must be admitted rather than inferred from the gameweek next to it. */
    await mountStats({ gameweek: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Is he finishing?" }));
    expect(screen.getByTestId("coverage-strip").textContent).toContain("∅");
  });
});

describe("selection opens the comparison", () => {
  it("is a mode reached from the sheet, not a separate page", async () => {
    await mountStats();
    expect(screen.queryByTestId("compare-tray")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Compare P1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare P2" }));
    expect(screen.getByTestId("compare-tray")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Compare 2/ }));
    const comparison = screen.getByTestId("comparison");
    // Both names, and the band headings that keep the transpose readable.
    expect(comparison.textContent).toContain("P1");
    expect(comparison.textContent).toContain("P2");
    expect(comparison.textContent).toContain("FPL record");
  });

  it("goes back to the question it was opened from", async () => {
    await mountStats();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare P1" }));
    fireEvent.click(screen.getByRole("button", { name: /Compare 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the sheet" }));
    expect(screen.queryByTestId("comparison")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("stats-row").length).toBeGreaterThan(0);
  });
});

describe("a feed this pipeline does not carry", () => {
  it("is named with its reason rather than left absent", async () => {
    /* It used to be a struck-through TAB sitting beside live ones. A question is
       not blocked — a FEED is — so the naming moved to the footer, where it can
       say what the column is and why it is not here without pretending to be a
       question the sheet could ask. */
    await mountStats();
    expect(screen.getByText(/Defending/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Defending" })).not.toBeInTheDocument();
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

  it("names every blocked feed, so none is quietly dropped", async () => {
    await mountStats();
    for (const label of ["Defending", "Set pieces", "Transfers in and out"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
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

  it("withholds only the coverage that needs a gameweek", async () => {
    /**
     * ONE claim now, not two. An unresolved gameweek costs the simulation its
     * week, because a projection has to point at one. It no longer costs the
     * RECORD its depth: that is measured from the file's own minutes, so it is
     * answerable whether or not anything could name the week — which is the
     * whole reason the derivation moved off the calendar.
     */
    await mountStats({ gameweek: null });
    expect(screen.getAllByTestId("stats-row").length).toBeGreaterThan(0);
    const strip = screen.getByTestId("coverage-strip");
    expect(strip.textContent).toContain("∅");
    expect(strip.textContent).toContain("2 matches");
    // And the reader still learns what the screen cannot answer at all.
    expect(screen.getByText(/Defending/)).toBeInTheDocument();
  });
});

describe("a source that stopped is not a source that is young", () => {
  /**
   * The failure this chip exists for, observed rather than imagined. Understat's
   * feed sat at one match for a fortnight while FPL's record grew to three. The
   * strip said "1 match" the whole time, which is true and reads as a young
   * season — the opposite of the reaction a frozen feed calls for. Its descriptor
   * has always carried a two-day budget and the artifact layer has always
   * computed the age; nothing on this screen asked until it mattered.
   */
  it("says nothing about age while a feed is inside its budget", async () => {
    await mountStats({ eventsAgeDays: 1 });
    expect(screen.queryByTestId("coverage-stale")).not.toBeInTheDocument();
  });

  it("marks the band when its file is past its budget", async () => {
    await mountStats({ eventsAgeDays: 15 });
    const stale = screen.getAllByTestId("coverage-stale");
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0].textContent).toMatch(/\d/);
  });

  it("marks only the band that is stale, not the sheet", async () => {
    // The record and the simulation refreshed this morning. A page-level warning
    // would tar them with a fault that belongs to one feed.
    await mountStats({ eventsAgeDays: 15 });
    expect(screen.getAllByTestId("coverage-stale")).toHaveLength(1);
  });
});
