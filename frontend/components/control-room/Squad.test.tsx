/**
 * The section, and the mislabel it is built to prevent.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Squad } from "@/components/control-room/Squad";
import { TAIL_THRESHOLD } from "@/lib/control-room/model";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

const SQUAD = [
  { name: "Verbruggen", position: "GKP", team: "BHA", price: 4.5, fixtures: [], elementId: 1 },
  { name: "Gabriel", position: "DEF", team: "ARS", price: 6.0, fixtures: [], elementId: 2 },
  { name: "Maguire", position: "DEF", team: "MUN", price: 5.5, fixtures: [], elementId: 3 },
  { name: "B.Fernandes", position: "MID", team: "MUN", price: 9.0, fixtures: [], elementId: 4,
    role: "captain" },
  { name: "Mbeumo", position: "MID", team: "MUN", price: 8.0, fixtures: [], elementId: 5 },
  { name: "Isak", position: "FWD", team: "LIV", price: 10.5, fixtures: [], elementId: 6 },
  { name: "Kinsky", position: "GKP", team: "TOT", price: 4.0, fixtures: [], elementId: 7,
    bench: true },
] as unknown as SquadPlayer[];

const PROJECTIONS = SQUAD.map((p, i) => ({
  elementId: (p as { elementId: number }).elementId,
  name: p.name, team: p.team, position: p.position,
  xp: 3 + i * 0.5, xpSd: 2, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 88,
  pGoal: 0.2, pCleanSheet: null, pGe5: 0.3, pGe10: 0.1,
  q10: 1, q25: 2, q50: 3, q75: 5, q90: 8,
})) as unknown as Projection[];

const BASE = {
  squad: SQUAD, projections: PROJECTIONS, gameweek: 1,
  squadAge: "6h old", squadSource: "captured_authenticated_draft",
  botPath: null as string | null, initialising: false,
};

afterEach(() => cleanup());

describe("a focused bot", () => {
  const BOT = { ...BASE, botPath: "fpl/decision_public_gw01_season.json" };

  it("shows no squad at all, rather than mine under its name", () => {
    render(<Squad {...BOT} team="ronny" />);
    expect(screen.getByTestId("squad-absent")).toBeTruthy();
    // The most misleading thing this page could do is relabel my fifteen.
    expect(screen.queryByText("B.Fernandes")).toBeNull();
    expect(screen.queryByTestId("band-count-midfield")).toBeNull();
  });

  it("names the artifact its squad would have come from", () => {
    render(<Squad {...BOT} team="wazza" />);
    expect(screen.getByText(/decision_public_gw01_season\.json · never written/))
      .toBeTruthy();
  });

  it("says it is reading, not that nothing exists, while the fetch is open", () => {
    render(<Squad {...BOT} team="ronny" initialising />);
    expect(screen.getByText(/Reading fpl\/decision_public_gw01_season\.json/))
      .toBeTruthy();
    expect(screen.queryByText(/has proposed no squad/)).toBeNull();
  });
});

describe("my own squad", () => {
  it("bands the eleven and puts the reserve keeper below the rule", () => {
    render(<Squad {...BASE} team="mine" />);
    expect(screen.getByTestId("band-count-defence").textContent).toBe("2");
    expect(screen.getByTestId("band-count-midfield").textContent).toBe("2");
    expect(screen.getByTestId("bench-rule")).toBeTruthy();
  });

  it("carries the MUN cluster, which is the point of the summary", () => {
    render(<Squad {...BASE} team="mine" />);
    expect(screen.getByTestId("cluster-MUN")).toBeTruthy();
    expect(screen.queryByTestId("cluster-ARS")).toBeNull();
  });

  it("quotes the threshold the model actually optimises", () => {
    render(<Squad {...BASE} team="mine" />);
    expect(screen.getByTestId("cluster-spread-MUN").getAttribute("title"))
      .toContain(`P(GW ≥ ${TAIL_THRESHOLD})`);
  });

  it("attributes the squad to the capture it came from", () => {
    render(<Squad {...BASE} team="mine" />);
    expect(screen.getByText("captured_authenticated_draft")).toBeTruthy();
  });

  it("refuses to assemble a plausible fifteen from nothing", () => {
    render(<Squad {...BASE} team="mine" squad={null} />);
    expect(screen.getByText(/does not assemble a plausible fifteen/)).toBeTruthy();
  });

  it("refuses the numbers when no week is resolved, but still lays out the squad", () => {
    /* The projections descriptor falls back to week 1's path so the hook is
       unconditional, so a readable artifact proves nothing about WHICH week it is. */
    render(<Squad {...BASE} team="mine" gameweek={null} />);
    expect(screen.getByTestId("band-count-midfield").textContent).toBe("2");
    expect(screen.getByTestId("band-total-midfield").textContent).toBe("∅");
    expect(screen.getByTestId("cluster-xp-MUN").textContent).toBe("∅");
    expect([...new Set(
      screen.getAllByTestId("minutes-cell").map((c) => c.textContent),
    )]).toEqual(["∅"]);
  });

  it("shows the numbers once a week IS resolved", () => {
    render(<Squad {...BASE} team="mine" gameweek={1} />);
    expect(screen.getByTestId("band-total-midfield").textContent).not.toBe("∅");
  });

  it("names a pick it could not band", () => {
    const odd = [...SQUAD, { name: "Nobody", position: "AM", team: "ARS", price: 4,
      fixtures: [] }] as unknown as SquadPlayer[];
    render(<Squad {...BASE} team="mine" squad={odd} />);
    expect(screen.getByTestId("squad-unplaced").textContent).toContain("Nobody");
  });
});
