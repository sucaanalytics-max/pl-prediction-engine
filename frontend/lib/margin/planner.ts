/**
 * The planner: your fifteen, your XI, and what a transfer costs.
 *
 * ## What this computes, and what it refuses to
 *
 * Three questions the app could not answer before, in descending order of how
 * well the data supports them:
 *
 * 1. **Which eleven should start this gameweek?** Fully computable.
 *    `fpl/xp_public_gw{NN}.json` publishes a projection for every player, and
 *    the XI is a small constrained maximisation over fifteen of them. This is
 *    the model's own number and the answer is defensible.
 *
 * 2. **What does my run look like?** Fully known. Every squad player carries
 *    their next ten fixtures with FPL's own difficulty. Fixtures are scheduled,
 *    not forecast — the one part of a horizon nobody has to model.
 *
 * 3. **Which eleven should start in gameweek six?** *Not computable.* The
 *    projection covers one gameweek. {@link optimiseXi} therefore takes a
 *    points map and returns null when it has none, and the planner renders the
 *    fixture run for those weeks instead of an XI it cannot solve.
 *
 * The transfer arithmetic is exact and belongs to the reader rather than to a
 * model: selling at `price` and buying at `price` moves the bank by a known
 * amount, and a transfer beyond the free ones costs four points. Nothing here
 * predicts whether the move is good — {@link transferDelta} reports the change
 * in *this gameweek's* projected total and says so, because that is the only
 * horizon the projection covers.
 */

import type { SquadFixture, SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

/** FPL's squad rules, as the only place they are written down in this app. */
export const RULES = {
  squadSize: 15,
  lineupSize: 11,
  /** Exactly one keeper starts; the other is always the bench keeper. */
  gk: { min: 1, max: 1 },
  def: { min: 3, max: 5 },
  mid: { min: 2, max: 5 },
  fwd: { min: 1, max: 3 },
  /** Points docked per transfer beyond the free ones. */
  hitCost: 4,
} as const;

export type Line = "GKP" | "DEF" | "MID" | "FWD";

const LIMITS: Record<Line, { min: number; max: number }> = {
  GKP: RULES.gk, DEF: RULES.def, MID: RULES.mid, FWD: RULES.fwd,
};

export const LINES: readonly Line[] = ["GKP", "DEF", "MID", "FWD"];

export function isLine(value: string): value is Line {
  return (LINES as readonly string[]).includes(value);
}

/** `4-4-2`, from an XI. Null when the XI is not eleven legal players. */
export function formationOf(xi: readonly SquadPlayer[]): string | null {
  if (xi.length !== RULES.lineupSize) return null;
  const count = (line: Line) => xi.filter((p) => p.position === line).length;
  const shape = { GKP: count("GKP"), DEF: count("DEF"), MID: count("MID"), FWD: count("FWD") };
  for (const line of LINES) {
    const { min, max } = LIMITS[line];
    if (shape[line] < min || shape[line] > max) return null;
  }
  return `${shape.DEF}-${shape.MID}-${shape.FWD}`;
}

export interface XiProblem {
  readonly line: Line;
  readonly have: number;
  readonly need: string;
}

/**
 * Why an XI is illegal, or an empty list.
 *
 * Returned rather than a boolean because the planner lets you build an XI by
 * hand, and "that is not a legal team" is useless next to "you have two
 * keepers". The reader is mid-edit; the message has to say what to change.
 */
export function xiProblems(xi: readonly SquadPlayer[]): readonly XiProblem[] {
  const out: XiProblem[] = [];
  for (const line of LINES) {
    const have = xi.filter((p) => p.position === line).length;
    const { min, max } = LIMITS[line];
    if (have < min || have > max) {
      out.push({
        line,
        have,
        need: min === max ? `exactly ${min}` : `${min} to ${max}`,
      });
    }
  }
  return out;
}

export interface OptimisedXi {
  readonly xi: readonly SquadPlayer[];
  readonly bench: readonly SquadPlayer[];
  readonly captain: SquadPlayer | null;
  readonly formation: string;
  /** Sum of the XI's projections, with the captain counted twice. */
  readonly total: number;
  /** Players with no published projection, excluded from the sum. */
  readonly unprojected: number;
}

/**
 * The best legal eleven by projected points.
 *
 * Exhaustive over formations rather than greedy. There are at most fifteen
 * legal shapes and picking the top scorers per line independently does not
 * respect the total of eleven — a greedy pass that takes five defenders because
 * they are individually the next best available can leave the midfield short,
 * and the result is not merely suboptimal, it is illegal.
 *
 * Returns null when no projection is available at all: an XI chosen with no
 * numbers is an arbitrary eleven wearing the authority of an optimisation.
 * A player the projection has no view of is ranked last rather than at zero,
 * so an unknown never displaces a known low score.
 */
export function optimiseXi(
  squad: readonly SquadPlayer[],
  pointsById: ReadonlyMap<number, number>,
): OptimisedXi | null {
  if (pointsById.size === 0) return null;

  const points = (p: SquadPlayer) =>
    p.elementId === undefined ? null : pointsById.get(p.elementId) ?? null;

  // Best first within each line; unprojected players sink.
  const byLine = new Map<Line, SquadPlayer[]>();
  for (const line of LINES) {
    byLine.set(line, squad
      .filter((p) => p.position === line)
      .sort((a, b) => {
        const av = points(a);
        const bv = points(b);
        if (av === null) return bv === null ? 0 : 1;
        if (bv === null) return -1;
        return bv - av;
      }));
  }

  let best: OptimisedXi | null = null;

  for (let d = RULES.def.min; d <= RULES.def.max; d += 1) {
    for (let m = RULES.mid.min; m <= RULES.mid.max; m += 1) {
      for (let f = RULES.fwd.min; f <= RULES.fwd.max; f += 1) {
        if (1 + d + m + f !== RULES.lineupSize) continue;
        const want: Record<Line, number> = { GKP: 1, DEF: d, MID: m, FWD: f };

        const xi: SquadPlayer[] = [];
        let feasible = true;
        for (const line of LINES) {
          const available = byLine.get(line) ?? [];
          if (available.length < want[line]) { feasible = false; break; }
          xi.push(...available.slice(0, want[line]));
        }
        if (!feasible) continue;

        const scored = xi.map(points);
        const total = scored.reduce((sum: number, v) => sum + (v ?? 0), 0);
        // The captain doubles, so the best XI is the one whose total plus its
        // own best player is highest — not the one with the highest bare sum.
        const captainPoints = Math.max(0, ...scored.map((v) => v ?? 0));
        const withArmband = total + captainPoints;

        if (best === null || withArmband > best.total) {
          const captainIndex = scored.findIndex((v) => (v ?? -1) === captainPoints);
          const chosen = new Set(xi);
          best = {
            xi,
            bench: squad.filter((p) => !chosen.has(p)),
            captain: captainPoints > 0 && captainIndex >= 0 ? xi[captainIndex] : null,
            formation: `${d}-${m}-${f}`,
            total: withArmband,
            unprojected: scored.filter((v) => v === null).length,
          };
        }
      }
    }
  }

  return best;
}

/** The projection map the optimiser wants, keyed by FPL's own id. */
export function pointsFrom(projections: readonly Projection[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of projections) {
    if (p.xp !== null && !p.blank) out.set(p.elementId, p.xp);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfers
// ─────────────────────────────────────────────────────────────────────────────

export interface Move {
  /**
   * The gameweek the transfer happens in.
   *
   * A plan is a sequence, not a set: selling Shaw in GW2 and Gabriel in GW4 are
   * two decisions a week apart, each with its own free transfer and its own
   * bank. Collapsing them into one list of moves loses the only thing that makes
   * a horizon worth planning — *when*.
   */
  readonly gameweek: number;
  readonly out: SquadPlayer;
  readonly in: Projection;
  /** What the incoming player costs, when a price is known. */
  readonly price: number | null;
}

/**
 * FPL's cap on banked free transfers.
 *
 * The pipeline reads the real value from FPL's own `game-settings`
 * (`max_extra_free_transfers + 1`, `pipeline/fpl/rules.py`) and does not publish
 * it to this app. Five is the current rule; if FPL changes it, the authoritative
 * number is on the Python side and this one is stale — which is why the planner
 * shows the banked count rather than silently clamping to it.
 */
export const MAX_BANKED_FREE_TRANSFERS = 5;

export interface TransferCost {
  readonly moves: number;
  /** Transfers beyond the free ones. */
  readonly hits: number;
  /** Points docked. `hits × 4`. */
  readonly pointsCost: number;
  /**
   * Bank after the moves, or null when any price is unknown.
   *
   * Null rather than a partial total: a bank computed from three of four prices
   * is a number that looks spendable and is not, and this is the figure a reader
   * commits real transfers against.
   */
  readonly bankAfter: number | null;
  /** True when the moves cannot be afforded. */
  readonly unaffordable: boolean;
}

/**
 * What a set of moves costs in points and money.
 *
 * `freeTransfers` is nullable because FPL does not publish it to this app — see
 * `DecideView`'s rail. When it is unknown the hit count is unknowable too, and
 * this returns `hits: 0` with `pointsCost: 0` rather than guessing one free
 * transfer: charging a reader four points for a hit they may not be taking is
 * worse than showing the move without a cost and saying the cost is unknown.
 */
export function transferCost(
  moves: readonly Move[],
  bank: number | null,
  freeTransfers: number | null,
): TransferCost {
  const count = moves.length;
  const hits = freeTransfers === null ? 0 : Math.max(0, count - freeTransfers);

  let bankAfter: number | null = bank;
  for (const move of moves) {
    if (bankAfter === null) break;
    if (move.price === null || move.out.price === null) { bankAfter = null; break; }
    bankAfter = bankAfter + move.out.price - move.price;
  }
  // Rounded to a tenth: FPL prices are tenths of a million and float addition
  // turns 0.1 + 0.2 into a bank of 0.30000000000000004.
  if (bankAfter !== null) bankAfter = Math.round(bankAfter * 10) / 10;

  return {
    moves: count,
    hits,
    pointsCost: hits * RULES.hitCost,
    bankAfter,
    unaffordable: bankAfter !== null && bankAfter < 0,
  };
}

/**
 * The change in this gameweek's projected total, net of any hit.
 *
 * Explicitly one gameweek. A transfer is a multi-week decision and this number
 * is not — `xp_public` covers the current gameweek only, so a positive delta
 * here is not a recommendation, and the planner labels it as the horizon it is.
 */
export function transferDelta(
  moves: readonly Move[],
  pointsById: ReadonlyMap<number, number>,
  cost: TransferCost,
): number | null {
  let delta = 0;
  for (const move of moves) {
    const outPoints = move.out.elementId === undefined
      ? null
      : pointsById.get(move.out.elementId) ?? null;
    const inPoints = move.in.xp;
    // One unknown side makes the whole delta unknown. Treating an unprojected
    // player as zero would make every transfer out of one look like a gain.
    if (outPoints === null || inPoints === null) return null;
    delta += inPoints - outPoints;
  }
  return Math.round((delta - cost.pointsCost) * 100) / 100;
}

/**
 * A club's fixture run, for a player the squad has never held.
 *
 * `xp_public` carries no fixtures, so an incoming player arrived with an empty
 * run and every one of his columns hatched as "no fixture" — which read as a
 * blank gameweek and made the grid useless for exactly the player being
 * evaluated. The run is a property of the club, and `fixtureMatrix` publishes it
 * per club, so it is looked up rather than left empty.
 */
export type FixtureLookup = (team: string | null) => readonly SquadFixture[];

/** The squad after the moves, for re-optimising the XI against it. */
export function applyMoves(
  squad: readonly SquadPlayer[],
  moves: readonly Move[],
  fixturesFor: FixtureLookup = () => [],
): readonly SquadPlayer[] {
  const outIds = new Set(moves.map((m) => m.out.elementId));
  const kept = squad.filter((p) => !outIds.has(p.elementId));
  const added: SquadPlayer[] = moves.map((move) => ({
    name: move.in.name ?? `#${move.in.elementId}`,
    position: move.in.position ?? "",
    team: move.in.team ?? "",
    price: move.price,
    elementId: move.in.elementId,
    // A player you have not owned through a deadline has no pick slot, so no
    // bench flag and no armband — the planner assigns those itself.
    bench: undefined,
    role: undefined,
    fixture: undefined,
    // Guarded here rather than in the caller's lookup: a player with no club
    // has no run, and that must hold whatever lookup is passed.
    fixtures: move.in.team === null ? [] : fixturesFor(move.in.team),
  }));
  return [...kept, ...added];
}


// ─────────────────────────────────────────────────────────────────────────────
// The plan as a sequence
// ─────────────────────────────────────────────────────────────────────────────

/** The squad as it stands in a given gameweek, after every move up to it. */
export function squadAtWeek(
  initial: readonly SquadPlayer[],
  moves: readonly Move[],
  gameweek: number,
  fixturesFor: FixtureLookup = () => [],
): readonly SquadPlayer[] {
  const upTo = moves
    .filter((m) => m.gameweek <= gameweek)
    .sort((a, b) => a.gameweek - b.gameweek);
  return applyMoves(initial, upTo, fixturesFor);
}

export interface WeekLedger {
  readonly gameweek: number;
  readonly squad: readonly SquadPlayer[];
  readonly transfersIn: readonly number[];
  readonly transfersOut: readonly number[];
  /** Transfers made beyond the free ones held that week. */
  readonly hits: number;
  readonly pointsCost: number;
  /** Free transfers held going in, or null when the count is unknown. */
  readonly freeBefore: number | null;
  /** Held going into the next week, after use and accrual. */
  readonly freeAfter: number | null;
  /** Bank after the week's moves, or null when any price is unknown. */
  readonly bankAfter: number | null;
  readonly unaffordable: boolean;
}

/**
 * The plan week by week: what moves, what it costs, what is left.
 *
 * The free-transfer chain is replayed from the transfers actually made rather
 * than tracked incrementally, which is the same reason `horizon.py` replays it:
 * the rule is deterministic given the moves, so deriving it cannot drift from
 * them.
 *
 * `startingFree` is nullable because FPL does not publish the count to this app.
 * Null propagates: every week's hit count is unknown rather than guessed, and
 * the planner asks the reader for the number instead of inventing it — they can
 * see it on the FPL site, and a wrong assumption here costs four points a time.
 */
export function weeklyLedger(
  initial: readonly SquadPlayer[],
  moves: readonly Move[],
  gameweeks: readonly number[],
  bank: number | null,
  startingFree: number | null,
  fixturesFor: FixtureLookup = () => [],
): readonly WeekLedger[] {
  const out: WeekLedger[] = [];
  let runningBank = bank;
  let free = startingFree;

  for (const gameweek of gameweeks) {
    const thisWeek = moves.filter((m) => m.gameweek === gameweek);
    const count = thisWeek.length;
    const hits = free === null ? 0 : Math.max(0, count - free);

    for (const move of thisWeek) {
      if (runningBank === null) break;
      if (move.price === null || move.out.price === null) { runningBank = null; break; }
      runningBank = runningBank + move.out.price - move.price;
    }
    if (runningBank !== null) runningBank = Math.round(runningBank * 10) / 10;

    const freeBefore = free;
    // Unused transfers roll over, plus one for the coming week, capped.
    free = free === null
      ? null
      : Math.min(MAX_BANKED_FREE_TRANSFERS, Math.max(0, free - count) + 1);

    out.push({
      gameweek,
      squad: squadAtWeek(initial, moves, gameweek, fixturesFor),
      transfersIn: thisWeek.map((m) => m.in.elementId),
      transfersOut: thisWeek
        .map((m) => m.out.elementId)
        .filter((id): id is number => id !== undefined),
      hits,
      pointsCost: hits * RULES.hitCost,
      freeBefore,
      freeAfter: free,
      bankAfter: runningBank,
      unaffordable: runningBank !== null && runningBank < 0,
    });
  }

  return out;
}

/**
 * Every player who appears in any week of the plan, for the grid's rows.
 *
 * The union rather than the current fifteen: a player bought in GW4 belongs on
 * the grid from the start as an unowned run, and one sold in GW2 belongs on it
 * to the end. Showing only today's squad would hide exactly the moves being
 * planned.
 */
export function playersAcross(
  ledger: readonly WeekLedger[], initial: readonly SquadPlayer[],
): readonly SquadPlayer[] {
  const seen = new Map<number | string, SquadPlayer>();
  const key = (p: SquadPlayer) => p.elementId ?? p.name;
  for (const p of initial) seen.set(key(p), p);
  for (const week of ledger) for (const p of week.squad) {
    if (!seen.has(key(p))) seen.set(key(p), p);
  }
  return [...seen.values()];
}

/** Whether a player is in the squad in a given week. */
export function ownedIn(week: WeekLedger, player: SquadPlayer): boolean {
  const id = player.elementId;
  return id === undefined
    ? week.squad.some((p) => p.name === player.name)
    : week.squad.some((p) => p.elementId === id);
}


/**
 * The change in projected points from a move, when that is knowable.
 *
 * Only for a move in the gameweek the projection covers. A GW4 swap has no
 * computable delta — `xp_public` is one gameweek — and returning a number
 * derived from this week's projections for a transfer four weeks out would be
 * the most confident wrong number on the screen.
 */
export function moveDelta(
  move: Move,
  pointsById: ReadonlyMap<number, number>,
  projectionGameweek: number,
): number | null {
  if (move.gameweek !== projectionGameweek) return null;
  const outPoints = move.out.elementId === undefined
    ? null
    : pointsById.get(move.out.elementId) ?? null;
  const inPoints = move.in.xp;
  if (outPoints === null || inPoints === null) return null;
  return Math.round((inPoints - outPoints) * 100) / 100;
}

/**
 * Rows ordered so a transfer's two players sit together.
 *
 * The grid sorted by line and then by projection, which put the player leaving
 * and the player replacing him anywhere relative to each other — so the one
 * thing a transfer plan has to show, *what swapped for what*, was the one thing
 * you could not see. The incoming player is lifted to sit directly under the
 * outgoing one, and both carry the move so the view can bracket them.
 */
export interface PlannerRowModel {
  readonly player: SquadPlayer;
  /** The move this player is part of, if any. */
  readonly move: Move | null;
  /** `out` leaves, `in` arrives — which half of the pair this row is. */
  readonly side: "out" | "in" | null;
}

export function pairRows(
  ordered: readonly SquadPlayer[], moves: readonly Move[],
): readonly PlannerRowModel[] {
  const inByOut = new Map<number, Move>();
  const incoming = new Set<number>();
  for (const move of moves) {
    if (move.out.elementId !== undefined) inByOut.set(move.out.elementId, move);
    incoming.add(move.in.elementId);
  }

  const byId = new Map<number, SquadPlayer>();
  for (const p of ordered) if (p.elementId !== undefined) byId.set(p.elementId, p);

  const out: PlannerRowModel[] = [];
  const placed = new Set<number>();

  for (const player of ordered) {
    const id = player.elementId;
    // An incoming player is placed by its pair, never in sort order.
    //
    // The guard was `!placed.has(id)` — which skipped an arrival that sorted
    // BEFORE its departure and then emitted it a second time when it sorted
    // after, because by then it had been placed. Skipping unconditionally is
    // the actual rule; the trailing loop picks up any the pairing missed.
    if (id !== undefined && incoming.has(id)) continue;
    out.push({ player, move: null, side: null });

    const move = id === undefined ? undefined : inByOut.get(id);
    if (!move) continue;
    out[out.length - 1] = { player, move, side: "out" };
    const arrival = byId.get(move.in.elementId);
    if (arrival) {
      out.push({ player: arrival, move, side: "in" });
      placed.add(move.in.elementId);
    }
  }

  // Anything the pairing missed still belongs on the grid.
  for (const player of ordered) {
    const id = player.elementId;
    if (id !== undefined && incoming.has(id) && !placed.has(id)) {
      out.push({ player, move: null, side: null });
    }
  }
  return out;
}
