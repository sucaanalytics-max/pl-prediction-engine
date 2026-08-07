/**
 * Units for the quantities where getting the unit wrong costs money.
 *
 * ## The hazard this closes
 *
 * `predictions/latest.json` carries four Kelly fields per value bet, and two of
 * them are in a different unit from the other two:
 *
 * ```
 * "full_kelly":     50.0     <- CURRENCY. pipeline/risk/kelly.py:279
 * "half_kelly":     25.0     <-           full_kelly_pct * bankroll, bankroll=1000.0
 * "full_kelly_pct":  0.05    <- FRACTION
 * "half_kelly_pct":  0.025   <-
 * ```
 *
 * `ValueBet` typed all four as bare `number`. Meanwhile `lib/kelly.ts` declares
 * an unrelated `KellyResult.full_kelly` that is a **fraction**, and
 * `app/bankroll/page.tsx` renders it as `pct(kellyResult.full_kelly)`. Two
 * identically named fields, a 1000x unit difference, and one plausible
 * copy-paste between the two files renders `pct(50.0)` — **"5000%"** — as a
 * recommended stake.
 *
 * Nothing was broken at the time of writing: `getHalfKellyPct` correctly prefers
 * `half_kelly_pct`, and the currency fields were declared but read nowhere. That
 * is the point. The type system permitted the mistake and only convention
 * prevented it, on the one code path in this repo where CLAUDE.md says
 * "Kelly staking is real money."
 *
 * ## Why a brand rather than a comment
 *
 * {@link Fraction} is `number` with a phantom property, so it is assignable *to*
 * `number` (arithmetic and formatting keep working) but a bare `number` is NOT
 * assignable *to* it. Every `Fraction` must therefore be minted by
 * {@link asFraction}, which **rejects anything outside 0..1** — so a currency
 * value of `50.0` can never become one. The check is the guard; the brand is what
 * forces you through the check.
 *
 * ## What happened to the currency fields
 *
 * Dropped from the narrowed model entirely, and deliberately not re-typed. They
 * are a stake against a **hardcoded £1000 default bankroll** that has nothing to
 * do with the user's real bankroll, which lives in `localStorage` on `/bankroll`.
 * So they were not merely ambiguous, they were meaningless to this app: a
 * fraction combined with the user's real bankroll is the only correct stake, and
 * a field that does not exist cannot be rendered by mistake.
 */

declare const FRACTION: unique symbol;

/**
 * A dimensionless proportion in `[0, 1]`.
 *
 * Multiply by a bankroll to get a stake; multiply by 100 to display a percent.
 */
export type Fraction = number & { readonly [FRACTION]: true };

export class UnitError extends RangeError {}

/**
 * Mint a {@link Fraction}, or throw.
 *
 * Throws rather than clamping. A value outside `[0, 1]` where a fraction was
 * expected means the producer's units are not what we think they are, and
 * clamping `50.0` to `1.0` would turn a unit bug into a **stake of the entire
 * bankroll** — the single worst available outcome on this path. Under-staking is
 * recoverable; over-staking is not.
 */
export function asFraction(value: number, what = "value"): Fraction {
  if (!Number.isFinite(value)) {
    throw new UnitError(`${what} is not a finite number: ${value}`);
  }
  if (value < 0 || value > 1) {
    throw new UnitError(
      `${what} is ${value}, outside [0, 1] — expected a fraction. ` +
      `A currency amount (e.g. a stake of 50.0) is the usual cause.`,
    );
  }
  return value as Fraction;
}

/**
 * Mint a {@link Fraction}, or return null.
 *
 * For the narrowing path, where a bad value must become a collected problem
 * rather than a thrown exception — a whole page should not go `unreadable`
 * because one bet in twenty has a malformed stake.
 */
export function toFraction(value: unknown): Fraction | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value as Fraction;
}

/** Zero, as a fraction. The identity for "no stake". */
export const NO_STAKE = 0 as Fraction;

/**
 * Render a fraction as a percentage.
 *
 * Deliberately separate from the general-purpose `pct()` in `lib/formats.ts`:
 * this one accepts only a {@link Fraction}, so it cannot be handed a currency
 * amount. `pct()` still exists for probabilities and other bare numbers.
 */
export function formatStake(value: Fraction, decimals = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * The stake in currency, for a bankroll the user actually told us about.
 *
 * Takes both explicitly so the bankroll can never be defaulted. The pipeline's
 * assumed £1000 is exactly the silent default this signature refuses.
 */
export function stakeFor(fraction: Fraction, bankroll: number): number {
  if (!Number.isFinite(bankroll) || bankroll < 0) {
    throw new UnitError(`bankroll is not a usable amount: ${bankroll}`);
  }
  return fraction * bankroll;
}
