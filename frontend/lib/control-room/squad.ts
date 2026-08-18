/**
 * The captured fifteen, joined to the published projection.
 *
 * The join is on `elementId` and nothing else. The previous board matched by name
 * and position, folding accents on both sides so `Kadıoğlu` could meet `Kadioglu`,
 * and refused outright whenever two players collided — FPL carries six Wilsons. The
 * id was in the payload the whole time.
 *
 * A pick the projection does not carry keeps a null `xp`, which the row renders as
 * `∅`. It is never given a neighbour's number, and it is never dropped: a squad
 * board that quietly shows fourteen players is worse than one that shows a gap.
 */
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";
import type { SquadBoardPlayer } from "@/components/squad/SquadBoard";
import type { Position } from "@/lib/fpl-live";

const POSITIONS: Record<string, Position> = {
  GKP: "GKP", DEF: "DEF", MID: "MID", FWD: "FWD",
};

export interface BoardSquad {
  readonly players: readonly SquadBoardPlayer[];
  /**
   * Picks whose position the payload did not state in FPL's own vocabulary.
   *
   * Empty in practice — `element_type` is always sent — but a player cannot be
   * banded without one, and dropping them silently would make the formation count
   * lie. The page names them instead.
   */
  readonly unplaced: readonly string[];
}

export function squadBoardPlayers(
  squad: readonly SquadPlayer[] | null | undefined,
  projections: readonly Projection[] | null | undefined,
  /**
   * The gameweek being shown, so the opponent and difficulty come from THIS week's
   * fixture rather than from `fixtures[0]`.
   *
   * The narrower sends ten fixtures per player and the first is not reliably the
   * current one — after a deadline passes it is next week's. Picking by index would
   * label a row with the wrong opponent, which is the class of error the whole
   * board is built to avoid. Null means no week is resolved, so no fixture is
   * claimed.
   */
  gameweek: number | null,
): BoardSquad {
  if (!squad || squad.length === 0) return { players: [], unplaced: [] };

  const byId = new Map<number, Projection>();
  for (const projection of projections ?? []) {
    byId.set(projection.elementId, projection);
  }

  const players: SquadBoardPlayer[] = [];
  const unplaced: string[] = [];

  for (const pick of squad) {
    const position = POSITIONS[pick.position];
    if (!position) {
      unplaced.push(pick.name);
      continue;
    }
    // `undefined` means the source did not distinguish starters, per `SquadPlayer`.
    // Treating that as "starting" would invent an XI, so it stays off the bench and
    // the band counts show what the source actually said.
    const projection = pick.elementId === undefined
      ? undefined
      : byId.get(pick.elementId);

    /* FPL's difficulty is its own 1-5 rating, not ours: external, and the row
       renders it as a monochrome tick rather than as a judgement of its own. */
    const fixture = gameweek === null
      ? undefined
      : pick.fixtures.find((f) => f.gameweek === gameweek);

    players.push({
      name: pick.name,
      club: pick.team,
      position,
      benched: pick.bench === true,
      armband: pick.role === "captain" ? "C" : pick.role === "vice" ? "V" : null,
      xp: projection?.xp ?? null,
      opponent: fixture?.label ?? null,
      expectedMinutes: projection?.eMinutes ?? null,
      difficulty: fixture?.difficulty ?? null,
      // Passed through, not defaulted: an absent flag is unknown, not fit.
      chanceOfPlaying: pick.chanceOfPlaying,
      news: pick.news,
      distribution: projection
        ? {
          q10: projection.q10, q25: projection.q25, q50: projection.q50,
          q75: projection.q75, q90: projection.q90,
          mean: projection.xp, mode: projection.mode,
        }
        : null,
    });
  }

  return { players, unplaced };
}
