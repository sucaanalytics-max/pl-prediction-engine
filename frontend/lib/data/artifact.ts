/**
 * The envelope every piece of pipeline data arrives in.
 *
 * ## Why this exists
 *
 * Four measured failures in this app were all the same failure: **absence
 * rendered as a confident answer.**
 *
 * - `/table` showed all 20 clubs in the Champions League places, because every
 *   row was `played: 0` and the gate was `pos <= 4`.
 * - `/health` scored an unmeasured model as a *failing* one, because the metric
 *   read was `(metrics.brier ?? 1) < 0.22` and the `?? 1` sentinel is worse than
 *   any real Brier score.
 * - `/decisions` classified every proposal `ready` — including expired ones —
 *   because the `deadline` field did not exist, so `Date.parse("")` was `NaN`.
 * - `/health` rendered chart scaffolding over metrics that were never emitted,
 *   because the file is a *successful* run of an older producer.
 *
 * None of these is a fetch error. In every case the fetch succeeded and the JSON
 * parsed. `undefined` and `0` and `""` simply flowed into code that had no way to
 * say "I do not know". So the point of this module is that **there is no way to
 * read a value without also confronting its state.**
 *
 * ## The five states
 *
 * | state        | value | meaning |
 * |--------------|-------|---------|
 * | `ok`         | yes   | present, fresh, carries information |
 * | `empty`      | yes   | present and well-formed, but carries no information |
 * | `stale`      | yes   | present, but older than its freshness budget |
 * | `absent`     | no    | nothing published there yet |
 * | `unreadable` | no    | published, but failed runtime narrowing |
 *
 * A sixth state, `outdated`, was designed and then dropped: none of the four
 * failures above needs it, and a state nothing branches on is a state that rots.
 * Producer drift instead stays visible as {@link Provenance.producerVersion},
 * which renders "version unknown" rather than "current" when a writer emits none.
 *
 * `empty` is the subtle one, and it is **declared per artifact, never guessed.**
 * There is no general test for "carries no information": for the league table it
 * is `rows.every(r => r.played === 0)`; for value bets it is a total of zero
 * *and* `health.odds_source === 'the_odds_api'` (markets were priced and nothing
 * cleared) as opposed to `'unavailable'` (no prices fetched at all) — which are
 * different cards, not one. So each descriptor supplies its own predicate.
 *
 * ## Enforcement, not discipline
 *
 * The value is held behind a module-private symbol, so `artifact.value` does not
 * compile outside this file. Reading requires {@link proven}, and *charting*
 * requires {@link chartable}, which refuses `empty` — that is what makes "312
 * lines of charts over absent data" unwritable rather than merely discouraged.
 */

/** Module-private slot for the payload. Not exported: that is the whole point. */
const VALUE = Symbol("artifact.value");

export type ArtifactState = "ok" | "empty" | "stale" | "absent" | "unreadable";

/** Where a value came from, when, and who produced it. */
export interface Provenance {
  /** Registry path, e.g. `latest.json` or `fpl/messages.json`. */
  readonly path: string;
  /**
   * Which fetch won. Supabase is tried first and local `/predictions/` is the
   * fallback; the distinction matters because a local hit during normal
   * operation means the remote is failing silently.
   */
  readonly source: "supabase" | "local" | "none";
  /** When this process read it. Always known. */
  readonly fetchedAt: string;
  /** The writer's own timestamp, or null when the artifact carries none. */
  readonly producedAt: string | null;
  /**
   * The producing code's version, or null when the writer emits none.
   *
   * Load-bearing rather than decorative. `health.json` is `pipeline_version
   * 4.0.0` against code at `4.1.0`, and 4.0.0 did not emit `model_metrics` at
   * all — so a *successful, complete, fresh* run of an old producer is
   * indistinguishable from a current run that measured nothing. No freshness
   * check can see that, because the file is not stale.
   */
  readonly producerVersion: string | null;
  /** Age at read time, or null when `producedAt` is unknown. */
  readonly ageMs: number | null;
  /** The budget this artifact was judged against, or null if it has none. */
  readonly freshnessBudgetMs: number | null;
}

/**
 * A value and its state, inseparably.
 *
 * `readonly` throughout, and the payload is behind {@link VALUE}, so the only
 * ways into it are the accessors below.
 */
export interface Artifact<T> {
  readonly state: ArtifactState;
  readonly provenance: Provenance;
  /**
   * Why the state is what it is, in a sentence fit to render.
   *
   * Non-null for every state except `ok`. A UI that shows a state without a
   * reason forces the user to guess, which is how "no data" gets read as "the
   * site is broken".
   */
  readonly reason: string | null;
  /** @internal */
  readonly [VALUE]: T | null;
}

/** What a narrower returns. Collect-then-report, never throw. */
export type NarrowResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

export function narrowed<T>(value: T): NarrowResult<T> {
  return { ok: true, value };
}

export function malformed<T>(problems: readonly string[]): NarrowResult<T> {
  return { ok: false, problems };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/** States that carry a payload. */
const WITH_VALUE: readonly ArtifactState[] = ["ok", "empty", "stale"];

/**
 * The value, or null when there is none.
 *
 * Returns the payload for `ok`, `empty` and `stale` alike — an empty table still
 * has 20 rows worth rendering as "no matches played yet", and a stale forecast is
 * still the last thing we knew. What a caller must not do is render any of the
 * three *identically*, which is why the state travels with the value rather than
 * being inferable from it.
 */
export function proven<T>(
  artifact: Artifact<T> | null | undefined,
): T | null {
  // Null and undefined are accepted so `proven(artifact) ?? proven(retained)`
  // typechecks — the retained artifact is null until something has been proven
  // once, and forcing every caller to guard that would put a truthiness check in
  // front of the one expression Rule 1 asks them all to write.
  if (!artifact) return null;
  return WITH_VALUE.includes(artifact.state) ? artifact[VALUE] : null;
}

/** Type guard for "there is something here". */
export function isProven<T>(artifact: Artifact<T>): boolean {
  return WITH_VALUE.includes(artifact.state) && artifact[VALUE] !== null;
}

/**
 * Whether the artifact is older than its budget, independently of `state`.
 *
 * `state` reports the single most decision-relevant fact, and `empty` outranks
 * `stale`: a pre-season table is more usefully described as "no matches played"
 * than as "three days old", and calling it stale invites someone to wait for a
 * fresher copy that will say exactly the same thing. But staleness is not
 * discarded — it stays computable here, so a page can show both.
 */
export function isStale<T>(artifact: Artifact<T>): boolean {
  if (artifact.state === "stale") return true;
  const { ageMs, freshnessBudgetMs } = artifact.provenance;
  if (ageMs === null || freshnessBudgetMs === null) return false;
  return ageMs > freshnessBudgetMs;
}

/**
 * Data for a chart, or null — and `empty` is null.
 *
 * Every Recharts mount sits behind this call. That is the mechanism, not a
 * convention: `/health` shipped 312 lines of chart scaffolding over metrics that
 * were never emitted, and an axis with no series reads as a broken page rather
 * than as an honest "nothing measured yet". Returning null lets the caller render
 * a state card instead, and lets the chart library stay out of the bundle.
 *
 * The selector is mandatory so the caller states what is being charted; nested
 * series (`health.calibration.bins`) are as common as top-level arrays.
 */
export function chartable<T, R>(
  artifact: Artifact<T>,
  select: (value: T) => readonly R[] | null | undefined,
): readonly R[] | null {
  if (artifact.state !== "ok" && artifact.state !== "stale") return null;
  const value = artifact[VALUE];
  if (value === null) return null;
  const series = select(value);
  if (!series || series.length === 0) return null;
  return series;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyInput<T> {
  readonly path: string;
  readonly source: Provenance["source"];
  /**
   * Whatever the fetch produced. `undefined` or `null` means nothing was
   * published — the normal state for most artifacts most of the time, and not an
   * error.
   */
  readonly raw: unknown;
  /** Runtime check. Never `raw as T`; see Rule 4 in the plan. */
  readonly narrow: (raw: unknown) => NarrowResult<T>;
  readonly producedAtOf?: (value: T) => string | null | undefined;
  /** See `Descriptor.producedAtOfRaw`. Preferred over `producedAtOf` when set. */
  readonly producedAtOfRaw?: (raw: unknown) => string | null | undefined;
  readonly producerVersionOf?: (value: T) => string | null | undefined;
  /** Declared per artifact. Absence of a predicate means `empty` is impossible. */
  readonly isEmpty?: (value: T) => boolean;
  readonly freshnessBudgetMs?: number | null;
  /** Injected so tests are not clock-dependent. */
  readonly now: Date;
  /** Set when the fetch itself failed, to distinguish 404 from network error. */
  readonly fetchError?: string | null;
}

/**
 * Turn a fetch result into an artifact.
 *
 * Precedence is `absent` > `unreadable` > `empty` > `stale` > `ok`, and the order
 * is deliberate: each earlier state makes the later ones unanswerable. You cannot
 * ask whether an absent file is stale, and you should not describe a file that
 * failed narrowing as merely empty.
 */
export function classify<T>(input: ClassifyInput<T>): Artifact<T> {
  const {
    path, source, raw, narrow, producedAtOf, producedAtOfRaw, producerVersionOf,
    isEmpty,
    freshnessBudgetMs = null, now, fetchError = null,
  } = input;

  const fetchedAt = now.toISOString();

  const base = (over: Partial<Provenance>): Provenance => ({
    path,
    source,
    fetchedAt,
    producedAt: null,
    producerVersion: null,
    ageMs: null,
    freshnessBudgetMs,
    ...over,
  });

  if (raw === null || raw === undefined) {
    return {
      state: "absent",
      provenance: base({ source: "none" }),
      reason: fetchError
        ? `Could not be read: ${fetchError}`
        : "Nothing has been published at this path yet.",
      [VALUE]: null,
    };
  }

  const result = narrow(raw);
  if (!result.ok) {
    return {
      state: "unreadable",
      provenance: base({}),
      // Every problem, not the first. A page showing one field name when six
      // are wrong sends whoever is debugging it round the loop six times.
      reason:
        `Published, but does not match the expected shape: ` +
        `${result.problems.join("; ")}.`,
      [VALUE]: null,
    };
  }

  const value = result.value;
  // Raw first: an artifact that narrows to a bare array cannot carry its own envelope.
  const producedAt = producedAtOfRaw?.(raw) ?? producedAtOf?.(value) ?? null;
  const producerVersion = producerVersionOf?.(value) ?? null;

  const producedMs = producedAt ? Date.parse(producedAt) : NaN;
  const ageMs = Number.isNaN(producedMs) ? null : now.getTime() - producedMs;

  const provenance = base({ producedAt, producerVersion, ageMs });

  if (isEmpty?.(value)) {
    return {
      state: "empty",
      provenance,
      reason: "Published and well-formed, but carries no data yet.",
      [VALUE]: value,
    };
  }

  if (
    ageMs !== null && freshnessBudgetMs !== null && ageMs > freshnessBudgetMs
  ) {
    return {
      state: "stale",
      provenance,
      reason:
        `Last produced ${describeAge(ageMs)} ago, beyond the ` +
        `${describeAge(freshnessBudgetMs)} budget for this artifact.`,
      [VALUE]: value,
    };
  }

  return { state: "ok", provenance, reason: null, [VALUE]: value };
}

/**
 * An artifact for a value already in hand.
 *
 * For `localStorage` and other non-fetched sources, so a page can hold every
 * input in one shape. `/bankroll` is the reference case: it must stay fully
 * functional with every pipeline artifact absent.
 */
export function present<T>(
  path: string, value: T, now: Date, isEmpty?: (value: T) => boolean,
): Artifact<T> {
  const provenance: Provenance = {
    path,
    source: "local",
    fetchedAt: now.toISOString(),
    producedAt: null,
    producerVersion: null,
    ageMs: null,
    freshnessBudgetMs: null,
  };
  if (isEmpty?.(value)) {
    return {
      state: "empty",
      provenance,
      reason: "Nothing recorded yet.",
      [VALUE]: value,
    };
  }
  return { state: "ok", provenance, reason: null, [VALUE]: value };
}

/** Compact "3 days" / "4 hours" / "20 minutes", for reasons and provenance strips. */
export function describeAge(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * How the producer version should read.
 *
 * "version unknown" rather than an empty string or a reassuring "current": a
 * writer that emits no version is a writer we cannot vouch for, and that is
 * worth saying out loud on the page.
 */
export function describeProducer(provenance: Provenance): string {
  return provenance.producerVersion ?? "version unknown";
}
