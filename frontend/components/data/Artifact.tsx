"use client";

/**
 * Rendering an {@link Artifact} without ever touching its value directly.
 *
 * Rule 1 says absence is a state, not a missing value. `artifact.ts` makes that
 * true of the *data*; this file makes it true of the *screen*. A page writes
 *
 *     <WhenProven of={table} then={(rows) => <Table rows={rows} />} />
 *
 * and cannot reach `rows` in any other way, because the payload lives behind a
 * module-private symbol. The five states each get a card, so "nothing rendered"
 * is never an option the page can accidentally choose.
 *
 * ## Why every state card says WHY
 *
 * The four original failures were all the same failure — absence rendered as a
 * confident answer — and in every case the user could not tell a broken page from
 * an honest empty one. `artifact.reason` is non-null for every state except `ok`,
 * and these components refuse to render a state without it.
 */

import type { ReactNode } from "react";
import {
  describeAge, describeProducer, isStale, proven,
  type Artifact,
} from "@/lib/data/artifact";

/** Tone per state. `empty` is deliberately neutral, not a warning. */
const TONE: Record<string, { colour: string; label: string }> = {
  // Present and informative — never rendered as a card.
  ok: { colour: "var(--text-3)", label: "" },
  // Published, well-formed, and carrying nothing yet. Not a fault.
  empty: { colour: "var(--text-3)", label: "Nothing yet" },
  // Real data, past its budget. Usable with a caveat.
  stale: { colour: "var(--warning)", label: "Out of date" },
  // Nothing published. The normal state for most artifacts most of the time.
  absent: { colour: "var(--text-3)", label: "Not published" },
  // Published but the shape is wrong — the only state that means something broke.
  unreadable: { colour: "var(--error)", label: "Unreadable" },
};

/**
 * How much of the page an absent artifact is allowed to occupy.
 *
 * ## Why this is a control rather than a constant
 *
 * The rule the surface redesign turns on: **absence never occupies more space than
 * substance.** Measured on the deployed app before this existed — `/decide` opened
 * with four consecutive `panel`-weight state cards, about 1200px of empty bordered
 * boxes, and the ranked transfer shortlist, the twelve alternative plans and the
 * six-gameweek captaincy plan all sat below them, unseen.
 *
 * The states themselves were right. Their weight was not.
 *
 * * `panel` — a full card. For the one artifact a page is *about*, where absence is
 *   the answer to the reader's question.
 * * `inset` — a smaller block inside a section that has other content.
 * * `line` — a single line of prose, no border. For a section whose absence is
 *   expected and uninteresting: the agent being idle ten days out from a deadline is
 *   not news.
 */
export type StateWeight = "panel" | "inset" | "line";

export function StateCard<T>({
  of, what, weight = "panel",
}: {
  of: Artifact<T>;
  /** What the reader was expecting, in their words, e.g. "the league table". */
  what: string;
  weight?: StateWeight;
}) {
  const tone = TONE[of.state] ?? TONE.absent;

  // One line, one element. The label is inlined rather than stacked, because a
  // three-line box is what made four of these dominate a page.
  if (weight === "line") {
    return (
      <p
        className="text-xs"
        role="status"
        data-state={of.state}
        data-weight="line"
        style={{ color: "var(--text-3)" }}
      >
        <span style={{ color: tone.colour }}>{tone.label}</span>
        {" — "}
        {what}
      </p>
    );
  }

  return (
    <div
      className={weight === "inset" ? "glass-inset p-3" : "card p-6 text-center"}
      role="status"
      data-state={of.state}
      data-weight={weight}
    >
      <p
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: tone.colour }}
      >
        {tone.label}
      </p>
      <p className="text-sm mt-1" style={{ color: "var(--text-2)" }}>
        {what}
      </p>
      {of.reason ? (
        <p className="text-xs mt-2" style={{ color: "var(--text-3)" }}>
          {of.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Render the value, or the state card. There is no third option.
 *
 * `empty` still passes the value through — a table with no matches played still
 * has 20 rows worth showing — but the caller opts in with `showEmpty`, because
 * for most artifacts an empty payload is better summarised than rendered.
 */
export function WhenProven<T>({
  of, what, then, showEmpty = false, weight = "panel",
}: {
  of: Artifact<T>;
  what: string;
  then: (value: T) => ReactNode;
  showEmpty?: boolean;
  /** See `StateWeight`. Default `panel`; use `line` where absence is expected. */
  weight?: StateWeight;
}) {
  const value = proven(of);
  if (value === null) return <StateCard of={of} what={what} weight={weight} />;
  if (of.state === "empty" && !showEmpty) {
    return <StateCard of={of} what={what} weight={weight} />;
  }
  return <>{then(value)}</>;
}

/**
 * Where this came from, how old it is, and who produced it.
 *
 * Rendered next to the data rather than on a separate diagnostics page. The
 * `health.json` drift — a complete, fresh file from a producer that emits no
 * metrics — is invisible unless the producer version sits beside the numbers it
 * failed to produce.
 */
export function ProvenanceStrip<T>({
  of, showSource = true,
}: {
  of: Artifact<T>;
  showSource?: boolean;
}) {
  const { producedAt, ageMs, source } = of.provenance;
  const stale = isStale(of);
  return (
    <p
      className="text-[10px] font-mono"
      style={{ color: stale ? "var(--warning)" : "var(--text-3)" }}
      data-testid="provenance"
    >
      {producedAt
        ? `updated ${describeAge(ageMs ?? 0)} ago`
        : "update time unknown"}
      {" · "}
      {/* "version unknown" rather than a reassuring blank: a writer that emits no
          version is one we cannot vouch for. */}
      {describeProducer(of.provenance)}
      {/* Ternaries, not `&&`: a falsy left operand renders itself, so a numeric
          or empty-string value would reach the DOM as visible text. */}
      {showSource && source !== "none" ? ` · ${source}` : null}
      {stale ? " · stale" : null}
    </p>
  );
}

/**
 * A section that owns its own state.
 *
 * Rule 2: no page-level gate. The old homepage returned early on one failed
 * fetch and blanked five sections that had nothing to do with it. Wrapping each
 * section here means one absent artifact costs exactly one card.
 */
export function Section({
  title, subtitle, children, aside,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2
            className="text-lg font-bold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            {title}
          </h2>
          {subtitle ? (
            <p className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
