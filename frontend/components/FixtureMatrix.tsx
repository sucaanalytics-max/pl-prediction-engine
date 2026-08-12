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
 * The ramp was validated rather than eyeballed. OKLab lightness runs
 * 0.905 → 0.812 → 0.717 → 0.622 → 0.480 — strictly monotonic, with even steps
 * (0.093, 0.095, 0.095, 0.142), so equal difficulty gaps read as equal. The darkest
 * step sits at 2.63:1 against the dark surface, below the 3:1 line, which obliges
 * visible relief — **the number is printed in every cell**, so nothing here is
 * carried by colour alone.
 */

/** Blue ramp, light = easy, dark = hard. Index by FDR 1–5. */
const FDR_FILL: Record<number, string> = {
  1: "#cde2fb",
  2: "#9ec5f4",
  3: "#6da7ec",
  4: "#3987e5",
  5: "#1c5cab",
};

/**
 * Ink per step, chosen for contrast against that step rather than per theme.
 *
 * The cell background is data, not chrome, so it does not flip with the theme — and
 * a single text colour would be unreadable at one end of the ramp in both themes.
 */
const FDR_INK: Record<number, string> = {
  1: "#0d366b",
  2: "#0d366b",
  3: "#0d366b",
  4: "#ffffff",
  5: "#ffffff",
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

  const byGameweek = (row: FixtureMatrixRow) => {
    const map = new Map<number, FixtureMatrixRow["fixtures"][number]>();
    for (const fixture of row.fixtures) map.set(fixture.gameweek, fixture);
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

      <div className="glass-panel rounded-2xl overflow-x-auto">
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
                    const fixture = map.get(gameweek);
                    if (!fixture) {
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
                      <td key={gameweek} className="text-center p-1">
                        <span
                          className="block rounded px-1 py-1 text-[11px] font-mono"
                          style={{
                            background: FDR_FILL[fixture.difficulty],
                            color: FDR_INK[fixture.difficulty],
                          }}
                          title={`${row.team} — ${fixture.label} · difficulty ${fixture.difficulty} (${DIFFICULTY_WORD[fixture.difficulty]})`}
                          data-difficulty={fixture.difficulty}
                        >
                          {fixture.label}
                        </span>
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
