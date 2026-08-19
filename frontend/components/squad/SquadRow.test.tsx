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
import { INK, PAPER } from "@/lib/margin/tokens";

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

/** jsdom normalises a hex colour to `rgb()` inside a style string. */
function asRgb(hex: string): string {
  const probe = document.createElement("span");
  probe.style.color = hex;
  return probe.style.color;
}

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

  it("keeps difficulty monochrome, and derives it from the surface", () => {
    /* This asserted the literal `rgba(27,26,22,…)` — PAPER's ink typed into the
       component — which passed while the tick was invisible on any dark surface. The
       property that matters is that it is a mix of THIS surface's ink and nothing
       else: monochrome, because club owns hue in this row. */
    render(<SquadRow player={{ ...BASE, difficulty: 5 }} surface={PAPER} />);
    const paint = screen.getByTestId("difficulty-tick").style.background;
    expect(paint).toContain("color-mix");
    expect(paint).toContain(asRgb(PAPER.ink));
    for (const hue of [PAPER.agree, PAPER.conflict, PAPER.noise, PAPER.brand]) {
      expect(paint, "difficulty must not borrow a judgement hue").not.toContain(hue);
    }
  });

  it("draws the tick from the ink of whichever surface it is given", () => {
    // The regression this replaces: a light-ink literal on a dark board painted
    // nothing at all, so the entire difficulty column disappeared.
    render(<SquadRow player={{ ...BASE, difficulty: 4 }} surface={INK} />);
    expect(screen.getByTestId("difficulty-tick").style.background)
      .toContain(asRgb(INK.ink));
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

describe("FPL's own availability flag", () => {
  /**
   * The route folds a pick role and an availability flag into one `status` field, and the
   * role wins: `pick.status ?? (element.status !== "a" || element.news ? "monitor" :
   * undefined)`. So a captain who is injured stayed "captain" and the flag was lost — on
   * exactly the pick where it matters most — and the narrower dropped the two fields the
   * route emits separately, so no squad surface could mark a flagged player at all.
   */
  it("marks a player FPL has ruled out", () => {
    render(
      <SquadRow
        player={{ ...BASE, chanceOfPlaying: 0, news: "Knee injury - expected back 30 Aug" }}
        surface={PAPER}
      />,
    );
    const flag = screen.getByTestId("availability-flag");
    expect(flag.textContent).toBe("✕");
    expect(flag.getAttribute("title")).toContain("Knee injury");
  });

  it("marks a doubt with its published percentage", () => {
    render(
      <SquadRow player={{ ...BASE, chanceOfPlaying: 25, news: "Knock" }} surface={PAPER} />,
    );
    expect(screen.getByTestId("availability-flag").getAttribute("title"))
      .toContain("25% chance of playing");
  });

  it("shows the flag ALONGSIDE the armband, which is the case that was lost", () => {
    render(
      <SquadRow
        player={{ ...BASE, armband: "C", chanceOfPlaying: 50, news: "Doubt" }}
        surface={PAPER}
      />,
    );
    expect(screen.getByTestId("armband").textContent).toBe("C");
    expect(screen.getByTestId("availability-flag")).toBeTruthy();
  });

  it("says nothing for a fit player, because FPL publishes nothing for one", () => {
    render(
      <SquadRow player={{ ...BASE, chanceOfPlaying: null, news: "" }} surface={PAPER} />,
    );
    expect(screen.queryByTestId("availability-flag")).toBeNull();
  });

  it("says nothing for a player the source never described, which is not the same", () => {
    // `undefined` is "this did not come from the route" — unknown, not fit. Nothing is
    // drawn either way; the difference is that nothing is claimed.
    render(<SquadRow player={BASE} surface={PAPER} />);
    expect(screen.queryByTestId("availability-flag")).toBeNull();
  });

  it("carries news even when FPL publishes no percentage", () => {
    render(
      <SquadRow
        player={{ ...BASE, chanceOfPlaying: null, news: "Suspended" }}
        surface={PAPER}
      />,
    );
    expect(screen.getByTestId("availability-flag").getAttribute("title"))
      .toContain("Suspended");
  });
});

describe("the row fills every track it declares", () => {
  /**
   * The grid declares ten columns. The armband was rendered conditionally, so the
   * thirteen rows without one had nine children and every column after it shifted left —
   * the `auto` data-strip track collapsing onto the 18px difficulty tick. A table whose
   * columns do not line up is a list with extra steps.
   *
   * Nothing in the tree asserted this: a grep for `gridTemplateColumns`,
   * `childElementCount` or `children.length` across the tests returned nothing. The
   * invariant is children === tracks, and it is checkable without jsdom doing layout,
   * which it does not.
   */
  const tracks = (row: HTMLElement) =>
    row.style.gridTemplateColumns.trim().split(/\s+(?![^(]*\))/).length;

  it("renders one child per declared track, with an armband", () => {
    render(<SquadRow player={{ ...BASE, armband: "C" }} surface={PAPER} />);
    const row = screen.getByTestId("squad-row");
    expect(row.children.length).toBe(tracks(row));
  });

  it("renders one child per declared track WITHOUT an armband", () => {
    render(<SquadRow player={{ ...BASE, armband: null }} surface={PAPER} />);
    const row = screen.getByTestId("squad-row");
    expect(row.children.length).toBe(tracks(row));
  });

  it("keeps the child count identical either way", () => {
    const { unmount } = render(<SquadRow player={{ ...BASE, armband: "C" }} surface={PAPER} />);
    const withBand = screen.getByTestId("squad-row").children.length;
    unmount();
    render(<SquadRow player={{ ...BASE, armband: null }} surface={PAPER} />);
    expect(screen.getByTestId("squad-row").children.length).toBe(withBand);
  });

  it("draws no box where there is no armband", () => {
    /* The fix's own trap: an empty span carrying the bordered style would put thirteen
       empty boxes down the column. */
    render(<SquadRow player={{ ...BASE, armband: null }} surface={PAPER} />);
    const empty = screen.getByTestId("armband-empty");
    expect(empty.style.border).toBe("");
    expect(empty.style.padding).toBe("");
    expect(empty.textContent).toBe("");
  });

  it("still finds a real armband, not the empty one", () => {
    render(<SquadRow player={{ ...BASE, armband: "V" }} surface={PAPER} />);
    expect(screen.getByTestId("armband").textContent).toBe("V");
    expect(screen.queryByTestId("armband-empty")).toBeNull();
  });
});
