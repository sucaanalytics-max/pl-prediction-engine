/**
 * Matches and Players — the two screens whose committed data is degenerate.
 *
 * Both currently sit in a state that renders as a confident answer under the old
 * code, so the tests are written against the real artifact shapes:
 *
 * * every fixture predicts `home` (the flat-prior fingerprint);
 * * every table row has `played: 0` AND `position: 0`, which made
 *   `if (pos <= 4)` true for all twenty clubs;
 * * `fouls_committed` is null on all 564 player rows while typed `number`.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MatchesPage from "@/app/matches/page";
import PlayersPage from "@/app/players/page";
import { REGISTRY } from "@/lib/data/narrow";

function fixture(id: string, home: string, away: string, call = "home", referee: string | null = null) {
  return {
    match_id: id, date: "2026-08-15", home_team: home, away_team: away,
    model_prediction: call, confidence_pct: 51.4, referee,
  };
}

const MATCHES = {
  gameweek: 1, season: "2026-27", generated_at: "2026-08-06T06:00:00Z",
  matches: [
    fixture("m1", "Arsenal", "Chelsea", "home", "M Oliver"),
    fixture("m2", "Everton", "Fulham", "away"),
  ],
};

/** The committed table: all zeros, positions included. */
const PRE_SEASON_TABLE = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Burnley", "Chelsea", "Crystal Palace", "Everton", "Fulham",
  "Leeds", "Liverpool", "Man City", "Man United", "Newcastle",
  "Nott'm Forest", "Sunderland", "Tottenham", "West Ham", "Wolves",
].map((team) => ({
  position: 0, team, played: 0, won: 0, drawn: 0, lost: 0,
  gf: 0, ga: 0, gd: 0, points: 0, form: [],
}));

const RANKED_TABLE = PRE_SEASON_TABLE.map((r, i) => ({
  ...r, position: i + 1, played: 10, points: 30 - i, gd: 20 - i,
}));

const PLAYERS = [
  {
    name: "Saka", team: "Arsenal", minutes: 2400, goals: 12, assists: 9,
    xg: 10.4, xa: 7.2, fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 41.2, fpl_price: 10.1, form: 6.2,
  },
  {
    name: "New Signing", team: "Leeds", minutes: 0, goals: 0, assists: 0,
    xg: 0.8, xa: 0.3, fouls_committed: null, fouls_per_90: null,
    fpl_ownership: null, fpl_price: 5.0, form: 0.0,
  },
];

function mockFetch(bodies: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    const path = String(url).replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200 });
  });
}

async function renderPage(node: React.ReactElement, bodies: Record<string, unknown>, settle: string) {
  vi.stubGlobal("fetch", mockFetch(bodies));
  render(node);
  await screen.findByText(settle);
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Matches — fixtures", () => {
  it("renders fixtures when the calls differ", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: RANKED_TABLE,
    }, "Fixtures");
    expect(screen.getAllByTestId("fixture")).toHaveLength(2);
  });

  it("an all-home slate is reported as no information, not as a forecast", async () => {
    const flat = {
      ...MATCHES,
      matches: MATCHES.matches.map((m) => ({ ...m, model_prediction: "home" })),
    };
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: flat,
      [REGISTRY.table.path]: RANKED_TABLE,
    }, "Fixtures");
    expect(screen.queryAllByTestId("fixture")).toHaveLength(0);
    const card = screen.getAllByRole("status").find(
      (n) => n.textContent?.includes("no fitted team strengths"),
    );
    expect(card).toBeDefined();
    expect(card?.dataset.state).toBe("empty");
  });

  it("says a referee is unappointed rather than showing a blank", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: RANKED_TABLE,
    }, "Fixtures");
    const rows = screen.getAllByTestId("fixture");
    expect(within(rows[0]).getByText("M Oliver")).toBeInTheDocument();
    expect(within(rows[1]).getByText("not appointed")).toBeInTheDocument();
  });
});

describe("Matches — the league table", () => {
  it("highlights no zone before a ball is kicked", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: PRE_SEASON_TABLE,
    }, "League table");
    // The bug: `pos <= 4` was true for all twenty, because every position is 0.
    const zoned = document.querySelectorAll('tr[data-zone]:not([data-zone="none"])');
    expect(zoned).toHaveLength(0);
  });

  it("still lists all twenty clubs pre-season", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: PRE_SEASON_TABLE,
    }, "League table");
    // showEmpty: the rows are worth seeing; it is the highlighting that must go.
    expect(document.querySelectorAll("tr[data-zone]")).toHaveLength(20);
  });

  it("stays unhighlighted when the writer assigns positions but nothing is played", async () => {
    // The prospective trap. `fpl_api.py:345` assigns 1..20 via
    // `enumerate(table, start=1)`, so the NEXT real run has real positions with
    // every counter still zero. A `position !== 0` gate passes today's fixture and
    // breaks here, which is why the check is on matches played.
    const positionedButUnplayed = PRE_SEASON_TABLE.map((r, i) => ({
      ...r, position: i + 1,
    }));
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: positionedButUnplayed,
    }, "League table");
    const zoned = document.querySelectorAll('tr[data-zone]:not([data-zone="none"])');
    expect(zoned).toHaveLength(0);
  });

  it("highlights the right zones once matches are played", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: RANKED_TABLE,
    }, "League table");
    expect(document.querySelectorAll('tr[data-zone="champions"]')).toHaveLength(4);
    expect(document.querySelectorAll('tr[data-zone="relegation"]')).toHaveLength(3);
  });
});

describe("Matches — Rule 2", () => {
  it("an absent table does not blank the fixtures", async () => {
    await renderPage(<MatchesPage />, { [REGISTRY.matches.path]: MATCHES }, "Fixtures");
    expect(screen.getAllByTestId("fixture")).toHaveLength(2);
    expect(screen.getByText("League table")).toBeInTheDocument();
  });

  it("an absent fixtures file does not blank the table", async () => {
    await renderPage(<MatchesPage />, { [REGISTRY.table.path]: RANKED_TABLE }, "Fixtures");
    expect(document.querySelectorAll("tr[data-zone]")).toHaveLength(20);
  });
});

describe("Players — the per-90 trap", () => {
  it("suppresses the rate for a player under the minutes floor", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS,
    }, "Season statistics");
    const suppressed = document.querySelectorAll('td[data-rates="suppressed"]');
    expect(suppressed).toHaveLength(1);
    // Assert the RENDERED CELL, not just the marker attribute. Removing the guard
    // leaves `data-rates="suppressed"` in place while the number appears anyway,
    // so an attribute-only assertion passes on a broken page — which a mutation
    // run duly demonstrated.
    expect(suppressed[0].textContent?.trim()).toBe("—");
  });

  it("never renders a rate computed by dividing by zero minutes", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS,
    }, "Season statistics");
    // The real failure mode. `xg / (0 / 90)` is Infinity, not the `xg * 10` the
    // pipeline's floored version would give — so a test looking for "8.00" misses
    // it entirely.
    expect(document.body.textContent).not.toContain("Infinity");
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("shows the rate for a player with real minutes", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS,
    }, "Season statistics");
    expect(document.querySelectorAll('td[data-rates="shown"]')).toHaveLength(1);
  });

  it("says how many rates were hidden", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS,
    }, "Season statistics");
    expect(screen.getByText(/per-90 rates hidden for 1 player/)).toBeInTheDocument();
  });
});

describe("Players — nulls stay null", () => {
  it("renders a dash for an unsupplied stat, never a zero", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS,
    }, "Season statistics");
    const rows = screen.getAllByTestId("player");
    // fouls_committed is null on all 564 real rows. A zero here would claim the
    // player committed no fouls, which the provider never said.
    for (const row of rows) {
      const cells = within(row).getAllByTitle("not supplied by the provider");
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  it("an all-zero-minutes squad is empty, not a table of zeros", async () => {
    await renderPage(<PlayersPage />, {
      [REGISTRY.playerStats.path]: PLAYERS.map((p) => ({ ...p, minutes: 0 })),
    }, "Season statistics");
    expect(screen.queryAllByTestId("player")).toHaveLength(0);
    expect(screen.getByRole("status").dataset.state).toBe("empty");
  });
});
