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

import type { NarrowResult } from "@/lib/data/artifact";

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
  /**
   * The producer's timestamp read from the RAW payload, when the narrowed value cannot
   * carry it.
   *
   * `producedAtOf` receives the narrowed value, which is right for almost every artifact
   * because the envelope narrows into the payload. It is wrong for one shape: an artifact
   * that narrows to a bare array. `player_stats.json` narrows to `readonly PlayerRow[]`,
   * so its `generated_at` had nowhere to survive, and the availability figure the control
   * room derives from it was the only artifact-derived number on the board with no way to
   * grow old.
   *
   * Additive and preferred when present, so no existing descriptor changes and the
   * alternative — widening the narrowed type and every consumer of it — is not forced on
   * an artifact whose consumers all want the array.
   */
  readonly producedAtOfRaw?: (raw: unknown) => string | null | undefined;
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
//
// There used to be three more — `tableIsEmpty`, `explainabilityIsEmpty` and
// `h2hIsEmpty` — for table.json, latest.json and h2h.json. No REGISTRY entry
// names those files any more, so no `classify` call could reach the predicates,
// and each carried a paragraph of measured evidence for a screen that no longer
// exists. Kept honest by deletion: a predicate that cannot run is not a guard,
// and their evidence was the most convincing thing in the file.
// ─────────────────────────────────────────────────────────────────────────────

interface MinutesRow { minutes?: number }

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
 * The registry is heterogeneous — `playerStats` carries `PlayerRow[]`, `health`
 * carries `Health` — and `Descriptor<T>` cannot be widened to `Descriptor<unknown>`
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

