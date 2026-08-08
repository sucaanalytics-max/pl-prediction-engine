/**
 * Are we any good, and how would anyone know.
 *
 * ## Why this screen has content before it has measured anything
 *
 * Measured accuracy needs sealed gameweeks and there are none. But the
 * **perfect-model ceiling** does not: a forecaster that knew each player's true
 * distribution would predict its mean and still incur its variance, so the
 * ceiling is computable from the spread of our own simulated distributions
 * alone.
 *
 * That number is the whole reason this page is worth shipping empty. The
 * published benchmark puts the top six public models within 0.08 RMSE of each
 * other and all near ~2.8, against a perfect model's ~2.806. Without the
 * ceiling on screen, a future RMSE of 2.9 reads as a failure and invites the
 * reader to imagine that 2.0 is reachable. It is not. `excessOverCeiling` is
 * the only part of the error that is ours.
 *
 * ## A negative excess is a bug, and is shown as one
 *
 * Beating the ceiling is not possible. If it happens, the most likely cause is
 * a look-ahead leak in how outcomes were joined to forecasts, and the page says
 * so rather than displaying it as an achievement.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, optNumber, optString, Problems, reqRecord,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface Slice {
  readonly n: number;
  readonly rmse: number;
  /** Signed mean residual. Distinguishes a biased model from a noisy one. */
  readonly bias: number | null;
  readonly biasRadius: number | null;
}

export interface Measured {
  readonly overall: Slice | null;
  readonly byPosition: Readonly<Record<string, Slice>>;
  readonly byBand: Readonly<Record<string, Slice>>;
  readonly byHorizon: Readonly<Record<string, Slice>>;
}

export interface Accuracy {
  readonly generatedAt: string | null;
  readonly season: string | null;
  readonly gameweeksSealed: number;
  readonly observations: number;
  readonly perfectModelRmse: number | null;
  readonly perfectModelBasis: string | null;
  readonly measured: Measured | null;
  readonly excessOverCeiling: number | null;
  readonly predictedXi: {
    readonly ours: number | null;
    readonly benchmark: number | null;
    readonly benchmarkSource: string | null;
  };
  readonly reason: string | null;
}

function narrowSlice(raw: unknown): Slice | null {
  if (!isRecord(raw)) return null;
  const n = optNumber(raw.n);
  const rmse = optNumber(raw.rmse);
  // Both required: an RMSE with no sample size is a number with no weight
  // behind it, and the page ranks slices by how much they are worth trusting.
  if (n === null || rmse === null) return null;
  return {
    n,
    rmse,
    bias: optNumber(raw.bias),
    biasRadius: optNumber(raw.bias_radius),
  };
}

function narrowSlices(raw: unknown): Record<string, Slice> {
  const out: Record<string, Slice> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const slice = narrowSlice(value);
    if (slice !== null) out[key] = slice;
  }
  return out;
}

function narrowMeasured(raw: unknown): Measured | null {
  if (!isRecord(raw)) return null;
  return {
    overall: narrowSlice(raw.overall),
    byPosition: narrowSlices(raw.by_position),
    byBand: narrowSlices(raw.by_band),
    byHorizon: narrowSlices(raw.by_horizon),
  };
}

export function narrowAccuracy(raw: unknown): NarrowResult<Accuracy> {
  const problems = new Problems();
  const file = reqRecord(raw, "accuracy", problems);
  if (!file) return malformed(problems.all);

  const measured = narrowMeasured(file.measured);
  const reason = optString(file.reason);
  if (measured === null && reason === null) {
    // Nothing measured and no explanation leaves the page with a blank where
    // the answer to "why not" belongs.
    problems.add("nothing is measured and no reason was given");
    return malformed(problems.all);
  }

  const xi = isRecord(file.predicted_xi) ? file.predicted_xi : {};
  return narrowed({
    generatedAt: optString(file.generated_at),
    season: optString(file.season),
    gameweeksSealed: optNumber(file.gameweeks_sealed) ?? 0,
    observations: optNumber(file.observations) ?? 0,
    perfectModelRmse: optNumber(file.perfect_model_rmse),
    perfectModelBasis: optString(file.perfect_model_basis),
    measured,
    excessOverCeiling: optNumber(file.excess_over_ceiling),
    predictedXi: {
      ours: optNumber(xi.ours),
      benchmark: optNumber(xi.benchmark),
      benchmarkSource: optString(xi.benchmark_source),
    },
    reason,
  });
}

/**
 * Nothing measured yet.
 *
 * The ceiling alone is real content, so a file carrying it is not `absent` —
 * but it carries no *accuracy*, which is what the page is for. `empty` with a
 * reason is the honest state, and the page still renders the ceiling.
 */
export function accuracyIsEmpty(value: Accuracy): boolean {
  return value.measured === null || value.measured.overall === null;
}

/**
 * Whether the measured error beats the theoretical floor.
 *
 * Not an achievement. A model cannot beat the ceiling, so this is evidence of a
 * defect — most plausibly a look-ahead leak joining outcomes to forecasts.
 */
export function beatsTheCeiling(value: Accuracy): boolean {
  return value.excessOverCeiling !== null && value.excessOverCeiling < 0;
}

export const ACCURACY: Descriptor<Accuracy> = {
  key: "accuracy",
  path: "fpl/accuracy.json",
  owner: "agent",
  describes: "measured forecast accuracy against the perfect-model ceiling",
  freshnessBudgetMs: 2 * DAY,
  narrow: narrowAccuracy,
  producedAtOf: (v) => v.generatedAt,
  isEmpty: accuracyIsEmpty,
};
