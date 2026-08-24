"use client";

/**
 * The phase matrix — twenty clubs, eight gameweeks, and the runs worth buying into.
 *
 * The arithmetic is in `lib/projections/phases.ts` and tested there. This file is
 * the matrix, the phase list beside it, and the sentences that stop the picture
 * being read as a forecast.
 *
 * ## Two readings of the same data, deliberately both
 *
 * The matrix answers "what does this club's month look like". The list answers
 * "what are the best runs in the league right now" — the same phases, ordered by
 * length rather than by club, which is the order a manager planning a transfer
 * actually wants. Neither is derivable from the other by eye: finding the third
 * longest run in a 20 × 8 grid of colour is exactly the work a list removes.
 *
 * ## Bright means kind here, and high there
 *
 * The grid's ramp runs bright for a big projection. This one runs bright for a LOW
 * difficulty, because difficulty is a cost. Both screens label their scale, and
 * the legend below is why: a reader arriving from the grid has a reasonable and
 * wrong expectation about what a bright cell means.
 */

import { useMemo, useState } from "react";

import type { FixtureMatrixRow } from "@/lib/data/heuristics";
import { DISPLAY, FLOODLIT, MONO, SANS, heatStep } from "@/lib/margin/tokens";
import { HEAT_STEPS } from "@/lib/projections/grid";
import {
  RUN_LENGTHS, THRESHOLDS, allPhases, buildClubRows, difficultyBand,
  matrixGameweeks, orderClubs, type PhaseOrder, type RunLength,
} from "@/lib/projections/phases";

const S = FLOODLIT;

const ORDERS: ReadonlyArray<readonly [PhaseOrder, string]> = [
  ["phase", "best run"], ["kindest", "kindest overall"], ["name", "A–Z"],
];

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "4px 9px", fontSize: 11, fontWeight: on ? 600 : 400,
    background: on ? "rgba(233,238,245,.10)" : "transparent",
    color: on ? S.ink : S.ink3, borderRight: `1px solid ${S.rule}`, cursor: "pointer",
  };
}

function Group({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", border: `1px solid ${S.rule}` }}>{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 9, letterSpacing: ".14em",
      textTransform: "uppercase", color: S.ink3, fontWeight: 600,
    }}>
      {children}
    </span>
  );
}

export function PhaseMatrix({ fixtures }: { fixtures: readonly FixtureMatrixRow[] }) {
  const [minLength, setMinLength] = useState<RunLength>(3);
  const [maxDifficulty, setMaxDifficulty] = useState<number>(THRESHOLDS[0].max);
  const [order, setOrder] = useState<PhaseOrder>("phase");

  const gameweeks = useMemo(() => matrixGameweeks(fixtures), [fixtures]);
  const clubs = useMemo(
    () => buildClubRows(fixtures, { minLength, maxDifficulty }),
    [fixtures, minLength, maxDifficulty],
  );
  const ordered = useMemo(() => orderClubs(clubs, order), [clubs, order]);
  const phases = useMemo(() => allPhases(clubs), [clubs]);

  const template = `104px repeat(${gameweeks.length}, minmax(46px, 1fr)) 54px`;

  return (
    <section style={{ fontFamily: SANS, color: S.ink }}>
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "12px 14px", background: S.inset,
        border: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.rule}`,
      }}>
        <Label>A run is</Label>
        <Group>
          {RUN_LENGTHS.map((value) => (
            <button
              key={value}
              onClick={() => setMinLength(value)}
              style={{ ...chip(minLength === value), fontFamily: MONO, minWidth: 26,
                       textAlign: "center" }}
              aria-pressed={minLength === value}
              aria-label={`A run is ${value} or more gameweeks`}
            >
              {value}
            </button>
          ))}
        </Group>
        <Label>or more weeks of</Label>
        <Group>
          {THRESHOLDS.map((threshold) => (
            <button
              key={threshold.max}
              onClick={() => setMaxDifficulty(threshold.max)}
              style={chip(maxDifficulty === threshold.max)}
              aria-pressed={maxDifficulty === threshold.max}
            >
              {threshold.label}
            </button>
          ))}
        </Group>
        <div style={{ width: 1, height: 20, background: S.rule }} />
        <Label>Order</Label>
        <Group>
          {ORDERS.map(([key, label]) => (
            <button key={key} onClick={() => setOrder(key)} style={chip(order === key)}
              aria-pressed={order === key}>
              {label}
            </button>
          ))}
        </Group>
        <div style={{ flexGrow: 1 }} />
        <span data-testid="phase-count" style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          {phases.length} run{phases.length === 1 ? "" : "s"} in {clubs.length} clubs
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 0, alignItems: "flex-start" }}>
        <div style={{
          flex: "1 1 560px", minWidth: 0, overflowX: "auto",
          border: `1px solid ${S.hair}`, borderTop: "none",
        }}>
          <div style={{ minWidth: 560, padding: "0 0 8px" }}>
            <div style={{
              display: "grid", gridTemplateColumns: template, alignItems: "center",
              background: S.bar, borderBottom: `1px solid ${S.rule}`,
            }}>
              <div style={{ padding: "0 10px", height: 28, display: "flex", alignItems: "center" }}>
                <Label>Club</Label>
              </div>
              {gameweeks.map((week) => (
                <div key={week} style={{
                  height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink2, fontWeight: 600 }}>
                    {week}
                  </span>
                </div>
              ))}
              <div style={{
                height: 28, display: "flex", alignItems: "center",
                justifyContent: "flex-end", paddingRight: 10,
              }}>
                <Label>FDR</Label>
              </div>
            </div>

            {ordered.map((cclub) => {
              const inPhase = (index: number) =>
                cclub.phases.some((p) => index >= p.fromIndex && index <= p.toIndex);
              return (
                <div
                  key={cclub.teamId}
                  data-testid="phase-row"
                  style={{ display: "grid", gridTemplateColumns: template, gap: 2, padding: "2px 0" }}
                >
                  <div style={{
                    padding: "0 10px", display: "flex", alignItems: "center", gap: 6,
                    minWidth: 0,
                  }}>
                    <span style={{
                      fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {cclub.shortName || cclub.team}
                    </span>
                  </div>

                  {cclub.weeks.map((week, index) => {
                    const band = difficultyBand(week.difficulty, HEAT_STEPS);
                    const [background, ink] = band === null
                      ? ["transparent", S.ink4] as const
                      : heatStep(band, HEAT_STEPS - 1);
                    return (
                      <div key={week.gameweek} style={{ position: "relative" }}>
                        <div
                          title={week.blank
                            ? `GW${week.gameweek}: no fixture`
                            : `GW${week.gameweek}: ${week.labels.join(" · ")} · FDR ${week.difficulty}`}
                          style={{
                            height: 24, background, color: ink,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontFamily: MONO, fontSize: 9,
                            border: band === null ? `1px dashed ${S.hair}` : "none",
                          }}
                        >
                          {/* Lowercase at home, uppercase away — a convention the
                              references use, and one that fits where a venue word
                              would not. A blank says so rather than sitting empty,
                              which would read as an unlabelled fixture. */}
                          {week.blank
                            ? "—"
                            : week.labels
                                .map((label) => venue(label))
                                .join("/")}
                        </div>
                        {inPhase(index) ? (
                          <div style={{
                            position: "absolute", left: 0, right: 0, bottom: -2,
                            height: 2, background: S.brand,
                          }} />
                        ) : null}
                      </div>
                    );
                  })}

                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "flex-end",
                    paddingRight: 10, fontFamily: MONO, fontSize: 10,
                    color: cclub.phases.length > 0 ? S.brand : S.ink3,
                  }}>
                    {cclub.meanDifficulty === null ? "—" : cclub.meanDifficulty.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{
          flex: "1 1 300px", minWidth: 260,
          border: `1px solid ${S.hair}`, borderTop: "none", borderLeft: "none",
        }}>
          <div style={{
            padding: "7px 12px", background: S.bar, borderBottom: `1px solid ${S.rule}`,
          }}>
            <Label>Hop on / hop off</Label>
          </div>
          {phases.length === 0 ? (
            <p style={{ padding: "16px 12px", fontSize: 11.5, color: S.ink2, margin: 0 }}>
              No club has {minLength} straight weeks this kind. That is an answer, not
              an empty state — loosen the run or the threshold to see what is closest.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {phases.map((phase) => (
                <li
                  key={`${phase.teamId}-${phase.fromGameweek}`}
                  data-testid="phase-entry"
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", borderBottom: `1px solid ${S.hair}`,
                  }}
                >
                  <span style={{ fontFamily: DISPLAY, fontSize: 15, minWidth: 42 }}>
                    {phase.shortName || phase.team}
                  </span>
                  <div style={{ minWidth: 0, flexGrow: 1 }}>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: S.ink2 }}>
                      GW{phase.fromGameweek}–{phase.toGameweek}
                    </div>
                    <div style={{ display: "flex", gap: 2, marginTop: 3, flexWrap: "wrap" }}>
                      {phase.weeks.map((week) => {
                        const band = difficultyBand(week.difficulty, HEAT_STEPS);
                        const [background, ink] = band === null
                          ? ["transparent", S.ink4] as const
                          : heatStep(band, HEAT_STEPS - 1);
                        return (
                          <span key={week.gameweek} style={{
                            fontFamily: MONO, fontSize: 9, padding: "1px 4px",
                            background, color: ink,
                          }}>
                            {week.labels.map((label) => venue(label)).join("/")}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: DISPLAY, fontSize: 16, color: S.brand }}>
                      {phase.length}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 8.5, color: S.ink3 }}>
                      FDR {phase.meanDifficulty.toFixed(2)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div style={{
        display: "flex", flexWrap: "wrap", gap: 26, padding: 14,
        background: S.bar, border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <div style={{ maxWidth: 300 }}>
          <div style={{ marginBottom: 6 }}><Label>Bright is kind</Label></div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3 }}>5</span>
            {Array.from({ length: HEAT_STEPS }, (_, band) => (
              <span key={band} style={{
                width: 20, height: 10, background: heatStep(band, HEAT_STEPS - 1)[0],
              }} />
            ))}
            <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3 }}>1</span>
          </div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            The opposite of the projection grid, where bright is a big number.
            Difficulty is a cost, so here bright is a LOW one. Lowercase is home,
            uppercase away; a dash is a blank gameweek.
          </p>
        </div>
        <div style={{ maxWidth: 420 }}>
          <div style={{ marginBottom: 6 }}><Label>Whose number this is</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            FDR is FPL&apos;s own 1–5 rating for the club in that fixture. It is not a
            model output and nothing here has calibrated it. It earns the screen
            because a fixture list is the one part of a horizon that is known rather
            than forecast — so this page says which weeks are soft, and the
            projection grid says what a player is worth in them. There is no
            &ldquo;expected return from this phase&rdquo; anywhere on it, because
            nothing simulated one.
          </p>
        </div>
        <div style={{ maxWidth: 320 }}>
          <div style={{ marginBottom: 6 }}><Label>What breaks a run</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            A blank gameweek, because a week with no fixture cannot be bought into.
            A double counts only if BOTH its fixtures are within the threshold, and
            is rated by the harder of the two — otherwise every double would look
            like the softest week of the season.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * `COV (H)` becomes `cov`, `MCI (A)` becomes `MCI`.
 *
 * Case carries the venue so the cell needs no second glyph, which is what makes a
 * 46px column readable. A label the matrix did not produce is passed through
 * rather than parsed into something else.
 */
function venue(label: string): string {
  const match = /^(.+?)\s*\((H|A)\)\s*$/.exec(label);
  if (!match) return label;
  return match[2] === "H" ? match[1].toLowerCase() : match[1].toUpperCase();
}
