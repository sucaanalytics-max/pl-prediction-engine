/**
 * The squad, banded by position, with the bench below the rule and the club
 * clusters read out underneath.
 *
 * Three things this board refuses to do:
 *
 * It does not sum the quantiles. Expectation is additive, so a band's xP total is a
 * real measurement; a band's *spread* is not, because `xp_public` publishes marginal
 * quantiles with no covariance and this squad is deliberately correlated — three of
 * the fifteen play in one fixture. Summing the marginals gave 11.0-96.0 against a
 * measured 27-51, three and a half times too wide, so the spread column is `∅`.
 *
 * It does not rank the clusters by how much they hurt or help. The direction is
 * knowable from each bot's objective alone: correlated holdings raise the variance of
 * the margin, which Ronny pays for and Wazza banks. The magnitude needs the
 * covariance, which is not published.
 *
 * It does not renumber the bench. FPL's own order decides who comes on, so the board
 * shows that order rather than an order of its own devising.
 */
import { Fragment } from "react";

import { KitMark } from "@/components/squad/KitMark";
import { SquadRow, type SquadRowPlayer } from "@/components/squad/SquadRow";
import type { Position } from "@/lib/fpl-live";
import type { MarginSurface } from "@/lib/margin/tokens";

export interface SquadBoardPlayer extends SquadRowPlayer {
  readonly position: Position;
}

/** Bands in FPL's own order, so the board reads like the squad screen. */
const BANDS: ReadonlyArray<{ position: Position; label: string }> = [
  { position: "GKP", label: "Goalkeeper" },
  { position: "DEF", label: "Defence" },
  { position: "MID", label: "Midfield" },
  { position: "FWD", label: "Attack" },
];

/** A club is a cluster once it carries a second player. One is just a pick. */
const CLUSTER_FLOOR = 2;

const MONO = "var(--font-mono, ui-monospace), monospace";

/** Expectation is additive; this is the only total the artifact supports. */
export function bandTotal(players: readonly SquadBoardPlayer[]): number | null {
  const scored = players.filter((p) => p.xp !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, p) => sum + (p.xp as number), 0);
}

export interface Cluster {
  readonly club: string;
  readonly count: number;
  readonly xp: number | null;
  readonly names: readonly string[];
}

/**
 * Clubs holding two or more of the fifteen, heaviest first.
 *
 * Bench players count. A cluster's correlation does not care whether a player
 * started — an early red card in that fixture reaches the bench too, via the
 * automatic substitution that brings the wrong player on.
 */
export function clusters(players: readonly SquadBoardPlayer[]): readonly Cluster[] {
  const byClub = new Map<string, SquadBoardPlayer[]>();
  for (const player of players) {
    const held = byClub.get(player.club);
    if (held) held.push(player);
    else byClub.set(player.club, [player]);
  }
  return [...byClub.entries()]
    .filter(([, held]) => held.length >= CLUSTER_FLOOR)
    .map(([club, held]) => ({
      club,
      count: held.length,
      xp: bandTotal(held),
      names: held.map((p) => p.name),
    }))
    .sort((a, b) => b.count - a.count || (b.xp ?? 0) - (a.xp ?? 0) || a.club.localeCompare(b.club));
}

function BandHeading(
  { label, count, xp, surface }:
  { label: string; count: number; xp: number | null; surface: MarginSurface },
) {
  return (
    <div
      data-testid={`band-${label.toLowerCase()}`}
      style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        gap: 8, padding: "10px 0 4px",
        borderBottom: `1px solid ${surface.hair}`,
      }}
    >
      <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{
          fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
          color: surface.ink3,
        }}>
          {label}
        </span>
        {/* The count is the band, not decoration: 3-4-3 is a formation. */}
        <span
          data-testid={`band-count-${label.toLowerCase()}`}
          style={{ fontFamily: MONO, fontSize: 10, color: surface.ink4 }}
        >
          {count}
        </span>
      </span>
      <span
        data-testid={`band-total-${label.toLowerCase()}`}
        style={{ fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums", color: surface.ink2 }}
      >
        {xp === null ? "∅" : xp.toFixed(1)}
      </span>
    </div>
  );
}

export function SquadBoard({
  players, surface, thresholdLabel = "P(GW ≥ 70)",
}: {
  players: readonly SquadBoardPlayer[];
  surface: MarginSurface;
  thresholdLabel?: string;
}) {
  const xi = players.filter((p) => !p.benched);
  const bench = players.filter((p) => p.benched);
  /* FPL substitutes outfield players in list order; the reserve keeper is not in
     that queue, so it carries no number rather than a misleading "1". */
  let outfieldSeen = 0;

  return (
    <section aria-label="Squad" style={{ display: "flex", flexDirection: "column" }}>
      {BANDS.map(({ position, label }) => {
        const band = xi.filter((p) => p.position === position);
        if (band.length === 0) return null;
        return (
          <Fragment key={position}>
            <BandHeading
              label={label} count={band.length} xp={bandTotal(band)} surface={surface}
            />
            {band.map((player) => (
              <SquadRow key={player.name} player={player} surface={surface} />
            ))}
          </Fragment>
        );
      })}

      {bench.length > 0 && (
        <>
          {/* The one 2px rule on the page: below it, points do not count. */}
          <div
            data-testid="bench-rule"
            style={{
              borderTop: `2px solid ${surface.rule}`,
              marginTop: 14, paddingTop: 8,
              display: "flex", alignItems: "baseline", gap: 6,
            }}
          >
            <span style={{
              fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
              color: surface.ink3,
            }}>
              Bench
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: surface.ink4 }}>
              {bench.length}
            </span>
          </div>
          {bench.map((player) => {
            /* `undefined` is the row's own way of saying "no number", which is
               exactly the reserve keeper's case. */
            const index = player.position === "GKP" ? undefined : ++outfieldSeen;
            return (
              <SquadRow
                key={player.name} player={player} surface={surface} benchIndex={index}
              />
            );
          })}
        </>
      )}

      <ClusterSummary
        clusters={clusters(players)} surface={surface} thresholdLabel={thresholdLabel}
      />
    </section>
  );
}

export function ClusterSummary({
  clusters: rows, surface, thresholdLabel,
}: {
  clusters: readonly Cluster[];
  surface: MarginSurface;
  thresholdLabel: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      data-testid="cluster-summary"
      style={{ marginTop: 18, borderTop: `1px solid ${surface.hair}`, paddingTop: 8 }}
    >
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
        color: surface.ink3, paddingBottom: 4,
      }}>
        <span>Club clusters</span>
        <span style={{ textTransform: "none", letterSpacing: 0, color: surface.ink4 }}>
          Ronny pays · Wazza banks
        </span>
      </div>

      {rows.map((row) => (
        <div
          key={row.club}
          data-testid={`cluster-${row.club}`}
          style={{
            display: "grid",
            gridTemplateColumns: "15px 34px 1fr 44px 30px",
            alignItems: "center", gap: 8, padding: "5px 0",
            borderBottom: `1px solid ${surface.hair}`,
          }}
        >
          <KitMark club={row.club} surface={surface} />
          <span style={{ fontFamily: MONO, fontSize: 11, color: surface.ink2 }}>
            {row.club}
          </span>
          <span style={{ fontSize: 11, color: surface.ink3, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.count} · {row.names.join(", ")}
          </span>
          <span
            data-testid={`cluster-xp-${row.club}`}
            style={{ fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums",
              color: surface.ink, textAlign: "right" }}
          >
            {row.xp === null ? "∅" : row.xp.toFixed(1)}
          </span>
          {/* What the cluster does to the SPREAD of the margin. Direction is
              knowable from the objectives; magnitude needs a covariance the
              artifact does not publish, so it is absent, not estimated. */}
          <span
            data-testid={`cluster-spread-${row.club}`}
            title={
              `Correlated holdings widen the margin's spread. Ronny maximises `
              + `expected season points and pays for that spread; Wazza maximises `
              + `${thresholdLabel} and banks it. The size of the effect needs a `
              + `covariance between these players, which xp_public does not publish.`
            }
            style={{
              fontFamily: MONO, fontSize: 11, color: surface.ink3, textAlign: "right",
              borderBottom: `1px dotted ${surface.ink4}`, cursor: "help",
            }}
          >
            ∅
          </span>
        </div>
      ))}
    </div>
  );
}
