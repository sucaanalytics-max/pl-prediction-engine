/**
 * The row, and the one cell allowed to carry a judgement.
 *
 * The minutes threshold is asserted against the REAL artifact rather than a
 * two-player fixture, because the design's own figures for this squad came from an
 * fplreview capture that is gitignored and absent from every deployment. It claimed
 * only Isak (76) and Schade (70) fall under 80. The simulation says six do, and Isak
 * is not among them — it puts him at 82.8 and Palestra, whom fplreview had at 92, at
 * 19.5. A fixture of two would have encoded the wrong squad and passed forever.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { MINUTES_FLOOR, SquadRow, type SquadRowPlayer } from "@/components/squad/SquadRow";
import { PAPER } from "@/lib/margin/tokens";

const ARTIFACT = JSON.parse(
  readFileSync("public/predictions/fpl/xp_public_gw01.json", "utf8"),
) as { players: Array<Record<string, number | string | null>> };

/** The captured fifteen, by element id, as `lib/fpl-live-server.ts` holds them. */
const XV: ReadonlyArray<readonly [number, string, string]> = [
  [109, "Verbruggen", "BHA"], [152, "Palestra", "CHE"], [4, "Gabriel", "ARS"],
  [418, "Maguire", "MUN"], [426, "B.Fernandes", "MUN"], [94, "Schade", "BRE"],
  [427, "Mbeumo", "MUN"], [542, "E.Le Fée", "SUN"], [379, "Isak", "LIV"],
  [165, "João Pedro", "CHE"], [106, "Thiago", "BRE"], [496, "Kinsky", "TOT"],
  [368, "Szoboszlai", "LIV"], [113, "F.Kadıoğlu", "BHA"], [173, "Thomas", "COV"],
];

function fromArtifact(id: number, name: string, club: string): SquadRowPlayer {
  const p = ARTIFACT.players.find((x) => x.element_id === id)!;
  return {
    name, club, armband: null, benched: false,
    xp: p.xp as number,
    opponent: "HUL (A)",
    expectedMinutes: p.e_minutes as number,
    difficulty: 3,
    distribution: {
      q10: p.q10 as number, q25: p.q25 as number, q50: p.q50 as number,
      q75: p.q75 as number, q90: p.q90 as number,
      mean: p.xp as number, mode: p.mode as number,
    },
  };
}

const BASE = fromArtifact(426, "B.Fernandes", "MUN");

afterEach(() => cleanup());

describe("the minutes cell, driven by the artifact", () => {
  it("flags exactly the players the simulation puts under the floor", () => {
    const flagged: string[] = [];
    for (const [id, name, club] of XV) {
      const player = fromArtifact(id, name, club);
      const { unmount } = render(<SquadRow player={player} surface={PAPER} />);
      const cell = screen.getByTestId("minutes-cell");
      if (cell.style.color === PAPER.noise) flagged.push(name);
      unmount();
    }
    expect(flagged.sort()).toEqual(
      ["Gabriel", "João Pedro", "Mbeumo", "Palestra", "Schade", "Thomas"].sort(),
    );
  });

  it("does NOT flag Isak, whom the design's third-party figures did", () => {
    render(<SquadRow player={fromArtifact(379, "Isak", "LIV")} surface={PAPER} />);
    expect(screen.getByTestId("minutes-cell").style.color).not.toBe(PAPER.noise);
  });

  it("is the only cell in the row that may take the warning hue", () => {
    render(<SquadRow player={fromArtifact(152, "Palestra", "CHE")} surface={PAPER} />);
    expect(screen.getByTestId("minutes-cell").style.color).toBe(PAPER.noise);
    for (const id of ["xp-cell", "difficulty-tick", "next-four"]) {
      expect(screen.getByTestId(id).style.color, id).not.toBe(PAPER.noise);
    }
  });

  it("says ∅ when no minutes were fitted, never 0", () => {
    render(<SquadRow player={{ ...BASE, expectedMinutes: null }} surface={PAPER} />);
    expect(screen.getByTestId("minutes-cell").textContent).toBe("∅");
  });

  it("keeps the threshold where the design put it", () => {
    expect(MINUTES_FLOOR).toBe(80);
  });
});

describe("the rest of the row", () => {
  it("inverts the xP cell, so the row's own number cannot be skimmed", () => {
    render(<SquadRow player={BASE} surface={PAPER} />);
    const xp = screen.getByTestId("xp-cell");
    // jsdom normalises hex to rgb(), so compare on the resolved form.
    const rgb = (hex: string) => {
      const probe = document.createElement("span");
      probe.style.color = hex;
      return probe.style.color;
    };
    expect(rgb(xp.style.background || "")).toBe(rgb(PAPER.ink));
    expect(rgb(xp.style.color)).toBe(rgb(PAPER.face));
  });

  it("renders the armband as a bordered letter in the row", () => {
    render(<SquadRow player={{ ...BASE, armband: "C" }} surface={PAPER} />);
    const band = screen.getByTestId("armband");
    expect(band.textContent).toBe("C");
    expect(band.style.border).toContain("1px solid");
  });

  it("keeps difficulty monochrome, because club owns hue", () => {
    render(<SquadRow player={{ ...BASE, difficulty: 5 }} surface={PAPER} />);
    // Monochrome: an rgba of the ink, never a hue. jsdom re-spaces the channels.
    expect(
      screen.getByTestId("difficulty-tick").style.background.replace(/\s+/g, ""),
    ).toContain("rgba(27,26,22");
  });

  it("renders next-four as ∅ under a dotted rule, since no horizon is published", () => {
    render(<SquadRow player={BASE} surface={PAPER} />);
    const next = screen.getByTestId("next-four");
    expect(next.textContent).toBe("∅");
    expect(next.style.borderBottom).toContain("dotted");
  });

  it("numbers a benched player so bench ORDER is readable", () => {
    render(<SquadRow player={{ ...BASE, benched: true }} surface={PAPER} benchIndex={2} />);
    expect(screen.getByTestId("bench-index").textContent).toBe("2");
  });

  it("draws the glyph from measured quartiles", () => {
    render(<SquadRow player={BASE} surface={PAPER} />);
    // Fernandes carries q10..q90 in the shipped artifact, so this is measurement.
    expect(BASE.distribution!.q25).not.toBeNull();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(1);
  });
});
