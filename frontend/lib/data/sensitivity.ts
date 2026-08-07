/**
 * The robustness report: how often a recommendation survives being wrong.
 *
 * ## The state to read first is `measurable`
 *
 * This artifact is published on every agent run, and today it always says
 * `measurable: false`. That is the correct output, not a placeholder. A
 * survival percentage is a statement about how wrong the projections have
 * historically been; no gameweek has settled, so there is no measured error
 * distribution and any number here would be laundered guesswork.
 *
 * The narrower therefore treats an unmeasurable report as **well-formed and
 * empty**, not as a failure. It is the `empty` arm of the envelope: published,
 * valid, carries no information yet — the same shape as a pre-season league
 * table. A page must render the reason, never a zero.
 *
 * ## Why `survival` is nullable even when measurable
 *
 * Every draw can fail to solve. `assess` counts those in `failed_draws` and
 * excludes them from the denominator rather than scoring them against the
 * baseline, so a run where every draw failed is measurable, has zero completed
 * draws, and honestly has no survival rate. Coercing that to 0.0 would report
 * the solver timing out as evidence that the recommendation is fragile.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, optNumber, optString, Problems, reqRecord,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface SurvivalBand {
  readonly label: string;
  readonly tone: "good" | "mixed" | "bad" | "unknown";
}

export interface Alternative {
  readonly move: string;
  readonly wins: number;
  readonly frequency: number;
}

export interface NoiseSummary {
  readonly sdByPosition: Readonly<Record<string, number>>;
  readonly intraTeamRho: number;
  readonly gameweeks: number;
}

export interface Sensitivity {
  readonly measurable: boolean;
  /** Non-null whenever `measurable` is false. Rendered verbatim. */
  readonly reason: string | null;
  readonly baselineMove: string | null;
  readonly survival: number | null;
  readonly alternatives: readonly Alternative[];
  readonly draws: number;
  readonly failedDraws: number;
  readonly settledGameweeks: number;
  readonly noise: NoiseSummary | null;
  readonly generatedAt: string | null;
}

/**
 * The band vocabulary, mirroring `sensitivity.interpret` on the Python side.
 *
 * Duplicated deliberately rather than shipped in the artifact: the thresholds
 * are a presentation decision and belong where the rendering is, and a band
 * string baked into a published file would freeze at whatever the producer
 * believed on the day it was written.
 *
 * Kept in step by `sensitivity.test.ts`, which asserts the same four bands and
 * the same cut points as the Python test.
 */
export function band(survival: number | null): SurvivalBand {
  if (survival === null) return { label: "not measured", tone: "unknown" };
  if (survival >= 0.8) {
    return { label: "robust — survives the model being wrong", tone: "good" };
  }
  if (survival >= 0.6) {
    return { label: "leaning — better, but not decisively", tone: "mixed" };
  }
  if (survival >= 0.4) {
    return { label: "a coin toss between the top options", tone: "mixed" };
  }
  return { label: "fragile — the headline ranking is noise", tone: "bad" };
}

function narrowAlternatives(raw: unknown): Alternative[] {
  if (!Array.isArray(raw)) return [];
  const out: Alternative[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const move = optString(entry.move);
    const frequency = optNumber(entry.frequency);
    // A move with no name and no frequency is not an alternative, it is a row.
    if (move === null || frequency === null) continue;
    out.push({ move, wins: optNumber(entry.wins) ?? 0, frequency });
  }
  return out;
}

function narrowNoise(raw: unknown): NoiseSummary | null {
  if (!isRecord(raw)) return null;
  const sd = isRecord(raw.sd_by_position) ? raw.sd_by_position : {};
  const sdByPosition: Record<string, number> = {};
  for (const [position, value] of Object.entries(sd)) {
    const n = optNumber(value);
    if (n !== null) sdByPosition[position] = n;
  }
  return {
    sdByPosition,
    intraTeamRho: optNumber(raw.intra_team_rho) ?? 0,
    gameweeks: optNumber(raw.gameweeks) ?? 0,
  };
}

export function narrowSensitivity(raw: unknown): NarrowResult<Sensitivity> {
  const problems = new Problems();
  const file = reqRecord(raw, "sensitivity", problems);
  if (!file) return malformed(problems.all);

  // The only genuinely required field. Everything else is legitimately absent
  // while the report is unmeasurable, which is its normal state today.
  if (typeof file.measurable !== "boolean") {
    problems.add("measurable is missing, so the report cannot be interpreted");
    return malformed(problems.all);
  }

  const reason = optString(file.reason);
  if (!file.measurable && reason === null) {
    // An unmeasurable report with no reason is the failure this whole envelope
    // exists to prevent: a page would have nothing to show but a blank.
    problems.add("measurable is false but no reason was given");
    return malformed(problems.all);
  }

  return narrowed({
    measurable: file.measurable,
    reason,
    baselineMove: optString(file.baseline_move),
    survival: optNumber(file.survival),
    alternatives: narrowAlternatives(file.alternatives),
    draws: optNumber(file.draws) ?? 0,
    failedDraws: optNumber(file.failed_draws) ?? 0,
    settledGameweeks: optNumber(file.settled_gameweeks) ?? 0,
    noise: narrowNoise(file.noise),
    generatedAt: optString(file.generated_at),
  });
}

/**
 * Carries no information yet.
 *
 * An unmeasurable report is `empty`, not `absent`: the agent did publish it,
 * and the distinction tells the reader "this is working and waiting for data"
 * rather than "something failed to write".
 */
export function sensitivityIsEmpty(value: Sensitivity): boolean {
  return !value.measurable || value.draws === 0;
}

export function sensitivityDescriptor(
  gameweek: number, label: string,
): Descriptor<Sensitivity> {
  const padded = String(gameweek).padStart(2, "0");
  return {
    key: `sensitivity:${label}:${padded}`,
    path: `fpl/sensitivity_gw${padded}_${label}.json`,
    owner: "agent",
    describes: `how well the ${label} team's move survives being wrong`,
    freshnessBudgetMs: DAY,
    narrow: narrowSensitivity,
    producedAtOf: (v) => v.generatedAt,
    isEmpty: sensitivityIsEmpty,
  };
}
