/**
 * The conflict list, rendered rather than inspected.
 *
 * This is the third component this session to be tested by mounting it, after two
 * were shipped wrong in ways a source-text test could not see: `CapturedHeadlines`
 * was written, tested and mounted **nowhere** — I verified it by reading
 * `news_view.json` instead of opening the browser — and `FixtureMatrix` carried
 * fourteen assertions that were all substring greps over its own source.
 *
 * So every assertion here reads the DOM, and the mount is checked too.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { narrowMinutesConflicts } from "@/lib/data/minutes-conflicts";

const CONFLICT = {
  element_id: 10,
  player: "Gvardiol",
  club: "Man City",
  kind: "fringe-but-discussed",
  e_minutes: 14.3,
  xp: 0.78,
  gap: 30.7,
  source: "x:robtFPL",
  url: "https://x.com/robtFPL/status/2086441723647905885",
  claimed_at: "2026-08-09T13:17:25Z",
  quote: "Foden, Dias and Gvardiol played full 90 - Gvardiol started LB.",
};

const DOUBTED = {
  ...CONFLICT,
  element_id: 11, player: "Minteh", club: "Brighton",
  kind: "nailed-but-doubted", e_minutes: 86.0, xp: 4.9, gap: 11.0,
  quote: "Brighton summary. Minteh injury one to keep an eye on.",
  url: "https://x.com/robtFPL/status/2086121456807575553",
};

function mountWith(value: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: value === null ? "not published" : null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/MinutesConflicts");
}

/**
 * Built by running the REAL narrower over the raw artifact shape.
 *
 * My first version hand-wrote the narrowed object, and it was wrong in exactly the
 * way this catches: the artifact is snake_case (`e_minutes`) and the component
 * consumes camelCase (`eMinutes`), so every assertion failed on
 * `undefined.toFixed`. Constructing the fixture through `narrowMinutesConflicts`
 * makes the two shapes impossible to drift apart, and exercises the narrower on
 * the same data the component renders.
 */
function narrowedFixture(conflicts: unknown[], ambiguous: Record<string, number[]> = {}) {
  const result = narrowMinutesConflicts({
    schema_version: 1,
    generated_at: "2026-08-13T00:00:00Z",
    thresholds: { fringe_minutes: 45, nailed_minutes: 75 },
    note: "Disagreements ... Reported, never applied: ...",
    conflicts,
    ambiguous_surnames: ambiguous,
  });
  if (!("value" in result) || !result.value) {
    throw new Error(`fixture did not narrow: ${JSON.stringify(result)}`);
  }
  return result.value;
}

const OK = narrowedFixture([CONFLICT, DOUBTED]);

describe("the disagreement itself", () => {
  it("names the player and shows the model's own numbers", async () => {
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(screen.getByText("Gvardiol")).toBeTruthy();
    // The gap has to be legible without arithmetic.
    expect(container.textContent).toContain("14 expected minutes");
    expect(container.textContent).toContain("0.78 xP");
  });

  it("renders the quote in full, not behind a hover", async () => {
    /**
     * The quote IS the content. A conflict list without its evidence is a second
     * opinion — "trust this number less" with nothing to check — so it must be
     * readable without interaction.
     */
    const { default: MinutesConflicts } = await mountWith(OK);
    render(<MinutesConflicts />);
    const quote = screen.getByText(/played full 90/);
    expect(quote).toBeTruthy();
    expect(quote.tagName.toLowerCase()).toBe("blockquote");
  });

  it("links to the post so the reader can check it", async () => {
    const { default: MinutesConflicts } = await mountWith(OK);
    render(<MinutesConflicts />);
    const link = screen.getAllByRole("link")[0] as HTMLAnchorElement;
    expect(link.href).toContain("x.com/robtFPL/status/");
    // An external link that hijacks the tab loses the page the reader was on.
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("attributes the claim and dates it", async () => {
    // provenance is the entire admissibility argument for these rows.
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toContain("x:robtFPL");
    expect(container.textContent).toContain("2026-08-09T13:17:25Z");
  });

  it("distinguishes the two directions of disagreement", async () => {
    // "the model expects nothing but someone is writing about them" and "the model
    // expects a full game but there is injury language" need different fixes.
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toMatch(/model says fringe/);
    expect(container.textContent).toMatch(/model says nailed on/);
  });

  it("renders one entry per conflict", async () => {
    const { default: MinutesConflicts } = await mountWith(OK);
    render(<MinutesConflicts />);
    expect(screen.getAllByTestId("minutes-conflict")).toHaveLength(2);
  });
});

describe("what it refuses to claim", () => {
  it("says it never applies a correction", async () => {
    // Otherwise a reader could reasonably assume the projection has been adjusted.
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toMatch(/never applied/i);
  });

  it("never prints a number taken from the quote", async () => {
    /**
     * The quote says "90". If that ever appears as the player's expected minutes,
     * a regex has been allowed to write a projection — the fabricated-number
     * failure this whole lane is built to avoid.
     */
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).not.toContain("90 expected minutes");
    expect(container.textContent).toContain("14 expected minutes");
  });

  it("says an unflagged player is unexamined, not verified", async () => {
    /**
     * The distinction that makes this surface honest. "Not listed" means nobody
     * wrote about them — which is a different fact from the evidence agreeing, and
     * conflating them turns an unexamined low projection into a confirmed one.
     */
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toMatch(/absence of evidence/i);
  });

  it("states the thresholds it judged against", async () => {
    // "14 minutes" is only a disagreement relative to a stated bar.
    const { default: MinutesConflicts } = await mountWith(OK);
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toContain("45");
    expect(container.textContent).toContain("75");
  });

  it("shows refused ambiguous surnames rather than dropping them", async () => {
    const { default: MinutesConflicts } = await mountWith(
      narrowedFixture([CONFLICT], { wilson: [12, 13] }),
    );
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toContain("wilson");
    expect(container.textContent).toMatch(/refused rather than guessed/i);
  });
});

describe("the states that are not conflicts", () => {
  it("calls an empty result a result", async () => {
    // Every checked projection agreeing is a finding, not an absence.
    const { default: MinutesConflicts } = await mountWith(narrowedFixture([]));
    const { container } = render(<MinutesConflicts />);
    expect(container.textContent).toMatch(/no projection contradicts/i);
    expect(container.querySelectorAll("[data-testid='minutes-conflict']")).toHaveLength(0);
  });

  it("is one line when the artifact is absent, not a panel", async () => {
    // Absence must never outweigh substance — the defect that put ~1200px of empty
    // bordered boxes on this app's own pages.
    const { default: MinutesConflicts } = await mountWith(null);
    const { container } = render(<MinutesConflicts />);
    expect(container.querySelector("[data-weight='line']")).toBeTruthy();
  });
});

describe("it is actually mounted", () => {
  it("appears on the evidence page", () => {
    /**
     * The check that `CapturedHeadlines` needed and did not have: it was written,
     * tested and rendered by nothing, and `git log -S` proved no commit ever
     * mounted it. A component with passing tests and no mount is invisible work.
     */
    const page = readFileSync("app/evidence/page.tsx", "utf8");
    expect(page).toContain("import MinutesConflicts");
    expect(page).toContain("<MinutesConflicts />");
  });
});

describe("which gameweek's conflicts it asks for", () => {
  /**
   * The path was frozen at `gw01` until the descriptor became a factory. This
   * component then took `gameweek = 1` as a default, which reads as safe and is
   * not: `/evidence` mounts it with no prop, so from GW2 it would have gone on
   * fetching gw01 while every other caller moved on. A default wrong for most of
   * a season is a hardcoded path with a nicer signature.
   */
  async function pathsRequested(statusGameweek: number | null, props: { gameweek?: number } = {}) {
    vi.resetModules();
    const asked: string[] = [];
    vi.doMock("@/lib/data/useArtifact", () => ({
      useArtifact: (descriptor: { key: string; path: string }) => {
        asked.push(descriptor.path);
        const isStatus = descriptor.key === "agentStatus";
        const value = isStatus && statusGameweek !== null
          ? { gameweek: statusGameweek } : null;
        return {
          artifact: {
            state: value === null ? "absent" : "ok",
            provenance: { source: "local", producedAt: null, ageMs: null },
            reason: value === null ? "not published" : null,
            value,
          },
        };
      },
    }));
    vi.doMock("@/lib/data/artifact", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, proven: (a: { value: unknown }) => a.value };
    });
    const { default: Component } = await import("@/components/MinutesConflicts");
    render(<Component {...props} />);
    return asked;
  }

  it("follows the phase resolver rather than assuming the first", async () => {
    const asked = await pathsRequested(7);
    expect(asked).toContain("fpl/minutes_conflicts_gw07.json");
    expect(asked).not.toContain("fpl/minutes_conflicts_gw01.json");
  });

  it("lets a caller that already knows override it", async () => {
    expect(await pathsRequested(7, { gameweek: 3 }))
      .toContain("fpl/minutes_conflicts_gw03.json");
  });

  it("falls back to the first gameweek only when nothing answers", async () => {
    // Last resort, not a default. A wrong gameweek renders a named absence,
    // which is recoverable; a stale file rendered as current is not.
    expect(await pathsRequested(null))
      .toContain("fpl/minutes_conflicts_gw01.json");
  });
});
