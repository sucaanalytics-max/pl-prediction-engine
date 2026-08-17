/**
 * The call, and the two ways this card used to describe a plan wrongly.
 *
 * Both fixes shipped without a test, and an adversarial pass proved both could
 * be reverted with the whole suite green. These are the tests that stop that.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DecideCard } from "@/components/margin/DecideCard";
import { classify, type Artifact } from "@/lib/data/artifact";
import { narrowPublicDecision, type PublicDecision } from "@/lib/data/narrow";

const PATH = "fpl/decision_public_gw01_season.json";

/**
 * A real artifact, built the way the loader builds one.
 *
 * Hand-rolling the envelope does not work and the failure is silent: `proven()`
 * reads the payload through a module-private symbol, so an object that merely
 * has the right fields narrows to null and every test renders the absence
 * branch while claiming to test the populated one.
 */
function ok(plan: Record<string, unknown> = {}): Artifact<PublicDecision> {
  return classify({
    path: PATH,
    source: "local",
    raw: {
      gameweek: 1,
      entry_label: "season",
      decision: {
        mean_points: 59.6,
        plan: {
          squad: [], xi: [], captain: null, vice: null,
          transfers_in: [], transfers_out: [], hits: 0, bank_after: 0,
          ...plan,
        },
      },
      credible_margin: true,
    },
    narrow: narrowPublicDecision,
    now: new Date("2026-08-17T00:00:00Z"),
  });
}

/** The same envelope with nothing behind it, which is the common case. */
function absent(state: "absent" | "unreadable", reason: string): Artifact<PublicDecision> {
  return classify({
    path: PATH,
    source: "none",
    raw: state === "unreadable" ? { gameweek: "not a number" } : undefined,
    narrow: narrowPublicDecision,
    now: new Date("2026-08-17T00:00:00Z"),
  });
}

const NAMES: Record<number, string> = { 9: "Saka", 21: "Haaland", 521: "Watkins", 400: "Palmer" };
const nameOf = (id: number) => NAMES[id] ?? null;

afterEach(cleanup);

describe("the move line", () => {
  it("names the buys on an opening build rather than calling it a roll", () => {
    /**
     * Fifteen bought and none sold is what the optimiser actually produces on
     * the opening build, and `milp.py` charges no hits for it. Gating on
     * `transfers_out.length` alone reported "roll the transfer" over a plan that
     * bought a whole squad.
     */
    render(<DecideCard gameweek={1} nameOf={nameOf}
                       of={ok({ transfers_in: [9, 21], transfers_out: [] })} />);
    const card = screen.getByTestId("decide-card");
    expect(card.textContent).toContain("in Saka, Haaland");
    expect(card.textContent).not.toContain("roll the transfer");
  });

  it("does not pair the two lists with an arrow", () => {
    /**
     * `milp.py:205-206` publishes `sorted(transfers_in)` and
     * `sorted(transfers_out)` independently, so no correspondence exists to
     * draw. Zipping by index printed "Saka → Watkins, Haaland → Palmer" for a
     * plan meaning the opposite — a MID→FWD swap that is not a legal transfer.
     */
    render(<DecideCard gameweek={1} nameOf={nameOf}
                       of={ok({ transfers_in: [9, 21], transfers_out: [521, 400] })} />);
    const text = screen.getByTestId("decide-card").textContent ?? "";
    expect(text).toContain("out Watkins, Palmer");
    expect(text).toContain("in Saka, Haaland");
    expect(text).not.toMatch(/Watkins\s*→\s*Saka|Saka\s*→\s*Watkins/);
  });

  it("says roll only when nothing moves at all", () => {
    render(<DecideCard gameweek={1} nameOf={nameOf} of={ok()} />);
    expect(screen.getByTestId("decide-card").textContent).toContain("roll the transfer");
  });
});

describe("the states that are not a call", () => {
  it("carries the artifact's own reason rather than a scheduling sentence", () => {
    /**
     * This printed "not solved for GW1 yet — the engine runs on the deadline"
     * for absent, stale, unreadable and empty alike. A 500 reported as a
     * schedule is a claim about the world that the app cannot support, and
     * ScoreView lower on the same page printed the true reason.
     */
    render(<DecideCard gameweek={1} of={absent("unreadable", "malformed")} />);
    const card = screen.getByTestId("decide-card");
    expect(card).toHaveAttribute("data-state", "unreadable");
    // The state is named and the reason travels with it — whatever the
    // classifier's wording. What must not appear is a claim about scheduling,
    // which is a fact about the world this artifact cannot support.
    expect(card.textContent).toContain("Unreadable");
    expect(card.textContent).not.toContain("the engine runs on the deadline");
  });

  it("distinguishes an absent decision from an unreadable one", () => {
    render(<DecideCard gameweek={1} of={absent("absent", "Nothing published yet.")} />);
    expect(screen.getByTestId("decide-card")).toHaveAttribute("data-state", "absent");
  });

  it("keeps the way through to the argument in every state", () => {
    render(<DecideCard gameweek={1} of={absent("absent", "Nothing published yet.")} />);
    expect(screen.getByText(/why/).closest("a")).toHaveAttribute("href", "/decide");
  });
});
