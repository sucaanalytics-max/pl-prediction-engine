/**
 * Client-side Kelly criterion calculator for interactive bankroll tracking.
 */

export interface KellyResult {
  full_kelly: number;
  half_kelly: number;
  quarter_kelly: number;
  edge: number;
  ev: number;
}

/**
 * Calculate Kelly fraction for a single bet.
 * f* = (bp - q) / b
 * where b = decimal odds - 1, p = model prob, q = 1 - p
 */
export function kellyFraction(
  modelProb: number,
  decimalOdds: number,
  maxStake: number = 0.05,
  minEdge: number = 0.03
): KellyResult {
  const b = decimalOdds - 1;
  const p = modelProb;
  const q = 1 - p;
  const edge = p - 1 / decimalOdds;
  const ev = p * b - q;

  if (edge < minEdge || ev <= 0) {
    return { full_kelly: 0, half_kelly: 0, quarter_kelly: 0, edge, ev };
  }

  const fullKelly = Math.min((b * p - q) / b, maxStake);
  const halfKelly = fullKelly / 2;
  const quarterKelly = fullKelly / 4;

  return {
    full_kelly: Math.max(0, fullKelly),
    half_kelly: Math.max(0, halfKelly),
    quarter_kelly: Math.max(0, quarterKelly),
    edge,
    ev,
  };
}

/**
 * Simulate bankroll trajectory over a set of bets.
 */
export function simulateBankroll(
  initialBankroll: number,
  bets: Array<{
    stake_pct: number;
    decimal_odds: number;
    won: boolean;
  }>
): number[] {
  const trajectory = [initialBankroll];
  let bankroll = initialBankroll;

  for (const bet of bets) {
    const stake = bankroll * bet.stake_pct;
    if (bet.won) {
      bankroll += stake * (bet.decimal_odds - 1);
    } else {
      bankroll -= stake;
    }
    trajectory.push(Math.max(0, bankroll));
  }

  return trajectory;
}

/**
 * Calculate current drawdown from peak.
 */
export function currentDrawdown(trajectory: number[]): number {
  if (trajectory.length === 0) return 0;
  const peak = Math.max(...trajectory);
  const current = trajectory[trajectory.length - 1];
  return peak > 0 ? (peak - current) / peak : 0;
}
