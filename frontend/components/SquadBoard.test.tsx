/**
 * The squad board's two provenance lines, which nothing tested.
 *
 * Both defects below were live and both were invisible to the suite: it went from
 * 821 passing to 821 passing across the fix, because no test rendered this
 * component's header line at all.
 *
 *  1. **A fabricated bank balance.** `fpl-live-server.ts` coerced FPL's
 *     `last_deadline_bank: null` — which means "no deadline has passed yet" — to
 *     `0`, and this component printed `money(0)` as "£0.0m in the bank". A
 *     confident, specific, wrong number about the one quantity a transfer
 *     decision turns on. The consumer type had been `number | null` the whole
 *     time; only the producer refused to use it.
 *
 *  2. **A dead source comparison.** The check was `squad.source === "live"`,
 *     and the server emits `official_public` or `captured_authenticated_draft`.
 *     So the branch could never be taken, and the comment above it — "Never
 *     presented as live when it is a draft" — described behaviour that did not
 *     exist. Both cases printed the raw enum identifier to the user.
 *
 * These are tested by rendering and reading the DOM. A source-text assertion
 * would have passed against both bugs.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const PLAYERS = [
  { name: "Raya", position: "GKP", team: "Arsenal", price: 5.5 },
  { name: "Gabriel", position: "DEF", team: "Arsenal", price: 6.0 },
  { name: "Saka", position: "MID", team: "Arsenal", price: 10.0 },
  { name: "Isak", position: "FWD", team: "Liverpool", price: 10.5 },
];

/**
 * The same fifteen with FPL's own ids on both sides.
 *
 * The board joins on `elementId` first now, so the id path needs its own fixture.
 * The name-and-position fallback still has to work — a captured draft can arrive
 * without ids — which is what every `PLAYERS`-based test above continues to cover.
 */
const IDS: Record<string, number> = { Raya: 1, Gabriel: 2, Saka: 3, Isak: 4 };

function mountWith(
  squad: Record<string, unknown> | null,
  projections: Array<Record<string, unknown>> | null = null,
) {
  vi.resetModules();
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({
      artifact: {
        state: "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: null,
        value: { squad },
      },
    }),
  }));
  // Mocked because the component reads a second artifact. Left unmocked, the real
  // hook issues a fetch under jsdom that no test controls, so every xP assertion
  // below would be racing a network call — and its default `absent` result makes
  // "the projection is missing" indistinguishable from "the match failed", which
  // is exactly the distinction these tests exist to pin.
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: projections === null
        ? { state: "absent", value: null }
        : { state: "ok", value: { players: projections } },
      initialising: false,
      reload: () => {},
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/SquadBoard");
}

const BASE = {
  players: PLAYERS,
  value: 100.0,
  bank: 1.5,
  formation: "4-4-2",
  source: "official_public",
  sourceLabel: "Official public GW picks",
};

describe("the bank", () => {
  it("prints a known balance", async () => {
    const { default: SquadBoard } = await mountWith(BASE);
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("£1.5m in the bank");
  });

  it("says unknown rather than £0.0m when FPL has not reported one", async () => {
    /**
     * The load-bearing assertion.
     *
     * "£0.0m in the bank" and "unknown" lead to opposite decisions: the first
     * says do not plan a move that needs money, the second says go and look.
     */
    const { default: SquadBoard } = await mountWith({ ...BASE, bank: null });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).not.toContain("£0.0m");
    expect(container.textContent).toMatch(/bank unknown/i);
  });

  it("prints a genuine zero balance as zero", async () => {
    // The distinction only means something if a real 0 still reads as £0.0m — a
    // squad that has actually spent everything is a different fact from one whose
    // bank has never been reported.
    const { default: SquadBoard } = await mountWith({ ...BASE, bank: 0 });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("£0.0m in the bank");
    expect(container.textContent).not.toMatch(/bank unknown/i);
  });
});

describe("the squad source", () => {
  it("calls the official endpoint live", async () => {
    const { default: SquadBoard } = await mountWith(BASE);
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("live from FPL");
  });

  it("never calls a captured draft live", async () => {
    /**
     * The defect: the guard compared against `"live"`, which the field cannot
     * hold, so this case fell through to printing `captured_authenticated_draft`.
     * A stale snapshot must not be able to read as the current team.
     */
    const { default: SquadBoard } = await mountWith({
      ...BASE, source: "captured_authenticated_draft",
    });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).not.toContain("live from FPL");
    expect(container.textContent).toMatch(/captured draft, not live/i);
  });

  it("does not print a raw enum identifier to the user", async () => {
    for (const source of ["official_public", "captured_authenticated_draft"]) {
      const { default: SquadBoard } = await mountWith({ ...BASE, source });
      const { container } = render(<SquadBoard />);
      expect(container.textContent, source).not.toContain(source);
    }
  });

  it("falls back to the raw value for a source it does not know", async () => {
    // Better than hiding it: an unrecognised source means the server changed and
    // the reader should see something rather than nothing.
    const { default: SquadBoard } = await mountWith({ ...BASE, source: "future_thing" });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("future_thing");
  });

  it("says so when there is no source at all", async () => {
    const { default: SquadBoard } = await mountWith({ ...BASE, source: null });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toMatch(/source unknown/i);
  });
});

/**
 * The per-player model projection, which nothing tested when it was added.
 *
 * The feature exists because the fitted `xP` sat unread in a published artifact
 * while the board showed heuristic numbers. What makes it worth testing is not
 * that a number appears — it is that the *join* is right. A wrong join puts
 * another player's points on your card, which is worse than the blank it replaced.
 *
 * The club is deliberately not part of the match, and that is the case most
 * likely to regress: the squad carries FPL's short code (`ARS`) and the
 * projection carries the full club name (`Arsenal`), so a match reaching for the
 * club matches nothing at all. That defect shipped once already — every card read
 * `— xP` while the artifact held a projection for all fifteen.
 */
describe("the model projection", () => {
  const PROJECTIONS = [
    { name: "Raya", team: "Arsenal", position: "GKP", xp: 3.64, eMinutes: 69.4 },
    { name: "Gabriel", team: "Arsenal", position: "DEF", xp: 3.61, eMinutes: 66.2 },
    { name: "Saka", team: "Arsenal", position: "MID", xp: 5.82, eMinutes: 71.0 },
    { name: "Isak", team: "Liverpool", position: "FWD", xp: 4.10, eMinutes: 63.5 },
  ];

  function xpCells(container: HTMLElement): string[] {
    return [...container.querySelectorAll("[data-testid='squad-xp']")]
      .map((node) => node.textContent?.trim() ?? "");
  }

  it("shows the model's xP beside each player it has a view on", async () => {
    const { default: SquadBoard } = await mountWith(BASE, PROJECTIONS);
    const { container } = render(<SquadBoard />);
    expect(xpCells(container)).toEqual(["3.6 xP", "3.6 xP", "5.8 xP", "4.1 xP"]);
  });

  it("matches on position, not on club", async () => {
    /**
     * The load-bearing regression test. The squad's `team` is the short code the
     * live server emits; the projection's is the full club name. If the match
     * ever reaches for the club again every cell returns to `— xP`, and this is
     * what notices.
     */
    const shortCodes = [
      { name: "Raya", position: "GKP", team: "ARS", price: 5.5 },
      { name: "Gabriel", position: "DEF", team: "ARS", price: 6.0 },
      { name: "Saka", position: "MID", team: "ARS", price: 10.0 },
      { name: "Isak", position: "FWD", team: "LIV", price: 10.5 },
    ];
    const { default: SquadBoard } = await mountWith(
      { ...BASE, players: shortCodes }, PROJECTIONS,
    );
    const { container } = render(<SquadBoard />);
    expect(xpCells(container)).not.toContain("— xP");
    expect(container.textContent).toContain("5.8 xP");
  });

  it("prints — xP, not a blank, for a player the projection does not cover", async () => {
    // "The model has no view of this player" and "we did not look" are different
    // facts, and only a printed dash says which one this is.
    const { default: SquadBoard } = await mountWith(
      BASE, PROJECTIONS.filter((p) => p.name !== "Isak"),
    );
    const { container } = render(<SquadBoard />);
    expect(xpCells(container)).toContain("— xP");
    expect(xpCells(container)).toHaveLength(4);
  });

  it("refuses an ambiguous name rather than guessing between two players", async () => {
    /**
     * FPL has six Wilsons. Putting one player's projection on another's card is
     * the one outcome worse than showing nothing, so a duplicate match collapses
     * to `— xP` rather than silently taking the first hit.
     */
    const ambiguous = [
      ...PROJECTIONS,
      { name: "Saka", team: "Chelsea", position: "MID", xp: 1.11, eMinutes: 10 },
    ];
    const { default: SquadBoard } = await mountWith(BASE, ambiguous);
    const { container } = render(<SquadBoard />);
    expect(container.textContent).not.toContain("5.8 xP");
    expect(container.textContent).not.toContain("1.1 xP");
    expect(xpCells(container)).toContain("— xP");
  });

  it("still matches when the two sides spell a name with different accents", async () => {
    // Not hypothetical: F.Kadıoğlu and João Pedro are both in this league, and the
    // Turkish dotless ı does not decompose under NFKD the way the others do.
    const accented = [
      { name: "F.Kadıoğlu", position: "DEF", team: "BHA", price: 4.5 },
      { name: "João Pedro", position: "FWD", team: "CHE", price: 7.5 },
    ];
    const plain = [
      { name: "F.Kadioglu", team: "Brighton", position: "DEF", xp: 3.9, eMinutes: 80 },
      { name: "Joao Pedro", team: "Chelsea", position: "FWD", xp: 2.7, eMinutes: 61 },
    ];
    const { default: SquadBoard } = await mountWith(
      { ...BASE, players: accented }, plain,
    );
    const { container } = render(<SquadBoard />);
    expect(xpCells(container)).toEqual(["3.9 xP", "2.7 xP"]);
  });

  it("shows — xP for every player when no projection is published", async () => {
    // The normal state for most of a gameweek cycle: the agent that writes the
    // artifact is deadline-gated, so the board must work without it.
    const { default: SquadBoard } = await mountWith(BASE, null);
    const { container } = render(<SquadBoard />);
    expect(xpCells(container)).toEqual(["— xP", "— xP", "— xP", "— xP"]);
  });
});

/**
 * The heuristic recommendation card, deleted.
 *
 * `/now` used to name TWO different captains: `GameweekCall`, directly above,
 * takes the argmax of `xp` over the published projection and named B.Fernandes,
 * while this board's HEURISTIC card named Mbeumo — and printed his figure already
 * DOUBLED, because `fpl-ranking-engine.ts` returns `projectedPoints * 2`. So the
 * reader compared the model's undoubled 6.66 against a doubled 8.8 and picked the
 * weaker player. The heuristic's own ranking agreed with the model (capScore 23.37
 * vs 17.34); it lost Fernandes only because `buildCaptaincyPlan` filters on
 * `expectedMinutes >= 60` and he is *estimated* at 59.
 *
 * These assertions exist so the card cannot come back. The board's job is the
 * fifteen and their model projections; the answer is stated once, above it.
 */
describe("what this board no longer recommends", () => {
  const WITH_ENGINE_OUTPUT = {
    // The engine's captaincy and transfer output, present and ignored. Passing it
    // is the point: absence of the card must not depend on absence of the data.
    squad: BASE,
    transfers: [{
      playerOut: { name: "F.Kadıoğlu" }, playerIn: { name: "Gabriel" },
      delta4: 3.8, confidence: 73, rationale: ["0.1% elite ownership adds differential upside"],
    }],
    captaincy: [{
      captain: { name: "Mbeumo" }, viceCaptain: { name: "Semenyo" },
      captainFixture: "HUL (A)", projectedCaptainPoints: 8.8,
    }],
  };

  async function mountWithEngineOutput() {
    vi.resetModules();
    vi.doMock("@/lib/data/useHeuristics", () => ({
      useHeuristics: () => ({
        artifact: {
          state: "ok",
          provenance: { source: "local", producedAt: null, ageMs: null },
          reason: null,
          value: WITH_ENGINE_OUTPUT,
        },
      }),
    }));
    vi.doMock("@/lib/data/useArtifact", () => ({
      useArtifact: () => ({
        artifact: { state: "absent", value: null }, initialising: false, reload: () => {},
      }),
    }));
    vi.doMock("@/lib/data/artifact", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
      return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
    });
    return import("@/components/SquadBoard");
  }

  it("renders no recommendation card at all", async () => {
    const { default: SquadBoard } = await mountWithEngineOutput();
    const { container } = render(<SquadBoard />);
    expect(container.querySelector("[data-testid='the-move']")).toBeNull();
  });

  it("names no captain, so the page cannot hold two answers", async () => {
    const { default: SquadBoard } = await mountWithEngineOutput();
    const { container } = render(<SquadBoard />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/captain/i);
    expect(text).not.toContain("Mbeumo");
  });

  it("suggests no transfer, which is the app's stated policy", async () => {
    const { default: SquadBoard } = await mountWithEngineOutput();
    const { container } = render(<SquadBoard />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/transfer/i);
    // The two claims that could not be checked against anything published: a
    // four-gameweek gain the engine has not solved, and an elite-ownership figure
    // from a gitignored export that is absent from every deployment.
    expect(text).not.toContain("over 4 GW");
    expect(text).not.toContain("elite ownership");
  });
});

/**
 * Two players who fold to the same name AND position.
 *
 * The board used to match on a folded name plus position and refuse on collision,
 * printing `— xP` for both. Not hypothetical: today's shipped `xp_public_gw01.json`
 * holds `kamara/MID` (Aston Villa 47 vs Hull City 293) and `sangare/MID`
 * (Brentford 565 vs Nott'm Forest 488). Joining on FPL's own id resolves them.
 */
describe("a folded name-and-position collision", () => {
  const COLLIDING_SQUAD = {
    ...BASE,
    players: [
      { elementId: 47, name: "Kamara", position: "MID", team: "AVL", price: 5.0 },
      { elementId: 293, name: "Kamara", position: "MID", team: "HUL", price: 4.5 },
    ],
  };
  const COLLIDING_PROJECTIONS = [
    { elementId: 47, name: "Kamara", team: "Aston Villa", position: "MID", xp: 3.20, eMinutes: 74 },
    { elementId: 293, name: "Kamara", team: "Hull City", position: "MID", xp: 1.40, eMinutes: 31 },
  ];

  it("gives each their own projection rather than refusing both", async () => {
    const { default: SquadBoard } = await mountWith(
      COLLIDING_SQUAD, COLLIDING_PROJECTIONS,
    );
    const { container } = render(<SquadBoard />);
    const cells = [...container.querySelectorAll("[data-testid='squad-xp']")]
      .map((n) => n.textContent?.trim() ?? "");
    expect(cells).toEqual(["3.2 xP", "1.4 xP"]);
  });

  it("never puts one colliding player's projection on the other", async () => {
    // The failure worth preventing is not the dash, it is the swap.
    const { default: SquadBoard } = await mountWith(
      COLLIDING_SQUAD, COLLIDING_PROJECTIONS,
    );
    const { container } = render(<SquadBoard />);
    const cards = [...container.querySelectorAll("[data-testid='squad-player']")];
    expect(cards[0]?.textContent).toContain("AVL");
    expect(cards[0]?.textContent).toContain("3.2 xP");
    expect(cards[1]?.textContent).toContain("HUL");
    expect(cards[1]?.textContent).toContain("1.4 xP");
  });

  it("still refuses an ambiguous name when neither side carries an id", async () => {
    // The fallback keeps the old rule: a captured draft with no ids must not be
    // given a guessed neighbour's number.
    const noIds = {
      ...BASE,
      players: COLLIDING_SQUAD.players.map(({ elementId: _id, ...rest }) => rest),
    };
    const { default: SquadBoard } = await mountWith(
      noIds, COLLIDING_PROJECTIONS.map(({ elementId: _id, ...rest }) => rest),
    );
    const { container } = render(<SquadBoard />);
    const cells = [...container.querySelectorAll("[data-testid='squad-xp']")]
      .map((n) => n.textContent?.trim() ?? "");
    expect(cells).toEqual(["— xP", "— xP"]);
  });
});

describe("the id join", () => {
  it("matches on FPL's id even when the two sides spell the name differently", async () => {
    // The name fallback would miss this; the id cannot.
    const { default: SquadBoard } = await mountWith(
      { ...BASE, players: PLAYERS.map((p) => ({ ...p, elementId: IDS[p.name] })) },
      [{ elementId: 3, name: "Bukayo Saka", team: "Arsenal", position: "MID", xp: 5.82, eMinutes: 71 }],
    );
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("5.8 xP");
  });
});

describe("a missing squad", () => {
  it("is one line, not a panel", async () => {
    // Absence must not outweigh substance: the rest of the page works without it.
    const { default: SquadBoard } = await mountWith(null);
    const { container } = render(<SquadBoard />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });
});
