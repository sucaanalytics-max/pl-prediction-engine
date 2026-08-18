/**
 * One player, one row, forty pixels.
 *
 * This replaces the jersey pitch, and the arithmetic is the argument. Measured
 * against the references: FPL's official pitch spends ~127px per player, FFFix's
 * assistant ~79px, and this row 40px. A pitch spends its whole area encoding ONE
 * categorical variable — the formation — and every other fact on it is text in a
 * label. It cannot be sorted, ranked, or compared across a horizon. The formation
 * band keeps the one thing the pitch owned, "is this a legal and sensible eleven",
 * for an eighth of the space.
 *
 * Hue budget: club owns it (see `kits.ts` — club is the correlation grouping
 * variable). So fixture difficulty CANNOT also own it, which is why the difficulty
 * tick is monochrome on both surfaces and why the only other coloured thing in the
 * row is the minutes cell past its threshold. Judgement hues stay reserved.
 */
import { Distribution, Nil } from "@/components/margin/Marks";
import { KitMark } from "@/components/squad/KitMark";
import type { DistributionInput } from "@/lib/margin/distribution";
import { MONO, type MarginSurface } from "@/lib/margin/tokens";

/** Below this, expected minutes is the figure most likely to be wrong. */
export const MINUTES_FLOOR = 80;

/** Fixture difficulty as ink weight, never as hue. */
const DIFFICULTY_ALPHA: Readonly<Record<number, number>> = {
  1: 0.08, 2: 0.16, 3: 0.3, 4: 0.52, 5: 0.78,
};

export interface SquadRowPlayer {
  readonly name: string;
  readonly club: string;
  /** `C`, `V`, or null. */
  readonly armband: "C" | "V" | null;
  readonly benched: boolean;
  /** Our own projected points for the gameweek. Null when nothing was fitted. */
  readonly xp: number | null;
  /** The opponent as the fixture spells it, e.g. `HUL (A)`. */
  readonly opponent: string | null;
  /**
   * OUR expected minutes, from the simulation — not a third party's.
   *
   * The design's own figures here came from an fplreview capture that is gitignored
   * and therefore absent from every deployment, and the two sources disagree hard:
   * it put Palestra at 92 where the simulation puts him at 19.5, and it flagged
   * Isak where the simulation does not. Reading the artifact is the only way this
   * cell can be both present in production and true.
   */
  readonly expectedMinutes: number | null;
  readonly difficulty: number | null;
  readonly distribution: DistributionInput | null;
}

export function SquadRow({
  player, surface, benchIndex,
}: {
  player: SquadRowPlayer;
  surface: MarginSurface;
  /** 1–3 for a benched player, so bench ORDER is readable. */
  benchIndex?: number;
}) {
  const dim = player.benched;
  const minutes = player.expectedMinutes;
  const minutesLow = minutes !== null && minutes < MINUTES_FLOOR;

  const cell: React.CSSProperties = {
    fontFamily: MONO, fontSize: 10, padding: "2px 6px",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      data-testid="squad-row"
      data-club={player.club}
      data-benched={dim ? "true" : "false"}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
        borderBottom: `1px solid ${surface.hair}`,
      }}
    >
      {benchIndex ? (
        <span
          data-testid="bench-index"
          title="bench order — a real FPL decision that most references bury"
          style={{ fontFamily: MONO, fontSize: 9, color: surface.ink3, width: 10 }}
        >
          {benchIndex}
        </span>
      ) : null}

      <KitMark club={player.club} surface={surface} />

      <span style={{ fontSize: 12.5, lineHeight: 1.2, flex: 1, color: dim ? surface.ink3 : surface.ink }}>
        {player.name}
      </span>

      {/* A bordered letter in the row, never a badge floating over a collar. */}
      {player.armband ? (
        <span
          data-testid="armband"
          style={{
            fontFamily: MONO, fontSize: 8.5, padding: "0 3px",
            border: `1px solid ${surface.block}`, color: surface.ink,
          }}
        >
          {player.armband}
        </span>
      ) : null}

      <span style={{ fontFamily: MONO, fontSize: 9, color: surface.ink3, width: 26 }}>
        {player.club}
      </span>

      {/* The data strip: one bordered unit, three cells, internal dividers. */}
      <span
        data-testid="data-strip"
        style={{ display: "inline-flex", border: `1px solid ${surface.block}` }}
      >
        <span
          data-testid="xp-cell"
          style={{
            ...cell, fontSize: 11, fontWeight: 500, minWidth: 34, textAlign: "right",
            // Inverted, so the one number the row exists for cannot be skimmed past.
            background: dim ? "transparent" : surface.ink,
            color: dim ? surface.ink3 : surface.face,
          }}
        >
          {player.xp === null ? <Nil surface={surface} size={10} /> : player.xp.toFixed(1)}
        </span>
        <span style={{ ...cell, minWidth: 52, color: surface.ink2, borderLeft: `1px solid ${surface.block}` }}>
          {player.opponent ?? <Nil surface={surface} size={10} />}
        </span>
        <span
          data-testid="minutes-cell"
          title={
            minutes === null
              ? "no expected minutes were fitted"
              : minutesLow
                ? `${minutes.toFixed(0)} expected minutes — under ${MINUTES_FLOOR}, so this is the input most likely to be wrong`
                : `${minutes.toFixed(0)} expected minutes`
          }
          style={{
            ...cell, minWidth: 34, textAlign: "right",
            borderLeft: `1px solid ${surface.block}`,
            // The ONLY cell in the row that may take a judgement hue, and only
            // under the floor. Expected minutes is the input a projection turns on.
            color: minutesLow ? surface.noise : surface.ink2,
          }}
        >
          {minutes === null ? <Nil surface={surface} size={10} /> : minutes.toFixed(0)}
        </span>
      </span>

      {/* Difficulty as ink weight. Monochrome, because club owns hue. */}
      <span
        data-testid="difficulty-tick"
        title={player.difficulty ? `fixture difficulty ${player.difficulty} of 5` : "no difficulty published"}
        style={{
          width: 16, height: 4, flexShrink: 0,
          background: player.difficulty
            ? `rgba(27,26,22,${DIFFICULTY_ALPHA[player.difficulty] ?? 0.3})`
            : "transparent",
          border: player.difficulty ? "none" : `1px dashed ${surface.hair}`,
        }}
      />

      {player.distribution ? (
        <Distribution of={player.distribution} surface={surface} width={96} height={12} />
      ) : (
        <Nil surface={surface} size={11} />
      )}

      {/* Next four. Only GW1 is published, so there is nothing to put here. The
          dotted rule is kept as the mark of an unsourced figure, and `∅` says what
          the dotted rule alone would only imply. */}
      <span
        data-testid="next-four"
        title="no horizon is published — only this gameweek is solved"
        style={{
          fontFamily: MONO, fontSize: 11, width: 32, textAlign: "right",
          borderBottom: `1.5px dotted ${surface.ink4}`,
        }}
      >
        <Nil surface={surface} size={10} />
      </span>
    </div>
  );
}
