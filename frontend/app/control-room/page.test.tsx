/**
 * The control room, rendered — and mostly, what it refuses to render.
 *
 * ## What these tests are for
 *
 * The design document this screen implements ships a fully populated example, and
 * its own provenance section says the populated parts are invented: two sample
 * proposals, every quantile, both bots' squad values, both bots' last-run times.
 * Neither bot has ever published a decision. So the single most important property
 * of this screen is negative — **no figure appears for Ronny or Wazza** — and a
 * negative property is exactly the kind that rots silently, because a screen that
 * has started showing invented numbers looks better than one that has not.
 *
 * Hence the assertions below are mostly refusals: no figure element in the bots'
 * projection, value or call cells; no currency anywhere in their columns; and the
 * `∅` mark present in each, which is the one mark that means "nothing was fitted"
 * as opposed to a blank, which reads as "fitted, and it came out low".
 *
 * The positive assertions cover the structure the design fixes: eight facet rows,
 * three team columns, one countdown, three glyph slots at three emphases, a
 * `?team=` round trip, and an availability bar whose two segments are counted from
 * the artifact rather than typed.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ControlRoomPage from "@/app/control-room/page";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { ACCURACY } from "@/lib/data/accuracy";
import { REGISTRY, decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { resetHeuristicsForTests } from "@/lib/data/useHeuristics";

const STATE = "/api/fpl/state";
const GW = 1;

const AGENT_IDLE = {
  schema_version: 1,
  generated_at: "2026-08-18T15:27:06Z",
  phase: "idle",
  gameweek: GW,
  deadline: "2026-08-21T17:30:00+00:00",
  seconds_to_deadline: 266_574,
  reason: "GW1 deadline in 74.0h; nothing due yet",
  agent_ran: false,
};

/**
 * Two players with real quantiles, one starting and one benched.
 *
 * Both ends of every span, because the glyph draws a span only when both are
 * published — a fixture carrying half a box would exercise a path the primitive
 * deliberately refuses.
 */
const PROJECTIONS = {
  gameweek: GW,
  season: "2627",
  generated_at: "2026-08-18T06:23:00Z",
  n_draws: 5000,
  producer_version: 1,
  players: [
    {
      name: "B.Fernandes", team: "Man Utd", position: "MID", element_id: 426,
      xp: 6.66, xp_sd: 4.9, mode: 2, p_appears: 0.98, p_60: 0.9, e_minutes: 88,
      p_goal: 0.3, p_clean_sheet: 0.2, p_ge_5: 0.5, p_ge_10: 0.1,
      q10: 2, q25: 3, q50: 5, q75: 9, q90: 14, n_fixtures: 1, blank: false,
    },
    {
      name: "Isak", team: "Liverpool", position: "FWD", element_id: 379,
      xp: 4.35, xp_sd: 3.9, mode: 2, p_appears: 0, p_60: 0.5, e_minutes: 60,
      p_goal: 0.3, p_clean_sheet: 0.05, p_ge_5: 0.4, p_ge_10: 0.08,
      q10: 2, q25: 2, q50: 2, q75: 6, q90: 9, n_fixtures: 1, blank: false,
    },
  ],
};

const ACCURACY_UNSEALED = {
  generated_at: "2026-08-18T06:00:00Z",
  season: "2627",
  gameweeks_sealed: 0,
  observations: 0,
  perfect_model_rmse: 2.24,
  perfect_model_basis: "the spread of our own simulated distributions",
  measured: null,
  reason: "No gameweek has sealed.",
};

const MATCHES = {
  gameweek: GW,
  season: "2026-27",
  generated_at: "2026-08-18T06:22:56Z",
  matches: [
    {
      match_id: "m1", date: "2026-08-21T19:00:00Z", home_team: "Arsenal",
      away_team: "Coventry City", model_prediction: "home", confidence_pct: 55.7,
      referee: null, is_derby: false, n_value_bets: 2,
    },
    {
      match_id: "m2", date: "2026-08-22T14:00:00Z", home_team: "Hull City",
      away_team: "Man United", model_prediction: "away", confidence_pct: 40.1,
      referee: null, is_derby: false, n_value_bets: 0,
    },
  ],
};

const FIXTURE_XG = {
  generated_at: "2026-08-18T06:20:00Z",
  current_gameweek: GW,
  fixtures: [
    {
      gameweek: GW, home_team: "Arsenal", away_team: "Coventry City",
      lambda_home: 2.453757, mu_away: 0.672378, rate_source: "market_blend",
    },
    {
      gameweek: GW, home_team: "Hull City", away_team: "Man United",
      lambda_home: 0.92, mu_away: 2.05, rate_source: "market_blend",
    },
  ],
};

/**
 * A catalogue with a deliberately lopsided split: two flagged, three not.
 *
 * The point is that 2 and 3 appear on screen only if they were counted. The
 * design's own caption says "39 of 587", which was one capture's number.
 */
const PLAYER_STATS = [
  row(426, "B.Fernandes", true), row(379, "Isak", true), row(1, "Raya", true),
  row(2, "Flagged One", false), row(3, "Flagged Two", false),
];

function row(id: number, name: string, available: boolean) {
  return {
    player_id: id, name, web_name: name, team: "Arsenal", position: "MID",
    minutes: 900, goals_scored: 1, assists: 1, expected_goals: 0.4,
    expected_assists: 0.3, fpl_price: 6.0, fpl_ownership: 10, form: 2,
    available,
  };
}

const LIVE = {
  schemaVersion: 4,
  generatedAt: "2026-08-18T15:00:00Z",
  season: "2026/27",
  entry: { id: 20945, teamName: "Suca" },
  event: { id: GW, deadlineTime: "2026-08-21T17:30:00Z" },
  freshness: { squad: "captured" },
  projections: { source: "fallback", sourceLabel: "No FPLReview export" },
  squad: {
    source: "captured_authenticated_draft",
    value: 99.5,
    bank: 0.5,
    formation: "4-4-2",
    players: [
      {
        elementId: 426, name: "B.Fernandes", position: "MID", team: "MUN",
        price: 12.0, bench: false, status: "captain", fixture: "HUL (A)",
      },
      {
        elementId: 379, name: "Isak", position: "FWD", team: "LIV",
        price: 9.0, bench: false, status: "vice", fixture: "NEW (A)",
      },
      {
        elementId: 173, name: "Thomas", position: "DEF", team: "COV",
        price: 4.0, bench: true, status: undefined, fixture: "ARS (A)",
      },
    ],
  },
  fixtureMatrix: [],
  recommendations: {
    modelVersion: "heuristic-only",
    transfers4: [], multiTransferPlans4: [], captaincyPlan: [],
  },
  rankings: {
    overall: [], captaincy: [], value: [], differentials: [],
    goalkeepers: [], defenders: [], midfielders: [], forwards: [],
  },
};

const PATHS = {
  status: AGENT_STATUS.path,
  projections: projectionsDescriptor(GW).path,
  accuracy: ACCURACY.path,
  matches: REGISTRY.matches.path,
  fixtureXg: REGISTRY.fixtureXg.path,
  playerStats: REGISTRY.playerStats.path,
  deltas: REGISTRY.deltas.path,
  ronny: decisionDescriptor(GW, "season").path,
  wazza: decisionDescriptor(GW, "weekly").path,
};

/**
 * Everything the pipeline actually publishes today.
 *
 * The two decision paths are deliberately absent, because they are absent in the
 * repository: no workflow has ever written either file.
 */
const ALL_PRESENT: Record<string, unknown> = {
  [PATHS.status]: AGENT_IDLE,
  [PATHS.projections]: PROJECTIONS,
  [PATHS.accuracy]: ACCURACY_UNSEALED,
  [PATHS.matches]: MATCHES,
  [PATHS.fixtureXg]: FIXTURE_XG,
  [PATHS.playerStats]: PLAYER_STATS,
  [PATHS.deltas]: "",
};

function mockFetch(bodies: Record<string, unknown>, live: unknown = LIVE) {
  return vi.fn(async (url: unknown) => {
    const raw = String(url);
    if (raw.startsWith(STATE)) {
      if (live === undefined) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ data: live }), { status: 200 });
    }
    const path = raw.replace(/^\/predictions\//, "");
    if (!(path in bodies)) return new Response("", { status: 404 });
    const body = bodies[path];
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status: 200 });
  });
}

async function renderBoard(
  bodies: Record<string, unknown> = ALL_PRESENT, live: unknown = LIVE,
) {
  vi.stubGlobal("fetch", mockFetch(bodies, live));
  render(<ControlRoomPage />);
  await screen.findByTestId("standings-matrix");
  // Every artifact resolves independently, so settle the queue rather than waiting
  // on one of them and asserting against a half-loaded board. Inside `act` because
  // the clock sets its own `now` on mount, and an update outside `act` is a warning
  // on every one of these cases.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  resetHeuristicsForTests();
  // The strip writes `?team=`, and jsdom shares one window across a file — so
  // without this the previous test's focus decides the next test's opening team.
  window.history.replaceState(null, "", "/control-room");
});
afterEach(() => {
  cleanup();
  resetHeuristicsForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────

const FACETS = [
  "objective", "projection", "value", "call",
  "wants", "ownership", "calibration", "run",
] as const;
const TEAMS = ["mine", "ronny", "wazza"] as const;

describe("the matrix keeps the design's structure", () => {
  it("renders all eight facet rows", async () => {
    await renderBoard();
    for (const facet of FACETS) {
      expect(
        screen.getByTestId(`cell-${facet}-mine`),
        `the ${facet} row is missing — the eight rows are the argument`,
      ).toBeInTheDocument();
    }
  });

  it("renders three team columns in every row", async () => {
    await renderBoard();
    for (const facet of FACETS) {
      for (const team of TEAMS) {
        expect(screen.getByTestId(`cell-${facet}-${team}`)).toBeInTheDocument();
      }
    }
    expect(screen.getAllByTestId(/^matrix-head-/)).toHaveLength(3);
  });

  it("keeps the opposed-objective argument readable across the empty rows", async () => {
    await renderBoard();
    // The two rows on which the bots are opposite are knowable for both, so they
    // must be filled even though the projection and the proposal are not.
    expect(screen.getByTestId("cell-ownership-ronny")).toHaveTextContent("Not an input");
    expect(screen.getByTestId("cell-ownership-wazza")).toHaveTextContent("Every input");
    expect(screen.getByTestId("cell-objective-ronny")).toHaveTextContent("E[season]");
    expect(screen.getByTestId("cell-objective-wazza")).toHaveTextContent(/P\(GW ≥ \d+\)/);
  });
});

describe("no fabricated figure appears for Ronny or Wazza", () => {
  /**
   * The assertion this file exists for.
   *
   * `data-role="figure"` marks every rendered figure on the board, so its absence
   * in these cells is a mechanical check rather than a regex over a paragraph —
   * and the paragraphs here legitimately contain digits, because they name the
   * artifact (`decision_public_gw01_season.json`) that would have carried the
   * number.
   */
  for (const team of ["ronny", "wazza"] as const) {
    for (const facet of ["projection", "value", "call"] as const) {
      it(`${team}'s ${facet} cell shows ∅ and no figure`, async () => {
        await renderBoard();
        const cell = screen.getByTestId(`cell-${facet}-${team}`);
        expect(
          cell.querySelector('[data-role="figure"]'),
          `${team}'s ${facet} cell renders a figure, and nothing has been `
          + `published for that entry`,
        ).toBeNull();
        expect(cell).toHaveTextContent("∅");
        expect(cell).toHaveTextContent(/never written|not published|Never/i);
      });
    }
  }

  it("prints no money in either bot's column", async () => {
    await renderBoard();
    for (const team of ["ronny", "wazza"] as const) {
      for (const facet of FACETS) {
        expect(
          screen.getByTestId(`cell-${facet}-${team}`).textContent ?? "",
          `${team}'s ${facet} cell prints a currency figure`,
        ).not.toMatch(/£/);
      }
    }
  });

  it("says never rather than a time for a run that has not happened", async () => {
    await renderBoard();
    const cell = screen.getByTestId("cell-run-ronny");
    expect(cell).toHaveTextContent("agent_ran: false");
    expect(cell.textContent ?? "").not.toMatch(/\b06:1\d\b/);
  });
});

describe("the projection row", () => {
  it("renders three glyphs at three emphases", async () => {
    await renderBoard();
    const glyphs = screen.getAllByTestId("projection-glyph");
    expect(glyphs).toHaveLength(3);
    expect(glyphs.map((g) => g.dataset.emphasis)).toEqual(["neutral", "median", "tail"]);
  });

  it("draws Mine's total from the published means, and no interval", async () => {
    await renderBoard();
    const cell = screen.getByTestId("cell-projection-mine");
    // 6.66 + 4.35 over the two starters, captain not doubled.
    expect(cell).toHaveTextContent("11.0");
    expect(cell).toHaveTextContent(/No interval is published for a squad total/);
    expect(cell).toHaveTextContent(/captain not doubled/);
  });

  it("gives the glyph an accessible description of what it drew", async () => {
    await renderBoard();
    const glyph = within(screen.getByTestId("cell-projection-mine")).getByRole("img");
    expect(glyph.getAttribute("aria-label")).toMatch(/mean 11\.0/);
  });
});

describe("the availability bar comes from the artifact", () => {
  it("counts both segments rather than using constants", async () => {
    await renderBoard();
    const bar = screen.getByTestId("availability");
    // Two flagged of five in the fixture. Any literal from the design would say
    // 39, and any total from it would say 587.
    expect(bar).toHaveTextContent("of 5 carry an availability flag");
    expect(
      within(bar).getByTestId("availability-flagged").getAttribute("title"),
    ).toContain("2 players");
    expect(
      within(bar).getByTestId("availability-no-news").getAttribute("title"),
    ).toContain("3 players");
  });

  it("never draws the absence of news as fitness", async () => {
    await renderBoard();
    const hatch = screen.getByTestId("availability-no-news");
    expect(hatch.getAttribute("title")).toMatch(/not the same as fit/);
    // The hatch is a gradient, not a fill: a solid segment would read as measured.
    expect(hatch.getAttribute("style") ?? "").toContain("repeating-linear-gradient");
  });

  it("says nothing rather than drawing a bar of zeroes when unpublished", async () => {
    const bodies = { ...ALL_PRESENT };
    delete bodies[PATHS.playerStats];
    await renderBoard(bodies);
    const bar = screen.getByTestId("availability");
    expect(within(bar).queryByTestId("availability-flagged")).toBeNull();
    expect(bar).toHaveTextContent(/could not be read/);
  });
});

describe("the clock", () => {
  it("renders exactly one countdown", async () => {
    await renderBoard();
    expect(screen.getAllByTestId("control-room-countdown")).toHaveLength(1);
  });

  it("states the deadline in the zone the deadline states", async () => {
    await renderBoard();
    expect(screen.getByText(/Fri 21 Aug 2026 · 17:30 UTC/)).toBeInTheDocument();
  });

  it("does not do NaN arithmetic on an unreadable deadline", async () => {
    await renderBoard({
      ...ALL_PRESENT,
      [PATHS.status]: { ...AGENT_IDLE, deadline: "" },
    });
    const clock = screen.getByTestId("control-room-countdown");
    expect(clock.textContent ?? "").not.toMatch(/NaN/);
    expect(clock).toHaveTextContent("—");
  });
});

describe("the team strip is the switcher, and the URL is the state", () => {
  it("opens on the team named in the query string", async () => {
    window.history.replaceState(null, "", "/control-room?team=wazza");
    await renderBoard();
    expect(screen.getByTestId("team-tile-wazza")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("team-tile-mine")).not.toHaveAttribute("aria-current");
  });

  it("writes the focused team back to the query string", async () => {
    await renderBoard();
    fireEvent.click(screen.getByTestId("team-tile-ronny"));
    expect(new URL(window.location.href).searchParams.get("team")).toBe("ronny");
    expect(screen.getByTestId("team-tile-ronny")).toHaveAttribute("aria-current", "true");
  });

  it("falls back to the human entry on a value it does not know", async () => {
    // `?team=toString` is the shape that once made `/margin` render a bar with no
    // panel under it, because `in` walks Object.prototype.
    window.history.replaceState(null, "", "/control-room?team=toString");
    await renderBoard();
    expect(screen.getByTestId("team-tile-mine")).toHaveAttribute("aria-current", "true");
  });

  it("keeps all three teams on screen whichever is focused", async () => {
    window.history.replaceState(null, "", "/control-room?team=ronny");
    await renderBoard();
    expect(screen.getAllByTestId(/^team-tile-/)).toHaveLength(3);
  });
});

describe("Rule 1 — age, not absence", () => {
  it("renders no skeleton and no spinner", async () => {
    await renderBoard();
    expect(document.querySelectorAll(".skeleton, .animate-pulse")).toHaveLength(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("states an age beside the figures rather than dimming them", async () => {
    await renderBoard();
    expect(screen.getByText(/projections: /)).toBeInTheDocument();
  });

  it("keeps every other section when one artifact is absent", async () => {
    const bodies = { ...ALL_PRESENT };
    delete bodies[PATHS.matches];
    await renderBoard(bodies);
    expect(screen.getByTestId("standings-matrix")).toBeInTheDocument();
    expect(screen.getByTestId("availability")).toBeInTheDocument();
    expect(screen.getByTestId("control-room-countdown")).toBeInTheDocument();
  });

  it("lists no non-event in the change feed", async () => {
    await renderBoard();
    expect(screen.queryByText(/no new proposal/i)).toBeNull();
    expect(screen.queryByText(/no median has moved/i)).toBeNull();
  });

  it("says what has never been computed, once, in body type", async () => {
    await renderBoard();
    const line = screen.getByText(/has never been scored for this squad/);
    expect(line).toBeInTheDocument();
    expect(line.tagName).toBe("P");
  });
});

describe("the board is read-only", () => {
  it("offers no approve, reject or defer control", async () => {
    await renderBoard();
    for (const label of [/approve/i, /reject/i, /defer/i, /submit/i, /confirm/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("has no interactive element other than the three team tiles", async () => {
    await renderBoard();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});

describe("§4.1 — the calibration counter", () => {
  it("renders zero of six truthfully, from the sealed count", async () => {
    await renderBoard();
    const counter = screen.getByTestId("calibration-counter");
    expect(counter).toHaveTextContent("0 of 6");
    expect(counter).toHaveTextContent(/running EV-optimal/);
  });

  it("draws six cells, none of them sealed", async () => {
    await renderBoard();
    const cells = screen.getByTestId("calibration-counter")
      .querySelectorAll("span[title]");
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.getAttribute("title")).toContain("not yet sealed");
    }
  });

  it("refuses the counter rather than guessing when nothing is sealed", async () => {
    // Above zero sealed, calibration and sealing part company: three sealed
    // gameweeks say nothing about whether the field model held its band in them.
    await renderBoard({
      ...ALL_PRESENT,
      [PATHS.accuracy]: { ...ACCURACY_UNSEALED, gameweeks_sealed: 3, observations: 700 },
    });
    const counter = screen.getByTestId("calibration-counter");
    expect(counter).toHaveTextContent("∅");
    expect(counter).toHaveTextContent(/not published/);
  });

  it("takes no warning hue — the caveat is content, not a fault", async () => {
    await renderBoard();
    const html = screen.getByTestId("calibration-counter").innerHTML;
    // The noise and conflict hues, as `lib/margin/tokens.ts` states them.
    expect(html).not.toContain("0.64 0.13 80");
    expect(html).not.toContain("0.55 0.13 30");
  });
});

describe("provenance is UI, not a footnote", () => {
  it("shows the legend exactly once", async () => {
    await renderBoard();
    expect(screen.getAllByTestId("provenance-legend")).toHaveLength(1);
  });

  /** Every fixture row's own strip, so the assertion cannot pick up the squad's. */
  function fixtureAnchors(): string[] {
    return screen.getAllByTestId("ambient-fixture").map(
      (row) => within(row).getByTestId("provenance-marks").textContent ?? "",
    );
  }

  it("reads each fixture's anchor from its own rate source", async () => {
    await renderBoard();
    // All ten GW1 fixtures carry `rate_source: "market_blend"` now; §9 recorded
    // only Arsenal v Coventry as anchored, and that has changed.
    expect(fixtureAnchors().every((text) => text.includes("market"))).toBe(true);
  });

  it("reports an unrecognised rate source as nothing fitted, not as a model", async () => {
    await renderBoard({
      ...ALL_PRESENT,
      [PATHS.fixtureXg]: {
        ...FIXTURE_XG,
        fixtures: FIXTURE_XG.fixtures.map(
          (fixture) => ({ ...fixture, rate_source: "something_new" }),
        ),
      },
    });
    // A fourth source nobody has seen is not something to quietly vouch for.
    expect(fixtureAnchors().some((text) => text.includes("market"))).toBe(false);
    expect(fixtureAnchors().every((text) => text.includes("∅"))).toBe(true);
  });
});

describe("the phase is derived, never toggled", () => {
  it("reports idle from the resolver without colouring it as a fault", async () => {
    await renderBoard();
    const chip = screen.getByTestId("phase-chip");
    expect(chip.dataset.mode).toBe("idle");
    expect(chip).toHaveTextContent(/Idle/);
  });

  it("does not fold an unreadable status into idle", async () => {
    const bodies = { ...ALL_PRESENT };
    delete bodies[PATHS.status];
    await renderBoard(bodies);
    expect(screen.getByTestId("phase-chip").dataset.mode).toBe("unknown");
  });

  it("offers no control that could put the board into deadline mode", async () => {
    await renderBoard();
    expect(screen.queryByRole("button", { name: /deadline mode/i })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
