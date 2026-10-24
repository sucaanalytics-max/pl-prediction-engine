"use client";

/**
 * The call, as a phone reads it: one card, one number with its range, two actions.
 *
 * A PRESENTATION of figures `CallBoard` has already computed. It derives nothing
 * of its own beyond layout geometry: the captain, the swap, the shape and the
 * total all arrive as props from the board, and the expected-points range arrives
 * as the decision artifact's own published quantiles. The desktop tiles
 * (`Tiles`) are untouched and stay the desktop arrangement of the same figures;
 * `globals.css` shows one and hides the other at 767px.
 *
 * ## What is deliberately not drawn
 *
 *  - **A vice-captain.** Nothing on this page recommends one: the armband is the
 *    optimiser's on the eleven on screen, and a vice from the decision artifact
 *    could belong to a different captain. `app/page.test.tsx` holds the page to it.
 *  - **A range the file did not publish.** Every mark comes from a quantile the
 *    decision carries. A missing q10 or q90 drops the bar; a missing q25 or q75
 *    drops the box (both or neither, as everywhere else); a missing P(60+) drops
 *    that figure. None is derived from the player projections, because a squad
 *    total's spread is not the sum of its players' (see `PublicDecision`).
 *  - **A transfer it was not given.** The row shows the `transfer` prop. The board
 *    passes null while the Transfer tile reads "None", so the two always say the
 *    same thing; whatever feeds the tile feeds this row.
 *
 * ## Absence on the actions
 *
 * "Set on FPL" is a link to another site, so it cannot work offline. It renders as
 * a disabled button that says why, rather than a link that opens a browser error.
 */

import Link from "next/link";
import { ChevronRight, ExternalLink } from "lucide-react";

import { useOnline } from "@/lib/use-online";
import { geometry } from "@/lib/margin/distribution";
import { formatUtc } from "@/lib/freshness";
import { SIGNAL } from "@/lib/margin/tokens";

const S = SIGNAL;

/** The note the Transfer tile prints while no transfer is suggested. */
export const NO_TRANSFER_NOTE =
  "No transfer is suggested: one published week cannot price a sale.";

export interface CardTransfer {
  readonly out: readonly string[];
  readonly in: readonly string[];
  readonly note: string;
}

export interface CardRange {
  readonly mean: number;
  readonly q10: number | null;
  readonly q25: number | null;
  readonly q75: number | null;
  readonly q90: number | null;
  /** P(total >= 60) as a fraction, when the file publishes that threshold. */
  readonly p60: number | null;
  readonly nDraws: number | null;
  readonly generatedAt: string | null;
  readonly sealed: boolean;
}

export interface CallCardProps {
  readonly gameweek: number;
  readonly captain: {
    readonly name: string;
    readonly team: string;
    readonly fixture: string | null;
    readonly xp: number | null;
  } | null;
  readonly transfer: CardTransfer | null;
  readonly bringIn: readonly string[];
  readonly sitDown: readonly string[];
  readonly lineupKnown: boolean;
  readonly shape: string;
  /** The decision artifact's simulated range, or null when it could not be read. */
  readonly range: CardRange | null;
  /** The eleven on screen, for when there is no range to lead with. */
  readonly total: number | null;
  readonly countingRule: string;
  readonly projectionDraws: number | null;
}

const LABEL = { fontSize: 12, color: S.ink3 } as const;
const ROW = {
  display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: 8,
  alignItems: "center", padding: "10px 16px",
} as const;

function Row({ label, last, children, testId }: {
  label: string; last?: boolean; children: React.ReactNode; testId?: string;
}) {
  return (
    <div data-testid={testId} style={{
      ...ROW, borderBottom: last ? 0 : `1px solid ${S.hair}`,
    }}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}

const SPLIT = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8,
} as const;
const COL = { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 } as const;
const RIGHT = { ...COL, alignItems: "flex-end" } as const;

const names = (list: readonly string[]) => list.join(", ");

function Lineup({ bringIn, sitDown, known, shape }: {
  bringIn: readonly string[]; sitDown: readonly string[]; known: boolean; shape: string;
}) {
  if (!known) {
    return (
      <div style={COL}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>No lineup on file</span>
        <span style={LABEL}>nothing to compare against · {shape}</span>
      </div>
    );
  }
  if (bringIn.length === 0 && sitDown.length === 0) {
    return (
      <div style={COL}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>No change</span>
        <span style={LABEL}>already the best eleven from this squad · {shape}</span>
      </div>
    );
  }
  return (
    <div style={COL}>
      <span style={{ fontSize: 15, fontWeight: 600 }}>
        {bringIn.length > 0 ? `Start ${names(bringIn)}` : `Bench ${names(sitDown)}`}
      </span>
      <span style={LABEL}>
        {bringIn.length > 0 && sitDown.length > 0 ? `Bench ${names(sitDown)} · ` : ""}{shape}
      </span>
    </div>
  );
}

function Range({ range }: { range: CardRange }) {
  const { q10, q25, q75, q90, mean } = range;
  const hasBar = q10 !== null && q90 !== null;
  // A scale that fits THIS file's own spread, in tens, so the marks do not crowd
  // one end. It only positions marks; it never moves a number.
  const lo = hasBar ? Math.max(0, Math.floor((q10 - 15) / 10) * 10) : 0;
  const hi = hasBar ? Math.ceil((q90 + 15) / 10) * 10 : 100;
  const g = geometry(
    { q10, q25: q25 !== null && q75 !== null ? q25 : null, q75: q25 !== null && q75 !== null ? q75 : null, q90, mean },
    lo, hi,
  );
  const r = Math.round;
  const say = [
    `1 in 10 below ${hasBar ? r(q10) : ""}`,
    q25 !== null && q75 !== null ? `middle half ${r(q25)} to ${r(q75)}` : null,
    `1 in 10 above ${hasBar ? r(q90) : ""}`,
    `mean ${mean.toFixed(1)}`,
  ].filter(Boolean).join(", ");

  if (!hasBar) return null;
  return (
    <>
      <div role="img" aria-label={`Simulated range: ${say}`} style={{ position: "relative", height: 22 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 10, height: 2, background: S.inset }} />
        {g.whisker ? (
          <div style={{
            position: "absolute", top: 8, height: 6, background: S.block,
            left: `${g.whisker.from}%`, width: `${g.whisker.to - g.whisker.from}%`,
          }} />
        ) : null}
        {g.box ? (
          <div style={{
            position: "absolute", top: 4, height: 14, background: "rgba(20,23,28,.5)",
            left: `${g.box.from}%`, width: `${g.box.to - g.box.from}%`,
          }} />
        ) : null}
        {g.mean ? (
          <div style={{
            position: "absolute", top: 0, width: 2, height: 22, background: S.ink,
            left: `calc(${g.mean.at}% - 1px)`,
          }} />
        ) : null}
      </div>
      <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: S.ink3 }}>
        <span>{r(q10)} · low 10%</span>
        {q25 !== null && q75 !== null ? <span>{r(q25)}–{r(q75)} · middle half</span> : null}
        <span>{r(q90)} · top 10%</span>
      </div>
    </>
  );
}

function Expected(props: CallCardProps) {
  const { range, total, countingRule, projectionDraws, gameweek } = props;
  const draws = range ? range.nDraws : projectionDraws;
  const run = range ? formatUtc(range.generatedAt) : null;
  const source = range
    ? [
      "Simulated",
      draws === null ? null : `${draws.toLocaleString("en-GB")} draws`,
      run === null ? null : `model run ${run} UTC`,
      range.sealed ? null : "provisional",
    ]
    : [
      "Projected",
      draws === null ? null : `${draws.toLocaleString("en-GB")} draws`,
      "no simulated range published for this week",
    ];

  const headline = range ? range.mean.toFixed(1) : total === null ? "—" : total.toFixed(2);
  return (
    <section
      aria-label="Expected points"
      data-testid="call-expected"
      style={{
        background: S.bar, border: `1px solid ${S.hair}`, padding: "14px 16px",
        display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{ ...SPLIT, alignItems: "flex-end" }}>
        <div style={COL}>
          <span style={LABEL}>
            {range
              ? `Expected for GW${gameweek}, the agent's plan`
              : `Expected for GW${gameweek}, best eleven (${countingRule})`}
          </span>
          <span style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>
            {headline} <span style={{ fontSize: 15, fontWeight: 500 }}>pts</span>
          </span>
        </div>
        {range && range.p60 !== null ? (
          <div style={RIGHT}>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{Math.round(range.p60 * 100)}%</span>
            <span style={LABEL}>chance of 60+</span>
          </div>
        ) : null}
      </div>
      {range ? <Range range={range} /> : null}
      <span style={{ fontSize: 11, fontStyle: "italic", color: S.ink3 }}>
        {source.filter(Boolean).join(" · ")}
      </span>
    </section>
  );
}

const BUTTON = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  minHeight: 48, fontSize: 15, fontWeight: 600, textDecoration: "none",
} as const;

export function CallCard(props: CallCardProps) {
  const online = useOnline();
  const { captain, transfer } = props;
  const captainXp = captain?.xp ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, color: S.ink }}>
      <section
        aria-label="This week's call"
        data-testid="call-card"
        style={{ background: S.bar, border: `1px solid ${S.hair}` }}
      >
        <h2 style={{
          margin: 0, padding: "12px 16px 4px", fontSize: 13, fontWeight: 600,
          letterSpacing: "0.08em", textTransform: "uppercase", color: S.ink2,
        }}>
          This week&rsquo;s call
        </h2>

        <Row label="Captain" testId="call-captain">
          {captain === null ? (
            <span style={{ fontSize: 20, fontWeight: 600 }}>None</span>
          ) : (
            <div style={SPLIT}>
              <div style={COL}>
                <span style={{ fontSize: 20, fontWeight: 600 }}>{captain.name}</span>
                <span style={LABEL}>
                  {captain.fixture === null ? captain.team : `${captain.team} v ${captain.fixture}`}
                </span>
              </div>
              {captainXp === null ? null : (
                <div style={RIGHT}>
                  <span style={{ fontSize: 20, fontWeight: 600 }}>{(captainXp * 2).toFixed(2)}</span>
                  <span style={{ fontSize: 11, color: S.ink3 }}>from {captainXp.toFixed(2)}, doubled</span>
                </div>
              )}
            </div>
          )}
        </Row>

        <Row label="Transfer" testId="call-transfer">
          {transfer === null ? (
            <div style={COL}>
              <span style={{ fontSize: 17, fontWeight: 600, color: S.ink2 }}>None</span>
              <span style={LABEL}>{NO_TRANSFER_NOTE}</span>
            </div>
          ) : transfer.out.length === 0 && transfer.in.length === 0 ? (
            // The agent's plan holds the squad: "None", with the plan's own note,
            // never an empty arrow.
            <div style={COL}>
              <span style={{ fontSize: 17, fontWeight: 600, color: S.ink2 }}>None</span>
              <span style={LABEL}>{transfer.note}</span>
            </div>
          ) : (
            <div style={COL}>
              <span style={{ fontSize: 17, fontWeight: 600 }}>
                {names(transfer.out)} <span style={{ color: S.ink3, fontWeight: 400 }}>→</span> {names(transfer.in)}
              </span>
              <span style={LABEL}>{transfer.note}</span>
            </div>
          )}
        </Row>

        <Row label="Lineup" last testId="call-lineup">
          <Lineup
            bringIn={props.bringIn} sitDown={props.sitDown}
            known={props.lineupKnown} shape={props.shape}
          />
        </Row>
      </section>

      <Expected {...props} />

      <a
        href="#the-eleven"
        style={{
          ...BUTTON, justifyContent: "space-between", padding: "0 16px",
          background: S.bar, border: `1px solid ${S.hair}`, color: S.ink,
        }}
      >
        <span>See your eleven</span>
        <ChevronRight size={18} aria-hidden="true" />
      </a>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {online ? (
          <a
            href="https://fantasy.premierleague.com/my-team"
            target="_blank"
            rel="noreferrer"
            style={{ ...BUTTON, background: S.brand, color: S.face }}
          >
            Set on FPL
            <ExternalLink size={15} aria-hidden="true" />
            <span className="sr-only">, opens FPL in a new tab</span>
          </a>
        ) : (
          <button
            type="button"
            disabled
            style={{
              ...BUTTON, flexDirection: "column", gap: 0, border: 0,
              background: S.inset, color: S.ink2, cursor: "not-allowed", lineHeight: 1.25,
            }}
          >
            <span>Set on FPL</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>needs a connection</span>
          </button>
        )}
        <Link
          href="/capture"
          style={{ ...BUTTON, border: `1px solid ${S.brand}66`, color: S.ink }}
        >
          Capture what I set
        </Link>
      </div>
    </div>
  );
}
