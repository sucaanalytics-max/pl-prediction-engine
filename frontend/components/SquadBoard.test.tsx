/**
 * The squad board's two provenance lines, which nothing tested.
 *
 * Both defects below were live and both were invisible to the suite: it went from
 * 821 passing to 821 passing across the fix, because no test rendered this
 * component's header line at all.
 *
 *  1. **A fabricated bank balance.** `fpl-live-server.ts` coerced FPL's
 *     `last_deadline_bank: null` — which means "no deadline has passed yet" — to
 *     `0`, and this component printed `money(0)` as "£0.0m in the bank". A
 *     confident, specific, wrong number about the one quantity a transfer
 *     decision turns on. The consumer type had been `number | null` the whole
 *     time; only the producer refused to use it.
 *
 *  2. **A dead source comparison.** The check was `squad.source === "live"`,
 *     and the server emits `official_public` or `captured_authenticated_draft`.
 *     So the branch could never be taken, and the comment above it — "Never
 *     presented as live when it is a draft" — described behaviour that did not
 *     exist. Both cases printed the raw enum identifier to the user.
 *
 * These are tested by rendering and reading the DOM. A source-text assertion
 * would have passed against both bugs.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const PLAYERS = [
  { name: "Raya", position: "GKP", team: "Arsenal", price: 5.5 },
  { name: "Gabriel", position: "DEF", team: "Arsenal", price: 6.0 },
  { name: "Saka", position: "MID", team: "Arsenal", price: 10.0 },
  { name: "Isak", position: "FWD", team: "Liverpool", price: 10.5 },
];

function mountWith(squad: Record<string, unknown> | null) {
  vi.resetModules();
  vi.doMock("@/lib/data/useHeuristics", () => ({
    useHeuristics: () => ({
      artifact: {
        state: "ok",
        provenance: { source: "local", producedAt: null, ageMs: null },
        reason: null,
        value: { squad },
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  return import("@/components/SquadBoard");
}

const BASE = {
  players: PLAYERS,
  value: 100.0,
  bank: 1.5,
  formation: "4-4-2",
  source: "official_public",
  sourceLabel: "Official public GW picks",
};

describe("the bank", () => {
  it("prints a known balance", async () => {
    const { default: SquadBoard } = await mountWith(BASE);
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("£1.5m in the bank");
  });

  it("says unknown rather than £0.0m when FPL has not reported one", async () => {
    /**
     * The load-bearing assertion.
     *
     * "£0.0m in the bank" and "unknown" lead to opposite decisions: the first
     * says do not plan a move that needs money, the second says go and look.
     */
    const { default: SquadBoard } = await mountWith({ ...BASE, bank: null });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).not.toContain("£0.0m");
    expect(container.textContent).toMatch(/bank unknown/i);
  });

  it("prints a genuine zero balance as zero", async () => {
    // The distinction only means something if a real 0 still reads as £0.0m — a
    // squad that has actually spent everything is a different fact from one whose
    // bank has never been reported.
    const { default: SquadBoard } = await mountWith({ ...BASE, bank: 0 });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("£0.0m in the bank");
    expect(container.textContent).not.toMatch(/bank unknown/i);
  });
});

describe("the squad source", () => {
  it("calls the official endpoint live", async () => {
    const { default: SquadBoard } = await mountWith(BASE);
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("live from FPL");
  });

  it("never calls a captured draft live", async () => {
    /**
     * The defect: the guard compared against `"live"`, which the field cannot
     * hold, so this case fell through to printing `captured_authenticated_draft`.
     * A stale snapshot must not be able to read as the current team.
     */
    const { default: SquadBoard } = await mountWith({
      ...BASE, source: "captured_authenticated_draft",
    });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).not.toContain("live from FPL");
    expect(container.textContent).toMatch(/captured draft, not live/i);
  });

  it("does not print a raw enum identifier to the user", async () => {
    for (const source of ["official_public", "captured_authenticated_draft"]) {
      const { default: SquadBoard } = await mountWith({ ...BASE, source });
      const { container } = render(<SquadBoard />);
      expect(container.textContent, source).not.toContain(source);
    }
  });

  it("falls back to the raw value for a source it does not know", async () => {
    // Better than hiding it: an unrecognised source means the server changed and
    // the reader should see something rather than nothing.
    const { default: SquadBoard } = await mountWith({ ...BASE, source: "future_thing" });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toContain("future_thing");
  });

  it("says so when there is no source at all", async () => {
    const { default: SquadBoard } = await mountWith({ ...BASE, source: null });
    const { container } = render(<SquadBoard />);
    expect(container.textContent).toMatch(/source unknown/i);
  });
});

describe("a missing squad", () => {
  it("is one line, not a panel", async () => {
    // Absence must not outweigh substance: the rest of the page works without it.
    const { default: SquadBoard } = await mountWith(null);
    const { container } = render(<SquadBoard />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });
});
