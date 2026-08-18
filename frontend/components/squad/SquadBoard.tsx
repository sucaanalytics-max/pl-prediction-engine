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
  { position: "FWD", label: "Forward" },
];

/** A club is a cluster once it carries a second player. One is just a pick. */
const CLUSTER_FLOOR = 2;

const MONO = "var(--font-mono, ui-monospace), monospace";

/**
 * How far a kit is pulled toward the paper neutral, as the header states it.
 *
 * Derived from `kitFill`'s own mix so the two cannot disagree: the design's caption
 * reads "muted 66%", which is the share of the club's own colour that survives.
 */
const MUTE_PERCENT = 66;

/** Expectation is additive; this is the only total the artifact supports. */
export function bandTotal(players: readonly SquadBoardPlayer[]): number | null {
  const scored = players.filter((p) => p.xp !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, p) => sum + (p.xp as number), 0);
}

/** FPL's own cap. Three from one club is the most a squad may hold. */
export const CLUB_LIMIT = 3;

export interface Cluster {
  readonly club: string;
  readonly count: number;
  readonly xp: number | null;
  readonly names: readonly string[];
  /** At FPL's three-per-club cap, so the exposure cannot be added to. */
  readonly atLimit: boolean;
  /**
   * The one fixture the whole cluster plays, when they share it.
   *
   * This is what makes a cluster a correlated bet rather than three separate ones,
   * so it is the single most useful thing the line can say. Null during a blank or a
   * double, where the members do not share one fixture and the naive label would be
   * wrong.
   */
  readonly sharedFixture: string | null;
  /** The armband sits inside the cluster, doubling the correlated stake. */
  readonly hasArmband: boolean;
  readonly benched: number;
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
    .map(([club, held]) => {
      const opponents = new Set(held.map((p) => p.opponent));
      const [only] = [...opponents];
      return {
        club,
        count: held.length,
        xp: bandTotal(held),
        names: held.map((p) => p.name),
        atLimit: held.length >= CLUB_LIMIT,
        // One opponent, and it was actually stated: a set of one `null` is not a
        // shared fixture, it is an unknown one.
        sharedFixture: opponents.size === 1 && only !== null ? only : null,
        hasArmband: held.some((p) => p.armband !== null),
        benched: held.filter((p) => p.benched).length,
      };
    })
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

/**
 * The XI's shape, as FPL writes it — outfield only, keeper implied.
 *
 * Null when the squad does not field a legal eleven, rather than printing a shape
 * that would read as one. An illegal eleven is caught by reading the band counts,
 * which is exactly why they are there.
 */
export function formationOf(xi: readonly SquadBoardPlayer[]): string | null {
  if (xi.length === 0) return null;
  const count = (position: Position) => xi.filter((p) => p.position === position).length;
  return `${count("DEF")}-${count("MID")}-${count("FWD")}`;
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

  const total = bandTotal(xi);
  const formation = formationOf(xi);

  return (
    <section aria-label="Squad" style={{ display: "flex", flexDirection: "column" }}>
      {/* The header the design puts above the table: the shape, the number, and how
          the run to its right is sourced — because the run's last three bars are the
          weeks nobody has solved. */}
      <div
        data-testid="board-header"
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          gap: 10, paddingBottom: 6, flexWrap: "wrap",
          fontFamily: MONO, fontSize: 9.5, letterSpacing: ".08em",
          textTransform: "uppercase", color: surface.ink3,
        }}
      >
        <span data-testid="board-shape">
          {formation ?? "no legal eleven"}
          {total === null ? " · ∅ projected" : ` · ${total.toFixed(1)} projected`}
        </span>
        <span data-testid="board-provenance" style={{ color: surface.ink4 }}>
          {`kit · muted ${MUTE_PERCENT}% · run: this week read, next three unsolved`}
        </span>
      </div>

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

/**
 * What the cluster is, in the order that matters.
 *
 * The shared fixture first, because that is what makes three holdings one bet. Then
 * the cap, then the armband, then the bench — each stated only when true, so the line
 * never pads itself with negations.
 */
export function clusterNote(cluster: Cluster): string {
  const parts = [`×${cluster.count}`];
  if (cluster.atLimit) parts.push("at the limit");
  if (cluster.sharedFixture) parts.push(`all ${cluster.sharedFixture}`);
  if (cluster.hasArmband) parts.push("armband inside");
  if (cluster.benched > 0) {
    parts.push(cluster.benched === 1 ? "one benched" : `${cluster.benched} benched`);
  }
  return `${parts.join(" · ")} — ${cluster.names.join(", ")}`;
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
          <span
            data-testid={`cluster-note-${row.club}`}
            style={{ fontSize: 11, color: surface.ink3, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {clusterNote(row)}
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
