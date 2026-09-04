/**
 * The team-strength section on /phases, in the state the season is actually in.
 *
 * ## Why the "no ranks yet" case leads
 *
 * The committed artifact right now has twenty clubs, two matches each, and every
 * rank null — the producer withholds a rank below three matches on purpose. That
 * is not a degraded state to be tolerated; it is the section's whole argument,
 * and it is the state a reader will meet for one more gameweek. So it is the
 * first thing asserted, and the section must say *why* the ranks are missing
 * rather than rendering a table with blank columns.
 *
 * The values below come from running the REAL narrower over the real file, so
 * these are not invented shapes.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { narrowTeamMetrics } from "@/lib/data/narrow";

const realView = () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "..", "predictions", "team_metrics.json"), "utf8"),
  );
  const out = narrowTeamMetrics(raw);
  if (!out.ok) throw new Error(out.problems.join("; "));
  return out.value;
};

function mountWith(value: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: value === null ? "not published" : null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/phases/TeamStrength");
}

afterEach(() => vi.resetModules());

describe("TeamStrength, before any club has three matches", () => {
  it("says why there are no ranks rather than showing blank columns", async () => {
    const { TeamStrength } = await mountWith(realView());
    render(<TeamStrength />);
    expect(screen.getByText(/not yet measurable/i)).toBeInTheDocument();
    expect(screen.getByText(/three matches|3 matches/i)).toBeInTheDocument();
  });

  it("still lists all twenty clubs, because the rates are real", async () => {
    const { TeamStrength } = await mountWith(realView());
    render(<TeamStrength />);
    expect(screen.getByText("Chelsea")).toBeInTheDocument();
    expect(screen.getByText("Coventry City")).toBeInTheDocument();
    expect(screen.getAllByTestId("team-strength-row")).toHaveLength(20);
  });

  it("shows no rank column while every rank is withheld", async () => {
    const { TeamStrength } = await mountWith(realView());
    render(<TeamStrength />);
    expect(screen.queryByTestId("rank-cell")).toBeNull();
  });

  it("names the provider, so it does not borrow our model's authority", async () => {
    const { TeamStrength } = await mountWith(realView());
    render(<TeamStrength />);
    expect(screen.getByText(/understat/i)).toBeInTheDocument();
  });

  it("states that it feeds no projection", async () => {
    const { TeamStrength } = await mountWith(realView());
    render(<TeamStrength />);
    expect(screen.getByText(/feeds no projection|informs nothing/i)).toBeInTheDocument();
  });
});

describe("TeamStrength once clubs are measurable", () => {
  const ranked = () => {
    const v = realView();
    return {
      ...v,
      teams: v.teams.slice(0, 3).map((t, i) => ({
        ...t, matches: 6, belowThreshold: false,
        attackRank: i + 1, defenceRank: 3 - i,
      })),
    };
  };

  it("shows ranks and orders by attack", async () => {
    const { TeamStrength } = await mountWith(ranked());
    render(<TeamStrength />);
    const cells = screen.getAllByTestId("rank-cell");
    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveTextContent("1");
  });

  it("drops the not-yet-measurable notice once ranks exist", async () => {
    const { TeamStrength } = await mountWith(ranked());
    render(<TeamStrength />);
    expect(screen.queryByText(/not yet measurable/i)).toBeNull();
  });
});

describe("TeamStrength when the artifact is missing", () => {
  it("is one line, not a panel — absence never outweighs substance", async () => {
    const { TeamStrength } = await mountWith(null);
    render(<TeamStrength />);
    expect(screen.queryAllByTestId("team-strength-row")).toHaveLength(0);
    expect(screen.getByText(/attack and defence/i)).toBeInTheDocument();
  });
});

describe("mounting", () => {
  it("is mounted on /phases", () => {
    const source = readFileSync(join(process.cwd(), "app", "phases", "page.tsx"), "utf8");
    expect(source).toContain("TeamStrength");
    expect(source).toContain("phases/TeamStrength");
  });
});
