/**
 * Absence never occupies more space than substance.
 *
 * ## The measured defect
 *
 * `/decide` opened with FOUR consecutive full-card empty states — two `EntryBlock`s,
 * each rendering a proposal and a robustness section, none of which the agent
 * publishes until a gameweek seals. Roughly 1200px of empty bordered panels. Below
 * them, unseen, sat the content that makes the page worth opening: a ranked 7-move
 * transfer shortlist with per-move reasoning, 12 alternative multi-transfer plans
 * scored to one decimal, and a 6-gameweek captaincy plan.
 *
 * Two of those panels carried the same heading, "Robustness", with nothing to say
 * which proposal each described.
 *
 * The states were correct. Their WEIGHT and their ORDER were the defect, and no
 * existing test could see either — every test asserted that the right state was
 * chosen, which it was.
 *
 * ## Why this is worth a test rather than a careful commit
 *
 * The agent is deadline-gated. For about ten days of every gameweek cycle its
 * artifacts are absent, so "mostly empty" is the normal state of this app rather
 * than an edge case — and every improvement to how articulately absence is explained
 * pushes the useful content further down the page. That pressure is permanent, so
 * the rule needs an enforcer.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StateCard, WhenProven } from "@/components/data/Artifact";
import { classify } from "@/lib/data/artifact";

function absent<T>() {
  return classify<T>({
    path: "nothing.json",
    source: "local",
    raw: undefined,
    now: new Date("2026-08-11T12:00:00Z"),
    narrow: () => ({ ok: false, problems: ["unused"] }) as never,
    freshnessBudgetMs: null,
  });
}

describe("a line-weight state renders one line, not a panel", () => {
  it("emits a single element with no card", () => {
    const { container } = render(
      <StateCard of={absent()} what="the agent has nothing to report" weight="line" />,
    );
    const node = container.querySelector('[data-weight="line"]');
    expect(node).not.toBeNull();
    // A paragraph, not a div wrapping three paragraphs. Asserted on the tag and the
    // child count rather than on a class name, because class names were what 53
    // tests in this repo used to pin and they broke on every restyle.
    expect(node?.tagName).toBe("P");
    expect(node?.querySelectorAll("p").length).toBe(0);
  });

  it("actually says something", () => {
    /**
     * The assertion this file was missing.
     *
     * A file-corruption event replaced the whole `line` branch with a self-closing
     * `<p />` — right tag, right attributes, no children — and all nine tests here
     * passed against it while every "Nothing yet" and "Not published" line on
     * /now, /decide and /evidence rendered invisible.
     *
     * Structure was asserted; content was not. So this asserts the two things a
     * reader needs: the state's label, and what they were expecting.
     */
    const { container } = render(
      <StateCard of={absent()} what="the agent has nothing to report" weight="line" />,
    );
    const node = container.querySelector('[data-weight="line"]');
    const text = node?.textContent ?? "";

    expect(text.length, "the line rendered no text at all").toBeGreaterThan(10);
    expect(text).toContain("the agent has nothing to report");
    // The state's own word, so a reader can tell absent from empty from unreadable.
    expect(text.toLowerCase()).toContain("not published");
  });

  it("says something in every state, not just absent", () => {
    // A state whose label is blank reads as a stray dash. `ok` is never carded, so
    // the four carded states must each name themselves.
    for (const state of ["empty", "stale", "absent", "unreadable"] as const) {
      const artifact = { ...absent(), state } as never;
      const { container, unmount } = render(
        <StateCard of={artifact} what="the league table" weight="line" />,
      );
      const text = container.querySelector('[data-weight="line"]')?.textContent ?? "";
      expect(text, `${state} rendered no label`).toMatch(/\S{3,}/);
      expect(text, `${state} did not say what was expected`).toContain("the league table");
      unmount();
    }
  });

  it("carries no card or inset styling", () => {
    const { container } = render(
      <StateCard of={absent()} what="nothing yet" weight="line" />,
    );
    expect(container.querySelector(".card")).toBeNull();
    expect(container.querySelector(".glass-inset")).toBeNull();
  });

  it("still declares the state, so honesty is not traded for compactness", () => {
    const { container } = render(
      <StateCard of={absent()} what="nothing yet" weight="line" />,
    );
    // The whole point of the artifact layer: the state is typed and named. A one-line
    // rendering that dropped it would be a regression dressed as a redesign.
    expect(container.querySelector('[data-state="absent"]')).not.toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("panel weight is still a card, for the artifact a page is about", () => {
    const { container } = render(
      <StateCard of={absent()} what="the league table" weight="panel" />,
    );
    expect(container.querySelector('[data-weight="panel"]')).not.toBeNull();
    expect(container.querySelector(".card")).not.toBeNull();
  });

  it("defaults to panel, so a caller must opt IN to quietness", () => {
    // The safe default. A default of `line` would let a page silently downgrade the
    // one absence its reader came to understand.
    const { container } = render(<StateCard of={absent()} what="x" />);
    expect(container.querySelector('[data-weight="panel"]')).not.toBeNull();
  });

  it("WhenProven passes the weight through", () => {
    const { container } = render(
      <WhenProven
        of={absent<string>()}
        what="nothing"
        weight="line"
        then={(value) => <span>{value}</span>}
      />,
    );
    expect(container.querySelector('[data-weight="line"]')).not.toBeNull();
  });
});

/**
 * The `/decide` ordering assertions are gone with the page.
 *
 * They pinned that `<HeuristicLists />` rendered above the `<EntryBlock` loop on
 * `app/decide/page.tsx`, because the agent's proposals are absent for ~10 days of
 * every gameweek cycle and four full-card empty states pushed the useful content
 * roughly 1200px down. That page was one of five answering "who do I captain this
 * week" and is deleted; `HeuristicLists` and `EntryBlock` were local to it and have
 * no other mount, so there is no composition left to assert an order over.
 *
 * The rule the page was made to obey outlives it and is what the assertions above
 * enforce: a `line`-weight state renders one line and not a panel. The surfaces that
 * currently spend it — `components/GameweekCall.tsx` and
 * `components/MinutesConflicts.tsx` — are ordinary components, and a source-order
 * assertion over a component is not the same claim as one over a page.
 */
