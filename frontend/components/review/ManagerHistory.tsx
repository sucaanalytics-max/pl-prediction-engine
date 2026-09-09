"use client";

/**
 * What your season has actually cost you.
 *
 * ## Why nothing here is coloured
 *
 * `DecisionReview` sits directly above this and judges FORESEEABILITY against
 * the sealed forecast — it goes to real lengths not to manufacture blame, which
 * is why `indistinguishable` exists as a third verdict. This judges OUTCOME.
 * Rendered alike, the two collapse, and "was the call wrong or merely unlucky"
 * — the question that page was built to keep open — silently closes. So every
 * number here is the plain ink: a −3 is a fact, not a reproach.
 *
 * ## Why the bench is first
 *
 * Measured 2026-09-09: the bench had cost 27 points across three gameweeks and
 * the single transfer had cost 3. Ordering these by novelty rather than by
 * magnitude would lead with the −3 and leave the 27 unmentioned.
 */
import { ProvenanceStrip, Section, StateCard } from "@/components/data/Artifact";
import { proven } from "@/lib/data/artifact";
import {
  SPANS, basketFor, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { SIGNAL as S } from "@/lib/margin/tokens";

/** An em-dash, never a zero: "not yet played" is not "scored nothing". */
const NOT_YET = "—";

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function Figure(
  { label, value, note, testId }:
  { label: string; value: string; note?: string; testId?: string },
) {
  return (
    <div data-testid={testId}>
      <div
        className="text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-3)", letterSpacing: ".15em" }}
      >
        {label}
      </div>
      <div className="font-mono text-xl mt-1" style={{ color: "var(--text-1)" }}>
        {value}
      </div>
      {note ? (
        <div className="text-[11px] mt-1" style={{ color: "var(--text-3)" }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

export default function ManagerHistory() {
  const { artifact } = useArtifact(REGISTRY.managerHistory);
  const history = proven(artifact);

  if (!history) {
    return (
      <StateCard
        of={artifact}
        weight="line"
        what="your manager history — each gameweek, and what each transfer returned"
      />
    );
  }

  const totals = seasonTotals(history);
  const weeks = [...history.gameweeks].sort((a, b) => b.event - a.event);
  const moves = [...history.transfers].sort((a, b) => b.event - a.event);

  return (
    <Section
      title="What it cost"
      subtitle="What happened, not whether it was right — the judgement lives above this"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <div className="glass-panel rounded-none p-4 grid gap-4 sm:grid-cols-4">
        <Figure
          testId="bench-waste"
          label="Left on the bench"
          value={String(totals.benchPoints)}
          note="the largest number on this page"
        />
        <Figure
          testId="vs-average"
          label="Against the field"
          value={totals.vsAverage === null ? NOT_YET : signed(totals.vsAverage)}
        />
        <Figure
          testId="captaincy-cost"
          label="Armband, vs your best"
          value={String(totals.captaincyCost)}
          note={`${totals.captainPoints} of a possible ${totals.bestCaptainPoints}`}
        />
        <Figure
          testId="hit-spend"
          label="Spent on hits"
          value={String(totals.hitSpend)}
          note={`auto-subs recovered ${totals.autoSubRescue}`}
        />
      </div>

      <div className="overflow-x-auto mt-6">
        <table className="w-full font-mono text-[11.5px]" style={{ color: S.ink }}>
          <thead>
            <tr style={{ color: S.ink3 }}>
              <th className="text-left font-normal">GW</th>
              <th className="text-right font-normal">Pts</th>
              <th className="text-right font-normal">Avg</th>
              <th className="text-right font-normal">Bench</th>
              <th className="text-right font-normal">Overall</th>
              <th className="text-right font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week.event} data-testid={`manager-week-${week.event}`}>
                <td className="text-left">{week.event}</td>
                <td className="text-right">{week.points}</td>
                <td className="text-right">
                  {week.averageEntryScore ?? NOT_YET}
                </td>
                <td className="text-right">{week.benchPoints}</td>
                <td className="text-right">
                  {week.overallRank === null
                    ? NOT_YET
                    : week.overallRank.toLocaleString()}
                </td>
                <td className="text-right">
                  {week.value === null ? NOT_YET : (week.value / 10).toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3
        className="mt-8 text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-3)", letterSpacing: ".15em" }}
      >
        Transfers
      </h3>

      {moves.length === 0 ? (
        <p className="text-[11px] mt-2" style={{ color: S.ink3 }}>
          No transfers made yet, so there is nothing here to measure.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto mt-2">
            <table
              className="w-full font-mono text-[11.5px]"
              style={{ color: S.ink }}
            >
              <thead>
                <tr style={{ color: S.ink3 }}>
                  <th className="text-left font-normal">GW</th>
                  <th className="text-left font-normal">In / out</th>
                  {SPANS.map((span) => (
                    <th key={span} className="text-right font-normal">
                      {span === 1 ? "same" : `+${span - 1}`}
                    </th>
                  ))}
                  <th className="text-right font-normal">raw</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((move) => {
                  const windows = SPANS.map((span) => windowFor(move, span));
                  const same = windows[0];
                  return (
                    <tr
                      key={`${move.event}-${move.elementIn}`}
                      data-testid={`transfer-row-${move.event}`}
                    >
                      <td className="text-left">{move.event}</td>
                      <td className="text-left">
                        {move.elementIn} / {move.elementOut}
                      </td>
                      {windows.map((window) => (
                        <td
                          key={window.span}
                          className="text-right"
                          // Polluted is de-emphasised, never recoloured: it is a
                          // caveat about the counterfactual, not a bad outcome.
                          style={{ color: window.polluted ? S.ink3 : S.ink }}
                          title={window.polluted
                            ? "polluted — the player left the squad inside this window"
                            : undefined}
                        >
                          {window.effective === null
                            ? NOT_YET
                            : signed(window.effective)}
                          {window.polluted ? "*" : ""}
                        </td>
                      ))}
                      <td className="text-right" style={{ color: S.ink3 }}>
                        {same.raw === null ? NOT_YET : signed(same.raw)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] mt-2" style={{ color: S.ink3 }}>
            {(() => {
              const basket = basketFor(history, moves[0].event);
              if (basket.transfers > 1) {
                return `GW${basket.event} as a basket: `
                  + `${basket.effective === null ? NOT_YET : signed(basket.effective)} `
                  + `across ${basket.transfers} transfers against a `
                  + `${basket.hit}-point hit. Pairing each buy with a particular `
                  + "sale is arbitrary once there is more than one.";
              }
              return `GW${basket.event}: one transfer, `
                + `${basket.hit} points of hit.`;
            })()}
          </p>

          <p
            className="text-[11px] mt-3"
            data-testid="transfer-aggregate"
            style={{ color: S.ink3 }}
          >
            {SPANS.map((span) => {
              const aggregate = transferAggregate(history, span);
              const label = span === 1 ? "same gameweek" : `over ${span} gameweeks`;
              return aggregate.withheldReason === null
                ? `${label}: ${signed(aggregate.effective ?? 0)} across ${aggregate.n}. `
                : `${label}: ${aggregate.withheldReason}. `;
            })}
          </p>
        </>
      )}
    </Section>
  );
}
