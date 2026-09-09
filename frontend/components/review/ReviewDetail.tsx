"use client";

/**
 * The Detailed data tab: what exactly happened, in rows.
 *
 * The gameweek table carries every column the artifact has rather than the four
 * a summary would pick, because that is what this tab is for. The transfer
 * ledger keeps its windows here, where there is room for them.
 *
 * `DecisionReview` is mounted at the foot rather than reduced to a verdict
 * column. Its cards carry four states this tab could not otherwise say —
 * `indistinguishable` (a tie is never a mistake), a rescued error that cost
 * nothing but was still foreseeable, "nothing to judge" for a bench player who
 * never came on, and "not covered" for a comparison the sealed universe never
 * held. Flattening it to one chip a week would quietly drop the distinctions
 * eighteen of its own tests exist to protect.
 */
import { ProvenanceStrip, StateCard } from "@/components/data/Artifact";
import DecisionReview from "@/components/review/DecisionReview";
import { proven } from "@/lib/data/artifact";
import {
  SPANS, basketFor, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";
import type { ManagerHistory as Ledger } from "@/lib/data/narrow-manager-history";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { SIGNAL as S } from "@/lib/margin/tokens";

/** Not a zero: "not yet played" and "scored nothing" are opposite readings. */
const NOT_YET = "—";

const LABEL = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".15em",
  color: S.ink3,
} as const;

const CELL = { padding: "9px 0", fontVariantNumeric: "tabular-nums" } as const;
const HEAD = {
  ...CELL,
  padding: "7px 0",
  fontWeight: 400,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".07em",
  color: S.ink3,
} as const;

function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

/** An id is not a name. Falls back to the id rather than inventing one. */
function nameOf(ledger: Ledger, element: number): string {
  return ledger.names.get(element) ?? String(element);
}

function Band({ children, aside }: { children: string; aside?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 30 }}>
      <div style={LABEL}>{children}</div>
      <div style={{ flex: 1, height: 1, background: S.hair }} />
      {aside ? (
        <div style={{ fontSize: 11, color: S.ink3, whiteSpace: "nowrap" }}>{aside}</div>
      ) : null}
    </div>
  );
}

export default function ReviewDetail() {
  const { artifact } = useArtifact(REGISTRY.managerHistory);
  const ledger = proven(artifact);

  if (!ledger) {
    return (
      <div className="space-y-8">
        <StateCard
          of={artifact}
          weight="line"
          what="your manager history — each gameweek, and what each transfer returned"
        />
        <DecisionReview />
      </div>
    );
  }

  const totals = seasonTotals(ledger);
  const weeks = [...ledger.gameweeks].sort((a, b) => b.event - a.event);
  const moves = [...ledger.transfers].sort((a, b) => b.event - a.event);
  const points = weeks.reduce((sum, w) => sum + w.points, 0);
  const field = weeks.reduce((sum, w) => sum + (w.averageEntryScore ?? 0), 0);
  const subs = weeks.reduce(
    (sum, w) => sum + w.autoSubs.reduce((s, a) => s + a.pointsGained, 0), 0,
  );

  return (
    <div className="space-y-3">
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <ProvenanceStrip of={artifact} />
      </div>

      <Band aside={`${weeks.length} settled`}>Gameweeks</Band>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: S.ink }}
        >
          <thead>
            <tr>
              <th style={{ ...HEAD, textAlign: "left" }}>GW</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Pts</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Avg</th>
              <th style={{ ...HEAD, textAlign: "right" }}>v field</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Bench</th>
              <th style={{ ...HEAD, textAlign: "left", paddingLeft: 22 }}>Captain</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Cap pts</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Auto-subs</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Rank</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Value</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Bank</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => {
              const margin = week.averageEntryScore === null
                ? null
                : week.points - week.averageEntryScore;
              const rescued = week.autoSubs.reduce((s, a) => s + a.pointsGained, 0);
              return (
                <tr
                  key={week.event}
                  data-testid={`detail-week-${week.event}`}
                  style={{ borderTop: `1px solid ${S.hair}` }}
                >
                  <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>{week.event}</td>
                  <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>{week.points}</td>
                  <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>
                    {week.averageEntryScore ?? NOT_YET}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>
                    {margin === null ? NOT_YET : signed(margin)}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>{week.benchPoints}</td>
                  <td style={{ ...CELL, textAlign: "left", paddingLeft: 22 }}>
                    {week.captain === null ? NOT_YET : nameOf(ledger, week.captain.element)}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>
                    {week.captain === null
                      ? NOT_YET
                      : week.captain.points * week.captain.multiplier}
                  </td>
                  <td style={{ ...CELL, textAlign: "right", color: rescued === 0 ? S.ink3 : S.ink }}>
                    {rescued === 0 ? NOT_YET : signed(rescued)}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>
                    {week.overallRank === null ? NOT_YET : week.overallRank.toLocaleString()}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>
                    {week.value === null ? NOT_YET : (week.value / 10).toFixed(1)}
                  </td>
                  <td style={{ ...CELL, textAlign: "right" }}>
                    {week.bank === null ? NOT_YET : (week.bank / 10).toFixed(1)}
                  </td>
                </tr>
              );
            })}
            <tr data-testid="detail-all" style={{ borderTop: `1px solid ${S.rule}` }}>
              <td style={{ ...CELL, textAlign: "left", fontWeight: 600 }}>All</td>
              <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>{points}</td>
              <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>{field}</td>
              <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>
                {totals.vsAverage === null ? NOT_YET : signed(totals.vsAverage)}
              </td>
              <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>
                {totals.benchPoints}
              </td>
              <td style={{ ...CELL, textAlign: "left", paddingLeft: 22, color: S.ink3 }}>
                {NOT_YET}
              </td>
              <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>
                {totals.captainPoints}
              </td>
              <td style={{ ...CELL, textAlign: "right", fontWeight: 600 }}>
                {subs === 0 ? NOT_YET : signed(subs)}
              </td>
              <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>{NOT_YET}</td>
              <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>{NOT_YET}</td>
              <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>{NOT_YET}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Band aside="effective points, with raw beside">Transfers</Band>
      {moves.length === 0 ? (
        <p style={{ fontSize: 11, color: S.ink3, marginTop: 8 }}>
          No transfers made yet, so there is nothing here to measure.
        </p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: S.ink }}
            >
              <thead>
                <tr>
                  <th style={{ ...HEAD, textAlign: "left" }}>GW</th>
                  <th style={{ ...HEAD, textAlign: "left" }}>In</th>
                  <th style={{ ...HEAD, textAlign: "left" }}>Out</th>
                  <th style={{ ...HEAD, textAlign: "right" }}>Hit</th>
                  {SPANS.map((span) => (
                    <th key={span} style={{ ...HEAD, textAlign: "right" }}>
                      {span === 1 ? "Same" : `+${span - 1}`}
                    </th>
                  ))}
                  <th style={{ ...HEAD, textAlign: "right" }}>Raw</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((move) => {
                  const windows = SPANS.map((span) => windowFor(move, span));
                  const same = windows[0];
                  const basket = basketFor(ledger, move.event);
                  return (
                    <tr
                      key={`${move.event}-${move.elementIn}`}
                      data-testid={`detail-transfer-${move.event}`}
                      style={{ borderTop: `1px solid ${S.hair}` }}
                    >
                      <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>{move.event}</td>
                      <td style={{ ...CELL, textAlign: "left" }}>
                        {nameOf(ledger, move.elementIn)}
                        {move.elementInCost === null ? "" : (
                          <span style={{ color: S.ink3 }}>
                            {" "}£{(move.elementInCost / 10).toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>
                        {nameOf(ledger, move.elementOut)}
                        {move.elementOutCost === null
                          ? ""
                          : ` £${(move.elementOutCost / 10).toFixed(1)}`}
                      </td>
                      <td style={{ ...CELL, textAlign: "right" }}>{basket.hit}</td>
                      {windows.map((window) => (
                        <td
                          key={window.span}
                          style={{
                            ...CELL,
                            textAlign: "right",
                            color: window.effective === null || window.polluted
                              ? S.ink3
                              : S.ink,
                          }}
                          title={window.polluted
                            ? "polluted — the player left the squad inside this window"
                            : undefined}
                        >
                          {window.effective === null ? NOT_YET : signed(window.effective)}
                          {window.polluted ? "*" : ""}
                        </td>
                      ))}
                      <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>
                        {same.raw === null ? NOT_YET : signed(same.raw)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p
            data-testid="detail-aggregate"
            style={{
              fontSize: 11, lineHeight: 1.55, color: S.ink3,
              marginTop: 10, maxWidth: "74ch",
            }}
          >
            {NOT_YET} is a window that has not finished, never a transfer that
            achieved nothing.
            {(() => {
              const rows = SPANS.map((span) => ({
                span, aggregate: transferAggregate(ledger, span),
              }));
              const label = (span: number) =>
                span === 1 ? "the same gameweek" : `${span} gameweeks`;
              const parts = rows
                .filter((r) => r.aggregate.withheldReason === null)
                .map((r) =>
                  ` Over ${label(r.span)}: `
                  + `${signed(r.aggregate.effective ?? 0)} across ${r.aggregate.n}.`);
              const withheld = rows.filter((r) => r.aggregate.withheldReason !== null);
              if (withheld.length > 0) {
                const counted = withheld
                  .map((r) => `${r.aggregate.n} over ${label(r.span)}`)
                  .join(", ");
                parts.push(` Clean windows so far — ${counted}.`);
              }
              return parts.join("");
            })()}
          </p>
        </>
      )}

      <div style={{ paddingTop: 18 }}>
        <DecisionReview />
      </div>
    </div>
  );
}
