/**
 * The front page: one captain, one total that says how it was counted, and the
 * distribution glyphs.
 *
 * ## Why the assertions are page-level rather than component-level
 *
 * Every one of these properties held in each component in isolation and failed on
 * the assembled screen. `/now` shipped two captains — `GameweekCall`'s model
 * argmax and `SquadBoard`'s heuristic card — and each component's own suite was
 * green, because neither could see the other. The same shape of failure is the
 * risk here: this page composes three components and any one of them can bring a
 * second answer to the single highest-leverage choice of the week.
 *
 * So the count is asserted on the mounted page. A test that mounted
 * `GameweekCall` alone would pass against the bug.
 *
 * ## The heuristic is present in the fixture on purpose
 *
 * `VIEW` carries `captaincy` and `transfers` — the engine's own armband list and
 * its transfer shortlist. A fixture that omitted them would pass against a page
 * that renders them. They are supplied, and the page must still hold one answer.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

/** Six weeks of run for every squad player, so the grid has cells to draw. */
const RUN = [1, 2, 3, 4, 5, 6].map((gameweek) => ({
  gameweek, label: `OPP${gameweek}`, difficulty: 3,
}));

/**
 * The fifteen, each carrying FPL's own `elementId`.
 *
 * `elementId` is the join key for both `joinProjections` and `pointsFrom`, so a
 * fixture without ids would exercise a join the app does not perform.
 * Kadıoğlu (3.85) is benched while Gvardiol (0.78) starts, which makes the XI
 * suboptimal — and only a suboptimal XI makes `GameweekCall` print the total this
 * file is here to check.
 */
const SQUAD = {
  players: [
    { elementId: 1, name: "Verbruggen", position: "GKP", team: "BHA", price: 4.5, bench: false,
      // A realistic label and rating: the fixture cell must show BOTH, and the
      // rating must not live only in a title attribute.
      fixture: "CHE (A)", difficulty: 4, ownership: 12.5, fixtures: RUN },
    { elementId: 2, name: "Gvardiol", position: "DEF", team: "MCI", price: 5.5, bench: false, fixtures: RUN },
    { elementId: 3, name: "Calafiori", position: "DEF", team: "ARS", price: 5.5, bench: false, fixtures: RUN },
    { elementId: 4, name: "Shaw", position: "DEF", team: "MUN", price: 4.5, bench: false, fixtures: RUN },
    { elementId: 5, name: "B.Fernandes", position: "MID", team: "MUN", price: 12.0, bench: false, fixtures: RUN },
    { elementId: 6, name: "Szoboszlai", position: "MID", team: "LIV", price: 7.0, bench: false, fixtures: RUN },
    { elementId: 7, name: "Semenyo", position: "MID", team: "MCI", price: 8.5, bench: false, fixtures: RUN },
    { elementId: 8, name: "Mbeumo", position: "MID", team: "MUN", price: 8.0, bench: false, fixtures: RUN },
    { elementId: 9, name: "E.Le Fée", position: "MID", team: "SUN", price: 6.0, bench: false, fixtures: RUN },
    { elementId: 10, name: "João Pedro", position: "FWD", team: "CHE", price: 7.5, bench: false, fixtures: RUN },
    { elementId: 11, name: "Thiago", position: "FWD", team: "BRE", price: 8.0, bench: false, fixtures: RUN },
    { elementId: 12, name: "Kinsky", position: "GKP", team: "TOT", price: 4.5, bench: true, fixtures: RUN },
    { elementId: 13, name: "Mateta", position: "FWD", team: "CRY", price: 6.5, bench: true, fixtures: RUN },
    { elementId: 14, name: "Thomas", position: "DEF", team: "COV", price: 4.0, bench: true, fixtures: RUN },
    { elementId: 15, name: "F.Kadıoğlu", position: "DEF", team: "BHA", price: 4.5, bench: true, fixtures: RUN },
  ],
  value: 96.5,
  bank: 3.5,
  formation: "3-5-2",
  source: "captured_authenticated_draft",
};

/** Real values from `xp_public_gw01.json`, keyed by element id. */
const XP: Record<number, number> = {
  1: 3.63, 2: 0.78, 3: 2.40, 4: 3.07, 5: 5.77, 6: 4.04, 7: 3.07, 8: 3.91,
  9: 5.06, 10: 2.68, 11: 5.12, 12: 2.23, 13: 1.32, 14: 1.17, 15: 3.85,
};

/**
 * Quantiles on every row, because the glyph is the point.
 *
 * `geometry` draws the interquartile box only from real q25 **and** q75, and the
 * whisker only from real q10 **and** q90 — half a box from one end would be a
 * narrower interval than the one that was measured. A fixture that left them null
 * would render `Nil` marks and the glyph assertion would pass on nothing.
 */
const PROJECTIONS = SQUAD.players.map((p) => ({
  elementId: p.elementId,
  name: p.name,
  team: null,
  position: p.position,
  xp: XP[p.elementId] ?? null,
  xpSd: 2,
  mode: 2,
  pAppears: 0.9,
  p60: 0.8,
  eMinutes: 80,
  pGoal: 0.2,
  pCleanSheet: 0.3,
  pGe5: 0.4,
  pGe10: 0.1,
  q10: 0,
  q25: 1,
  q50: XP[p.elementId] ?? 0,
  q75: 7,
  q90: 11,
  nFixtures: 1,
  decomposition: null,
  blank: false,
}));

const FIXTURE_MATRIX = [
  {
    teamId: 1, team: "Manchester United", shortName: "MUN",
    meanDifficulty: 3, totalDifficulty: 18, fixtures: RUN,
  },
  {
    teamId: 2, team: "Arsenal", shortName: "ARS",
    meanDifficulty: 2, totalDifficulty: 12, fixtures: RUN,
  },
];

/**
 * The live view, WITH the heuristic engine's own answers present.
 *
 * `captaincy` names Mbeumo six times over, already doubled for the armband
 * (`fpl-ranking-engine.ts` returns `projectedPoints * 2`), and `transfers` names
 * a sale of the second-best defender in the squad. Both are the state of the
 * shipped app. The page must render neither.
 */
const VIEW = {
  squad: SQUAD,
  event: { id: 1, deadlineTime: null },
  fixtureMatrix: FIXTURE_MATRIX,
  transfers: [{
    playerOut: { name: "F.Kadıoğlu" },
    playerIn: { name: "Gabriel" },
    delta4: 3.8,
    confidence: 73,
    rationale: ["0.1% elite ownership adds differential upside"],
  }],
  captaincy: [1, 2, 3, 4, 5, 6].map((gameweek) => ({
    gameweek,
    captain: { name: "Mbeumo" },
    viceCaptain: { name: "Semenyo" },
    captainFixture: "HUL (A)",
    projectedCaptainPoints: 8.8,
  })),
};

const PLAYER_STATS = SQUAD.players.map((p) => ({
  elementId: p.elementId, fpl_price: p.price,
}));

/**
 * Mount the page with every artifact it reads served from a fixture.
 *
 * `agentGameweek` and `eventId` are served SEPARATELY and default to the same
 * number only for the cases that are not about the gameweek. They are the two
 * sources `useCurrentGameweek` ranks, and the whole page must resolve to the
 * first of them — see the divergence case below, which sets them apart.
 *
 * Every descriptor key the page asks for is recorded, because "one gameweek
 * across the page" is a claim about which FILES were read, not about what was
 * printed. Two of the three components render no gameweek at all.
 */
async function mountPage(
  {
    squad = SQUAD as typeof SQUAD | null,
    projections = PROJECTIONS as typeof PROJECTIONS | null,
    agentGameweek = 1 as number | null,
    eventId = 1 as number | null,
    // A date with no other meaning anywhere in this repo, so a deadline on screen
    // can only have come from this fixture. It was originally chosen to avoid
    // colliding with the hardcoded "Fri 21 Aug · 23:00 IST" that
    // `compactIstDeadline` used to return when handed nothing; that fallback is gone
    // and the parameter is now required, so the collision is no longer possible —
    // the fixture stays because a distinct date is still the clearer evidence.
    deadline = "2026-09-12T10:00:00Z" as string | null,
    agentStatusAbsent = false,
  } = {},
) {
  vi.resetModules();
  const requested: string[] = [];
  const ok = (value: unknown) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { source: "local", producedAt: null, ageMs: null },
      reason: value === null ? "nothing is published at this path" : null,
      value,
    },
    initialising: false,
    reload: () => {},
  });
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ok(
      squad === null
        ? null
        : { ...VIEW, squad, event: { id: eventId, deadlineTime: null } },
    ),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) => {
      const key = String(d?.key);
      requested.push(key);
      if (key.startsWith("projections")) {
        return ok(projections === null ? null : { players: projections, horizon: null, nDraws: 10000 });
      }
      if (key === "agentStatus") {
        return ok(
          agentGameweek === null || agentStatusAbsent
            ? null
            : {
              gameweek: agentGameweek, agentRan: false, phase: "idle",
              deadline, secondsToDeadline: null, reason: null, generatedAt: null,
            },
        );
      }
      if (key === "playerStats") return ok(PLAYER_STATS);
      // Everything else absent, which is Rule 2: it must cost one line, not the page.
      return ok(null);
    },
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: Page } = await import("@/app/page");
  return { ...render(<Page />), requested };
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useHeuristics");
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("it is a page and not a redirect", () => {
  it("renders the call rather than sending the reader somewhere else", async () => {
    const { container } = await mountPage();
    expect(container.querySelector("[data-testid='call-board']")).not.toBeNull();
    // The table is the default view: five of seven reviewers put a sortable
    // table ahead of the pitch, because sorting is the operation this screen
    // exists for and a pitch cannot be sorted.
    expect(container.querySelectorAll("[data-testid='eleven-row']").length).toBe(11);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your call");
  });

  it("renders the link to /capture, which is the write path's only door", async () => {
    /**
     * Asserted on the DOM, not on the source. `test/nav-coverage.test.tsx` reads
     * the file text — enough to stop the link disappearing again, not enough to
     * know it renders — and this route was reachable only by typing the URL for
     * the whole of the route cut while two files claimed it was "reached from /".
     *
     * It sits beside the squad because capturing the position is what makes the
     * squad above it true: `_read_entry` reads a committed capture BEFORE asking
     * FPL live, so this anchor is the head of the only write path the app has.
     */
    await mountPage();
    const link = screen.getByRole("link", { name: /Capture what you actually submitted/ });
    expect(link.getAttribute("href")).toBe("/capture");
  });

  it("names no gameweek in its own chrome", async () => {
    /**
     * The gameweek is named once, by the board's provenance line, beside the
     * artifact it was read from — `xp_public_gw01.json`. `/now`'s heading was the literal
     * `title="Your GW1 call"`, which is a hand-maintained number that is wrong
     * for 37 weeks of 38 and cannot 404 to tell anyone.
     */
    await mountPage();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).not.toMatch(/GW\s*\d/);
    // The header block, heading and subtitle together.
    expect(heading.parentElement?.textContent ?? "").not.toMatch(/GW\s*\d/);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("app/page.tsx", "utf8")).not.toContain('title="Your GW1 call"');
  });
});

/**
 * ONE gameweek, from one resolver, with the two sources deliberately disagreeing.
 *
 * `agent_status.gameweek` is the NEXT deadline's week (`pipeline/learning/
 * schedule.py:274`); `/api/fpl/state` returns `is_current ?? is_next`. So during
 * any in-progress gameweek N the two differ by exactly one, and that is the only
 * interesting case — a fixture that sets both to 1 cannot see a page reading two
 * of them, which is how three components shipped with two resolvers between them.
 *
 * The number is a fetch path (`fpl/xp_public_gwNN.json`), so disagreement is not a
 * mislabelled figure: it is two files under one heading. Hence the assertion is on
 * the descriptor keys as well as on the printed copy.
 */
describe("one gameweek across the page, even when the two sources disagree", () => {
  const DIVERGED = { agentGameweek: 7, eventId: 6 };

  it("reads exactly one gameweek's projection file", async () => {
    const { requested } = await mountPage(DIVERGED);
    const weeks = [...new Set(requested.filter((k) => k.startsWith("projections:")))];
    // The board and the solved-plan section both key a projection off the week,
    // and they must key it off the SAME week.
    expect(weeks).toEqual(["projections:07"]);
  });

  it("names that same gameweek everywhere it names one", async () => {
    const { container } = await mountPage(DIVERGED);
    const text = container.textContent ?? "";
    // The board's provenance line, beside the call it computed. This is the only
    // place the page names a gameweek, which is why the chrome carries none.
    expect(text).toContain("xp_public_gw07.json");
    expect(text).not.toContain("xp_public_gw06.json");
    expect(container.querySelector("[data-testid='call-provenance']")?.textContent)
      .toContain("GW7");
  });

  it("prefers agent_status over the live route, which is the documented order", async () => {
    // With agent_status absent the live route answers, and the whole page moves
    // together — the precedence is shared, not per-component.
    const { container, requested } = await mountPage({ agentGameweek: null, eventId: 6 });
    expect([...new Set(requested.filter((k) => k.startsWith("projections:")))])
      .toEqual(["projections:06"]);
    expect(container.textContent).toContain("xp_public_gw06.json");
  });

  it("reads no projection at all when neither source can name a week", async () => {
    /**
     * The reason there is no `?? 1` here. `xp_public_gw01.json` EXISTED — it was
     * pruned when gw02 published — and a guess of 1 does not reliably 404 into an
     * honest `absent`: whenever that file is on disk it renders GW1's numbers as
     * though they were this week's, for 37 weeks of 38, silently.
     */
    const { container, requested } = await mountPage(
      { agentGameweek: null, eventId: null },
    );
    expect(requested.filter((k) => k.startsWith("projections:"))).toEqual([]);
    expect(container.textContent).toMatch(/gameweek is unknown/);
  });
});

/**
 * ONE captain. The measured defect this whole surface exists to remove.
 *
 * The armband is the single highest-leverage choice of the week and the deadline
 * is a hard clock. Two names, badged but unreconciled, with the weaker engine's
 * rendering LAST, means the final thing the owner reads before acting is the one
 * least connected to the model.
 */
describe("one captain, not two and not seven", () => {
  it("recommends exactly one captain", async () => {
    const { container } = await mountPage();
    /* Asserted on the armband marker rather than on however many bold "Captain"
       labels a layout happens to have. One armband on the pitch, and the tile that
       names him is the same player — two elements, one recommendation. Counting
       bold text was a proxy for this and broke the moment the layout changed. */
    const markers = container.querySelectorAll("[data-testid='captain-marker']");
    expect(markers).toHaveLength(1);
    const armband = container.querySelector("[data-testid='tile-armband']");
    expect(armband?.textContent).toContain("B.Fernandes");
  });

  it("names the model's captain, not the heuristic's", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    expect(text).toContain("B.Fernandes");
    // Mbeumo is one of the fifteen and appears in the squad and the grid, so the
    // assertion is about the armband rather than about the name at all.
    expect(text).not.toMatch(/Captain\s*Mbeumo/);
  });

  it("draws no vice-captain, because nothing on the page recommends one", async () => {
    const { container } = await mountPage();
    expect(container.textContent).not.toMatch(/vice/i);
  });

  it("does not draw the heuristic engine's six-week armband list", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Captaincy plan");
    // "8.8" is `projectedCaptainPoints`, already doubled. Beside the model's
    // undoubled 5.77 it made the weaker player look like the stronger pick.
    expect(text).not.toContain("8.8");
  });

  it("suggests no transfer anywhere on the page", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    expect(text).toMatch(/No transfer is suggested/);
    expect(container.querySelector("[data-testid='tile-transfer']")?.textContent)
      .toContain("one published week cannot price a sale");
    expect(text).not.toContain("over 4 GW");
    expect(text).not.toContain("elite ownership");
    expect(text).not.toContain("Gabriel");
  });
});

/**
 * ONE total, and it states its counting rule.
 *
 * `/now` printed 48.20 and `/margin` printed 54.9 for the same squad and the same
 * artifact; the difference was the captain's projection counted twice on one of
 * them. Both were defensible and neither screen said which it was, which is the
 * defect — not the arithmetic.
 */
describe("the projected total says how it was counted", () => {
  it("carries the 'captain not doubled' qualifier", async () => {
    const { container } = await mountPage();
    expect(container.textContent).toMatch(/XI total, captain not doubled/);
  });

  it("prints the bare XI sum and not the sum plus the armband", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    // 42.60 is the eleven; 48.37 is that eleven with B.Fernandes counted twice,
    // which is the key `optimiseXi` compares formations on and never renders.
    expect(text).toContain("42.60");
    expect(text).not.toContain("48.37");
  });

  it("shows the captain's doubling on the armband tile, where it was asked for", async () => {
    const { container } = await mountPage();
    /* Both halves, in that order: the bare projection, an arrow, the doubled
       figure, then the word. The doubling is the one place a captain's points are
       counted twice on this page, and showing only the product would leave a
       reader unable to tell which counting rule produced it. */
    const armband = container.querySelector("[data-testid='tile-armband']")?.textContent ?? "";
    expect(armband).toMatch(/5\.77/);
    expect(armband).toMatch(/11\.54\s*doubled/);
  });
});

/**
 * The distribution glyphs.
 *
 * The best thing in this frontend: q10–q90 with the median, the mean and the mode
 * on it, drawn per player in the planner's xP column. It is the only mark in the
 * app that shows a projection as a spread rather than as a point estimate, and
 * the front page would be poorer than `/margin` without it.
 */
describe("the distribution glyphs render", () => {
  it("draws a glyph, described in words for a screen reader", async () => {
    await mountPage();
    const glyphs = screen.getAllByRole("img");
    expect(glyphs.length).toBeGreaterThan(0);
    // The label is the glyph in words; without it the mark is decoration.
    expect(glyphs.some((g) => /median/.test(g.getAttribute("aria-label") ?? "")))
      .toBe(true);
  });

  it("draws one for every projected player in the grid", async () => {
    await mountPage();
    // Fifteen rows, every one of them projected in the fixture.
    expect(screen.getAllByRole("img").length).toBe(SQUAD.players.length);
  });

  it("names the measured quantiles rather than a derived spread", async () => {
    await mountPage();
    const label = screen
      .getAllByRole("img")
      .map((g) => g.getAttribute("aria-label") ?? "")
      .find((l) => l.includes("median"));
    expect(label).toMatch(/q10 0 to q90 11/);
    expect(label).toMatch(/middle half 1 to 7/);
  });
});

/**
 * The horizon rail, and the claim it must not make.
 *
 * This block replaces four assertions about `Planner`, the multi-week table this
 * page used to carry. The defect they guarded is unchanged and is the reason they
 * are still here in a new shape: a grid of eight weeks beside an eleven invites
 * the reader to read a rotation plan off it, and only ONE week has been solved.
 *
 * `Planner` handled that by drawing later weeks as fixtures and dimming nothing
 * it had not solved. The rail handles it differently — it shows per-player
 * PROJECTIONS rather than any lineup at all, so there is no start/bench mark
 * across the horizon to be wrong about. What must survive is the sentence saying
 * so, because without it a heat grid of eight columns looks exactly like a plan.
 */
describe("the horizon rail does not claim an eleven it has not solved", () => {
  it("says in words that these are projections and not a lineup", async () => {
    const { container } = await mountPage();
    expect(container.textContent).toMatch(/per-player projections, not a lineup/);
  });

  it("names the one week that was solved, and points elsewhere for the rest", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    expect(text).toMatch(/Only this gameweek has a\s+solved eleven/);
    // The weeks that WERE solved are the decision artifact's, drawn by
    // `PlanGridSection` under its own heading further down.
    expect(text).toContain("Week by week");
  });

  it("draws no horizon columns at all when the projection carries no horizon", async () => {
    /**
     * The fixture in this suite publishes `horizon: null`, which is the normal
     * state for a run that solved one week. Eight columns of dots would imply
     * seven weeks were considered and came back empty; one line saying there is
     * no horizon is the honest rendering of a horizon that does not exist.
     */
    const { container } = await mountPage();
    expect(container.querySelectorAll("[data-testid='horizon-row']")).toHaveLength(0);
    expect(container.textContent).toMatch(/solved no horizon/);
  });

  it("still recomputes the total off the eleven on screen, not off a stored one", async () => {
    /**
     * The interaction the redesign exists for, and the invariant that makes it
     * safe: there is nowhere for a stale total to live, because the total is
     * derived from the eleven every render. Benching a player must move the
     * headline figure — a screen that kept them in step by hand is the class of
     * bug that had two surfaces printing different sums for one squad.
     */
    const { container } = await mountPage();
    const before = container.querySelector("[data-testid='tile-xi']")?.textContent ?? "";
    const row = container.querySelector("[data-testid='eleven-row']") as HTMLElement;
    fireEvent.click(row);
    const after = container.querySelector("[data-testid='tile-xi']")?.textContent ?? "";
    expect(after).not.toBe(before);
    // Ten in the eleven, and the benched one has moved to the bench block.
    expect(container.querySelectorAll("[data-testid='eleven-row']")).toHaveLength(10);
  });
});

/**
 * Absence, which is the normal state of this app for most of a gameweek cycle.
 *
 * The agent is deadline-gated, so "mostly empty" is the base case rather than an
 * edge case — and every improvement to how articulately absence is explained
 * pushes the content that answers the question further down the page. The rule is
 * that absence never occupies more space than substance.
 */
describe("absence sits below the answers, and quietly", () => {
  it("costs one line when the projection is absent, not a card above the page", async () => {
    const { container } = await mountPage({ projections: null });
    const line = container.querySelector("[data-weight='line']");
    expect(line).not.toBeNull();
    expect(line?.tagName).toBe("P");
    /* And nothing above it is a panel. The board cannot draw an eleven without a
       projection — there is nothing to score — so this absence legitimately costs
       the whole board, and the check that matters is that it costs ONE LINE rather
       than a bordered card. The deadline, the capture link and the solved-plan
       section all still render, so one absent artifact has not blanked the page. */
    expect(container.querySelectorAll("[data-testid='pitch-tile']")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /Capture what you actually submitted/ }))
      .toBeInTheDocument();
    expect(container.querySelector("[data-testid='deadline-clock']")).not.toBeNull();
  });

  it("puts the answer above the plan that supports it, in the source", async () => {
    /* Source-level: the ordering is a property of the composition, and rendering
       it under every combination of artifacts would assert the mocks.

       Three components used to be ordered here — GameweekCall, then SquadBoard,
       then ScoreView — on the principle that the model speaks first. There is now
       one board, so what is left to order is the board against the solved plan
       below it: the board answers this week, and "Week by week" is context for a
       decision the board has already stated. */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/page.tsx", "utf8");
    const board = source.indexOf("<CallBoard gameweek={gameweek} />");
    expect(board).toBeGreaterThan(-1);
    expect(board).toBeLessThan(source.indexOf("<PlanGridSection"));
    // And the three it replaced are mounted nowhere.
    for (const gone of ["<GameweekCall />", "<SquadBoard />", "<ScoreView"]) {
      expect(source, `${gone} is still mounted`).not.toContain(gone);
    }
  });

  it("says so in one line when no resolver can name the gameweek", async () => {
    const { container } = await mountPage({ squad: null, projections: null });
    // The squad is gone with the live route, so the two leading sections state
    // their own absence and the plan says why it cannot be pointed at a file.
    expect(container.textContent).toMatch(/No squad could be read/);
  });
});

/* The `/margin` compatibility pin is gone with the component it pinned.
   Its own docstring set the condition — "it goes when `/margin` goes" — and that
   route has been served a 410 for weeks; `Planner` and `ScoreView` were unmounted
   when the call screen replaced them and are now deleted, so there is no shipped
   behaviour left for it to protect. */

// ─────────────────────────────────────────────────────────────────────────────
// The deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("the deadline is on the page, exactly once", () => {
  /**
   * This app shipped for a week with no deadline anywhere.
   *
   * Two clocks used to run — Margin's countdown and one in the sidebar chrome. The
   * route cut deleted `/margin`, and the same commit removed "the second deadline
   * clock" from the sidebar, a description that was accurate when written and wrong
   * by the time it was applied. Nothing failed: no test asserted that a planner
   * whose purpose is deciding before a deadline shows the deadline, and
   * `compactIstDeadline` sat with zero callers.
   *
   * The count matters as much as the presence. The rule the surviving code was
   * written against is that ONE clock renders: `schedule.py` stamps a duration into
   * `agent_status.reason` when the agent runs, and a second live countdown beside it
   * showed a frozen "71.0h" next to "2d 23h" — two clocks for one deadline, one of
   * them wrong. Two readouts with independent staleness budgets disagree on a
   * Friday, which is the day it matters. So `toHaveLength(1)` below is the assertion
   * that the old defect never had.
   */
  const FORMATTED = "Sat 12 Sept · 15:30 IST";

  it("prints the deadline from the agent's status", async () => {
    const { container } = await mountPage();
    expect(container.textContent).toContain(FORMATTED);
  });

  it("labels it with the gameweek it belongs to", async () => {
    const { container } = await mountPage({ agentGameweek: 4 });
    expect(container.querySelector("[data-testid='deadline-clock']")?.textContent)
      .toContain("GW4 deadline");
  });

  it("renders exactly one clock", async () => {
    const { container } = await mountPage();
    expect(container.querySelectorAll("[data-testid='deadline-clock']"))
      .toHaveLength(1);
    // Belt and braces: the formatted time itself appears once, so a second clock
    // built without the test id still fails.
    expect(container.textContent?.split(FORMATTED).length).toBe(2);
  });

  it("agrees with the tested formatter rather than formatting its own date", async () => {
    // The point of reusing `compactIstDeadline` is that the app has ONE definition
    // of what a deadline looks like. Losing its last caller is what let the clock
    // disappear unnoticed.
    const { compactIstDeadline } = await import("@/lib/formats");
    const { container } = await mountPage();
    expect(container.textContent)
      .toContain(compactIstDeadline("2026-09-12T10:00:00Z"));
  });

  it("says so in one line when the status carries no deadline", async () => {
    const { container } = await mountPage({ deadline: null });
    const line = container.querySelector("[data-testid='deadline-unknown']");
    expect(line?.tagName).toBe("P");
    expect(line?.textContent).toMatch(/no deadline/i);
    expect(container.querySelector("[data-testid='deadline-clock']")).toBeNull();
  });

  it("says so in one line when the status cannot be read at all", async () => {
    const { container } = await mountPage({ agentStatusAbsent: true });
    expect(container.querySelector("[data-testid='deadline-unknown']")?.textContent)
      .toMatch(/could not be read/i);
  });

  it("never shows the formatter's fabricated placeholder", async () => {
    /**
     * `compactIstDeadline` used to return the literal "Fri 21 Aug · 23:00 IST" — a
     * date from the design document — whenever it was handed nothing. On screen an
     * invented deadline is indistinguishable from a measured one, which is the
     * `fpl-portal.ts` failure this repo scans two other surfaces for.
     *
     * The fallback is deleted and `dateStr` is now required, so no caller can ask
     * for it; `lib/formats.test.ts` pins that there is no input for which the
     * function returns a date it was not given. This stays as the end-to-end half of
     * that guarantee: a hardcoded deadline reintroduced anywhere between the
     * artifact and the DOM fails here, at the page, where a reader would see it.
     */
    for (const args of [{ deadline: null }, { agentStatusAbsent: true }]) {
      const { container } = await mountPage(args);
      expect(container.textContent).not.toContain("Fri 21 Aug");
      expect(container.textContent).not.toContain("23:00 IST");
      cleanup();
    }
  });
});

/**
 * What the design council changed, and the reasons it gave.
 *
 * Seven independent lenses reviewed four candidate directions for this screen.
 * These are the three findings that survived into the build, pinned here because
 * each one is a claim about honesty rather than about taste, and each replaced
 * something that looked finished.
 */
describe("the call says what to do, not just how much better it would be", () => {
  it("names the swap, so the delta is an instruction and not a boast", async () => {
    /**
     * The screen printed "+2.26 better than as picked" and never said HOW. The
     * component this one replaced computed `bringIn`/`sitDown`; folding it in
     * kept the number and dropped the action, which makes the figure a claim the
     * reader cannot act on.
     *
     * The fixture starts nobody, so every one of the eleven is a change — what
     * matters is that the line exists and names players, not the exact count.
     */
    const { container } = await mountPage();
    const line = container.querySelector("[data-testid='swap-line']");
    expect(line, "the delta is stated with no way to act on it").not.toBeNull();
    expect(line?.textContent).toMatch(/start|bench/);
  });

  it("puts the fixture rating on screen, not only in a tooltip", async () => {
    /**
     * It lived in a `title` attribute, which does not exist on a phone, for a
     * keyboard, or for a screen reader — leaving the chip's COLOUR as the sole
     * carrier of a five-band quantity, and colour is exactly the channel that
     * collapses under red-green colour blindness.
     */
    const { container } = await mountPage();
    const row = [...container.querySelectorAll("[data-testid='eleven-row']")]
      .find((r) => r.getAttribute("data-player") === "Verbruggen");
    expect(row, "the seeded starter is not in the eleven").toBeDefined();
    // Label and rating both in the text, not one of them in an attribute.
    expect(row?.textContent).toContain("CHE (A)");
    expect(row?.textContent).toContain("4");
  });

  it("keeps a spread on every row, not only on the three it singles out", async () => {
    /**
     * Every candidate direction deleted the per-player interval and left a bare
     * point estimate — the deletion that looks like tidying. A mean without its
     * spread cannot answer the question a captaincy call turns on, and showing it
     * for three players teaches a repeat reader that the other eight are certain.
     */
    const { container } = await mountPage();
    const rows = container.querySelectorAll("[data-testid='eleven-row']");
    const withInterval = [...rows].filter((row) =>
      row.querySelector("[role='img']") !== null);
    expect(withInterval).toHaveLength(rows.length);
    expect(withInterval[0].querySelector("[role='img']")?.getAttribute("aria-label"))
      .toMatch(/median .*middle half .*q10 .* to q90/);
  });

  it("offers the pitch as the second view, not as no view", async () => {
    // The pitch answers "what shape am I playing", which no table does. It is
    // one toggle away rather than deleted.
    const { container } = await mountPage();
    const pitch = screen.getByRole("button", { name: "pitch" });
    fireEvent.click(pitch);
    expect(container.querySelectorAll("[data-testid='pitch-tile']")).toHaveLength(11);
    expect(container.querySelectorAll("[data-testid='eleven-row']")).toHaveLength(0);
  });

  it("links out to where the decision is actually made", async () => {
    /**
     * The panel's blind spot: seven lenses judged this screen as a closed system
     * and none asked what happens after it is read. This is a planner — the
     * binding action happens on FPL's own site, re-typed by the same hands under
     * the same clock, and nothing on either side can notice a mismatch.
     */
    await mountPage();
    const out = screen.getByRole("link", { name: /Set this on FPL/i });
    expect(out.getAttribute("href")).toContain("fantasy.premierleague.com");
    // And the capture link stays: it is the only way the two are reconciled.
    expect(screen.getByRole("link", { name: /Capture what you actually submitted/ }))
      .toBeInTheDocument();
  });
});
