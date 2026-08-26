"use client";

/**
 * The rail: what the numbers single out, and the eight weeks behind them.
 *
 * Two blocks with one job between them. The callouts say what is unusual about
 * this squad right now; the horizon table says whether that is about to change.
 *
 * ## The callouts are argmaxes, and can be absent
 *
 * `lib/call/board.ts` derives each one as the maximum of a published quantity —
 * widest interval, lowest projection, highest ownership — so a reader can check
 * every claim against the artifact. When the quantity is unpublished the callout
 * does not appear, rather than falling back to whoever sorted first.
 *
 * ## The horizon table is per-player projections, NOT a lineup
 *
 * This is the distinction the whole file turns on. Only the current gameweek has
 * a solved eleven; `xp_public` publishes a per-player projection for each of the
 * next seven weeks and nothing more. So the table shows what each player is
 * projected for, week by week, and never who starts — a grid of eight solved
 * elevens would be a rotation plan carrying a solver's authority with none of its
 * evidence. `components/PlanGridSection.tsx` draws the weeks that WERE solved,
 * from the decision artifact, further down the page.
 *
 * The two scales are offered for the reason the note states: absolute makes cells
 * comparable across weeks and shows certainty draining rightward; per-week ranks
 * each column against itself and is useless for judging whether a later week is
 * worth planning around.
 */

import type { Horizon } from "@/lib/data/projections";
import type { SquadRow } from "@/lib/margin/squad";
import { DISPLAY, FLOODLIT, MONO, SANS, HEAT, stepOf } from "@/lib/margin/tokens";
import { EYEBROW } from "@/lib/margin/type";
import { FIXED, HEAT_STEPS, POINT_BANDS, bandOf } from "@/lib/projections/grid";
import type { Callout } from "@/lib/call/board";

const S = FLOODLIT;

const BADGE_COLOUR: Record<Callout["kind"], string> = {
  widest: S.brand,
  drag: S.conflict,
  template: S.noise,
};

const BADGE_LABEL: Record<Callout["kind"], string> = {
  widest: "WIDEST",
  drag: "DRAG",
  template: "TEMPLATE",
};

export type HorizonScale = "absolute" | "week";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ ...EYEBROW, color: S.ink3 }}>{children}</span>
  );
}

export function Rail({
  callouts, starters, horizon, currentGameweek, scale, onScale,
}: {
  readonly callouts: readonly Callout[];
  readonly starters: readonly SquadRow[];
  readonly horizon: Horizon | null;
  readonly currentGameweek: number;
  readonly scale: HorizonScale;
  readonly onScale: (scale: HorizonScale) => void;
}) {
  const weeks = [currentGameweek, ...(horizon?.weeks ?? []).map((w) => w.gameweek)]
    .filter((week, index, all) => all.indexOf(week) === index)
    .slice(0, 8);

  const xpFor = (row: SquadRow, week: number, index: number): number | null => {
    if (index === 0) return row.projection?.xp ?? null;
    const id = row.player.elementId;
    if (id === undefined) return null;
    return horizon?.weeks.find((w) => w.gameweek === week)?.xp.get(id) ?? null;
  };

  const rows = starters
    .slice()
    .sort((a, b) => (b.projection?.xp ?? -Infinity) - (a.projection?.xp ?? -Infinity));

  // The per-week scale ranks a column against the rows in view, which is what
  // makes it a within-week ranking rather than a second absolute scale.
  const ceilings = weeks.map((week, index) => Math.max(
    0.1,
    ...rows.map((row) => xpFor(row, week, index) ?? 0),
  ));

  return (
    <aside style={{ background: S.bar, fontFamily: SANS, color: S.ink }}>
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${S.rule}` }}>
        <Eyebrow>What the numbers single out</Eyebrow>
      </div>

      {callouts.length === 0 ? (
        <p style={{ padding: "13px 14px", fontSize: 11.5, color: S.ink2, margin: 0 }}>
          Nothing to single out: each of these is the largest of a published
          quantity, and none of them is published for this squad yet.
        </p>
      ) : (
        callouts.map((callout) => (
          <div
            key={callout.kind}
            data-testid="callout"
            data-kind={callout.kind}
            style={{
              padding: "13px 14px", borderBottom: `1px solid ${S.hair}`,
              display: "flex", gap: 12, alignItems: "flex-start",
            }}
          >
            <span style={{
              fontFamily: SANS, fontSize: 8.5, letterSpacing: ".12em", fontWeight: 700,
              padding: "3px 6px", whiteSpace: "nowrap",
              border: `1px solid ${BADGE_COLOUR[callout.kind]}`,
              color: BADGE_COLOUR[callout.kind],
            }}>
              {BADGE_LABEL[callout.kind]}
            </span>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{callout.who}</span>
                <span style={{
                  fontFamily: MONO, fontSize: 11.5, color: BADGE_COLOUR[callout.kind],
                }}>
                  {callout.figure}
                </span>
              </div>
              <p style={{
                fontSize: 11.5, color: S.ink2, lineHeight: 1.45, margin: "4px 0 0",
              }}>
                {callout.why}
              </p>
            </div>
          </div>
        ))
      )}

      <div style={{
        padding: "12px 14px 8px", borderBottom: `1px solid ${S.hair}`,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <Eyebrow>
          Horizon — GW{weeks[0]}
          {weeks.length > 1 ? ` to GW${weeks[weeks.length - 1]}` : ""}
        </Eyebrow>
        <span style={{ flexGrow: 1 }} />
        <span style={{ display: "flex", border: `1px solid ${S.rule}` }}>
          {([["absolute", "fixed"], ["week", "per week"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onScale(key)}
              aria-pressed={scale === key}
              style={{
                padding: "4px 9px", fontSize: 10.5,
                fontWeight: scale === key ? 600 : 400,
                background: scale === key ? "rgba(233,238,245,.10)" : "transparent",
                color: scale === key ? S.ink : S.ink3,
                borderRight: `1px solid ${S.rule}`, border: 0, cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {weeks.length <= 1 ? (
        <p style={{ padding: "12px 14px", fontSize: 11.5, color: S.ink2, margin: 0 }}>
          This run solved no horizon, so there is one week to show and nothing to
          compare it against.
        </p>
      ) : (
        <div style={{ padding: "0 14px 12px", overflowX: "auto" }}>
          <div style={{
            display: "grid", gridTemplateColumns: `84px repeat(${weeks.length}, 1fr)`,
            gap: 2, marginBottom: 3,
          }}>
            <div />
            {weeks.map((week) => (
              <div key={week} style={{ textAlign: "center" }}>
                <span style={{
                  // "GW3" is a label; the cells below it are the figures.
                  fontFamily: SANS, fontSize: 8.5, letterSpacing: ".1em",
                  color: S.ink3, fontWeight: 600,
                }}>
                  GW{week}
                </span>
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <div
              key={row.player.elementId ?? row.player.name}
              data-testid="horizon-row"
              style={{
                display: "grid", gridTemplateColumns: `84px repeat(${weeks.length}, 1fr)`,
                gap: 2, marginBottom: 2, alignItems: "center",
              }}
            >
              <div style={{
                fontSize: 10.5, color: S.ink2, whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {row.player.name}
              </div>
              {weeks.map((week, index) => {
                const xp = xpFor(row, week, index);
                const band = bandOf(
                  xp,
                  scale === "absolute" ? FIXED : ceilings[index],
                  HEAT_STEPS,
                );
                const [background, colour] = band === null
                  ? ["transparent", S.ink3] as const
                  : stepOf(HEAT, band);
                return (
                  <div
                    key={week}
                    style={{
                      background, color: colour, fontFamily: MONO, fontSize: 9.5,
                      textAlign: "center", padding: "3px 0",
                      border: band === null ? `1px solid ${S.hair}` : "none",
                    }}
                  >
                    {/* A dot, not a zero: this player has no view for that week. */}
                    {xp === null ? "·" : xp.toFixed(1)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: "11px 14px 16px", borderTop: `1px solid ${S.hair}` }}>
        <p style={{ fontSize: 11, color: S.ink2, lineHeight: 1.5, margin: 0 }}>
          {scale === "absolute"
            ? `Fixed bands at ${POINT_BANDS.join(", ")} points, the same on every screen
               and in every week — so a colour here means what it means on the
               projections grid. Rows still fade rightward, because certainty decays
               with distance: a week eight out is a weaker claim about the same
               player, not a worse fixture. Read the fade as confidence, not as
               difficulty.`
            : `Per-week scale: each column is ranked against itself, so the brightest
               cell in the last column is only the best of that column. Use this to
               pick within a week; use absolute to decide whether a later week is
               worth planning around at all.`}
        </p>
        <p style={{ fontSize: 11, color: S.ink3, lineHeight: 1.5, margin: "8px 0 0" }}>
          These are per-player projections, not a lineup. Only this gameweek has a
          solved eleven — the weeks that were solved are drawn further down the page,
          from the decision the agent actually published.
        </p>
      </div>
    </aside>
  );
}
