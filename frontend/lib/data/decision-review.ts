/**
 * Your own decisions, scored against what the engine said before the deadline.
 *
 * ## Why this is not another accuracy screen
 *
 * `accuracy.json` asks whether the model was right. This asks whether *you* were,
 * and it can only ask honestly because `predictions/fpl/ledger/gwNN/forecast.jsonl`
 * records a forecast with a `sealed_at` and a `seconds_before_deadline`. Every
 * verdict below is therefore a claim about what was knowable at the time rather
 * than hindsight wearing a confident face.
 *
 * ## The three verdicts, and why a tie is one of them
 *
 * A bench call is `foreseeable`, `defensible` or `indistinguishable`. The third is
 * the one that matters: the producer compares two sealed projections against the
 * Monte Carlo standard error of each, so two players the simulation could not
 * separate never become a lesson. Rendering `indistinguishable` as a mild version
 * of `foreseeable` would manufacture a weekly reproach out of arithmetic noise —
 * on GW1 the one real bench cost was a 0.0008 xP gap against a combined 2-sigma of
 * 0.100, and a naive `>` would have called it an error.
 *
 * A missing verdict (`null`) is a fourth state and not a fourth judgement: the
 * sealed universe excludes fringe players by design, so a player it never covered
 * has no forecast to be judged against. Absence of a verdict is absence of
 * evidence, exactly as in `minutes-conflicts.ts`.
 *
 * ## What it withholds
 *
 * `aggregate` is null until `minimumObservations` gameweeks have settled, and
 * `aggregateReason` says so in the producer's own words. One week of
 * self-assessment is noise, and a rate rendered off it is indistinguishable from a
 * real finding. Per-gameweek calls always ship, because "three of your four bench
 * players were rated above the man you started" is a fact about one gameweek and
 * needs no season behind it.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  optBoolean,
  optNumber,
  optString,
  Problems,
  reqArray,
  reqRecord,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

/** How a bench or selection call stands against the sealed forecast. */
export type Verdict = "foreseeable" | "defensible" | "indistinguishable";

/** What became of a benched player. */
export type BenchKind = "rescued" | "cost" | "correct" | "no_claim";

const VERDICTS: readonly Verdict[] = [
  "foreseeable",
  "defensible",
  "indistinguishable",
];
const KINDS: readonly BenchKind[] = ["rescued", "cost", "correct", "no_claim"];

export interface BenchCall {
  readonly benchElement: number;
  /** Null for `rescued` without a pair, and for `correct` / `no_claim`. */
  readonly starterElement: number | null;
  readonly kind: BenchKind;
  /** Points the benched player beat the starter by. Zero is a real zero here. */
  readonly pointsForgone: number;
  /** Null when the sealed forecast did not cover both players. */
  readonly verdict: Verdict | null;
  /**
   * The producer's own judgement, carried rather than recomputed.
   *
   * Deliberately not derived here as `verdict === "foreseeable"`: the rule is a
   * producer decision (a rescued error still counts, because the call was the same
   * whether or not an automatic substitution covered it) and a second
   * implementation on this side would be free to drift from it.
   */
  readonly isLesson: boolean;
}

export interface Selection {
  readonly worstStarter: number | null;
  readonly bestBench: number | null;
  /** Benched players the forecast separated above the weakest starter. */
  readonly benchRatedHigher: readonly number[];
  readonly gap: number | null;
  readonly misordered: boolean;
}

export interface CaptainCall {
  readonly chosen: number;
  readonly sealedBest: number | null;
  readonly agreed: boolean | null;
  /** Doubled, because the armband doubles. Positive means the engine won. */
  readonly pointsDelta: number | null;
}

export interface GameweekReview {
  readonly gameweek: number;
  /** Proof this was a pre-deadline forecast. Null means the seal said nothing. */
  readonly sealedAt: string | null;
  readonly secondsBeforeDeadline: number | null;
  readonly sealedUniverse: number | null;
  readonly points: number | null;
  /**
   * FPL's own bench figure, which is computed AFTER automatic substitutions and
   * therefore cannot see a rescue. Kept beside ours precisely because they differ.
   */
  readonly fplPointsOnBench: number | null;
  readonly transfers: number | null;
  readonly hitCost: number | null;
  readonly submittedEleven: readonly number[];
  readonly submittedBench: readonly number[];
  readonly selection: Selection | null;
  readonly bench: readonly BenchCall[];
  readonly captain: CaptainCall | null;
}

export interface Aggregate {
  readonly gameweeks: number;
  readonly pointsForgoneOnBench: number;
  readonly foreseeableBenchErrors: number;
  readonly captainAgreementRate: number | null;
  readonly captainPointsVsEngine: number | null;
}

export interface DecisionReview {
  readonly generatedAt: string | null;
  /**
   * The producer's schema version.
   *
   * Narrowed rather than left out so the provenance strip names the writer instead
   * of printing "version unknown" beside a real judgement about your season — the
   * exact drift `health.json` demonstrated, where a complete, fresh file from a
   * producer that emitted no version looked identical to a current one.
   */
  readonly producerVersion: string | null;
  readonly season: string | null;
  readonly teamName: string | null;
  readonly observations: number;
  readonly minimumObservations: number;
  /** Null until the sample is large enough. Never a partial number. */
  readonly aggregate: Aggregate | null;
  /** The producer's stated reason for withholding. Rendered verbatim. */
  readonly aggregateReason: string | null;
  readonly gameweeks: readonly GameweekReview[];
  /** Element id (as a string, because JSON keys are) to display name. */
  readonly names: ReadonlyMap<string, string>;
}

function narrowVerdict(raw: unknown): Verdict | null {
  const value = optString(raw);
  return value !== null && VERDICTS.includes(value as Verdict)
    ? (value as Verdict)
    : null;
}

function narrowBench(raw: unknown): BenchCall | null {
  const problems = new Problems();
  const row = reqRecord(raw, "bench call", problems);
  if (!row) return null;

  const benchElement = optNumber(row.bench_element);
  const kind = optString(row.kind);
  // Without an element there is nobody to name, and without a kind there is no
  // claim being made. Either missing makes the row unrenderable rather than
  // partial.
  if (benchElement === null || kind === null) return null;
  if (!KINDS.includes(kind as BenchKind)) return null;

  return {
    benchElement,
    starterElement: optNumber(row.starter_element),
    kind: kind as BenchKind,
    pointsForgone: optNumber(row.points_forgone) ?? 0,
    verdict: narrowVerdict(row.verdict),
    isLesson: optBoolean(row.is_lesson) ?? false,
  };
}

function narrowSelection(raw: unknown): Selection | null {
  if (raw === null || raw === undefined) return null;
  const problems = new Problems();
  const row = reqRecord(raw, "selection", problems);
  if (!row) return null;
  const higher = Array.isArray(row.bench_rated_higher)
    ? row.bench_rated_higher.filter((n): n is number => typeof n === "number")
    : [];
  return {
    worstStarter: optNumber(row.worst_starter),
    bestBench: optNumber(row.best_bench),
    benchRatedHigher: higher,
    gap: optNumber(row.gap),
    // Derived from the list rather than trusted separately, so a payload whose
    // flag and list disagree cannot render a contradiction.
    misordered: higher.length > 0,
  };
}

function narrowCaptain(raw: unknown): CaptainCall | null {
  if (raw === null || raw === undefined) return null;
  const problems = new Problems();
  const row = reqRecord(raw, "captain", problems);
  if (!row) return null;
  const chosen = optNumber(row.chosen);
  if (chosen === null) return null;
  return {
    chosen,
    sealedBest: optNumber(row.sealed_best),
    agreed: optBoolean(row.agreed),
    pointsDelta: optNumber(row.points_delta),
  };
}

function narrowGameweek(raw: unknown): GameweekReview | null {
  const problems = new Problems();
  const row = reqRecord(raw, "gameweek review", problems);
  if (!row) return null;
  const gameweek = optNumber(row.gameweek);
  if (gameweek === null) return null;

  const ids = (value: unknown): readonly number[] =>
    Array.isArray(value)
      ? value.filter((n): n is number => typeof n === "number")
      : [];

  return {
    gameweek,
    sealedAt: optString(row.sealed_at),
    secondsBeforeDeadline: optNumber(row.seconds_before_deadline),
    sealedUniverse: optNumber(row.sealed_universe),
    points: optNumber(row.points),
    fplPointsOnBench: optNumber(row.fpl_points_on_bench),
    transfers: optNumber(row.transfers),
    hitCost: optNumber(row.hit_cost),
    submittedEleven: ids(row.submitted_eleven),
    submittedBench: ids(row.submitted_bench),
    selection: narrowSelection(row.selection),
    bench: (Array.isArray(row.bench) ? row.bench : [])
      .map(narrowBench)
      .filter((c): c is BenchCall => c !== null),
    captain: narrowCaptain(row.captain),
  };
}

function narrowAggregate(raw: unknown): Aggregate | null {
  if (raw === null || raw === undefined) return null;
  const problems = new Problems();
  const row = reqRecord(raw, "aggregate", problems);
  if (!row) return null;
  const gameweeks = optNumber(row.gameweeks);
  if (gameweeks === null) return null;
  return {
    gameweeks,
    pointsForgoneOnBench: optNumber(row.points_forgone_on_bench) ?? 0,
    foreseeableBenchErrors: optNumber(row.foreseeable_bench_errors) ?? 0,
    captainAgreementRate: optNumber(row.captain_agreement_rate),
    captainPointsVsEngine: optNumber(row.captain_points_vs_engine),
  };
}

export function narrowDecisionReview(raw: unknown): NarrowResult<DecisionReview> {
  const problems = new Problems();
  const file = reqRecord(raw, "decision_review", problems);
  if (!file) return malformed(problems.all);

  const rows = reqArray(file.gameweeks, "gameweeks", problems);
  if (!rows) return malformed(problems.all);

  const observations = optNumber(file.observations);
  const minimum = optNumber(file.minimum_observations);
  // Both are required, not defaulted. A withheld aggregate is only interpretable
  // against the bar it failed to clear, and inventing a threshold here would let
  // the producer change its mind without the page noticing — the same reason
  // `minutes-conflicts.ts` refuses to default its own thresholds.
  if (observations === null || minimum === null) return malformed(problems.all);

  const names = new Map<string, string>();
  if (file.names && typeof file.names === "object") {
    for (const [key, value] of Object.entries(file.names)) {
      if (typeof value === "string") names.set(key, value);
    }
  }

  const producerVersion = optNumber(file.producer_version);

  return narrowed({
    generatedAt: optString(file.generated_at),
    producerVersion:
      producerVersion === null ? null : String(producerVersion),
    season: optString(file.season),
    teamName: optString(file.team_name),
    observations,
    minimumObservations: minimum,
    aggregate: narrowAggregate(file.aggregate),
    aggregateReason: optString(file.aggregate_reason),
    gameweeks: rows
      .map(narrowGameweek)
      .filter((g): g is GameweekReview => g !== null),
    names,
  });
}

/**
 * Nothing has settled yet.
 *
 * A real and expected state for most of August, and declared rather than inferred
 * so the page can say "no gameweek has settled" instead of rendering an absence.
 */
export function decisionReviewIsEmpty(value: DecisionReview): boolean {
  return value.gameweeks.length === 0;
}

/** A player's display name, or null. Never the raw id dressed as a name. */
export function nameOf(
  review: DecisionReview,
  element: number | null,
): string | null {
  if (element === null) return null;
  return review.names.get(String(element)) ?? null;
}

/** Every call the forecast says was avoidable, newest gameweek first. */
export function lessons(
  review: DecisionReview,
): readonly { readonly gameweek: number; readonly call: BenchCall }[] {
  return [...review.gameweeks]
    .sort((a, b) => b.gameweek - a.gameweek)
    .flatMap((week) =>
      week.bench
        .filter((call) => call.isLesson)
        .map((call) => ({ gameweek: week.gameweek, call })),
    );
}

export const DECISION_REVIEW: Descriptor<DecisionReview> = {
  key: "decisionReview",
  path: "fpl/decision_review.json",
  owner: "agent",
  describes: "your own decisions, scored against the pre-deadline seal",
  // Rewritten when a gameweek settles, which is weekly at most. A day-old copy is
  // entirely normal here, so the budget is generous — unlike the news tick, a
  // stale review is not evidence that anything has stopped.
  freshnessBudgetMs: 30 * DAY,
  narrow: narrowDecisionReview,
  producedAtOf: (v) => v.generatedAt,
  producerVersionOf: (v) => v.producerVersion,
  isEmpty: decisionReviewIsEmpty,
};
