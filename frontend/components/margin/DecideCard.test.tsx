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
function absent(state: "absent" | "unreadable", _reason: string): Artifact<PublicDecision> {
  return classify({
    path: PATH,
    source: "none",
    raw: state === "unreadable" ? { gameweek: "not a number" } : undefined,
    narrow: narrowPublicDecision,
    now: new Date("2026-08-17T00:00:00Z"),
  });
}

/** Published, and carrying no plan — which no state label covers. */
function noPlan(): Artifact<PublicDecision> {
  return classify({
    path: PATH,
    source: "local",
    raw: {
      gameweek: 1,
      entry_label: "season",
      decision: { mean_points: 59.6, plan: null },
      credible_margin: true,
    },
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

/**
 * The states that are not a call, which now render nothing.
 *
 * This card used to print a `THE CALL · NOT PUBLISHED` line whenever the artifact
 * was absent, and it was mounted at the top of `/margin` — so for the ten days of
 * every cycle that the deadline-gated writer is idle, the loudest element on the
 * owner's planning screen was an alarm about a cron gate.
 *
 * And the artifact it was alarming about is `decision_public_gw01_season.json`,
 * which is the plan for **Ronny** — an automated entry (2561567, see
 * `pipeline/config.py`) — not the owner's team (20945), the only team this app
 * displays. So the banner reported the absence of a file about a team that appears
 * nowhere on the screen it was interrupting.
 *
 * The tests that pinned the wording of that banner are gone with it. What is
 * pinned instead is that absence is silent: the state is still named once, lower
 * down, by whichever view is reading the artifact.
 */
describe("the states that are not a call", () => {
  it("renders nothing at all when nothing is published", () => {
    const { container } = render(
      <DecideCard gameweek={1} of={absent("absent", "Nothing published yet.")} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("decide-card")).toBeNull();
  });

  it("renders nothing when the artifact is unreadable, rather than an alarm", () => {
    // An unreadable artifact is a real problem and worth reporting — but not here,
    // and not as the largest thing on a planning screen. `MarginState` reports it.
    const { container } = render(
      <DecideCard gameweek={1} of={absent("unreadable", "malformed")} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a decision published with no plan in it", () => {
    const { container } = render(<DecideCard gameweek={1} of={noPlan()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never names another entry's artifact to the reader", () => {
    // The specific harm: the owner reading a NOT PUBLISHED notice about a bot's
    // file, on his own screen, hours before his deadline.
    const { container } = render(
      <DecideCard gameweek={1} of={absent("absent", "Nothing published yet.")} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/not published/i);
    expect(text).not.toMatch(/the call/i);
  });
});
