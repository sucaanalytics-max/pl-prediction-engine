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
import {
  geometry, SCALE_HI, SCALE_LO, type DistributionInput,
} from "@/lib/margin/distribution";
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
 * q10–q90 with the median, the mean and the mode on it, and the interquartile
 * box when the producer publishes both of its ends.
 *
 * The box is drawn only from real q25/q75. The design derives them as
 * `q25 = q50 − sd × 0.5`, which is a shape invented from a spread and drawn at
 * the same weight as the marks that were measured — so a file carrying one end
 * and not the other gets no box rather than half of one.
 */
export function Distribution(
  {
    of, surface, width = 88, height = 14,
    lo = SCALE_LO, hi = SCALE_HI, emphasis = "neutral",
  }: {
    of: DistributionInput;
    surface: MarginSurface;
    width?: number;
    height?: number;
    /** Scale floor. `SQUAD_SCALE_LO` for a squad total. */
    lo?: number;
    /** Scale ceiling. */
    hi?: number;
    /**
     * Which mark carries the weight.
     *
     * The two automated teams read one identical projection and reach opposite
     * conclusions: the season objective ranks on the median and prices spread
     * as a cost, the weekly objective ranks on the right tail and prices spread
     * as the instrument. So `median` thickens the median rule; `tail` adds the
     * q75–q90 span as a filled bar and drops the median to `ink3`.
     *
     * `neutral` is the default and is the shipped glyph, mark for mark. Every
     * departure from it is opt-in, including the tail — an emphasis that painted
     * itself on by default would put the weekly reading on the season surfaces,
     * which is the one thing this prop exists to prevent.
     *
     * Same marks, same scale — which is why a diff of the two never needs a
     * second chart type.
     */
    emphasis?: "neutral" | "median" | "tail";
  },
) {
  const g = geometry(of, lo, hi);
  if (g.blank) return <Nil surface={surface} size={11} />;

  const mid = (height - 2) / 2;
  const pct = (v: number) => `${v}%`;

  // One arrowhead per clamped edge rather than per clamped mark: two marks
  // pinned to the same edge are one fact about the scale, not two.
  const marks = [g.median, g.mean, g.mode];
  const clampLow = marks.some((m) => m?.clamped && m.at === 0);
  const clampHigh = marks.some((m) => m?.clamped && m.at === 100);

  return (
    <div
      style={{ position: "relative", width, height }}
      role="img"
      aria-label={describeGlyph(of, emphasis)}
    >
      {/* The box first, so the whisker rule stays visible across it. */}
      {g.box ? (
        <div
          title="interquartile range, q25 to q75"
          style={{
            position: "absolute",
            left: pct(g.box.from),
            width: pct(g.box.to - g.box.from),
            top: mid - 3,
            height: 7,
            background: surface.block,
          }}
        />
      ) : null}
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
      {/* The right tail — drawn ONLY under tail emphasis.
          Drawn unconditionally it was a 3px bar laid over the 1px whisker on
          every glyph in the app, and because q10–q25 stays a hairline that made
          every projection on every surface read right-heavy: the weekly
          objective's conclusion imposed on the season ones. That asymmetry is
          precisely the reading `emphasis` exists to keep opt-in, so at neutral
          and at median emphasis this mark does not exist and the glyph is the
          shipped set of marks, unchanged. */}
      {emphasis === "tail" && g.tail ? (
        <div
          title="right tail, q75 to q90"
          style={{
            position: "absolute",
            left: pct(g.tail.from),
            width: pct(g.tail.to - g.tail.from),
            top: mid - 4,
            height: 9,
            background: surface.ink,
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
          title="median"
          style={{
            position: "absolute",
            left: pct(g.median.at),
            top: emphasis === "median" ? mid - 6 : mid - 5,
            width: emphasis === "median" ? 2.5 : 1.5,
            height: emphasis === "median" ? 13 : 11,
            // Demoted, not hidden: under tail emphasis the median is still the
            // reader's anchor for where the tail is measured from.
            background: emphasis === "tail" ? surface.ink3 : surface.ink,
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
      {clampLow ? (
        <div
          title={`below the scale floor of ${lo} — pinned, not measured here`}
          style={{
            position: "absolute", left: 0, top: mid - 3,
            width: 0, height: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderRight: `4px solid ${surface.ink3}`,
          }}
        />
      ) : null}
      {clampHigh ? (
        <div
          title={`above the scale ceiling of ${hi} — pinned, not measured here`}
          style={{
            position: "absolute", right: 0, top: mid - 3,
            width: 0, height: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderLeft: `4px solid ${surface.ink3}`,
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The glyph in words, for a screen reader and for the title attribute.
 *
 * `emphasis` is part of the description, not decoration on top of it. Under `tail`
 * the glyph gains a filled q75–q90 bar and demotes the median; under `median` it
 * thickens the median rule. Those are the two bots' opposite readings of one
 * identical projection, so a label that omitted them would describe the same
 * picture for both — the reader using the label would be told the two agree.
 */
export function describeGlyph(
  of: DistributionInput,
  emphasis: "neutral" | "median" | "tail" = "neutral",
): string {
  const bits: string[] = [];
  const has = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined;

  if (has(of.q10) && has(of.q90)) bits.push(`q10 ${of.q10} to q90 ${of.q90}`);
  if (has(of.q25) && has(of.q75)) bits.push(`middle half ${of.q25} to ${of.q75}`);
  if (has(of.q50)) bits.push(`median ${of.q50}`);
  if (has(of.mean)) bits.push(`mean ${of.mean.toFixed(1)}`);
  if (has(of.mode)) bits.push(`most likely ${of.mode}`);
  if (bits.length === 0) return "no distribution published";

  // Only claimed when the mark it describes was actually drawn: the tail span needs
  // both q75 and q90, exactly as the glyph does.
  if (emphasis === "tail" && has(of.q75) && has(of.q90)) {
    bits.push(`upside q75 ${of.q75} to q90 ${of.q90} emphasised`);
  } else if (emphasis === "median" && has(of.q50)) {
    bits.push("median emphasised");
  }
  return bits.join(", ");
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
