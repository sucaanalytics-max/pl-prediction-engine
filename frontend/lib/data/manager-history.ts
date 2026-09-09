/**
 * Verdicts computed from the manager ledger's facts.
 *
 * These live here rather than in the producer because windows are a
 * presentation choice: changing 2/3/4 to 1/3/6, or adding a clean-only toggle,
 * must not need a pipeline run and a commit to a permanent artifact.
 *
 * ## Effective and raw are both true, and they answer different questions
 *
 * *Effective* holds the lineup fixed and swaps one player, so it is what
 * actually reached the score: a buy left on the bench earned nothing, a
 * captained buy counts double. *Raw* ignores the lineup, so it measures the
 * scouting call on its own merits. A good buy you wrongly benched is +12 raw
 * and 0 effective, and neither number is wrong. Their difference is a third
 * metric — the value handed back through lineup decisions — which is the reason
 * both are kept rather than one chosen.
 */
import type {
  ManagerHistory, ManagerTransfer,
} from "@/lib/data/narrow-manager-history";

/** Same-gameweek, then the following two, three and four. */
export const SPANS = [1, 2, 3, 4] as const;

/**
 * Clean windows required before a season rate is reported.
 *
 * One transfer is an anecdote, and a rate rendered off it is indistinguishable
 * from a finding — the same reasoning as `decision-review.ts`'s
 * `minimumObservations`. Five is the point at which one outlier stops setting
 * the sign on its own.
 */
export const MINIMUM_CLEAN_WINDOWS = 5;

export interface TransferWindow {
  readonly span: number;
  /** Every gameweek in the window has settled. */
  readonly settled: boolean;
  /** The incoming player left the squad inside the window. */
  readonly polluted: boolean;
  /** Points that actually reached the score. Null when unsettled. */
  readonly effective: number | null;
  /** The scouting call, ignoring lineup. Null when unsettled. */
  readonly raw: number | null;
  /** raw − effective: value given back through lineup decisions. */
  readonly gap: number | null;
}

export function windowFor(
  transfer: ManagerTransfer, span: number,
): TransferWindow {
  const gameweeks: number[] = [];
  for (let gw = transfer.event; gw < transfer.event + span; gw += 1) {
    gameweeks.push(gw);
  }

  const settled = gameweeks.every((gw) => transfer.inPointsByGw.has(gw));
  if (!settled) {
    return {
      span, settled: false, polluted: false,
      effective: null, raw: null, gap: null,
    };
  }

  let raw = 0;
  let effective = 0;
  let polluted = false;
  for (const gw of gameweeks) {
    const delta = (transfer.inPointsByGw.get(gw) ?? 0)
      - (transfer.outPointsByGw.get(gw) ?? 0);
    raw += delta;
    const multiplier = transfer.inMultiplierByGw.get(gw) ?? null;
    // Null is "no longer in the squad", which is the pollution signal and
    // reaches the score as nothing. It is NOT the same as 0, which is "in the
    // squad, benched, and earned nothing" — a lineup decision, not a sale.
    if (multiplier === null) polluted = true;
    effective += delta * (multiplier ?? 0);
  }
  return { span, settled: true, polluted, effective, raw, gap: raw - effective };
}

export interface TransferAggregate {
  readonly span: number;
  readonly n: number;
  readonly effective: number | null;
  readonly raw: number | null;
  readonly withheldReason: string | null;
}

export function transferAggregate(
  history: ManagerHistory, span: number,
): TransferAggregate {
  const clean = history.transfers
    .map((t) => windowFor(t, span))
    .filter((w) => w.settled && !w.polluted);

  if (clean.length < MINIMUM_CLEAN_WINDOWS) {
    return {
      span,
      n: clean.length,
      effective: null,
      raw: null,
      withheldReason:
        `${clean.length} clean ${clean.length === 1 ? "window" : "windows"}; `
        + `a rate needs ${MINIMUM_CLEAN_WINDOWS} before it says more than the `
        + "last transfer did",
    };
  }
  return {
    span,
    n: clean.length,
    effective: clean.reduce((sum, w) => sum + (w.effective ?? 0), 0),
    raw: clean.reduce((sum, w) => sum + (w.raw ?? 0), 0),
    withheldReason: null,
  };
}

export interface SeasonTotals {
  readonly benchPoints: number;
  readonly vsAverage: number | null;
  readonly hitSpend: number;
  readonly autoSubRescue: number;
  readonly captainPoints: number;
  /** What the armband would have returned on the best of the fifteen. */
  readonly bestCaptainPoints: number;
  readonly captaincyCost: number;
}

export function seasonTotals(history: ManagerHistory): SeasonTotals {
  let benchPoints = 0;
  let hitSpend = 0;
  let autoSubRescue = 0;
  let captainPoints = 0;
  let bestCaptainPoints = 0;
  let mine = 0;
  let field = 0;
  let fieldKnown = true;

  for (const gameweek of history.gameweeks) {
    benchPoints += gameweek.benchPoints;
    hitSpend += gameweek.transferCost;
    for (const sub of gameweek.autoSubs) autoSubRescue += sub.pointsGained;
    mine += gameweek.points;
    if (gameweek.averageEntryScore === null) fieldKnown = false;
    else field += gameweek.averageEntryScore;

    // The armband, against the best of the fifteen in hindsight. Measured at
    // the multiplier actually used, so a triple-captain week is compared with a
    // triple-captain alternative rather than against a merely doubled one.
    const armband = gameweek.captain?.multiplier ?? 2;
    if (gameweek.captain) captainPoints += gameweek.captain.points * armband;
    const best = gameweek.picks.reduce(
      (most, pick) => Math.max(most, pick.points),
      Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(best)) bestCaptainPoints += best * armband;
  }
  return {
    benchPoints,
    hitSpend,
    autoSubRescue,
    captainPoints,
    bestCaptainPoints,
    captaincyCost: bestCaptainPoints - captainPoints,
    vsAverage: fieldKnown ? mine - field : null,
  };
}

export interface Basket {
  readonly event: number;
  readonly transfers: number;
  readonly hit: number;
  readonly effective: number | null;
  readonly settled: boolean;
}

/**
 * One gameweek's transfers taken together, against that gameweek's total hit.
 *
 * Pairing each `element_in` with each `element_out` is a fiction FPL's list
 * implies but does not mean: with three transfers the pairing is arbitrary, and
 * so is any per-transfer share of the hit. With one transfer this equals that
 * transfer; from three onwards it is the only honest number.
 */
export function basketFor(history: ManagerHistory, event: number): Basket {
  const made = history.transfers.filter((t) => t.event === event);
  const windows = made.map((t) => windowFor(t, 1));
  const settled = windows.length > 0 && windows.every((w) => w.settled);
  const gameweek = history.gameweeks.find((g) => g.event === event);
  return {
    event,
    transfers: made.length,
    hit: gameweek?.transferCost ?? 0,
    settled,
    effective: settled
      ? windows.reduce((sum, w) => sum + (w.effective ?? 0), 0)
      : null,
  };
}
