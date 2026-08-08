/**
 * Players — season actuals, and the heuristic rankings ported onto the page.
 *
 * Two independent sources sit here, and the tests that matter are about their
 * independence and their labelling:
 *
 * 1. **The per-90 suppression survives.** `xg_per_90` is computed upstream as
 *    `xg / max(minutes / 90, 0.1)`, so a 0-minute player reads as `xg × 10`. A
 *    fabricated rate in the same column as measured ones is the exact failure
 *    the artifact envelope exists to prevent, and an earlier version of this
 *    suite asserted only the `data-rates` attribute while the cell rendered
 *    `Infinity` — so the value itself is asserted here.
 * 2. **The rankings are labelled a heuristic and own their own state.** They
 *    come from `/api/fpl/state`, not from a model. `/rankings` and
 *    `/projections` are retired in favour of this section; neither is on `main`
 *    and both 404 in production, so the port loses nothing — but it must not
 *    quietly upgrade a guess into a projection either.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlayersPage from "@/app/players/page";
import { REGISTRY } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";

function statRow(over: Record<string, unknown> = {}) {
  return {
    name: "Saka", team: "Arsenal", minutes: 900, goals: 6, assists: 4,
    xg: 5.2, xa: 3.9, xg_per_90: 0.52, xa_per_90: 0.39,
    fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 31.2, fpl_price: 10.1, form: 5.4,
    ...over,
  };
}

function rankedPlayer(over: Record<string, unknown> = {}) {
  return {
    elementId: 427, name: "Salah", team: "LIV", position: "MID",
    price: 14.5, ownership: 42.1, status: "a", news: "",
    expectedMinutes: 88, projected4: 24.2, projected6: 35.8,
    captainScore: 9.1, valueScore: 1.67, differentialScore: 0.4,
    ...over,
  };
}

const EMPTY_LISTS = {
  overall: [], captaincy: [], value: [], differentials: [],
  goalkeepers: [], defenders: [], midfielders: [], forwards: [],
};

function liveState(over: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-08-06T06:00:00Z",
    recommendations: {
      modelVersion: "heuristic-only", transfers4: [], captaincyPlan: [],
    },
    rankings: {
      ...EMPTY_LISTS,
      overall: [rankedPlayer()],
      differentials: [rankedPlayer({ elementId: 3, name: "Mbeumo", team: "MUN" })],
    },
    projections: {
      source: "fallback",
      sourceLabel: "No FPLReview export available — official FPL fields only",
    },
    ...over,
  };
}

async function renderPlayers(
  bodies: Record<string, unknown>, live?: unknown,
) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const raw = String(url);
    if (raw.includes("/api/fpl/state")) {
      return live === undefined
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ data: live }), { status: 200 });
    }
    const path = raw.replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200 });
  }));
  render(<PlayersPage />);
  await screen.findByText("Players");
  await new Promise((r) => setTimeout(r, 30));
}

const STATS = REGISTRY.playerStats.path;

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("season actuals", () => {
  it("renders a row per player", async () => {
    await renderPlayers({ [STATS]: [statRow(), statRow({ name: "Ødegaard" })] });
    expect(screen.getAllByTestId("player")).toHaveLength(2);
  });

  it("shows a dash for a stat the provider never supplied", async () => {
    await renderPlayers({ [STATS]: [statRow()] });
    // fouls_committed is null on all 564 committed rows. A zero would claim the
    // player committed no fouls, which is a far more convincing lie than a dash.
    const row = screen.getAllByTestId("player")[0];
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("suppresses the per-90 rate below the minutes floor, VALUE included", async () => {
    // A played row is needed alongside it: `playerStatsAreEmpty` is
    // `every(r => minutes === 0)`, so a lone 0-minute row makes the whole
    // artifact `empty` and the table never renders at all.
    await renderPlayers({
      [STATS]: [statRow(), statRow({ name: "Nketiah", minutes: 0, xg: 0.4 })],
    });
    const cell = screen.getAllByTestId("player")
      .find((row) => row.textContent?.includes("Nketiah"))
      ?.querySelector('[data-rates="suppressed"]');
    expect(cell).not.toBeNull();
    // Asserting the attribute alone once passed while the cell rendered
    // `Infinity`. The rendered text is the thing that misleads.
    expect(cell?.textContent).toBe("—");
    expect(cell?.textContent).not.toMatch(/Infinity|NaN|\d/);
  });

  it("shows the rate when there are enough minutes", async () => {
    await renderPlayers({ [STATS]: [statRow({ minutes: 900, xg: 5.2 })] });
    const cell = screen.getAllByTestId("player")[0]
      .querySelector('[data-rates="shown"]');
    expect(cell?.textContent).toBe("0.52");
  });
});

describe("the ported rankings", () => {
  it("are labelled a heuristic, not a projection", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    expect(screen.getByText("HEURISTIC — NOT A MODEL")).toBeInTheDocument();
  });

  it("render the overall list by default", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    const rows = screen.getAllByTestId("ranked-player");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Salah")).toBeInTheDocument();
  });

  it("expose every category the engine emits as a tab", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    // Eight, matching the retired /rankings page exactly — a category dropped in
    // the move would be a feature lost without anyone noticing.
    expect(screen.getAllByRole("tab")).toHaveLength(8);
  });

  it("switch list when a tab is chosen", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    await userEvent.click(screen.getByRole("tab", { name: "Differentials" }));
    expect(screen.getByText("Mbeumo")).toBeInTheDocument();
    expect(screen.queryByText("Salah")).not.toBeInTheDocument();
  });

  it("say which projection source is behind the numbers", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    // "fallback" is the normal case now that the paid export is not bundled.
    expect(screen.getByText(/No FPLReview export available/)).toBeInTheDocument();
  });

  it("flag a player FPL has marked unavailable", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState({
      rankings: { ...EMPTY_LISTS, overall: [rankedPlayer({ status: "d", news: "Knock" })] },
    }));
    expect(screen.getByText("flagged")).toBeInTheDocument();
  });

  it("show an empty category as empty rather than as a blank table", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    await userEvent.click(screen.getByRole("tab", { name: "GKP" }));
    expect(screen.getByText(/No players in this category/)).toBeInTheDocument();
  });
});

describe("the two sources are independent", () => {
  it("a dead live route leaves the season table intact", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, undefined);
    expect(screen.getAllByTestId("player")).toHaveLength(1);
    expect(screen.queryAllByTestId("ranked-player")).toHaveLength(0);
  });

  it("absent season stats leave the rankings intact", async () => {
    await renderPlayers({}, liveState());
    expect(screen.getAllByTestId("ranked-player")).toHaveLength(1);
  });

  it("both absent renders two honest cards, not one blank page", async () => {
    await renderPlayers({}, undefined);
    const cards = screen.getAllByRole("status");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Players")).toBeInTheDocument();
  });
});

describe("the pieces carried over from /transfers and /projections", () => {
  it("keeps the watchlist, which is the user's own data", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    const star = screen.getByRole("button", { name: /Add Salah to watchlist/ });
    expect(star).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(star);
    expect(
      screen.getByRole("button", { name: /Remove Salah from watchlist/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("persists a watched player when storage works", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    await userEvent.click(screen.getByRole("button", { name: /Add Salah/ }));
    expect(store.get("suca-fpl-watchlist-v1")).toContain("427");
  });

  it("keeps working, and says so, when storage is unavailable", async () => {
    // jsdom here has no working localStorage, which is the same shape as
    // Safari private mode and a quota overrun. The unguarded `setItem` used to
    // throw straight out of the click handler and take the whole page down
    // through ErrorBoundary — losing the rankings because a star could not be
    // saved.
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    await userEvent.click(screen.getByRole("button", { name: /Add Salah/ }));
    expect(
      screen.getByRole("button", { name: /Remove Salah from watchlist/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/not storing it/)).toBeInTheDocument();
    // The page is still a page, not an error boundary.
    expect(screen.getByText("Players")).toBeInTheDocument();
  });

  it("searches by player and by team", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState({
      rankings: {
        ...EMPTY_LISTS,
        overall: [rankedPlayer(), rankedPlayer({ elementId: 2, name: "Haaland", team: "MCI" })],
      },
    }));
    await userEvent.type(screen.getByLabelText("Search ranked players"), "mci");
    expect(screen.getAllByTestId("ranked-player")).toHaveLength(1);
    expect(screen.getByText("Haaland")).toBeInTheDocument();
  });

  it("says when a search matches nothing, distinctly from an empty category", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    await userEvent.type(screen.getByLabelText("Search ranked players"), "zzzz");
    expect(screen.getByText(/No player matches that search/)).toBeInTheDocument();
  });

  it("renders a per-gameweek column per projected week", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState({
      rankings: {
        ...EMPTY_LISTS,
        overall: [rankedPlayer({
          gameweekProjections: [
            { gameweek: 1, fixture: "LIV v BOU", difficulty: 2, projectedPoints: 6.1 },
            { gameweek: 2, fixture: "NEW v LIV", difficulty: 4, projectedPoints: 4.3 },
          ],
        })],
      },
    }));
    const row = screen.getAllByTestId("ranked-player")[0];
    expect(within(row).getByText("6.1")).toBeInTheDocument();
    expect(within(row).getByText("4.3")).toBeInTheDocument();
  });

  it("shows a dash, not 0.0, for a gameweek with no projection", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState({
      rankings: {
        ...EMPTY_LISTS,
        overall: [
          rankedPlayer({
            gameweekProjections: [
              { gameweek: 1, fixture: "a", difficulty: 2, projectedPoints: 6.1 },
              { gameweek: 2, fixture: "b", difficulty: 2, projectedPoints: 5.0 },
            ],
          }),
          // Fewer weeks than the widest row, so its trailing cell is unknown.
          rankedPlayer({
            elementId: 8, name: "Short",
            gameweekProjections: [
              { gameweek: 1, fixture: "c", difficulty: 2, projectedPoints: 3.0 },
            ],
          }),
        ],
      },
    }));
    const short = screen.getAllByTestId("ranked-player")
      .find((r) => r.textContent?.includes("Short"));
    // A missing projection is not a projection of zero, and coercing would sort
    // the two identically.
    expect(short?.textContent).toContain("—");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The model's own projections.
//
// The section that distinguishes this app from the category: `xp 6.4` beside
// "most often 2" beside "P(10+) 15%". Seven of eight competitors publish only
// the first of the three, and given the top models all sit near the theoretical
// ceiling, the mean is the least informative of them.
// ─────────────────────────────────────────────────────────────────────────────

const MATCHES = {
  gameweek: 7, season: "2026-27", generated_at: "2026-08-06T06:00:00Z",
  matches: [{
    match_id: "m1", date: "2026-08-15", home_team: "Arsenal",
    away_team: "Chelsea", model_prediction: "away", confidence_pct: 51,
  }],
};

function projection(id: number, over: Record<string, unknown> = {}) {
  return {
    element_id: id, name: `P${id}`, team: "LIV", position: "MID",
    xp: 6.4, xp_sd: 3.7, mode: 2, p_ge_5: 0.5, p_ge_10: 0.15,
    q10: 1, q90: 13, n_fixtures: 1, blank: false,
    decomposition: {
      appearance: 1.9, goals: 2.1, assists: 0.6, clean_sheets: 0.3, other: 1.5,
    },
    ...over,
  };
}

const XP_FILE = {
  schema_version: 1, gameweek: 7, season: "2627",
  generated_at: "2026-08-07T06:00:00Z", n_draws: 10000,
  players: [projection(1)],
};

const XP_PATH = projectionsDescriptor(7).path;

describe("the projections section", () => {
  it("shows the mean, the mode and the tail together", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES, [XP_PATH]: XP_FILE,
    }, liveState());
    const row = screen.getAllByTestId("projection")[0];
    expect(within(row).getByText("6.4")).toBeInTheDocument();
    expect(within(row).getByTestId("mode").textContent).toContain("2");
    expect(within(row).getByText("15%")).toBeInTheDocument();
  });

  it("flags a mean carried by the tail", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES, [XP_PATH]: XP_FILE,
    }, liveState());
    // 6.4 against a mode of 2 is a 4.4-point gap: the mean is not a forecast of
    // a typical week, and the page has to say so.
    expect(screen.getByText("skew")).toBeInTheDocument();
  });

  it("does not flag a symmetric projection", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES,
      [XP_PATH]: { ...XP_FILE, players: [projection(1, { xp: 2.5, mode: 2 })] },
    }, liveState());
    expect(screen.queryByText("skew")).not.toBeInTheDocument();
  });

  it("expands to show where the mean comes from", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES, [XP_PATH]: XP_FILE,
    }, liveState());
    expect(screen.queryByTestId("breakdown")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show points breakdown/ }));
    const breakdown = screen.getByTestId("breakdown");
    expect(within(breakdown).getByText("Clean sheet")).toBeInTheDocument();
    expect(within(breakdown).getByText("2.10")).toBeInTheDocument();
  });

  it("offers no breakdown when the producer published none", async () => {
    const noParts = projection(1);
    delete (noParts as Record<string, unknown>).decomposition;
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES,
      [XP_PATH]: { ...XP_FILE, players: [noParts] },
    }, liveState());
    expect(screen.queryByRole("button", { name: /breakdown/ })).not.toBeInTheDocument();
  });

  it("says how many draws are behind the tail probabilities", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES, [XP_PATH]: XP_FILE,
    }, liveState());
    // P(10+) = 15% from 2,000 draws and from 10,000 are different claims.
    expect(screen.getByText(/10,000 simulated draws/)).toBeInTheDocument();
  });

  it("explains itself when no projection is published", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES,
    }, liveState());
    const cards = screen.getAllByRole("status");
    expect(cards.some((c) => /No projection has been published/.test(c.textContent ?? "")))
      .toBe(true);
  });

  it("explains itself when the gameweek is unknown", async () => {
    await renderPlayers({ [STATS]: [statRow()] }, liveState());
    expect(screen.getByText(/current gameweek is unknown/)).toBeInTheDocument();
  });

  it("does not blank the season table when the projection is absent", async () => {
    await renderPlayers({
      [STATS]: [statRow()], [REGISTRY.matches.path]: MATCHES,
    }, liveState());
    expect(screen.getAllByTestId("player")).toHaveLength(1);
  });
});
