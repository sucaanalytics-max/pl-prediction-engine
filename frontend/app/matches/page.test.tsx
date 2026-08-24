/**
 * Matches — the screen whose committed data is degenerate.
 *
 * It currently sits in a state that renders as a confident answer under the old
 * code, so the tests are written against the real artifact shapes:
 *
 * * every fixture predicts `home` (the flat-prior fingerprint);
 * * every table row has `played: 0` AND `position: 0`, which made
 *   `if (pos <= 4)` true for all twenty clubs.
 *
 * The Players suites this file used to carry alongside it — the per-90 trap and
 * the nulls-stay-null rule — rendered `/players`' old `PlayersTable`, which is
 * gone: `/players` now mounts `ResearchView` and carries no season-statistics
 * table at all. `app/players/page.test.tsx` covers the page as it is now; there
 * is nothing left here for those two describe blocks to assert against.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MatchesPage from "@/app/matches/page";
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

describe("Matches — the columns ported from /table", () => {
  const WITH_FORM = RANKED_TABLE.map((r, i) => ({
    ...r, won: 9, drawn: 2, lost: 1, gf: 25, ga: 10,
    form: i === 0 ? ["W", "W", "D", "L", "W"] : [],
  }));

  it("renders W/D/L, GF and GA", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: WITH_FORM,
    }, "League table");
    const first = document.querySelectorAll("tr[data-zone]")[0];
    const text = first.textContent ?? "";
    for (const value of ["9", "2", "1", "25", "10"]) {
      expect(text).toContain(value);
    }
  });

  it("renders the form guide as letters, not colour alone", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: WITH_FORM,
    }, "League table");
    const guides = screen.getAllByTestId("form");
    // The letter carries the meaning; colour only reinforces it. A guide encoded
    // in colour alone is unreadable to a colourblind reader.
    expect(guides[0].textContent).toBe("WWDLW");
  });

  it("labels each result for a screen reader", async () => {
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: WITH_FORM,
    }, "League table");
    expect(screen.getAllByTitle("Win").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Loss").length).toBeGreaterThan(0);
  });

  it("shows an EMPTY form guide pre-season, not placeholder dots", async () => {
    // An invented form guide is the same lie as an invented qualification zone.
    await renderPage(<MatchesPage />, {
      [REGISTRY.matches.path]: MATCHES,
      [REGISTRY.table.path]: PRE_SEASON_TABLE,
    }, "League table");
    for (const guide of screen.getAllByTestId("form")) {
      expect(guide.textContent).toBe("");
    }
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
