/**
 * The board, its bands, and the one number it refuses to compute.
 *
 * Positions and clubs come from the committed bootstrap fixture rather than a typed
 * formation, so a captured squad that changes shape moves this test's expectations
 * with it. The captured fifteen is a 3-4-3 with MUN as the heaviest cluster.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  bandTotal, clusters, SquadBoard, type SquadBoardPlayer,
} from "@/components/squad/SquadBoard";
import type { Position } from "@/lib/fpl-live";
import { PAPER } from "@/lib/margin/tokens";

const FPL_TYPE: Record<number, Position> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

const BOOTSTRAP = JSON.parse(readFileSync("test/fixtures/bootstrap-min.json", "utf8")) as {
  elements: Array<{ id: number; web_name: string; element_type: number; team: number }>;
  teams: Array<{ id: number; short_name: string }>;
};
const PROJECTIONS = JSON.parse(
  readFileSync("public/predictions/fpl/xp_public_gw01.json", "utf8"),
) as { players: Array<Record<string, number | null>> };

/** The capture, as element ids and bench flags — the shape `CAPTURED_DRAFT` holds. */
const XV: ReadonlyArray<readonly [number, boolean]> = [
  [109, false], [152, false], [4, false], [418, false], [426, false], [94, false],
  [427, false], [542, false], [379, false], [165, false], [106, false],
  [496, true], [368, true], [113, true], [173, true],
];

const SQUAD: readonly SquadBoardPlayer[] = XV.map(([id, benched]) => {
  const element = BOOTSTRAP.elements.find((e) => e.id === id)!;
  const club = BOOTSTRAP.teams.find((t) => t.id === element.team)!.short_name;
  const projection = PROJECTIONS.players.find((p) => p.element_id === id);
  return {
    name: element.web_name,
    club,
    position: FPL_TYPE[element.element_type],
    benched,
    armband: null,
    xp: projection?.xp ?? null,
    opponent: null,
    expectedMinutes: projection?.e_minutes ?? null,
    difficulty: 3,
    distribution: null,
  };
});

afterEach(() => cleanup());

describe("formation bands", () => {
  it("reads the squad's real shape out of the fixture, not a typed formation", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    const count = (band: string) =>
      Number(screen.getByTestId(`band-count-${band}`).textContent);
    expect([count("defence"), count("midfield"), count("attack")]).toEqual([3, 4, 3]);
    expect(count("goalkeeper")).toBe(1);
  });

  it("bands only the XI — the bench has its own section", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    const banded = ["goalkeeper", "defence", "midfield", "attack"]
      .reduce((sum, b) => sum + Number(screen.getByTestId(`band-count-${b}`).textContent), 0);
    expect(banded).toBe(11);
  });

  it("sums a band's xP, because expectation is additive", () => {
    const midfield = SQUAD.filter((p) => !p.benched && p.position === "MID");
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    expect(screen.getByTestId("band-total-midfield").textContent)
      .toBe(bandTotal(midfield)!.toFixed(1));
  });

  it("says ∅ for a band whose players carry no projection", () => {
    const unprojected = SQUAD.filter((p) => p.position === "GKP" && !p.benched)
      .map((p) => ({ ...p, xp: null }));
    render(<SquadBoard players={unprojected} surface={PAPER} />);
    expect(screen.getByTestId("band-total-goalkeeper").textContent).toBe("∅");
    expect(bandTotal(unprojected)).toBeNull();
  });

  it("omits a band the squad has nobody in, rather than printing a zero", () => {
    render(<SquadBoard players={SQUAD.filter((p) => p.position !== "FWD")} surface={PAPER} />);
    expect(screen.queryByTestId("band-attack")).toBeNull();
  });
});

describe("the bench", () => {
  it("sits under the page's one 2px rule", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    expect(screen.getByTestId("bench-rule").style.borderTop).toContain("2px");
  });

  it("numbers the outfield subs in FPL's order and leaves the keeper unnumbered", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    // Kinsky (GKP) is not in the substitution queue; the other three are, in order.
    expect(screen.getAllByTestId("bench-index").map((n) => n.textContent))
      .toEqual(["1", "2", "3"]);
  });
});

describe("club clusters", () => {
  it("finds the clusters the capture actually holds", () => {
    expect(clusters(SQUAD).map((c) => c.club).sort())
      .toEqual(["BHA", "BRE", "CHE", "LIV", "MUN"]);
    expect(clusters(SQUAD)[0]).toMatchObject({ club: "MUN", count: 3 });
  });

  it("orders by count, then by the size of the stake — not alphabetically", () => {
    /* Ties break on xP rather than club code, so the cluster costing the most
       attention sits at the top of its group. LIV outranks BHA here on that rule. */
    const ordered = clusters(SQUAD);
    for (let i = 1; i < ordered.length; i += 1) {
      const [prev, next] = [ordered[i - 1], ordered[i]];
      if (prev.count === next.count) {
        expect(prev.xp!, `${prev.club} before ${next.club}`)
          .toBeGreaterThanOrEqual(next.xp!);
      } else {
        expect(prev.count).toBeGreaterThan(next.count);
      }
    }
  });

  it("counts a bench player into their club's cluster", () => {
    /* LIV is Isak in the XI and Szoboszlai on the bench. A red card in that fixture
       reaches the bench too, via the substitution it triggers. */
    const liverpool = clusters(SQUAD).find((c) => c.club === "LIV")!;
    expect([...liverpool.names].sort()).toEqual(["Isak", "Szoboszlai"]);
  });

  it("ignores a club holding a single player, which is a pick and not a cluster", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    for (const single of ["ARS", "SUN", "TOT", "COV"]) {
      expect(screen.queryByTestId(`cluster-${single}`), single).toBeNull();
    }
  });

  it("sums the cluster's xP but refuses its spread", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} />);
    const mun = clusters(SQUAD).find((c) => c.club === "MUN")!;
    expect(screen.getByTestId("cluster-xp-MUN").textContent).toBe(mun.xp!.toFixed(1));
    // The refusal: no covariance is published, so no spread is shown.
    expect(screen.getByTestId("cluster-spread-MUN").textContent).toBe("∅");
  });

  it("says why the spread is absent, and names both objectives", () => {
    render(<SquadBoard players={SQUAD} surface={PAPER} thresholdLabel="P(GW ≥ 70)" />);
    const title = screen.getByTestId("cluster-spread-MUN").getAttribute("title")!;
    expect(title).toContain("covariance");
    expect(title).toContain("P(GW ≥ 70)");
    expect(title).toMatch(/Ronny/);
    expect(title).toMatch(/Wazza/);
    // No digit may appear where the magnitude would be.
    expect(screen.getByTestId("cluster-spread-MUN").textContent).not.toMatch(/\d/);
  });

  it("renders nothing at all when the squad has no cluster", () => {
    const spread = SQUAD.slice(0, 4).map((p, i) => ({ ...p, club: ["ARS", "BUR", "EVE", "FUL"][i] }));
    render(<SquadBoard players={spread} surface={PAPER} />);
    expect(screen.queryByTestId("cluster-summary")).toBeNull();
  });
});
