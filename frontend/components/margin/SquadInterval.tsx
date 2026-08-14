"use client";

/**
 * §2 — the squad total's interval, under the projected-points figure on Decide.
 *
 * ## Why this is a component and not three lines in `TheCall`
 *
 * It has one job the surrounding tile does not: **return the honest sentence when
 * the producer published nothing**. Keeping that inside the component means
 * `DecideView` has no branch, and a producer that ships the block late cannot
 * leave a hole on the screen — the tile reads exactly as it does today until the
 * numbers arrive.
 *
 * ## Scale
 *
 * `SQUAD_SCALE_LO/HI` (20–110), not the per-player 0–18. Fixed across weeks so a
 * narrow week looks narrow; a total outside it clamps and the glyph marks the
 * clamp, so a pinned mark never passes for a measured one.
 *
 * Drop in at `components/margin/SquadInterval.tsx`, then in `DecideView.tsx`
 * replace the "A mean over the simulated draws…" paragraph inside `TheCall`'s
 * Projected points tile with `<SquadInterval decision={decision} />`.
 */

import type { PublicDecision } from "@/lib/data/narrow";
import { SQUAD_SCALE_HI, SQUAD_SCALE_LO } from "@/lib/margin/distribution";
import { INK, MONO } from "@/lib/margin/tokens";
import { Distribution } from "@/components/margin/Marks";

const S = INK;

/** The sentence the shipped screen prints, kept verbatim for the absent case. */
const NO_INTERVAL =
  "A mean over the simulated draws. No interval is published for a squad total, "
  + "so none is drawn.";

function pct(fraction: number): string {
  // One decimal: the thresholds are read against each other, and 47.9 against
  // 48 is the difference between "a coin flip" and "a coin flip, rounded".
  return `${(fraction * 100).toFixed(1)}%`;
}

export function SquadInterval({ decision }: { decision: PublicDecision }) {
  const {
    mean_points, points_sd, points_q10, points_q50, points_q90, points_mode,
    probAtLeast, autosubProb, nDraws,
  } = decision;

  const hasGlyph =
    points_q10 !== null || points_q50 !== null
    || points_q90 !== null || points_mode !== null;

  if (!hasGlyph && probAtLeast.length === 0) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
        {NO_INTERVAL}
      </p>
    );
  }

  // The threshold nearest the median is the one the reader acts on, so it is the
  // one drawn in the agreement hue. With no median published, nothing is
  // emphasised — guessing which threshold matters is the kind of small invention
  // this screen does not make.
  const centre = points_q50 ?? mean_points;
  const emphasised = centre === null || probAtLeast.length === 0
    ? null
    : probAtLeast.reduce((best, row) =>
      Math.abs(row.points - centre) < Math.abs(best.points - centre) ? row : best,
    ).points;

  return (
    <div style={{ marginTop: 7 }}>
      {points_sd !== null ? (
        <div style={{ fontFamily: MONO, fontSize: 12, color: S.ink3, marginBottom: 6 }}>
          &plusmn;{points_sd.toFixed(1)}
          {points_mode !== null ? (
            <span title="the most likely single total, which is not the mean">
              {" \u00b7 most likely "}{points_mode.toFixed(0)}
            </span>
          ) : null}
        </div>
      ) : null}

      {hasGlyph ? (
        <>
          <Distribution
            of={{
              q10: points_q10,
              q50: points_q50,
              q90: points_q90,
              mean: mean_points,
              mode: points_mode,
            }}
            surface={S}
            width={200}
            height={22}
            lo={SQUAD_SCALE_LO}
            hi={SQUAD_SCALE_HI}
          />
          <div
            style={{
              display: "flex", justifyContent: "space-between", marginTop: 4,
              fontFamily: MONO, fontSize: 9.5, color: S.ink3, width: 200,
            }}
          >
            <span>{points_q10 === null ? "" : `q10 ${points_q10.toFixed(0)}`}</span>
            <span>{points_q50 === null ? "" : `median ${points_q50.toFixed(0)}`}</span>
            <span>{points_q90 === null ? "" : `q90 ${points_q90.toFixed(0)}`}</span>
          </div>
        </>
      ) : null}

      {probAtLeast.length > 1 ? (
        <div
          style={{
            display: "flex", flexWrap: "wrap", gap: "3px 12px", marginTop: 8,
            fontFamily: MONO, fontSize: 10.5, color: S.ink2,
          }}
        >
          {probAtLeast.map((row) => (
            <span key={row.points}>
              {`P(\u2265${row.points}) `}
              <span
                style={{
                  color: row.points === emphasised ? S.agree : S.ink,
                  fontWeight: row.points === emphasised ? 500 : 400,
                }}
              >
                {pct(row.p)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <p style={{ margin: "7px 0 0", fontSize: 11.5, lineHeight: 1.45, color: S.ink3 }}>
        {autosubProb === null
          ? null
          : `Auto-sub fires in ${pct(autosubProb)} of draws. `}
        {nDraws === null
          ? "From the same draws as the mean."
          : `From the same ${nDraws.toLocaleString()} draws as the mean, so the interval and the mean cannot disagree.`}
      </p>
    </div>
  );
}
