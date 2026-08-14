"use client";

import { useMemo, useState } from "react";

import { proven } from "@/lib/data/artifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";

/**
 * Every club's run of fixtures, by official difficulty.
 *
 * ## Why this screen
 *
 * It is the view Solio and FPL Review both lead with, and the question a manager
 * asks first when drafting: who has the kindest opening run. FPL's difficulty was
 * already on every request — `/fixtures/` carries `team_h_difficulty` and
 * `team_a_difficulty` — and was exposed only nested inside individual players, so
 * the league-wide picture existed nowhere.
 *
 * ## The colour, and why it is not FPL's green-to-red
 *
 * FDR 1–5 is **ordered magnitude**, not polarity around a zero, so the correct
 * encoding is a single hue light→dark rather than a diverging pair. That also avoids
 * green↔red, which is the canonical colour-vision failure: roughly one man in twelve
 * cannot separate those hues, and FPL's own site uses exactly that pair.
 *
 * The ramp is validated on two axes, and the first version only checked one.
 *
 * **Lightness monotonicity** — strictly decreasing, so equal difficulty gaps read as
 * ordered. That was checked.
 *
 * **Ink contrast on each step** — that was NOT. Step 4 shipped as `#3987e5`, on which
 * white text computes to 3.64:1, below the 4.5:1 that AA requires for the 11px cell
 * text.
 *
 * The ramp was blue when the app's accent was emerald, so the grid was the only blue
 * on the surface and the largest block of colour in it — on a screen whose whole
 * point is that colour marks agreement, disagreement and noise. It is now the app's
 * own warm neutral, which keeps every property the blue was chosen for: a single hue
 * light→dark rather than a diverging pair, still nothing near green↔red, and the
 * difficulty number in the cell so the value never rests on colour alone.
 *
 * Re-validated when it moved, because that is exactly how step 4 slipped through the
 * first time. Relative luminance 0.775 → 0.545 → 0.309 → 0.086 → 0.022, strictly
 * decreasing; contrast against each step's own ink 13.68, 9.87, 5.95, 7.08, 13.37,
 * every one clearing AA with room. `FixtureMatrix.test.tsx` pins the ordering.
 */

/** Warm-neutral ramp, light = easy, dark = hard. Index by FDR 1–5. */
const FDR_FILL: Record<number, string> = {
  1: "#e6e4dc",
  2: "#c6c3b8",
  3: "#9a978c",
  4: "#55534a",
  5: "#2a2924",
};

/**
 * Ink per step, chosen for contrast against that step rather than per theme.
 *
 * The cell background is data, not chrome, so it does not flip with the theme — and
 * a single text colour would be unreadable at one end of the ramp in both themes.
 */
const FDR_INK: Record<number, string> = {
  1: "#1b1a16",
  2: "#1b1a16",
  3: "#1b1a16",
  4: "#f6f5f2",
  5: "#f6f5f2",
};

const DIFFICULTY_WORD: Record<number, string> = {
  1: "very easy",
  2: "easy",
  3: "average",
  4: "hard",
  5: "very hard",
};

function Legend() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px]" style={{ color: "var(--text-4)" }}>
        FPL difficulty
      </span>
      {[1, 2, 3, 4, 5].map((level) => (
        <span
          key={level}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: FDR_FILL[level], color: FDR_INK[level] }}
          title={DIFFICULTY_WORD[level]}
        >
          {level}
        </span>
      ))}
      <span className="text-[10px]" style={{ color: "var(--text-4)" }}>
        easy → hard
      </span>
    </div>
  );
}

export default function FixtureMatrix() {
  const { artifact } = useHeuristics();
  const view = proven(artifact);
  const rows = view?.fixtureMatrix ?? [];
  const [hardestFirst, setHardestFirst] = useState(false);

  const gameweeks = useMemo(() => {
    const seen = new Set<number>();
    for (const row of rows) for (const f of row.fixtures) seen.add(f.gameweek);
    return [...seen].sort((a, b) => a - b);
  }, [rows]);

  const ordered = useMemo(() => {
    // The server sorts easiest-first; reversing is enough and keeps one source of
    // truth for the ordering rule.
    return hardestFirst ? [...rows].reverse() : rows;
  }, [rows, hardestFirst]);

  if (rows.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        No fixtures could be read from FPL, so the difficulty grid is not shown.
      </p>
    );
  }

  /**
   * Every fixture in a gameweek, not the last one seen.
   *
   * This was `map.set(fixture.gameweek, fixture)`, which keeps one fixture per
   * gameweek. A club with two — a double gameweek, created whenever a postponed
   * match is rescheduled into an existing week — had its first one silently
   * overwritten. That is the single most decision-relevant fixture event in FPL
   * (it is what a Bench Boost or a Triple Captain is spent on), and the grid
   * would have shown the club playing once.
   *
   * The array is the honest shape: zero entries is a blank, one is ordinary, two
   * or more is a double, and the cell renders what it is given.
   */
  const byGameweek = (row: FixtureMatrixRow) => {
    // A mutable element array, not `row["fixtures"]` — that type is `readonly`,
    // which is correct for the artifact and wrong for a local accumulator.
    const map = new Map<number, Array<FixtureMatrixRow["fixtures"][number]>>();
    for (const fixture of row.fixtures) {
      const existing = map.get(fixture.gameweek);
      if (existing) existing.push(fixture);
      else map.set(fixture.gameweek, [fixture]);
    }
    return map;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Legend />
        <button
          type="button"
          className="text-xs underline"
          style={{ color: "var(--accent)" }}
          onClick={() => setHardestFirst((value) => !value)}
        >
          {hardestFirst ? "Show kindest runs first" : "Show hardest runs first"}
        </button>
      </div>

      <div className="glass-panel rounded-none overflow-x-auto">
        <table className="data-table" aria-label="Fixture difficulty by club and gameweek">
          <thead>
            <tr>
              <th scope="col">Club</th>
              <th scope="col" className="text-center">Mean</th>
              {gameweeks.map((gameweek) => (
                <th key={gameweek} scope="col" className="text-center">
                  GW{gameweek}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => {
              const map = byGameweek(row);
              return (
                <tr key={row.teamId} data-testid="fixture-row">
                  <td className="text-sm whitespace-nowrap">{row.team}</td>
                  <td className="text-center font-mono text-sm">
                    {row.meanDifficulty.toFixed(2)}
                  </td>
                  {gameweeks.map((gameweek) => {
                    const fixtures = map.get(gameweek);
                    if (!fixtures || fixtures.length === 0) {
                      // A blank gameweek. Left empty rather than filled with a
                      // neutral 3: a fixture that does not exist is not an
                      // average-difficulty fixture.
                      return (
                        <td
                          key={gameweek}
                          className="text-center text-[10px]"
                          style={{ color: "var(--text-4)" }}
                          title={`${row.team} has no fixture in GW${gameweek}`}
                        >
                          —
                        </td>
                      );
                    }
                    return (
                      <td
                        key={gameweek}
                        className="text-center p-1 space-y-0.5"
                        data-fixtures={fixtures.length}
                      >
                        {fixtures.length > 1 ? (
                          // A double gameweek, named rather than left for the
                          // reader to infer from two stacked cells.
                          <span
                            className="block text-[9px] font-semibold uppercase tracking-wide"
                            style={{ color: "var(--text-4)" }}
                          >
                            Double
                          </span>
                        ) : null}
                        {fixtures.map((fixture) => (
                          <span
                            key={`${fixture.label}-${fixture.difficulty}`}
                            className="block rounded px-1 py-1 text-[11px] font-mono"
                            style={{
                              background: FDR_FILL[fixture.difficulty],
                              color: FDR_INK[fixture.difficulty],
                            }}
                            title={`${row.team} — ${fixture.label} · difficulty ${fixture.difficulty} (${DIFFICULTY_WORD[fixture.difficulty]})`}
                            data-difficulty={fixture.difficulty}
                          >
                            {fixture.label}
                            {" "}
                            {/* The difficulty itself, in the cell.
                                This was only in `title=`, so the FDR value was
                                carried by colour alone — the exact opposite of what
                                this component's docstring claimed, and unreadable to
                                anyone who cannot separate the ramp or is not hovering
                                a mouse. An adversarial audit caught the contradiction
                                between the claim and the code. */}
                            <strong>{fixture.difficulty}</strong>
                          </span>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
        Difficulty is FPL&apos;s own 1–5 rating, taken from the fixture list. Mean is
        over fixtures that exist, so a club with a blank stays comparable to one
        without.
      </p>
    </div>
  );
}
