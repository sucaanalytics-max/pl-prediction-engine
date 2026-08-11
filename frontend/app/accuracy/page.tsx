"use client";

/**
 * Accuracy — are we any good, and how would you know.
 *
 * Exactly one product in this category publishes model accuracy at all, once,
 * on 2022/23 data. A rolling in-season measurement would be unique. We do not
 * have one yet: no gameweek has sealed.
 *
 * What this page can show today is the **perfect-model ceiling**, and that is
 * not a consolation prize. FPL points are close to irreducibly random: the
 * published benchmark puts the top six public models within 0.08 RMSE of each
 * other, all near ~2.8, against a perfect forecaster's ~2.806. Shown alone, a
 * future RMSE of 2.9 reads as failure and invites the reader to imagine 2.0 is
 * reachable. Shown against the ceiling, it reads as 0.1 of avoidable error —
 * which is the truth and the only part worth working on.
 */

import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  ACCURACY, beatsTheCeiling, type Accuracy, type Slice,
} from "@/lib/data/accuracy";

/** Positions and bands in a fixed order, so the table does not reorder itself. */
const POSITIONS = ["GKP", "DEF", "MID", "FWD"] as const;
const BANDS = [
  { key: "blank", label: "Blanks", hint: "Under 2 points" },
  { key: "return", label: "Returns", hint: "2 to 9" },
  { key: "haul", label: "Hauls", hint: "10 or more — the band that moves rank" },
] as const;

function Ceiling({ report }: { report: Accuracy }) {
  return (
    <div className="glass-inset p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <p className="stat-label">Perfect-model RMSE</p>
          <p className="font-mono text-3xl" style={{ color: "var(--text-1)" }}>
            {report.perfectModelRmse !== null
              ? report.perfectModelRmse.toFixed(3)
              : "—"}
          </p>
        </div>
        {report.measured?.overall ? (
          <div className="text-right">
            <p className="stat-label">Ours</p>
            <p className="font-mono text-3xl" style={{ color: "var(--text-1)" }}>
              {report.measured.overall.rmse.toFixed(3)}
            </p>
          </div>
        ) : null}
      </div>
      {report.perfectModelBasis ? (
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          {report.perfectModelBasis}
        </p>
      ) : null}
    </div>
  );
}

function Excess({ report }: { report: Accuracy }) {
  if (report.excessOverCeiling === null) return null;

  if (beatsTheCeiling(report)) {
    // Not an achievement. A model cannot beat the theoretical floor, so this
    // is a defect report — most plausibly outcomes joined to forecasts with a
    // look-ahead leak.
    return (
      <div
        className="card p-4"
        role="alert"
        data-state="beats-ceiling"
        style={{ borderColor: "var(--danger, #f87171)" }}
      >
        <span className="text-[9px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--danger, #f87171)" }}>
          Impossible result — investigate
        </span>
        <p className="text-sm mt-1" style={{ color: "var(--text-2)" }}>
          The measured error is {Math.abs(report.excessOverCeiling).toFixed(3)}{" "}
          <em>below</em> the theoretical floor. No forecaster can beat it, so
          this is evidence of a defect rather than of skill — most likely
          outcomes being joined to forecasts that had already seen them.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-inset p-3">
      <p className="stat-label">Avoidable error</p>
      <p className="font-mono text-xl" data-testid="excess">
        {report.excessOverCeiling.toFixed(3)}
      </p>
      <p className="text-xs mt-1" style={{ color: "var(--text-3)" }}>
        Everything above the ceiling, and the only part that is ours to improve.
      </p>
    </div>
  );
}

function SliceRow({ label, hint, slice }: {
  label: string; hint?: string; slice: Slice | undefined;
}) {
  return (
    <tr data-testid="slice">
      <td className="text-sm">
        {label}
        {hint ? (
          <span className="block text-[10px]" style={{ color: "var(--text-4)" }}>
            {hint}
          </span>
        ) : null}
      </td>
      <td className="text-center font-mono text-sm">
        {slice ? slice.rmse.toFixed(3) : "—"}
      </td>
      <td className="text-center font-mono text-sm hidden sm:table-cell">
        {/* Bias, not error. A model 0.5 points optimistic every week is a
            different problem from one that is noisy, and RMSE conflates them. */}
        {slice?.bias != null ? slice.bias.toFixed(3) : "—"}
      </td>
      <td className="text-center font-mono text-xs" style={{ color: "var(--text-3)" }}>
        {slice ? slice.n.toLocaleString() : "—"}
      </td>
    </tr>
  );
}

function Breakdown({ measured }: { measured: NonNullable<Accuracy["measured"]> }) {
  return (
    <div className="glass-panel rounded-2xl overflow-x-auto">
      <table className="data-table" aria-label="Accuracy by slice">
        <thead>
          <tr>
            <th scope="col">Slice</th>
            <th scope="col" className="text-center">RMSE</th>
            <th scope="col" className="text-center hidden sm:table-cell">Bias</th>
            <th scope="col" className="text-center">n</th>
          </tr>
        </thead>
        <tbody>
          {BANDS.map((band) => (
            <SliceRow
              key={band.key}
              label={band.label}
              hint={band.hint}
              slice={measured.byBand[band.key]}
            />
          ))}
          {POSITIONS.map((position) => (
            <SliceRow
              key={position}
              label={position}
              slice={measured.byPosition[position]}
            />
          ))}
          {Object.keys(measured.byHorizon)
            .sort((a, b) => Number(a) - Number(b))
            .map((horizon) => (
              <SliceRow
                key={`h${horizon}`}
                label={`GW+${horizon}`}
                slice={measured.byHorizon[horizon]}
              />
            ))}
        </tbody>
      </table>
    </div>
  );
}

function PredictedXi({ report }: { report: Accuracy }) {
  const { ours, benchmark, benchmarkSource } = report.predictedXi;
  return (
    <div className="glass-inset p-3 flex items-baseline justify-between gap-3 flex-wrap">
      <div>
        <p className="stat-label">Predicted XI — ours</p>
        <p className="font-mono text-xl">
          {ours !== null ? `${(ours * 100).toFixed(0)}%` : "not measured"}
        </p>
      </div>
      <div className="text-right">
        <p className="stat-label">The bar</p>
        <p className="font-mono text-xl">
          {benchmark !== null ? `${(benchmark * 100).toFixed(0)}%` : "—"}
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
          {benchmarkSource ?? ""}
        </p>
      </div>
    </div>
  );
}

export default function AccuracyPage() {
  const { artifact } = useArtifact<Accuracy>(ACCURACY);
  const report = proven(artifact);

  return (
    <ErrorBoundary pageName="Accuracy">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Accuracy
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What the model gets wrong, against what anything could get right
          </p>
        </header>

        <Section
          title="Against the ceiling"
          subtitle="A perfect forecaster still makes errors, because the outcome is random"
          aside={<ProvenanceStrip of={artifact} />}
        >
          <WhenProven
            of={artifact}
            what="No accuracy rollup has been published yet."
            // Shown while empty on purpose: the ceiling is real content and does
            // not depend on a single settled gameweek.
            showEmpty
            then={(value) => (
              <div className="space-y-3">
                <Ceiling report={value} />
                <Excess report={value} />
                {value.reason ? (
                  <div className="card p-4" role="status" data-state="unmeasured">
                    <span className="badge-amber text-[9px]">NOT YET MEASURED</span>
                    <p className="text-sm mt-1" style={{ color: "var(--text-2)" }}>
                      {value.reason}
                    </p>
                    <p className="text-xs mt-2" style={{ color: "var(--text-4)" }}>
                      {value.gameweeksSealed} of 38 gameweeks sealed.
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          />
        </Section>

        {report?.measured ? (
          <Section
            title="Where the error is"
            subtitle="Hauls are the band that moves rank; an aggregate hides them"
          >
            <Breakdown measured={report.measured} />
          </Section>
        ) : null}

        <Section
          title="Predicted XI"
          subtitle="The number that decides whether a paid lineup feed is worth it"
        >
          <WhenProven
            of={artifact}
            what="No predicted-XI comparison has been published yet."
            showEmpty
            then={(value) => <PredictedXi report={value} />}
          />
        </Section>
      </div>
    </ErrorBoundary>
  );
}
