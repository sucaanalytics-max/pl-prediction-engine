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

describe("/decide puts content before absence", () => {
  /**
   * Source-level, not render-level.
   *
   * Rendering the page needs the live FPL fetch and the heuristic engine, and a test
   * that mocks both would be asserting the mocks. The ordering is a property of the
   * composition, and the composition is readable.
   */
  const source = readDecideSource();

  it("renders the heuristic lists before the agent proposals", () => {
    const lists = source.indexOf("<HeuristicLists />");
    const proposals = source.indexOf("ENTRY_LABELS.map");
    expect(lists).toBeGreaterThan(-1);
    expect(proposals).toBeGreaterThan(-1);
    expect(
      lists,
      "the transfer shortlist and captaincy plan must render above the agent " +
        "proposals, which are absent for ~10 days of every gameweek cycle",
    ).toBeLessThan(proposals);
  });

  it("gives the absent proposals and robustness reports line weight", () => {
    // Two of them, one per entry label.
    expect(source.match(/weight="line"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("does not render two sections with the same bare title", () => {
    // `title="Robustness"` twice is what produced the duplicate heading.
    expect(source).not.toContain('title="Robustness"');
    expect(source).toContain("Robustness — season team");
    expect(source).toContain("Robustness — weekly team");
  });
});

function readDecideSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(process.cwd(), "app", "decide", "page.tsx"), "utf8");
}
