/**
 * How old a published artifact is, as the "Data freshness" list on `/more` says it.
 *
 * Pure so it can be tested without a fetch. The inputs are the registry's own:
 * `Provenance.producedAt` (the writer's timestamp) and the descriptor's
 * `freshnessBudgetMs`. Nothing here is a model output.
 */

export type Freshness = "fresh" | "ageing" | "stale" | "unstamped" | "missing";

/** Past this share of its own budget an artifact reads as ageing, not fresh. */
export const AGEING_FRACTION = 0.5;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24 Oct, 06:23" in UTC, or null for anything that is not a date. */
export function formatUtc(iso: string | null): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/**
 * `missing` is an artifact that could not be read at all; `unstamped` one that
 * read fine but carries no timestamp of its own, which is not the same thing as
 * fresh and must not be coloured as if it were.
 */
export function freshnessOf(input: {
  readonly readable: boolean;
  readonly stale: boolean;
  readonly producedAt: string | null;
  readonly ageMs: number | null;
  readonly budgetMs: number | null;
}): Freshness {
  if (!input.readable) return "missing";
  if (input.stale) return "stale";
  if (input.producedAt === null || input.ageMs === null) return "unstamped";
  if (input.budgetMs !== null && input.ageMs > input.budgetMs * AGEING_FRACTION) return "ageing";
  return "fresh";
}
