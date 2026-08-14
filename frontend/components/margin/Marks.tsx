"use client";

/**
 * Margin's vocabulary of marks.
 *
 * ## Why absence gets a typographic treatment rather than a card
 *
 * `components/data/Artifact.tsx` renders the five artifact states as cards, and
 * the rule it enforces — absence never occupies more space than substance — was
 * measured against a page that opened with 1200px of empty bordered boxes. That
 * rule holds here. The implementation cannot: a bordered card in the middle of a
 * dense ink-on-black decision screen is a hole, and four of them would be the
 * same failure in a different palette.
 *
 * So Margin says the same five things in its own marks, and the substitution is
 * exact rather than approximate — {@link MarginState} still refuses to render a
 * state without `artifact.reason`, which is the property that made the cards
 * worth having.
 *
 * | mark | means | never confused with |
 * |---|---|---|
 * | `∅` {@link Nil} | no rate was fitted here | a zero |
 * | hatch {@link Hatch} | outside the plan, or no run | a low number |
 * | hollow {@link Hollow} | published, flagged uncalibrated | a number to act on |
 * | dimmed | real, but past its freshness budget | current |
 * | rule + reason {@link MarginState} | nothing published | a broken page |
 *
 * The distinction the whole set exists to preserve is `∅` against `0`. A
 * defender with no scheduled fixture has no fitted clean-sheet rate; printing
 * `0.0` there says the model looked and found nothing, which is a different and
 * much more actionable claim than the true one.
 */

import type { CSSProperties, ReactNode } from "react";
import { describeAge, isStale, proven, type Artifact } from "@/lib/data/artifact";
import { geometry, type DistributionInput } from "@/lib/margin/distribution";
import { hatch, MONO, type MarginSurface } from "@/lib/margin/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────────────────────

/** The mono label that sits above every panel. */
export function Eyebrow(
  { surface, tone, children, style }: {
    surface: MarginSurface;
    /** Overrides the default tertiary ink — used to colour a panel by its state. */
    tone?: string;
    children: ReactNode;
    style?: CSSProperties;
  },
) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: ".14em",
        textTransform: "uppercase",
        color: tone ?? surface.ink3,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A number the model published and then flagged as uncalibrated.
 *
 * Drawn as an outline so it is legible, occupies its real width, and cannot be
 * read as solid. Greying it would have said "old"; hiding it would have said
 * "the model has no view", and it has one — it just does not stand behind it.
 */
export function Hollow(
  { surface, children, size = 14 }: {
    surface: MarginSurface; children: ReactNode; size?: number;
  },
) {
  return (
    <span
      title="the model published this and flagged it uncalibrated"
      style={{
        fontFamily: MONO,
        fontSize: size,
        fontWeight: 600,
        color: "transparent",
        WebkitTextStroke: `1px ${surface.ink}`,
      }}
    >
      {children}
    </span>
  );
}

/** No rate was fitted. Not a zero, and the title attribute says so. */
export function Nil({ surface, size = 13 }: { surface: MarginSurface; size?: number }) {
  return (
    <span
      title="no rate was fitted here — this is not a zero"
      style={{ fontFamily: MONO, fontSize: size, color: surface.ink3 }}
    >
      &#8709;
    </span>
  );
}

/** Outside the plan, or produced by a run that did not happen. */
export function Hatch(
  { surface, width = "100%", height = 13 }: {
    surface: MarginSurface; width?: number | string; height?: number;
  },
) {
  return (
    <span
      aria-hidden
      style={{
        display: "block", width, height, background: hatch(surface),
        border: `1px solid ${surface.hair}`,
      }}
    />
  );
}

/**
 * How old the thing beside it is.
 *
 * Attached to the number rather than to a diagnostics strip at the bottom of the
 * page. Age is only decision-relevant next to the value it qualifies: "the last
 * call was 59.6" and "the last call was 59.6, four days ago" are different
 * sentences, and only the second one is honest about a solve that predates two
 * team-news windows.
 */
export function Age<T>({ of, surface }: { of: Artifact<T>; surface: MarginSurface }) {
  const { ageMs } = of.provenance;
  if (ageMs === null) return null;
  const stale = isStale(of);
  return (
    <span
      title={`produced ${describeAge(ageMs)} ago`}
      style={{
        fontFamily: MONO,
        fontSize: 9,
        color: stale ? surface.noise : surface.ink3,
        border: `1px solid ${stale ? surface.noise : surface.hair}`,
        padding: "0 3px",
        whiteSpace: "nowrap",
      }}
    >
      {compactAge(ageMs)}
    </span>
  );
}

/** `4d`, `7h`, `12m` — the chip form of `describeAge`. */
export function compactAge(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The distribution glyph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * q10–q90 with the median, the mean and the mode on it.
 *
 * See `lib/margin/distribution.ts` for why there is no interquartile box: the
 * producer does not publish q25 or q75, and the design's habit of deriving them
 * from the standard deviation would draw an invented shape at the same weight as
 * the measured one.
 */
export function Distribution(
  { of, surface, width = 88, height = 14 }: {
    of: DistributionInput;
    surface: MarginSurface;
    width?: number;
    height?: number;
  },
) {
  const g = geometry(of);
  if (g.blank) return <Nil surface={surface} size={11} />;

  const mid = (height - 2) / 2;
  const pct = (v: number) => `${v}%`;

  return (
    <div
      style={{ position: "relative", width, height }}
      role="img"
      aria-label={describeGlyph(of)}
    >
      {g.whisker ? (
        <div
          style={{
            position: "absolute",
            left: pct(g.whisker.from),
            width: pct(g.whisker.to - g.whisker.from),
            top: mid,
            height: 1,
            background: surface.block,
          }}
        />
      ) : null}
      {/* The mode: a notch below the axis, so it never reads as the centre. */}
      {g.mode ? (
        <div
          style={{
            position: "absolute", left: pct(g.mode.at), top: mid + 2,
            width: 1.5, height: 5, background: surface.ink3,
          }}
        />
      ) : null}
      {g.median ? (
        <div
          style={{
            position: "absolute", left: pct(g.median.at), top: mid - 5,
            width: 1.5, height: 11, background: surface.ink,
          }}
        />
      ) : null}
      {/* The mean, hollow, so it is visibly the derived mark of the three. */}
      {g.mean ? (
        <div
          style={{
            position: "absolute",
            left: `calc(${pct(g.mean.at)} - 2.5px)`,
            top: mid - 2,
            width: 5, height: 5,
            border: `1px solid ${surface.ink}`,
            background: surface.face,
            transform: "rotate(45deg)",
          }}
        />
      ) : null}
    </div>
  );
}

/** The glyph in words, for a screen reader and for the title attribute. */
export function describeGlyph(of: DistributionInput): string {
  const bits: string[] = [];
  if (of.q10 !== null && of.q10 !== undefined && of.q90 !== null && of.q90 !== undefined) {
    bits.push(`q10 ${of.q10} to q90 ${of.q90}`);
  }
  if (of.q50 !== null && of.q50 !== undefined) bits.push(`median ${of.q50}`);
  if (of.mean !== null && of.mean !== undefined) bits.push(`mean ${of.mean.toFixed(1)}`);
  if (of.mode !== null && of.mode !== undefined) bits.push(`most likely ${of.mode}`);
  return bits.length ? bits.join(", ") : "no distribution published";
}

// ─────────────────────────────────────────────────────────────────────────────
// Absence
// ─────────────────────────────────────────────────────────────────────────────

/** What each state is called on this surface. Neutral for `empty`, as elsewhere. */
const LABEL: Record<string, string> = {
  empty: "Nothing yet",
  stale: "Out of date",
  absent: "Not published",
  unreadable: "Unreadable",
  ok: "",
};

/**
 * An artifact's state, in Margin's marks.
 *
 * Two lines and a rule: what the reader wanted, and `artifact.reason`. The
 * reason is not optional — every one of the four original failures this data
 * layer was built for looked identical to a broken page, and the sentence is the
 * only thing that separates "the agent is idle by design" from "the agent is
 * broken".
 */
export function MarginState<T>(
  { of, what, surface, compact = false }: {
    of: Artifact<T>;
    /** What the reader was expecting, in their words. */
    what: string;
    surface: MarginSurface;
    /** One line, no rule. For a panel that already has other content. */
    compact?: boolean;
  },
) {
  const label = LABEL[of.state] ?? LABEL.absent;
  const tone = of.state === "unreadable" ? surface.conflict : surface.ink3;

  if (compact) {
    return (
      <p
        role="status"
        data-state={of.state}
        style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: surface.ink3 }}
      >
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: tone }}>
          {label}
        </span>
        {" — "}
        {what} {of.reason}
      </p>
    );
  }

  return (
    <div
      role="status"
      data-state={of.state}
      style={{ borderTop: `1px solid ${surface.hair}`, paddingTop: 11 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
        <Hatch surface={surface} width={54} height={11} />
        <Eyebrow surface={surface} tone={tone}>{label}</Eyebrow>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: surface.ink2, maxWidth: 640 }}>
        {what}
      </p>
      {of.reason ? (
        <p style={{ margin: "5px 0 0", fontSize: 11.5, lineHeight: 1.5, color: surface.ink3, maxWidth: 640 }}>
          {of.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Render the value, or the state. There is no third option.
 *
 * The Margin-surfaced twin of `WhenProven`, and it keeps that component's one
 * load-bearing property: the payload lives behind a module-private symbol, so a
 * caller cannot reach it without going through `proven` and therefore cannot
 * forget to handle the four states that carry no value.
 */
export function WhenProvenHere<T>(
  { of, what, surface, then, compact = false, showEmpty = false }: {
    of: Artifact<T>;
    what: string;
    surface: MarginSurface;
    then: (value: T) => ReactNode;
    compact?: boolean;
    showEmpty?: boolean;
  },
) {
  const value = proven(of);
  if (value === null || (of.state === "empty" && !showEmpty)) {
    return <MarginState of={of} what={what} surface={surface} compact={compact} />;
  }
  return <>{then(value)}</>;
}
