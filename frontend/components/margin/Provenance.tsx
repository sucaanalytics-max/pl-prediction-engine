/**
 * Provenance is UI, not a footnote.
 *
 * Every figure carries where it came from and how stale it is, in ONE mono strip
 * of at most three glyphs: anchor, freshness, seal. The legend appears once per
 * screen; rows carry marks only. No badge farm, no coloured pills, and no figure
 * without a strip.
 *
 * Why three slots and not one label: they answer different questions and a reader
 * needs them separately.
 *
 *   anchor     is this tied to something traded, or is it our model alone?
 *   freshness  when was it computed, and is that past its budget?
 *   seal       was it recorded before the deadline, and can it still be rewritten?
 *
 * Only the freshness slot may take the warning hue, and only past budget. Hue
 * carries judgement here, so an anchor is never coloured: `○ model` is not worse
 * than `◆ market`, it is a different kind of claim.
 *
 * The fourth anchor, `◆ external`, is load-bearing rather than decorative. This
 * app once stated on every render that its projections came from a premium
 * third-party snapshot that was absent from the deployment, while the numbers
 * beside that sentence had silently fallen back to a fixture heuristic. A figure
 * from outside our pipeline gets the mark AND a dotted underline on the figure
 * itself, so the claim travels with the number rather than with the paragraph.
 */
import type { MarginSurface } from "@/lib/margin/tokens";
import { MONO } from "@/lib/margin/tokens";

/** Where a figure's authority comes from. */
export type Anchor = "market" | "model" | "external" | "none";

/** Whether the record predates its deadline, and whether it may still move. */
export type Seal = "sealed" | "recomputed" | null;

export interface Freshness {
  /** The age line, e.g. `live`, `6h`, `31h`. */
  readonly label: string;
  /** Past its freshness budget. The ONLY thing that may take the warning hue. */
  readonly stale: boolean;
}

const ANCHOR_MARK: Record<Anchor, string> = {
  market: "◆ market",
  external: "◆ external",
  model: "○ model",
  // Not a blank and not a zero: nothing was fitted, which is a fact about the
  // model rather than about the clock.
  none: "∅",
};

const ANCHOR_TITLE: Record<Anchor, string> = {
  market: "tied to a traded price or published odds",
  external: "from a third party, outside our pipeline",
  model: "model only — no market exists for this quantity",
  none: "nothing was fitted here — this is not a zero",
};

const SEAL_MARK: Record<Exclude<Seal, null>, string> = {
  sealed: "▣ sealed",
  recomputed: "↻ recomputed",
};

const SEAL_TITLE: Record<Exclude<Seal, null>, string> = {
  sealed: "recorded before the deadline and never rewritten",
  recomputed: "rebuilt after the deadline; may disagree with the sealed copy",
};

/**
 * Map the pipeline's own `rate_source` onto an anchor.
 *
 * `market_blend` means bookmaker odds were blended into the goal rates that
 * produced this figure. Everything else the producer emits is model-only. An
 * unrecognised string reports `none` rather than guessing `model`: a fourth
 * source we have not seen is not something to quietly vouch for.
 */
export function anchorFromRateSource(source: string | null | undefined): Anchor {
  if (!source) return "none";
  if (source === "market_blend") return "market";
  if (source.startsWith("dixon_coles") || source === "archive_team_strengths") {
    return "model";
  }
  if (source === "ensemble_unanchored" || source === "flat_default") return "model";
  return "none";
}

/** The strip. At most three glyphs, 9.5px, mono, in fixed order. */
export function ProvenanceMarks({
  anchor, freshness, seal, surface,
}: {
  anchor: Anchor;
  freshness?: Freshness | null;
  seal?: Seal;
  surface: MarginSurface;
}) {
  const slots: Array<{ key: string; text: string; title: string; warn: boolean }> = [
    {
      key: "anchor",
      text: ANCHOR_MARK[anchor],
      title: ANCHOR_TITLE[anchor],
      warn: false,
    },
  ];
  if (freshness) {
    slots.push({
      key: "freshness",
      text: freshness.stale ? `${freshness.label} stale-cache` : freshness.label,
      title: freshness.stale
        ? `past its freshness budget — ${freshness.label} old`
        : `computed ${freshness.label}`,
      warn: freshness.stale,
    });
  }
  if (seal) {
    slots.push({
      key: "seal", text: SEAL_MARK[seal], title: SEAL_TITLE[seal], warn: false,
    });
  }

  return (
    <span
      data-testid="provenance-marks"
      style={{
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: ".08em",
        color: surface.ink3,
        whiteSpace: "nowrap",
      }}
    >
      {slots.map((slot, i) => (
        <span key={slot.key}>
          {i > 0 ? <span style={{ color: surface.ink4 }}>{"  ·  "}</span> : null}
          <span
            data-slot={slot.key}
            title={slot.title}
            style={{ color: slot.warn ? surface.noise : surface.ink3 }}
          >
            {slot.text}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The underline that travels with a third-party figure.
 *
 * Spread onto the element carrying the number, not onto its container: the point
 * is that the number itself is marked, so it cannot be read apart from its
 * source. 1.5px dotted, in ink4 — one of that token's only two sanctioned uses.
 */
export function externalFigureStyle(surface: MarginSurface): React.CSSProperties {
  return {
    borderBottom: `1.5px dotted ${surface.ink4}`,
    paddingBottom: 1,
  };
}

/** The legend. Once per screen, never per row. */
export function ProvenanceLegend({ surface }: { surface: MarginSurface }) {
  return (
    <span
      data-testid="provenance-legend"
      style={{
        fontFamily: MONO, fontSize: 9.5, letterSpacing: ".08em",
        color: surface.ink3, whiteSpace: "nowrap",
      }}
    >
      {"◆ market  ·  ○ model  ·  ∅ not fitted  ·  "}
      {"▣ sealed  ·  ↻ recomputed"}
    </span>
  );
}
