"use client";

/**
 * What your season has actually cost you.
 *
 * ## Why nothing here is coloured
 *
 * `DecisionReview` sits directly above this and spends the app's semantic
 * three on its verdicts — `conflict` for "could have known", `agree` for "right
 * call", `ink3` for "too close to call". On that page **colour is judgement**.
 *
 * This section judges nothing; it accounts. So it spends no semantic colour at
 * all, and the absence is the argument: a −3 is a fact, not a reproach. Given a
 * red minus and a green plus, a reader would take the ledger for a second
 * verdict and "was the call wrong or merely unlucky" — the question the page
 * above exists to hold open — would quietly close.
 *
 * ## How it separates itself instead
 *
 * Structurally, on tokens the app already owns:
 *
 *  * A full-bleed rule at `S.rule` (.20 ink) above the heading — the heaviest
 *    line on the page, against the .095 hairlines used inside panels. It says a
 *    different kind of claim starts here.
 *  * The four figures sit **directly on the ground**, divided by hairlines,
 *    where `DecisionReview` puts its aggregate inside a bordered `glass-panel`.
 *    Same tokens, opposite construction, so the eye reads a different object
 *    without a single new colour being introduced.
 *
 * ## Two sizes that carry findings
 *
 * Bench waste renders at 32px where the other three are 22px. Measured
 * 2026-09-09: the bench had cost 27 points across three gameweeks and the one
 * transfer had cost 3. Equal weight leads with the −3 and buries the 27, so the
 * type scale does the ranking.
 *
 * The em-dash is never a zero: an unfinished window must not read as "this
 * transfer achieved nothing". It is set in `ink3`, NOT the fainter `ink4` — a
 * first draft used ink4 and `legibility.test.ts` rejected it at 2.14:1, which
 * is a border tone. The right answer was not a legible-but-still-dimmer tone:
 * the glyph already distinguishes itself from a digit, so the character carries
 * the meaning and the colour stays readable.
 */
import { ProvenanceStrip, Section, StateCard } from "@/components/data/Artifact";
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

const FIGURES = "1.35fr 1fr 1fr 1fr";

function signed(value: number): string {
  // U+2212, the minus sign, not a hyphen: it aligns with the digits.
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

/** An id is not a name. Falls back to the id rather than inventing one. */
function nameOf(ledger: Ledger, element: number): string {
  return ledger.names.get(element) ?? String(element);
}

function Figure(
  { label, value, note, size = 22, testId }: {
    label: string; value: string; note?: string; size?: number; testId?: string;
  },
) {
  return (
    <div data-testid={testId}>
      <div style={LABEL}>{label}</div>
      <div
        style={{
          fontSize: size, fontWeight: 600, lineHeight: 1.05, marginTop: 6,
          color: S.ink, fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {note ? (
        <div style={{ fontSize: 11, color: S.ink3, marginTop: 5 }}>{note}</div>
      ) : null}
    </div>
  );
}

/** A label with a hairline running out to the right. */
function Band({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 30 }}>
      <div style={LABEL}>{children}</div>
      <div style={{ flex: 1, height: 1, background: S.hair }} />
    </div>
  );
}

const CELL = { padding: "7px 0", fontVariantNumeric: "tabular-nums" } as const;
const HEAD = {
  ...CELL,
  fontWeight: 400,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: S.ink3,
} as const;

export default function ManagerHistory() {
  const { artifact } = useArtifact(REGISTRY.managerHistory);
  const ledger = proven(artifact);

  if (!ledger) {
    return (
      <StateCard
        of={artifact}
        weight="line"
        what="your manager history — each gameweek, and what each transfer returned"
      />
    );
  }

  const totals = seasonTotals(ledger);
  const weeks = [...ledger.gameweeks].sort((a, b) => b.event - a.event);
  const moves = [...ledger.transfers].sort((a, b) => b.event - a.event);
  const perWeek = weeks.length > 0
    ? Math.round(totals.benchPoints / weeks.length)
    : 0;

  return (
    <Section
      title="What it cost"
      subtitle="What happened, not whether it was right — the judgement is above this line"
      aside={<ProvenanceStrip of={artifact} />}
    >
      {/* Figures on the ground, not in a panel. See the docstring. */}
      <div
        style={{
          display: "grid", gridTemplateColumns: FIGURES,
          borderTop: `1px solid ${S.hair}`, borderBottom: `1px solid ${S.hair}`,
        }}
      >
        <div style={{ padding: "16px 22px 16px 0" }}>
          <Figure
            testId="bench-waste"
            label="Left on the bench"
            value={String(totals.benchPoints)}
            size={32}
            note={`${perWeek} a week — the largest number here`}
          />
        </div>
        <div style={{ padding: "16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="vs-average"
            label="Against the field"
            value={totals.vsAverage === null ? NOT_YET : signed(totals.vsAverage)}
          />
        </div>
        <div style={{ padding: "16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="captaincy-cost"
            label="Armband"
            value={String(totals.captainPoints)}
            note={`of a possible ${totals.bestCaptainPoints}`}
          />
        </div>
        <div style={{ padding: "16px 0 16px 22px", borderLeft: `1px solid ${S.hair}` }}>
          <Figure
            testId="hit-spend"
            label="Spent on hits"
            value={String(totals.hitSpend)}
            note={`auto-subs recovered ${totals.autoSubRescue}`}
          />
        </div>
      </div>

      <Band>Gameweeks</Band>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: S.ink }}
        >
          <thead>
            <tr>
              <th style={{ ...HEAD, textAlign: "left", width: 44 }}>GW</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Points</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Average</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Bench</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Overall rank</th>
              <th style={{ ...HEAD, textAlign: "right" }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr
                key={week.event}
                data-testid={`manager-week-${week.event}`}
                style={{ borderTop: `1px solid ${S.hair}` }}
              >
                <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>
                  {week.event}
                </td>
                <td style={{ ...CELL, textAlign: "right" }}>{week.points}</td>
                <td style={{ ...CELL, textAlign: "right", color: S.ink3 }}>
                  {week.averageEntryScore ?? NOT_YET}
                </td>
                <td style={{ ...CELL, textAlign: "right" }}>{week.benchPoints}</td>
                <td style={{ ...CELL, textAlign: "right" }}>
                  {week.overallRank === null
                    ? NOT_YET
                    : week.overallRank.toLocaleString()}
                </td>
                <td style={{ ...CELL, textAlign: "right" }}>
                  {week.value === null ? NOT_YET : (week.value / 10).toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Band>Transfers</Band>
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
                  <th style={{ ...HEAD, textAlign: "left", width: 44 }}>GW</th>
                  <th style={{ ...HEAD, textAlign: "left" }}>In</th>
                  <th style={{ ...HEAD, textAlign: "left" }}>Out</th>
                  {SPANS.map((span) => (
                    <th key={span} style={{ ...HEAD, textAlign: "right", width: 62 }}>
                      {span === 1 ? "Same" : `+${span - 1}`}
                    </th>
                  ))}
                  <th style={{ ...HEAD, textAlign: "right", width: 62 }}>Raw</th>
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
                      style={{ borderTop: `1px solid ${S.hair}` }}
                    >
                      <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>
                        {move.event}
                      </td>
                      <td style={{ ...CELL, textAlign: "left" }}>
                        {nameOf(ledger, move.elementIn)}
                      </td>
                      <td style={{ ...CELL, textAlign: "left", color: S.ink3 }}>
                        {nameOf(ledger, move.elementOut)}
                      </td>
                      {windows.map((window) => (
                        <td
                          key={window.span}
                          style={{
                            ...CELL,
                            textAlign: "right",
                            // Unsettled is the quietest ink; polluted is merely
                            // de-emphasised. Neither is recoloured — a caveat
                            // about the counterfactual is not a bad outcome.
                            color: window.effective === null || window.polluted
                              ? S.ink3
                              : S.ink,
                          }}
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
            style={{
              fontSize: 11, lineHeight: 1.55, color: S.ink3,
              marginTop: 12, maxWidth: "62ch",
            }}
          >
            <span>{NOT_YET}</span>
            {" "}marks a window that has not finished, not a transfer that
            achieved nothing.
            {(() => {
              const basket = basketFor(ledger, moves[0].event);
              return basket.transfers > 1
                ? ` GW${basket.event} as a basket: `
                  + `${basket.effective === null ? NOT_YET : signed(basket.effective)}`
                  + ` across ${basket.transfers} transfers against a `
                  + `${basket.hit}-point hit — pairing each buy with a particular `
                  + "sale is arbitrary once there is more than one."
                : ` GW${basket.event} cost ${basket.hit} points of hit.`;
            })()}
          </p>

          <p
            data-testid="transfer-aggregate"
            style={{
              fontSize: 11, lineHeight: 1.55, color: S.ink3,
              marginTop: 6, maxWidth: "62ch",
            }}
          >
            {SPANS.map((span) => {
              const aggregate = transferAggregate(ledger, span);
              const label = span === 1 ? "Same gameweek" : `Over ${span} gameweeks`;
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
