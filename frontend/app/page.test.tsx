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

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Planner } from "@/components/margin/Planner";
import type { FixtureMatrixRow, SquadPlayer } from "@/lib/data/heuristics";
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
    { elementId: 1, name: "Verbruggen", position: "GKP", team: "BHA", price: 4.5, bench: false, fixtures: RUN },
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
    expect(container.querySelector("[data-testid='gameweek-call']")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your call");
  });

  it("names no gameweek in its own chrome", async () => {
    /**
     * The gameweek is named once, by `GameweekCall`, beside the artifact it was
     * read from — `xp_public_gw01.json`. `/now`'s heading was the literal
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
    // GameweekCall, SquadBoard and ScoreView all key a projection off the week.
    expect(weeks).toEqual(["projections:07"]);
  });

  it("names that same gameweek everywhere it names one", async () => {
    const { container } = await mountPage(DIVERGED);
    const text = container.textContent ?? "";
    // GameweekCall's provenance line, beside the call it computed.
    expect(text).toContain("xp_public_gw07.json");
    expect(text).not.toContain("xp_public_gw06.json");
    // The planner, three sections down, which used to print the other one.
    expect(text).toContain("Planner · GW7");
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
     * The reason there is no `?? 1` here. `xp_public_gw01.json` EXISTS, so a
     * guess of 1 does not 404 into an honest `absent` — it renders GW1's numbers
     * as though they were this week's, for 37 weeks of 38, silently.
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
    // Counting the bold `Captain` label counts recommendations; counting the word
    // would also catch the section heading, which recommends nothing.
    const labels = [...container.querySelectorAll("strong")]
      .filter((node) => (node.textContent ?? "").trim() === "Captain");
    expect(labels).toHaveLength(1);
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

  it("shows the captain's doubling on the captain's own line, where it was asked for", async () => {
    const { container } = await mountPage();
    expect(container.textContent).toMatch(/doubled\s*11\.54/);
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
 * The planner, and the two marks that used to speak for weeks nobody solved.
 */
describe("the planner does not claim a horizon it has not got", () => {
  it("is titled with the one gameweek it solves", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Planner · GW1");
    expect(text).not.toContain("Planner · GW1–GW6");
  });

  it("still draws six columns, because a fixture list is scheduled rather than forecast", async () => {
    const { container } = await mountPage();
    const text = container.textContent ?? "";
    for (const week of [1, 2, 3, 4, 5, 6]) expect(text).toContain(`GW${week}`);
  });

  it("says in words that no eleven is chosen for the later weeks", async () => {
    const { container } = await mountPage();
    expect(container.textContent).toMatch(/no eleven is chosen for them/);
  });

  it("dims this week's non-starters and no week that was never solved", async () => {
    /**
     * The ink at 0.45 means "does not make the eleven" everywhere in this app. On
     * five of six columns it was a benching nobody computed, sitting three inches
     * above a footnote saying no eleven is chosen for those weeks.
     */
    const { container } = await mountPage();
    const benched = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((row) => row.getAttribute("data-starting") === "false");
    expect(benched, "no benched row to check").toBeDefined();
    const cells = [...(benched?.querySelectorAll("[data-testid='planner-cell']") ?? [])]
      .map((cell) => (cell as HTMLElement).style.opacity);
    // GW1 is solved, so a non-starter there is genuinely out of the eleven.
    expect(cells[0]).toBe("0.45");
    // GW2 onward are not solved, so nothing there is out of anything.
    expect(cells.slice(1).every((o) => o === "1")).toBe(true);
    expect(cells.length).toBe(6);
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
    // And the squad still renders, so one absent artifact has not blanked the page.
    expect(container.querySelectorAll("[data-testid='squad-player']").length)
      .toBe(SQUAD.players.length);
  });

  it("puts the answers above every absence statement in the source", async () => {
    // Source-level: the ordering is a property of the composition, and rendering
    // it under every combination of five artifacts would assert the mocks.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/page.tsx", "utf8");
    expect(source.indexOf("<GameweekCall />")).toBeGreaterThan(-1);
    expect(source.indexOf("<GameweekCall />"))
      .toBeLessThan(source.indexOf("<SquadBoard />"));
    expect(source.indexOf("<SquadBoard />")).toBeLessThan(source.indexOf("<ScoreView"));
  });

  it("says so in one line when no resolver can name the gameweek", async () => {
    const { container } = await mountPage({ squad: null, projections: null });
    // The squad is gone with the live route, so the two leading sections state
    // their own absence and the plan says why it cannot be pointed at a file.
    expect(container.textContent).toMatch(/No squad could be read/);
  });
});

/**
 * `/margin` renders exactly as it did. This is the compatibility pin.
 *
 * The two new props on `Planner` and `ScoreView` default to the shipped
 * behaviour, so the old route is untouched while the two surfaces are compared
 * side by side. These assertions pin the defaults, including the dimming the spec
 * calls a defect — deliberately. It goes when `/margin` goes, and until then a
 * silent change to it would be a change to a live route.
 */
describe("the default behaviour /margin depends on is unchanged", () => {
  const fifteen: SquadPlayer[] = SQUAD.players.map((p) => ({ ...p })) as SquadPlayer[];
  const projections = PROJECTIONS as unknown as Projection[];
  const matrix = FIXTURE_MATRIX as unknown as FixtureMatrixRow[];

  function drawDefault() {
    return render(
      <Planner
        squad={fifteen}
        projections={projections}
        horizon={null}
        decisionDraws={10000}
        prices={new Map(fifteen.map((p) => [p.elementId as number, p.price ?? 0]))}
        fixtureMatrix={matrix}
        bank={3.5}
        gameweek={1}
      />,
    );
  }

  it("keeps the GW1–GW6 range in the title", () => {
    expect(drawDefault().container.textContent).toContain("Planner · GW1–GW6");
  });

  it("keeps dimming every week a player does not start, solved or not", () => {
    /**
     * `cells.every(...)` on its own passes with ZERO cells examined, so this used
     * to be satisfied by a `/margin` that had stopped rendering non-starting rows
     * at all — the opposite of the behaviour it is here to pin. The sibling
     * assertion above guards it properly; this now does the same.
     */
    const { container } = drawDefault();
    const benched = [...container.querySelectorAll("[data-testid='planner-row']")]
      .find((row) => row.getAttribute("data-starting") === "false");
    expect(benched, "no benched row to check").toBeDefined();
    const cells = [...(benched?.querySelectorAll("[data-testid='planner-cell']") ?? [])]
      .map((cell) => (cell as HTMLElement).style.opacity);
    expect(cells.length, "no cells to check, so `every` would pass vacuously")
      .toBe(6);
    expect(cells.every((o) => o === "0.45")).toBe(true);
  });
});

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
