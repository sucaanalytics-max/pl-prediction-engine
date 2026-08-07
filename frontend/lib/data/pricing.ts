/**
 * Whether the bookmaker markets were actually priced for a run.
 *
 * Lives here rather than in `app/markets/page.tsx` because **Next.js validates the
 * complete export shape of a `page.tsx`** — a page may export the default
 * component and a fixed set of reserved names (`metadata`, `generateMetadata`,
 * `dynamic`, …) and nothing else. An extra named export fails `next build` with
 * "does not match the required types of a Next.js Page", and neither `tsc
 * --noEmit` nor vitest catches it, because both type-check the module in
 * isolation and never apply the framework's page contract.
 */

/**
 * The only two values `run_pipeline.py` writes, from a single ternary at
 * run_pipeline.py:845. Anything else came from an older producer.
 */
export const PRICED_SOURCE = "the_odds_api";
export const UNPRICED_SOURCE = "unavailable";

export type Pricing = "priced" | "unpriced" | "unrecognised";

export function pricingOf(oddsSource: string | null | undefined): Pricing {
  if (oddsSource === PRICED_SOURCE) return "priced";
  if (oddsSource === UNPRICED_SOURCE) return "unpriced";
  // Measured: the committed health.json says `football_data`, which NO current
  // code path writes. Guessing which bucket it belongs in would report a stale
  // vocabulary as a confident market judgement.
  return "unrecognised";
}

/**
 * What to tell the reader, given the pricing state and the raw value.
 *
 * Takes the value so the unrecognised case can NAME it. "We do not recognise this
 * source" is a dead end; "we do not recognise `football_data`" is something the
 * reader can go and look up.
 */
export function pricingCopy(
  pricing: Pricing,
  oddsSource: string | null | undefined,
): { headline: string; detail: string } {
  if (pricing === "priced") {
    return {
      headline: "Markets were priced and nothing cleared the edge threshold.",
      detail:
        "This is a real answer, not a missing one — there is simply no value on offer.",
    };
  }
  if (pricing === "unpriced") {
    return {
      headline: "No bookmaker prices were fetched, so no bet could be assessed.",
      detail:
        "The Odds API free tier is 500 requests a month, and the daily run consumes it.",
    };
  }
  return {
    headline: "Cannot tell whether markets were priced.",
    detail:
      `odds_source is "${oddsSource ?? "absent"}", which this pipeline version ` +
      `does not write — it only ever emits "${PRICED_SOURCE}" or ` +
      `"${UNPRICED_SOURCE}". The artifact predates the current producer, so ` +
      `"no bets" here means nothing either way.`,
  };
}
