/**
 * The gameweek call, rendered.
 *
 * This replaced advice that came from a competitor's stale CSV via an unvalidated
 * heuristic. Measured on the live app before the change, `/now` opened with:
 *
 *     Transfer  F.Kadıoğlu → Gabriel   +7.5 pts over 4 GW
 *     Captain   B.Fernandes · 14.2 proj · vice Semenyo
 *
 * F.Kadıoğlu is 3.9 xP, the second-best defender in the squad — the app's most
 * prominent advice was to sell the player the model most wants on the pitch, and
 * "14.2 proj" is not a number the projection contains for anybody.
 *
 * So the assertions that matter are the ones tying every rendered number to the
 * projection it came from.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * Every pick carries FPL's own `elementId`, because that is now the join key.
 *
 * The projection and the squad are matched on `elementId` via
 * `pointsFrom`/`optimiseXi` rather than on a folded name and position. These ids
 * used to be `0` on every projection and absent from every pick, which the old
 * name-matching code did not care about — so a fixture that cannot possibly join
 * still produced a full call. Numbering them is what makes these tests exercise
 * the join the app actually performs.
 */
const SQUAD = {
  players: [
    { elementId: 101, name: "Verbruggen", position: "GKP", team: "BHA", price: 4.5, bench: false },
    { elementId: 102, name: "Gvardiol", position: "DEF", team: "MCI", price: 5.5, bench: false },
    { elementId: 103, name: "Calafiori", position: "DEF", team: "ARS", price: 5.5, bench: false },
    { elementId: 104, name: "Shaw", position: "DEF", team: "MUN", price: 4.5, bench: false },
    { elementId: 105, name: "B.Fernandes", position: "MID", team: "MUN", price: 12.0, bench: false },
    { elementId: 106, name: "Szoboszlai", position: "MID", team: "LIV", price: 7.0, bench: false },
    { elementId: 107, name: "Semenyo", position: "MID", team: "MCI", price: 8.5, bench: false },
    { elementId: 108, name: "Mbeumo", position: "MID", team: "MUN", price: 8.0, bench: false },
    { elementId: 109, name: "E.Le Fée", position: "MID", team: "SUN", price: 6.0, bench: false },
    { elementId: 110, name: "João Pedro", position: "FWD", team: "CHE", price: 7.5, bench: false },
    { elementId: 111, name: "Thiago", position: "FWD", team: "BRE", price: 8.0, bench: false },
    { elementId: 112, name: "Kinsky", position: "GKP", team: "TOT", price: 4.5, bench: true },
    { elementId: 113, name: "Mateta", position: "FWD", team: "CRY", price: 6.5, bench: true },
    { elementId: 114, name: "Thomas", position: "DEF", team: "COV", price: 4.0, bench: true },
    { elementId: 115, name: "F.Kadıoğlu", position: "DEF", team: "BHA", price: 4.5, bench: true },
  ],
  value: 96.5, bank: 3.5, formation: "3-5-2", source: "captured_authenticated_draft",
};

/** Real values from `xp_public_gw01.json`. */
const XP: Record<string, number> = {
  Verbruggen: 3.63, Gvardiol: 0.78, Calafiori: 2.40, Shaw: 3.07,
  "B.Fernandes": 5.77, Szoboszlai: 4.04, Semenyo: 3.07, Mbeumo: 3.91,
  "E.Le Fée": 5.06, "João Pedro": 2.68, Thiago: 5.12,
  Kinsky: 2.23, Mateta: 1.32, Thomas: 1.17, "F.Kadıoğlu": 3.85,
};

const PROJECTIONS = SQUAD.players.map((p) => ({
  elementId: p.elementId, name: p.name, team: null, position: p.position,
  xp: XP[p.name] ?? null, xpSd: null, mode: 2, pAppears: null, p60: null,
  eMinutes: null, pGoal: null, pCleanSheet: null, pGe5: null, pGe10: null,
  q10: null, q90: null, decomposition: null, blank: false,
}));

type Squad = typeof SQUAD;
type Projections = typeof PROJECTIONS;

/**
 * Typed explicitly so `{ projections: null }` is a legal call.
 *
 * Inferring the defaults gave `projections` the type of the fixture array, and
 * the "absent projection" test below has been a standing `tsc` error ever since
 * it was written — passing `null` to a parameter whose type came from a non-null
 * default. The absent case is a real state, so the signature admits it.
 */
function mountWith(
  {
    squad = SQUAD as Squad | null,
    projections = PROJECTIONS as Projections | null,
    conflicts = [] as Array<{ player: string }>,
    producedAt = null as string | null,
  }: {
    squad?: Squad | null;
    projections?: Projections | null;
    conflicts?: Array<{ player: string }>;
    /** The projection's own timestamp, which is where its age must come from. */
    producedAt?: string | null;
  } = {},
) {
  vi.resetModules();
  const ok = (value: unknown, producedAt: string | null = null) => ({
    artifact: {
      state: value === null ? "absent" : "ok",
      provenance: { source: "local", producedAt, ageMs: null },
      reason: null, value,
    },
  });
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ok({ squad, event: { id: 1, deadlineTime: null } }),
  }));
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: (d: { key?: string }) =>
      String(d?.key).startsWith("projections")
        ? ok(projections === null ? null : { players: projections }, producedAt)
        : ok({ conflicts, fringeMinutes: 45, nailedMinutes: 75,
               ambiguousSurnames: new Map(), generatedAt: null, note: null }),
  }));
  vi.doMock("@/lib/data/artifact", async (o) => {
    const actual = await o<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/GameweekCall");
}

describe("the captain", () => {
  it("is the highest xP in the eleven, with the number it came from", async () => {
    const { default: C } = await mountWith();
    const { container } = render(<C />);
    expect(container.textContent).toContain("B.Fernandes");
    expect(container.textContent).toContain("5.77 xP");
  });

  it("shows the doubled value, since that is what the armband is worth", async () => {
    const { default: C } = await mountWith();
    expect(render(<C />).container.textContent).toContain("11.54");
  });

  it("never prints a number the projection does not contain", async () => {
    // The heuristic this replaced showed "14.2 proj" for the same player.
    const { default: C } = await mountWith();
    expect(render(<C />).container.textContent).not.toContain("14.2");
  });
});

describe("the eleven", () => {
  it("finds the swap the model wants", async () => {
    // Kadıoğlu 3.85 is benched while Gvardiol 0.78 starts.
    const { default: C } = await mountWith();
    const text = render(<C />).container.textContent ?? "";
    expect(text).toContain("F.Kadıoğlu");
    expect(text).toContain("Gvardiol");
    expect(text).toMatch(/39\.5\d → 42\.6\d/);
  });

  it("keeps the formation legal — one keeper, three defenders, one forward", async () => {
    /**
     * The greedy fill is only correct because the constraints are minimums. If it
     * ever returned two keepers or two defenders the "best XI" would be a squad
     * FPL would reject, and the +xP would be unearnable.
     */
    const { default: C } = await mountWith();
    const text = render(<C />).container.textContent ?? "";
    // Kinsky (the second keeper, 2.23) must never be brought in over an outfielder.
    expect(text).not.toContain("Kinsky");
  });

  it("says so when the XI is already optimal, rather than inventing a change", async () => {
    const optimal = {
      ...SQUAD,
      players: SQUAD.players.map((p) => ({
        ...p,
        bench: ["Kinsky", "Mateta", "Thomas", "Gvardiol"].includes(p.name),
      })),
    };
    const { default: C } = await mountWith({ squad: optimal });
    expect(render(<C />).container.textContent).toMatch(/already the best eleven/i);
  });
});

describe("what it refuses to do", () => {
  it("does not suggest a transfer", async () => {
    /**
     * The discipline that the heuristic lacked. A transfer needs several
     * gameweeks and a sell-value model; the projection covers one. Offering one
     * anyway is exactly how "sell your 3.9 xP defender" got onto the page.
     */
    const { default: C } = await mountWith();
    expect(render(<C />).container.textContent).toMatch(/No transfer is suggested/i);
  });

  it("badges itself as the model, not the heuristic", async () => {
    const { default: C } = await mountWith();
    const text = render(<C />).container.textContent ?? "";
    expect(text).toContain("MODEL");
    expect(text).toContain("xp_public_gw01.json");
  });

  it("names any player whose projection the evidence disputes", async () => {
    // A recommendation resting on a contested projection must say so, or it is
    // more confident than its inputs.
    const { default: C } = await mountWith({ conflicts: [{ player: "Gvardiol" }] });
    const text = render(<C />).container.textContent ?? "";
    expect(text).toMatch(/Evidence disputes/i);
    expect(text).toContain("Gvardiol");
  });

  it("stays quiet about evidence when there is none", async () => {
    const { default: C } = await mountWith({ conflicts: [] });
    expect(render(<C />).container.textContent).not.toMatch(/Evidence disputes/i);
  });

  it("is one line when the projection is absent, not a panel", async () => {
    const { default: C } = await mountWith({ projections: null });
    const { container } = render(<C />);
    expect(container.querySelector("[data-weight='line']")).toBeTruthy();
  });
});

/**
 * The join, which is where a call can silently lose a player.
 *
 * This component used to match the squad against the projection on a folded name
 * plus position and refuse the match on collision. A refused match here did not
 * print a dash — it removed the player from the pool, so the "best eleven" was
 * chosen from fourteen, or the card collapsed entirely to "the projection does not
 * cover enough of the squad". Today's shipped `xp_public_gw01.json` contains two
 * such collisions (`kamara/MID`, `sangare/MID`), so this is a live shape rather
 * than an invented one.
 */
describe("two players who fold to the same name and position", () => {
  const COLLIDING = {
    ...SQUAD,
    players: SQUAD.players.map((p) => (
      // Both midfielders become "Kamara/MID" — the exact collision in the live
      // artifact — while keeping their own ids and their own projections.
      p.name === "B.Fernandes" || p.name === "Mbeumo"
        ? { ...p, name: "Kamara" }
        : p
    )),
  };

  const COLLIDING_PROJECTIONS = PROJECTIONS.map((p) => (
    p.name === "B.Fernandes" || p.name === "Mbeumo" ? { ...p, name: "Kamara" } : p
  ));

  it("keeps both, because the join is on FPL's id and not on the name", async () => {
    const { default: C } = await mountWith({
      squad: COLLIDING, projections: COLLIDING_PROJECTIONS,
    });
    const text = render(<C />).container.textContent ?? "";
    // Fernandes is still the captain at his own 5.77, not dropped and not given
    // Mbeumo's 3.91.
    expect(text).toContain("5.77 xP");
    expect(text).not.toMatch(/does not cover enough/i);
  });

  it("still solves the same eleven as it does with distinct names", async () => {
    const { default: Plain } = await mountWith();
    const before = render(<Plain />).container.textContent ?? "";
    cleanup();
    const { default: Collided } = await mountWith({
      squad: COLLIDING, projections: COLLIDING_PROJECTIONS,
    });
    const after = render(<Collided />).container.textContent ?? "";
    // The totals are the assertion: a dropped player changes them.
    const totals = (t: string) => t.match(/\d+\.\d\d → \d+\.\d\d/)?.[0];
    expect(totals(after)).toBe(totals(before));
  });
});

/**
 * One definition of "projected total", stated on the surface that prints it.
 *
 * `/now` printed 48.20 and `/margin` printed 54.9 for the same squad and the same
 * artifact — the difference was the captain's projection, added once more on
 * `/margin`. Both were defensible and neither screen said which it was. So the
 * number is now the bare XI sum on both, and this surface names that.
 */
describe("the projected total", () => {
  it("says the captain is not doubled in it", async () => {
    const { default: C } = await mountWith();
    expect(render(<C />).container.textContent)
      .toMatch(/captain not doubled/i);
  });

  it("is the bare sum of the eleven, not the sum plus the armband", async () => {
    const { default: C } = await mountWith();
    const text = render(<C />).container.textContent ?? "";
    // 42.60 is the XI sum; 48.37 is that sum with B.Fernandes counted twice, and
    // it is what `optimiseXi` compares formations on. It must not be rendered.
    expect(text).toContain("42.60");
    expect(text).not.toContain("48.37");
  });
});

describe("it is actually mounted", () => {
  it("appears on /now", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/now/page.tsx", "utf8");
    expect(page).toContain("<GameweekCall />");
  });

  it("sits above the heuristic squad board", async () => {
    // Order is the message: the model speaks first.
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/now/page.tsx", "utf8");
    expect(page.indexOf("<GameweekCall />")).toBeLessThan(page.indexOf("<SquadBoard />"));
  });
});

describe("the age of the numbers this card is made of", () => {
  /**
   * This card names the captain, the doubling, the XI swap, both totals and every
   * per-player xP on the page the owner opens to decide the armband — and carried no age
   * at all. A projection fitted before a press conference read exactly like one fitted
   * after it, which is the difference the whole evidence surface exists to surface.
   */
  it("states the projection's age beside the file it names", async () => {
    const { default: C } = await mountWith({ producedAt: "2026-08-18T06:00:00Z" });
    const text = render(<C />).container.textContent ?? "";
    expect(text).toContain("xp_public_gw01.json");
    // ageLine renders "as at ..." beyond a day and "Nh old" within one; either is an age.
    expect(text).toMatch(/as at |\dh old/);
  });

  it("says nothing rather than guessing when the artifact carries no timestamp", async () => {
    // producedAt is null on an artifact whose writer stamped none. Inventing "0h old"
    // there would be the same defect the squad line had.
    const { default: C } = await mountWith({ producedAt: null });
    const text = render(<C />).container.textContent ?? "";
    expect(text).toContain("xp_public_gw01.json");
    expect(text).not.toMatch(/0h old/);
  });
});
