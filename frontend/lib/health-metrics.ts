/**
 * Scoring a model metric against its target, including the case where there is
 * no metric.
 *
 * `/health` used to compute `good={(metrics.brier_1x2_home ?? 1) < 0.22}`. The
 * `?? 1` substituted a sentinel worse than any real Brier score, so an *absent*
 * metric rendered in the same amber as a measured miss: the page reported a model
 * we had never scored as one we had scored and found wanting.
 *
 * That is the failure this module exists to prevent, and it is not hypothetical
 * — the committed `health.json` is `pipeline_version 4.0.0` while the code is
 * `4.1.0`, and 4.0.0 did not emit `model_metrics` at all. A successful run of an
 * older producer therefore yields a *healthy, complete* file whose metrics are
 * absent, which no freshness check can detect.
 */

export interface CoreMetric {
  key: string;
  label: string;
  /** Upper bound. Every core metric here is "lower is better". */
  target: number;
}

export const CORE_METRICS: readonly CoreMetric[] = [
  { key: "brier_1x2_home", label: "Brier (H)", target: 0.22 },
  { key: "brier_1x2_draw", label: "Brier (D)", target: 0.23 },
  { key: "brier_1x2_away", label: "Brier (A)", target: 0.22 },
  { key: "rps_mean", label: "RPS", target: 0.2 },
  { key: "ece", label: "ECE", target: 0.05 },
  { key: "log_loss_home", label: "Log Loss", target: 0.65 },
];

export type Metrics = Record<string, number | undefined>;

/**
 * Pass, fail, or not-measured.
 *
 * Three-valued on purpose. Null is not "unknown, assume the worst" — it is a
 * distinct state that must not borrow either verdict's colour. `NaN` also
 * resolves to null: it is a measurement that failed, which is likewise not a
 * result.
 */
export function verdict(value: number | undefined, target: number): boolean | null {
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  return value < target;
}

/**
 * Whether this artifact carries any core metric at all.
 *
 * Distinguishes "the producer emitted no metrics" from "the producer emitted
 * zeros", which are opposite situations: the first is unmeasured, the second is
 * a perfect score and almost certainly a bug.
 */
export function hasCoreMetrics(metrics: Metrics): boolean {
  return CORE_METRICS.some((m) => verdict(metrics[m.key], m.target) !== null);
}
