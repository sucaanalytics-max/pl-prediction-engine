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

/**
 * The run's ceiling, in points, matching the per-player glyph scale.
 *
 * Fixed rather than per-row: a bar whose scale moved with its own value would make
 * every player's run look the same height, which is the one thing a run must not do.
 */
export const RUN_SCALE_HI = 18;

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
  /**
   * FPL's own availability, when the source stated one.
   *
   * `null` chance with empty news is a fit player; a number, or any news at all, is FPL
   * saying something. `undefined` is a player who did not come from the route, and is
   * NOT the same as fit — it renders nothing rather than a clean bill of health.
   */
  readonly chanceOfPlaying?: number | null;
  readonly news?: string;
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

  /**
   * What FPL says about this player, if anything.
   *
   * Absent chance AND empty news is a fit player — FPL sets these only when it has
   * something to say. `undefined` on both means the source never stated one, which is
   * unknown rather than fit, so nothing is drawn either way; the difference is that
   * nothing is CLAIMED.
   */
  const flag = (() => {
    const chance = player.chanceOfPlaying;
    const news = player.news ?? "";
    if (chance === undefined && !news) return null;
    if (chance === null && !news) return null;
    if (chance === 0) return { mark: "✕", title: `ruled out — ${news || "FPL flags 0%"}` };
    if (typeof chance === "number" && chance < 100) {
      return { mark: "!", title: `${chance}% chance of playing — ${news || "flagged by FPL"}` };
    }
    return news ? { mark: "·", title: news } : null;
  })();

  const cell: React.CSSProperties = {
    fontFamily: MONO, fontSize: 12, padding: "2px 6px",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      data-testid="squad-row"
      data-club={player.club}
      data-benched={dim ? "true" : "false"}
      style={{
        /*
         * A grid with stated columns, not a stretched flex.
         *
         * The row was `display: flex` with the name at `flex: 1`, so on a wide screen
         * the name sat at the far left and its numbers at the far right with a thousand
         * pixels of nothing between them. Nobody can carry a name across that gap to a
         * number, which is why a correct, well-contrasted row still read as unusable.
         *
         * Every column is now fixed except the name, and the board caps the whole
         * measure, so the eye travels a short constant distance and the columns line up
         * down the table — which is the only reason a table beats a list.
         */
        display: "grid",
        gridTemplateColumns:
          "14px 18px minmax(0, 1fr) 18px 30px auto 18px 100px 24px 34px",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
        borderBottom: `1px solid ${surface.hair}`,
      }}
    >
      {/* Always rendered, so the grid's first column exists on every row and the
          fifteen names start at one x-position. */}
      <span
        data-testid={benchIndex ? "bench-index" : "bench-index-empty"}
        title={benchIndex ? "bench order — a real FPL decision that most references bury" : undefined}
        style={{
          fontFamily: MONO, fontSize: 11, color: surface.ink3, textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {benchIndex ?? ""}
      </span>

      <KitMark club={player.club} surface={surface} />

      {/*
        * FPL's own flag, beside the name it is about.
        *
        * The route folds a pick role and an availability flag into one `status` field and
        * the role wins, so a captain who is injured kept "captain" and lost the flag — on
        * exactly the pick where it matters most. This reads the two fields the route
        * emits separately, so an armband and an injury can both be true.
        */}
      {flag ? (
        <span
          data-testid="availability-flag"
          title={flag.title}
          style={{
            fontFamily: MONO, fontSize: 11, lineHeight: 1,
            color: surface.noise, cursor: "help",
          }}
        >
          {flag.mark}
        </span>
      ) : null}

      <span
        style={{
          fontSize: 13.5, lineHeight: 1.25,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          // A benched name is quieter but still has to be readable: ink2 is 6.88:1 on
          // this surface, where ink3 is 3.82 and would fail for 13.5px body text.
          color: dim ? surface.ink2 : surface.ink,
        }}
      >
        {player.name}
      </span>

      {/* A bordered letter in the row, never a badge floating over a collar. */}
      {player.armband ? (
        <span
          data-testid="armband"
          style={{
            fontFamily: MONO, fontSize: 11, lineHeight: 1, padding: "1px 3px",
            textAlign: "center",
            border: `1px solid ${surface.rule}`, color: surface.ink,
          }}
        >
          {player.armband}
        </span>
      ) : null}

      {/* The disambiguator of last resort, per the design: colour narrows a club to a
          family, pattern and code settle it. So it has to be readable — ink2, not ink3. */}
      <span style={{ fontFamily: MONO, fontSize: 11, color: surface.ink2 }}>
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
            ...cell, fontSize: 12.5, fontWeight: 500, minWidth: 38, textAlign: "right",
            // Inverted, so the one number the row exists for cannot be skimmed past.
            background: dim ? "transparent" : surface.ink,
            color: dim ? surface.ink3 : surface.face,
          }}
        >
          {player.xp === null ? <Nil surface={surface} size={11} /> : player.xp.toFixed(1)}
        </span>
        <span style={{ ...cell, minWidth: 58, color: surface.ink2, borderLeft: `1px solid ${surface.block}` }}>
          {player.opponent ?? <Nil surface={surface} size={11} />}
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
            ...cell, minWidth: 38, textAlign: "right",
            borderLeft: `1px solid ${surface.block}`,
            // The ONLY cell in the row that may take a judgement hue, and only
            // under the floor. Expected minutes is the input a projection turns on.
            color: minutesLow ? surface.noise : surface.ink2,
          }}
        >
          {minutes === null ? <Nil surface={surface} size={11} /> : minutes.toFixed(0)}
        </span>
      </span>

      {/* Difficulty as ink weight. Monochrome, because club owns hue. */}
      <span
        data-testid="difficulty-tick"
        title={player.difficulty ? `fixture difficulty ${player.difficulty} of 5` : "no difficulty published"}
        style={{
          width: 18, height: 5, flexShrink: 0,
          /*
           * Derived from the surface, not a literal. This was
           * `rgba(27,26,22,alpha)` — PAPER's ink — which is invisible on a dark
           * ground, so the whole column vanished when the board changed surface.
           * `color-mix` keeps it monochrome, because club owns hue here.
           */
          background: player.difficulty
            ? `color-mix(in oklab, ${surface.ink} `
              + `${Math.round((DIFFICULTY_ALPHA[player.difficulty] ?? 0.3) * 100)}%, `
              + `transparent)`
            : "transparent",
          border: player.difficulty ? "none" : `1px dashed ${surface.hair}`,
        }}
      />

      {player.distribution ? (
        <Distribution of={player.distribution} surface={surface} width={96} height={12} />
      ) : (
        <Nil surface={surface} size={11} />
      )}

      {/* The four-bar run. The first bar is a measurement; the other three are slots
          for weeks the engine has not solved, drawn as empty outlines rather than as
          short bars — a short bar is a low projection, and there is no projection.
          This is the "solid versus light" the design asks for, with nothing invented
          to fill it. */}
      <span
        data-testid="run"
        title={
          "the next four gameweeks. Only this one is solved, so the first bar is the "
          + "only measurement and the other three are empty slots, not low scores."
        }
        style={{ display: "inline-flex", alignItems: "flex-end", gap: 1.5, height: 12 }}
      >
        {[0, 1, 2, 3].map((i) => {
          const solved = i === 0 && player.xp !== null;
          const height = solved
            ? Math.max(2, Math.min(12, ((player.xp as number) / RUN_SCALE_HI) * 12))
            : 12;
          return (
            <span
              key={i}
              data-testid={solved ? "run-solved" : "run-unsolved"}
              style={{
                width: 3,
                height,
                background: solved ? (dim ? surface.ink3 : surface.ink) : "transparent",
                border: solved ? undefined : `1px solid ${surface.hair}`,
              }}
            />
          );
        })}
      </span>

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
        <Nil surface={surface} size={11} />
      </span>
    </div>
  );
}
