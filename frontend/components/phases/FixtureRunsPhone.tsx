"use client";

/**
 * Fixture runs at phone width — twenty clubs, six gameweeks, one screen.
 *
 * ## Whose number this is
 *
 * Every figure here is FPL's published fixture list and FPL's own 1-5 difficulty
 * for the club in that fixture. Nothing is simulated and nothing is calibrated, so
 * the header says "published" and the page keeps the measured team-strength section
 * below it as a separate, labelled thing — see the docstring on `app/phases/page.tsx`.
 *
 * ## Case is venue, and the digit is the difficulty
 *
 * lowercase is a home fixture and UPPERCASE is away — the same way round as the
 * desktop `PhaseMatrix` (`venue()`). The phone design first drew it the other way;
 * two opposite conventions in one app would make every cell ambiguous to anyone
 * who reads both screens, so the phone follows the surface that already existed.
 * The legend still says which way round it is. Colour is never the only
 * channel: each cell carries the difficulty digit, and each cell's accessible name
 * spells out venue, opponent and difficulty.
 *
 * ## The average
 *
 * Mean difficulty over the weeks shown that the club actually plays. A blank is
 * excluded rather than counted as zero, which would rank an idle club as having the
 * kindest run in the league. A double gameweek counts at its harder fixture — the
 * convention `lib/projections/phases.ts` already applies.
 */

import { useMemo } from "react";

import { PhoneHeader } from "@/components/phone/PhoneHeader";
import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import { SANS, SIGNAL, difficultyTile } from "@/lib/margin/tokens";
import { clubWeeks, matrixGameweeks } from "@/lib/projections/phases";

const S = SIGNAL;

/** Six columns is what a 390px screen holds with a legible opponent code. */
export const PHONE_WEEKS = 6;

interface Leg {
  readonly code: string;
  readonly home: boolean;
  readonly difficulty: number | null;
}

/**
 * `BHA (H)` becomes `{ code: "BHA", home: true }`.
 *
 * A label this does not recognise is kept whole and treated as away rather than
 * dropped: an unparsed fixture that vanished would read as a blank week.
 */
export function parseLabel(label: string): { code: string; home: boolean | null } {
  const match = /^(.+?)\s*\((H|A)\)\s*$/.exec(label);
  if (!match) return { code: label, home: null };
  return { code: match[1], home: match[2] === "H" };
}

function legsOf(row: FixtureMatrixRow, gameweek: number): Leg[] {
  return row.fixtures
    .filter((f) => f.gameweek === gameweek)
    .map((f) => {
      const { code, home } = parseLabel(f.label);
      return { code, home: home === true, difficulty: f.difficulty };
    });
}

export interface PhoneClub {
  readonly teamId: number;
  readonly code: string;
  readonly average: number | null;
  readonly weeks: ReadonlyArray<{
    readonly gameweek: number;
    readonly legs: readonly Leg[];
    /** The harder leg of a double; null for a blank. */
    readonly difficulty: number | null;
  }>;
}

/** Exposed for the test: the rows in order, easiest run first. */
export function buildPhoneClubs(
  fixtures: readonly FixtureMatrixRow[], weekCount: number = PHONE_WEEKS,
): { weeks: number[]; clubs: PhoneClub[] } {
  const weeks = matrixGameweeks(fixtures).slice(0, weekCount);
  const clubs = fixtures.map((row) => {
    const played = clubWeeks(row, weeks);
    const ratings = played
      .map((w) => w.difficulty)
      .filter((d): d is number => d !== null);
    return {
      teamId: row.teamId,
      code: row.shortName || row.team,
      average: ratings.length === 0
        ? null
        : ratings.reduce((sum, d) => sum + d, 0) / ratings.length,
      weeks: played.map((w) => ({
        gameweek: w.gameweek,
        legs: legsOf(row, w.gameweek),
        difficulty: w.difficulty,
      })),
    };
  });
  clubs.sort((a, b) => {
    if (a.average === null && b.average === null) return a.code.localeCompare(b.code);
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    return a.average - b.average || a.code.localeCompare(b.code);
  });
  return { weeks, clubs };
}

function spoken(gameweek: number, legs: readonly Leg[]): string {
  if (legs.length === 0) return `Gameweek ${gameweek}: no fixture`;
  return `Gameweek ${gameweek}: `
    + legs.map((leg) =>
      `${leg.home ? "home" : "away"} against ${leg.code}, difficulty ${leg.difficulty ?? "unrated"}`,
    ).join(" and ");
}

const CELL: React.CSSProperties = {
  height: 28, padding: 0, textAlign: "center", verticalAlign: "middle",
  fontSize: 11, lineHeight: 1.15, color: S.ink,
};

export function FixtureRunsPhone({ fixtures }: { fixtures: readonly FixtureMatrixRow[] }) {
  const { weeks, clubs } = useMemo(() => buildPhoneClubs(fixtures), [fixtures]);
  const range = weeks.length === 0
    ? null
    : weeks.length === 1 ? `GW${weeks[0]}` : `GW${weeks[0]}–${weeks[weeks.length - 1]}`;

  return (
    <div data-testid="fixture-runs-phone" style={{ fontFamily: SANS, color: S.ink }}>
      <PhoneHeader title="Fixture runs" aside={range} sticky={false}>
        <span style={{ fontSize: 12, color: S.ink2 }}>
          Published fixture list · FPL difficulty · easiest {weeks.length}-week run first
        </span>
        <div
          role="group"
          aria-label="Legend"
          style={{
            display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4,
            fontSize: 11, color: S.ink2,
          }}
        >
          <span style={{ marginRight: 2 }}>Easy</span>
          {[1, 2, 3, 4, 5].map((d) => (
            <span
              key={d}
              style={{
                width: 22, height: 18, display: "inline-flex", alignItems: "center",
                justifyContent: "center", background: difficultyTile(d), color: S.ink,
              }}
            >
              {d}
            </span>
          ))}
          <span style={{ marginLeft: 2 }}>Hard</span>
          <span style={{ marginLeft: "auto" }}>lower home · CAPS away</span>
        </div>
      </PhoneHeader>

      <table
        aria-label={weeks.length === 0
          ? "Fixture difficulty"
          : `Fixture difficulty, gameweeks ${weeks[0]} to ${weeks[weeks.length - 1]}`}
        style={{
          width: "100%", tableLayout: "fixed", borderCollapse: "separate",
          borderSpacing: 2, marginTop: 8,
        }}
      >
        <colgroup>
          <col style={{ width: 44 }} />
          {weeks.map((w) => <col key={w} />)}
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr style={{ fontSize: 11, fontWeight: 600, color: S.ink3 }}>
            <th scope="col" style={{ textAlign: "left", padding: "0 0 4px", fontWeight: 600 }}>Club</th>
            {weeks.map((w) => (
              <th key={w} scope="col" aria-label={`Gameweek ${w}`}
                style={{ textAlign: "center", padding: "0 0 4px", fontWeight: 600 }}>
                {w}
              </th>
            ))}
            <th scope="col" style={{ textAlign: "right", padding: "0 0 4px", fontWeight: 600 }}>Avg</th>
          </tr>
        </thead>
        <tbody>
          {clubs.map((club) => (
            <tr key={club.teamId} data-testid="fixture-runs-row">
              <th scope="row" style={{
                textAlign: "left", fontSize: 12, fontWeight: 700, letterSpacing: ".04em",
                padding: 0, height: 28,
              }}>
                {club.code}
              </th>
              {club.weeks.map((week) => (
                <td
                  key={week.gameweek}
                  aria-label={spoken(week.gameweek, week.legs)}
                  data-testid="fixture-runs-cell"
                  style={{
                    ...CELL,
                    background: week.difficulty === null ? "transparent" : difficultyTile(week.difficulty),
                    outline: week.difficulty === null ? `1px dashed ${S.rule}` : "none",
                    outlineOffset: -1,
                  }}
                >
                  {week.legs.length === 0 ? "—" : week.legs.map((leg, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "center", gap: 3, alignItems: "baseline" }}>
                      <span style={{ fontWeight: leg.home ? 700 : 500 }}>
                        {leg.home ? leg.code.toLowerCase() : leg.code.toUpperCase()}
                      </span>
                      <span style={{ color: S.ink2 }}>{leg.difficulty ?? "?"}</span>
                    </div>
                  ))}
                </td>
              ))}
              <td style={{ textAlign: "right", fontSize: 12, color: S.ink2, padding: 0 }}>
                {club.average === null ? "—" : club.average.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
