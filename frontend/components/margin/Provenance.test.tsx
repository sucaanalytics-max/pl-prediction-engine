/**
 * Rule 2's strip, tested on the rules rather than the pixels.
 *
 * Three claims worth pinning:
 *   1. Hue carries judgement, so only the freshness slot may be coloured, and
 *      only past its budget. `○ model` is not worse than `◆ market`.
 *   2. `∅` means nothing was fitted. It is not a zero and not a blank.
 *   3. A third-party figure is marked on the figure, not in a paragraph beside
 *      it — the failure that produced this rule was a sentence claiming a source
 *      the numbers had silently stopped using.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProvenanceMarks, ProvenanceLegend, anchorFromRateSource, externalFigureStyle,
} from "@/components/margin/Provenance";
import { INK, PAPER } from "@/lib/margin/tokens";

afterEach(() => cleanup());

function slots() {
  const strip = screen.getByTestId("provenance-marks");
  return {
    anchor: strip.querySelector('[data-slot="anchor"]') as HTMLElement | null,
    freshness: strip.querySelector('[data-slot="freshness"]') as HTMLElement | null,
    seal: strip.querySelector('[data-slot="seal"]') as HTMLElement | null,
    text: strip.textContent ?? "",
  };
}

describe("the anchor says what kind of claim the figure is", () => {
  it("maps the producer's own market_blend to a market anchor", () => {
    expect(anchorFromRateSource("market_blend")).toBe("market");
  });

  it("maps every model-only source to model", () => {
    for (const s of [
      "dixon_coles_posterior", "dixon_coles_posterior+level",
      "dixon_coles_posterior+market_blend", "archive_team_strengths",
      "ensemble_unanchored", "flat_default",
    ]) {
      expect(anchorFromRateSource(s), s).toBe("model");
    }
  });

  it("refuses to vouch for a source it has never seen", () => {
    // Reporting `model` for an unknown fourth source would quietly claim we know
    // what produced it.
    expect(anchorFromRateSource("vibes")).toBe("none");
    expect(anchorFromRateSource(null)).toBe("none");
    expect(anchorFromRateSource(undefined)).toBe("none");
  });

  it("renders nothing-fitted as ∅ rather than a blank", () => {
    render(<ProvenanceMarks anchor="none" surface={PAPER} />);
    expect(slots().anchor?.textContent).toBe("∅");
    expect(slots().anchor?.getAttribute("title")).toMatch(/not a zero/i);
  });
});

describe("hue carries judgement, so the anchor never takes one", () => {
  it("colours a market anchor the same as a model anchor", () => {
    const { unmount } = render(<ProvenanceMarks anchor="market" surface={PAPER} />);
    const market = slots().anchor!.style.color;
    unmount();
    render(<ProvenanceMarks anchor="model" surface={PAPER} />);
    expect(slots().anchor!.style.color).toBe(market);
  });

  it("leaves fresh freshness uncoloured", () => {
    render(
      <ProvenanceMarks
        anchor="model" surface={PAPER}
        freshness={{ label: "6h", stale: false }}
      />,
    );
    expect(slots().freshness!.style.color).toBe(slots().anchor!.style.color);
  });

  it("gives the warning hue to freshness ONLY past its budget", () => {
    render(
      <ProvenanceMarks
        anchor="model" surface={PAPER}
        freshness={{ label: "31h", stale: true }}
        seal="sealed"
      />,
    );
    const s = slots();
    expect(s.freshness!.style.color).not.toBe(s.anchor!.style.color);
    // And no other slot borrows it.
    expect(s.seal!.style.color).toBe(s.anchor!.style.color);
    expect(s.text).toContain("stale-cache");
  });
});

describe("at most three glyphs, in a fixed order", () => {
  it("omits absent slots rather than rendering placeholders", () => {
    render(<ProvenanceMarks anchor="market" surface={PAPER} />);
    const s = slots();
    expect(s.anchor).not.toBeNull();
    expect(s.freshness).toBeNull();
    expect(s.seal).toBeNull();
  });

  it("orders anchor, then freshness, then seal", () => {
    render(
      <ProvenanceMarks
        anchor="market" surface={PAPER}
        freshness={{ label: "live", stale: false }} seal="recomputed"
      />,
    );
    const t = slots().text;
    expect(t.indexOf("market")).toBeLessThan(t.indexOf("live"));
    expect(t.indexOf("live")).toBeLessThan(t.indexOf("recomputed"));
  });

  it("distinguishes sealed from recomputed in words, not colour", () => {
    const { unmount } = render(
      <ProvenanceMarks anchor="model" surface={PAPER} seal="sealed" />,
    );
    expect(slots().seal!.getAttribute("title")).toMatch(/never rewritten/i);
    unmount();
    render(<ProvenanceMarks anchor="model" surface={PAPER} seal="recomputed" />);
    expect(slots().seal!.getAttribute("title")).toMatch(/may disagree/i);
  });
});

describe("a third-party figure is marked on the figure", () => {
  it("names the source in the anchor", () => {
    render(<ProvenanceMarks anchor="external" surface={PAPER} />);
    expect(slots().anchor!.textContent).toContain("external");
    expect(slots().anchor!.getAttribute("title")).toMatch(/outside our pipeline/i);
  });

  it("underlines the number itself, dotted, in ink4", () => {
    const style = externalFigureStyle(PAPER);
    expect(style.borderBottom).toContain("dotted");
    expect(style.borderBottom).toContain(PAPER.ink4);
  });
});

describe("the legend appears once, and works on both surfaces", () => {
  it("names every mark a row can carry", () => {
    render(<ProvenanceLegend surface={PAPER} />);
    const t = screen.getByTestId("provenance-legend").textContent ?? "";
    for (const mark of ["◆ market", "○ model", "∅", "▣ sealed", "↻ recomputed"]) {
      expect(t, mark).toContain(mark);
    }
  });

  it("takes its colours from whichever surface it is on", () => {
    const { unmount } = render(<ProvenanceLegend surface={PAPER} />);
    const paper = screen.getByTestId("provenance-legend").style.color;
    unmount();
    render(<ProvenanceLegend surface={INK} />);
    expect(screen.getByTestId("provenance-legend").style.color).not.toBe(paper);
  });
});
