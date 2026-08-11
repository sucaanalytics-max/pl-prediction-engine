/**
 * Every artifact this app reads, declared once.
 *
 * The registry is what the tests iterate. Three of the four load-bearing rules
 * are enforced by walking this table rather than by reviewer diligence:
 *
 * - **Rule 1** — each descriptor supplies its own `isEmpty`, because there is no
 *   general test for "present but carries no information".
 * - **Rule 3** — `paths.test.ts` asserts every `path` here is actually published
 *   by a workflow. A fetched path nothing writes is a failing test, not a blank
 *   page. This test is **red on day one**, by design.
 * - **Rule 4** — each descriptor names a `narrow` function, so no page ever casts
 *   `res.json()` to a type.
 *
 * ## Where the emptiness predicates come from
 *
 * Every one below was derived by executing against the real committed artifact,
 * not by guessing. The comments record what was actually observed, because the
 * naive predicate is wrong in a specific way for almost every artifact and the
 * reason is never obvious from the type.
 *
 * ## Writers and ownership
 *
 * `owner` records which workflow produces the file, and it is not documentation:
 * path ownership is what lets the daily pipeline and the 3-hourly agent both push
 * to `main` safely, because git rebases at file granularity and writers that
 * never touch the same file cannot conflict. `commit_and_push.sh`'s
 * `FORBID_PATHS` enforces it at run time; the paths test checks the table agrees.
 */

import type { Artifact, NarrowResult } from "@/lib/data/artifact";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Which workflow writes the file. See the ownership note above. */
export type Owner = "daily" | "agent" | "news" | "validate" | "client";

export interface Descriptor<T = unknown> {
  /** Stable key used by loaders and tests. */
  readonly key: string;
  /**
   * Path relative to the predictions root, as fetched.
   *
   * The root is Supabase Storage when `NEXT_PUBLIC_SUPABASE_URL` is set, with
   * local `/predictions/` as the fallback on any failure. Keep that fallback.
   */
  readonly path: string;
  readonly owner: Owner;
  /** Human sentence for the state card. */
  readonly describes: string;
  /**
   * How old this may be before it is `stale`, or null for "no budget".
   *
   * Null is a real answer, not a gap: `h2h.json` is a historical record that does
   * not go off, and calling it stale would invite someone to wait for a fresher
   * copy that says the same thing.
   */
  readonly freshnessBudgetMs: number | null;
  /**
   * Wire format. `jsonl` is newline-delimited and must NOT be handed to
   * `res.json()`, which throws on the second line — the loader reads it as text
   * and the narrower splits it.
   */
  readonly format?: "json" | "jsonl";
  /** Runtime narrowing. Never `as T`. */
  readonly narrow: (raw: unknown) => NarrowResult<T>;
  readonly producedAtOf?: (value: T) => string | null | undefined;
  readonly producerVersionOf?: (value: T) => string | null | undefined;
  /** Declared per artifact. Omitted means `empty` is not a state this can reach. */
  readonly isEmpty?: (value: T) => boolean;
  /**
   * True when no writer publishes this path yet.
   *
   * Recorded so `paths.test.ts` can distinguish "we forgot to publish it" from
   * "this is a planned artifact whose writer does not exist yet", and still fail
   * on the former. Set back to false the moment a workflow starts writing it.
   */
  readonly unpublished?: boolean;
  /** Why it is unpublished, when it is. */
  readonly unpublishedReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Emptiness predicates
//
// Kept as named functions rather than inline arrows so each can carry the
// evidence that produced it, and so they are individually testable.
// ─────────────────────────────────────────────────────────────────────────────

interface PlayedRow { played?: number }
interface MinutesRow { minutes?: number }

/**
 * The league table before a ball is kicked.
 *
 * Verified against the committed `table.json`: all 20 rows have `played: 0`,
 * `won/drawn/lost/gf/ga/gd/points: 0`, `form: []` — and `position: 0`.
 *
 * **Do not add `r.position === 0`.** It is true on today's file, so it would pass
 * every test written against today's file. But `fpl_api.py:345` assigns positions
 * with `enumerate(table, start=1)`, so the next real run emits 1..20 with the
 * counters still zero — and a position-based signature then reports the table as
 * *ranked*, highlighting whichever four clubs the degenerate all-zero sort put on
 * top (alphabetically: Arsenal, Aston Villa, Bournemouth, Brentford).
 *
 * A predicate that passes on the fixture and fails in production is worse than
 * none, because it will be trusted. Matches played is the only real evidence.
 */
export function tableIsEmpty(rows: readonly PlayedRow[]): boolean {
  return rows.length > 0 && rows.every((r) => (r.played ?? 0) === 0);
}

/**
 * Player season stats before anyone has played.
 *
 * `minutes === 0` across the board. This also protects the per-90 columns:
 * `xg_per_90` is computed as `xg / max(minutes / 90, 0.1)`, so a 0-minute player
 * reads as `xg * 10` — a fabricated rate presented as a measured one.
 */
export function playerStatsAreEmpty(rows: readonly MinutesRow[]): boolean {
  return rows.length > 0 && rows.every((r) => (r.minutes ?? 0) === 0);
}

/**
 * Match summaries carrying no discrimination.
 *
 * Verified signature: every fixture predicted `"home"`. Before team strengths are
 * fitted, the flat prior makes home advantage the only surviving signal, so ten
 * identical calls is the fingerprint of a model with no information rather than a
 * genuine forecast that the home side wins everywhere.
 */
export function matchesAreEmpty(
  value: { matches: readonly { model_prediction?: string }[] },
): boolean {
  const { matches } = value;
  return matches.length > 0 && matches.every((m) => m.model_prediction === "home");
}

/**
 * Predictions present, but the stages that make them inspectable never ran.
 *
 * Verified against the committed `latest.json`: `shap_features` is `[]` on 10/10
 * predictions and `odds_comparison` is `null` on 10/10, while the core
 * probability payload is genuinely informative — ten distinct 1x2 tuples, full
 * 49-cell scoreline grids summing to ~1.0.
 *
 * So this is `empty` in a partial sense the UI must respect: the fixture and
 * probability sections have real content, and the SHAP waterfall and the
 * bookmaker-odds panel have none. The predicate exists so those two panels render
 * a reason instead of an axis with no series. `predictions.length > 0` and
 * `metadata.gameweek !== 0` both PASS on exactly this data.
 */
export function explainabilityIsEmpty(
  value: {
    predictions: readonly {
      shap_features?: readonly unknown[];
      odds_comparison?: unknown;
    }[];
  },
): boolean {
  const { predictions } = value;
  return (
    predictions.length > 0 &&
    predictions.every(
      (p) => (p.shap_features?.length ?? 0) === 0 && p.odds_comparison == null,
    )
  );
}

/**
 * Model health with nothing measured.
 *
 * The 4.0.0-producer case. A *successful, complete, fresh* run of the older
 * pipeline emits no `model_metrics`, no `calibration` and no
 * `forecast_validation_status` at all — so no freshness check can see it, because
 * the file is not stale. Only the absence of the metrics themselves reveals it,
 * with `provenance.producerVersion` naming the culprit.
 */
export function healthIsEmpty(
  value: { model_metrics?: Record<string, unknown>; calibration?: unknown },
): boolean {
  const keys = Object.keys(value.model_metrics ?? {});
  return keys.length === 0 && value.calibration == null;
}

/**
 * Head-to-head with nothing for the current season.
 *
 * Not `recs.length === 0` alone: the file is 241KB of genuine history. It is
 * empty *for this season's purposes* when no record carries a `2627` match.
 */
export function h2hIsEmpty(
  records: readonly {
    matches?: readonly { season?: string | null }[] | null;
  }[],
): boolean {
  if (records.length === 0) return true;
  return records.every((r) => (r.matches ?? []).every((m) => m.season !== "2627"));
}

/**
 * Value bets: nothing cleared, versus nothing priced.
 *
 * Deliberately NOT a descriptor predicate, because the distinction needs a second
 * artifact. Zero bets with `health.odds_source === 'the_odds_api'` means markets
 * were priced and nothing beat the edge threshold — a real, informative answer.
 * Zero bets with `'unavailable'` means no prices were fetched at all. Those are
 * different cards, and collapsing them into one "no value bets" message would
 * report a quota failure as a market judgement.
 */
export function valueBetsAreEmpty(
  totalBets: number, oddsSource: string | null | undefined,
): boolean {
  return totalBets === 0 && oddsSource === "the_odds_api";
}

export function valueBetsUnpriced(oddsSource: string | null | undefined): boolean {
  return oddsSource !== "the_odds_api";
}

// ─────────────────────────────────────────────────────────────────────────────
// The table
//
// `narrow` is filled in by ./narrow/index.ts, which imports this module — the
// descriptors are declared here with their narrowers attached at the point of
// definition in that file to avoid a cycle. See buildRegistry there.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A descriptor with its payload type deliberately erased.
 *
 * The registry is heterogeneous — `table` carries `Standing[]`, `health` carries
 * `Health` — and `Descriptor<T>` cannot be widened to `Descriptor<unknown>`
 * because `isEmpty: (value: T) => boolean` puts the payload in a contravariant
 * position. TypeScript has no existential types, so this is the encoding: keep
 * the metadata and the payload-agnostic `narrow`, and omit the members that
 * consume `T`.
 *
 * Use it for iteration that only reads metadata — the paths test, hygiene checks,
 * a nav listing. Anything that needs to *classify* an artifact must go through
 * the keyed `REGISTRY` entry, which retains its real type.
 */
export type OpaqueDescriptor =
  & Pick<
      Descriptor<unknown>,
      "key" | "path" | "owner" | "describes" | "freshnessBudgetMs" | "format"
        | "unpublished" | "unpublishedReason"
    >
  & { readonly narrow: (raw: unknown) => NarrowResult<unknown> };

/** Convenience type for a page holding a loaded artifact by key. */
export type Loaded<T> = Artifact<T>;
