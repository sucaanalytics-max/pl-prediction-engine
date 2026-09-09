"use client";

/**
 * The season's three shapes.
 *
 * ## Why three charts and not one
 *
 * Rank, margin over the field and bench points carry three different units. A
 * single chart carrying two of them needs two y-scales, which is the one chart
 * mistake with no defence: the crossing point of two arbitrary scales looks
 * like a finding and is an artefact of where you put the axes.
 *
 * Each is a SINGLE series, so none carries a legend — the heading names it —
 * and there is no categorical palette to check. Marks take `HEAT`'s darkest
 * step, the system's own data colour, so a mark says "this is data" rather
 * than "this is good or bad".
 *
 * ## Why the sign is never a colour
 *
 * `DecisionReview` spends the semantic three on verdicts, so on this page
 * colour means judgement. A red bar for a week below average would put a
 * verdict into what is only accounting. Direction carries the sign instead:
 * above the rule or below it.
 *
 * The geometry helpers are exported and tested because an inverted axis is
 * exactly the kind of thing that silently ships upside down.
 */
import { SIGNAL as S } from "@/lib/margin/tokens";

/** The one data colour on the page. `HEAT`'s darkest step. */
const MARK = "#3b5480";

export interface SeasonPoint {
  readonly event: number;
  readonly value: number | null;
}

/**
 * Rank to a y coordinate, INVERTED: a smaller rank is a better rank, so it
 * sits higher on the screen. Plotting it the obvious way round gives a chart
 * that falls as you improve.
 */
export function rankY(
  rank: number, worst: number, top: number, bottom: number,
): number {
  if (worst <= 0) return bottom;
  const share = Math.min(Math.max(rank / worst, 0), 1);
  return top + share * (bottom - top);
}

/** A bar hanging off a zero rule. Positive above, negative below. */
export function signedBar(
  value: number, maxAbs: number, zeroY: number, reach: number,
): { readonly y: number; readonly height: number } {
  if (maxAbs <= 0) return { y: zeroY, height: 0 };
  const length = (Math.abs(value) / maxAbs) * reach;
  return value >= 0
    ? { y: zeroY - length, height: length }
    : { y: zeroY, height: length };
}

/** A bar rising from a baseline. Magnitude only; never negative. */
export function magnitudeBar(
  value: number, max: number, baselineY: number, reach: number,
): { readonly y: number; readonly height: number } {
  if (max <= 0) return { y: baselineY, height: 0 };
  const length = (Math.max(value, 0) / max) * reach;
  return { y: baselineY - length, height: length };
}

/** Millions, to two figures — 3,427,838 reads as 3.43m. */
export function millions(rank: number): string {
  return `${(rank / 1_000_000).toFixed(2)}m`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

/** Evenly spaced x positions, inset from both ends. */
function columns(count: number, width: number): number[] {
  if (count <= 0) return [];
  const step = width / count;
  return Array.from({ length: count }, (_, i) => step * (i + 0.5));
}

const AXIS = { fontSize: 11, fill: S.ink3 } as const;

function Empty({ what }: { what: string }) {
  return (
    <p style={{ fontSize: 11, color: S.ink3, margin: 0 }}>
      No {what} settled yet.
    </p>
  );
}

export function RankChart({ rows }: { rows: readonly SeasonPoint[] }) {
  const known = rows.filter((r) => r.value !== null);
  if (known.length === 0) return <Empty what="rank" />;

  const W = 1100;
  const TOP = 30;
  const BOTTOM = 190;
  // Round the worst rank up to a whole million so the gridlines are readable
  // numbers rather than whatever this season happens to have produced.
  const worst = Math.max(
    1_000_000,
    Math.ceil(Math.max(...known.map((r) => r.value as number)) / 1_000_000) * 1_000_000,
  );
  const xs = columns(rows.length, W - 66).map((x) => x + 66);
  const path = known
    .map((r) => {
      const i = rows.indexOf(r);
      return `${xs[i]},${rankY(r.value as number, worst, TOP, BOTTOM).toFixed(1)}`;
    })
    .join(" ");
  const gridlines = [worst / 4, worst / 2, worst].map((rank) => ({
    rank, y: rankY(rank, worst, TOP, BOTTOM),
  }));
  const last = known[known.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} 214`}
      width="100%"
      height={214}
      role="img"
      aria-label={`Overall rank by gameweek: ${known.map((r) => millions(r.value as number)).join(", ")}`}
    >
      {gridlines.map((g, i) => (
        <g key={g.rank}>
          <line
            x1={66} y1={g.y} x2={W} y2={g.y}
            stroke={i === gridlines.length - 1 ? S.rule : S.hair}
            strokeWidth={1}
          />
          <text x={58} y={g.y + 4} textAnchor="end" {...AXIS}>
            {millions(g.rank)}
          </text>
        </g>
      ))}
      <polyline
        points={path} fill="none" stroke={MARK} strokeWidth={2} strokeLinejoin="round"
      />
      {known.map((r) => {
        const i = rows.indexOf(r);
        const y = rankY(r.value as number, worst, TOP, BOTTOM);
        return (
          <g key={r.event}>
            <circle cx={xs[i]} cy={y} r={5} fill={MARK} stroke={S.shell} strokeWidth={2} />
            {r === last ? (
              <text x={xs[i]} y={y - 13} textAnchor="middle" fontSize={11} fill={S.ink}>
                {millions(r.value as number)}
              </text>
            ) : null}
          </g>
        );
      })}
      {rows.map((r, i) => (
        <text key={r.event} x={xs[i]} y={208} textAnchor="middle" {...AXIS}>
          {r.event}
        </text>
      ))}
    </svg>
  );
}

export function MarginChart({ rows }: { rows: readonly SeasonPoint[] }) {
  const known = rows.filter((r) => r.value !== null);
  if (known.length === 0) return <Empty what="margin" />;

  const W = 520;
  const ZERO = 66;
  const REACH = 45;
  const maxAbs = Math.max(...known.map((r) => Math.abs(r.value as number)), 1);
  const xs = columns(rows.length, W);
  const bandwidth = Math.min(58, (W / rows.length) * 0.55);

  return (
    <svg
      viewBox={`0 0 ${W} 132`}
      width="100%"
      height={132}
      role="img"
      aria-label={`Points minus the gameweek average: ${known.map((r) => signed(r.value as number)).join(", ")}`}
    >
      <line x1={0} y1={ZERO} x2={W} y2={ZERO} stroke={S.rule} strokeWidth={1} />
      {known.map((r) => {
        const i = rows.indexOf(r);
        const value = r.value as number;
        const bar = signedBar(value, maxAbs, ZERO, REACH);
        return (
          <g key={r.event}>
            <rect
              x={xs[i] - bandwidth / 2} y={bar.y}
              width={bandwidth} height={bar.height} rx={4} fill={MARK}
            />
            <text
              x={xs[i]}
              y={value >= 0 ? bar.y - 6 : bar.y + bar.height + 14}
              textAnchor="middle" fontSize={11} fill={S.ink}
            >
              {signed(value)}
            </text>
          </g>
        );
      })}
      {rows.map((r, i) => (
        <text key={r.event} x={xs[i]} y={126} textAnchor="middle" {...AXIS}>
          {r.event}
        </text>
      ))}
    </svg>
  );
}

export function BenchChart({ rows }: { rows: readonly SeasonPoint[] }) {
  const known = rows.filter((r) => r.value !== null);
  if (known.length === 0) return <Empty what="bench" />;

  const W = 520;
  const BASE = 110;
  const REACH = 80;
  const max = Math.max(...known.map((r) => r.value as number), 1);
  const xs = columns(rows.length, W);
  const bandwidth = Math.min(58, (W / rows.length) * 0.55);

  return (
    <svg
      viewBox={`0 0 ${W} 132`}
      width="100%"
      height={132}
      role="img"
      aria-label={`Bench points by gameweek: ${known.map((r) => r.value).join(", ")}`}
    >
      <line x1={0} y1={BASE} x2={W} y2={BASE} stroke={S.rule} strokeWidth={1} />
      {known.map((r) => {
        const i = rows.indexOf(r);
        const bar = magnitudeBar(r.value as number, max, BASE, REACH);
        return (
          <g key={r.event}>
            <rect
              x={xs[i] - bandwidth / 2} y={bar.y}
              width={bandwidth} height={bar.height} rx={4} fill={MARK}
            />
            <text x={xs[i]} y={bar.y - 6} textAnchor="middle" fontSize={11} fill={S.ink}>
              {r.value}
            </text>
          </g>
        );
      })}
      {rows.map((r, i) => (
        <text key={r.event} x={xs[i]} y={126} textAnchor="middle" {...AXIS}>
          {r.event}
        </text>
      ))}
    </svg>
  );
}
