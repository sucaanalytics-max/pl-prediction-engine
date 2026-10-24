import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallCard, NO_TRANSFER_NOTE, type CallCardProps, type CardRange } from "@/components/call/CallCard";
import { agentTransferNote } from "@/components/call/Tiles";

const RANGE: CardRange = {
  mean: 55.3, q10: 36, q25: 44, q75: 64, q90: 76, p60: 0.36,
  nDraws: 10000, generatedAt: "2026-10-23T19:50:00Z", sealed: true,
};

const BASE: CallCardProps = {
  gameweek: 9,
  captain: { name: "Palmer", team: "CHE", fixture: "MUN (H)", xp: 5.66 },
  transfer: null,
  bringIn: ["Thiaw", "Wissa"],
  sitDown: ["Groß", "Palestra"],
  lineupKnown: true,
  shape: "3-4-3",
  range: RANGE,
  total: 42.6,
  countingRule: "captain not doubled",
  projectionDraws: 10000,
};

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the call card", () => {
  it("shows the captain with the doubled figure and where it comes from", () => {
    setOnline(true);
    render(<CallCard {...BASE} />);
    const row = screen.getByTestId("call-captain");
    expect(row.textContent).toContain("Palmer");
    expect(row.textContent).toContain("CHE v MUN (H)");
    expect(row.textContent).toContain("11.32");
    expect(row.textContent).toContain("from 5.66, doubled");
    // Nothing on the page recommends a vice, and the card must not either.
    expect(document.body.textContent).not.toMatch(/vice/i);
  });

  it("reads the transfer row as None with the tile's own note when given no transfer", () => {
    setOnline(true);
    render(<CallCard {...BASE} />);
    const row = screen.getByTestId("call-transfer");
    expect(row.textContent).toContain("None");
    expect(row.textContent).toContain(NO_TRANSFER_NOTE);
  });

  it("shows out → in and a note when it is given a transfer", () => {
    setOnline(true);
    render(<CallCard {...BASE} transfer={{ out: ["Foden"], in: ["Tavernier"], note: "the agent's plan" }} />);
    const row = screen.getByTestId("call-transfer");
    expect(row.textContent).toMatch(/Foden\s*→\s*Tavernier/);
    expect(row.textContent).toContain("the agent's plan");
    expect(row.textContent).not.toContain(NO_TRANSFER_NOTE);
  });

  it("reads a plan that holds the squad as None with the plan's note, never an empty arrow", () => {
    setOnline(true);
    const note = agentTransferNote({ out: [], in: [], sealed: false });
    render(<CallCard {...BASE} transfer={{ out: [], in: [], note }} />);
    const row = screen.getByTestId("call-transfer");
    expect(row.textContent).toContain("None");
    expect(row.textContent).toContain("the agent's plan makes no transfer this week");
    expect(row.textContent).not.toContain("→");
  });

  it("prints the same note as the desktop Transfer tile for a two-move plan", () => {
    setOnline(true);
    const plan = { out: ["Palestra", "Foden"], in: ["Hill", "Tavernier"], sealed: false };
    render(<CallCard {...BASE} transfer={{ ...plan, note: agentTransferNote(plan) }} />);
    const row = screen.getByTestId("call-transfer");
    expect(row.textContent).toMatch(/Palestra, Foden\s*→\s*Hill, Tavernier/);
    expect(row.textContent).toContain(
      "the agent's plan · provisional, re-solved until the deadline · not applied to the eleven below",
    );
  });

  it("states the lineup change as start and bench, with the shape", () => {
    setOnline(true);
    render(<CallCard {...BASE} />);
    const row = screen.getByTestId("call-lineup");
    expect(row.textContent).toContain("Start Thiaw, Wissa");
    expect(row.textContent).toContain("Bench Groß, Palestra · 3-4-3");
  });

  it("says so when no lineup is on file rather than listing eleven changes", () => {
    setOnline(true);
    render(<CallCard {...BASE} lineupKnown={false} bringIn={[]} sitDown={[]} />);
    expect(screen.getByTestId("call-lineup").textContent).toContain("No lineup on file");
  });

  it("draws the simulated range from the published quantiles, with a source line", () => {
    setOnline(true);
    render(<CallCard {...BASE} />);
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label"))
      .toBe("Simulated range: 1 in 10 below 36, middle half 44 to 64, 1 in 10 above 76, mean 55.3");
    const block = screen.getByTestId("call-expected").textContent ?? "";
    expect(block).toContain("55.3");
    expect(block).toContain("36%");
    expect(block).toContain("chance of 60+");
    expect(block).toContain("Simulated · 10,000 draws · model run 23 Oct, 19:50 UTC");
  });

  it("omits what the file did not publish instead of computing it", () => {
    setOnline(true);
    render(<CallCard {...BASE} range={{ ...RANGE, q25: null, p60: null, nDraws: null, generatedAt: null }} />);
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).not.toContain("middle half");
    const block = screen.getByTestId("call-expected").textContent ?? "";
    expect(block).not.toContain("chance of 60+");
    // No invented source detail: no draw count, no run time.
    expect(block).not.toContain("draws");
    expect(block).not.toContain("model run");
  });

  it("drops the whole bar when q10 or q90 is missing", () => {
    setOnline(true);
    render(<CallCard {...BASE} range={{ ...RANGE, q90: null }} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("falls back to the best eleven, with its counting rule, when there is no range", () => {
    setOnline(true);
    render(<CallCard {...BASE} range={null} />);
    const block = screen.getByTestId("call-expected").textContent ?? "";
    expect(block).toContain("42.60");
    expect(block).toContain("captain not doubled");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("flags a provisional solve in the source line", () => {
    setOnline(true);
    render(<CallCard {...BASE} range={{ ...RANGE, sealed: false }} />);
    expect(screen.getByTestId("call-expected").textContent).toContain("provisional");
  });

  it("links Set on FPL out when online, and Capture to /capture", () => {
    setOnline(true);
    render(<CallCard {...BASE} />);
    expect(screen.getByRole("link", { name: /Set on FPL/ }).getAttribute("href"))
      .toBe("https://fantasy.premierleague.com/my-team");
    expect(screen.getByRole("link", { name: "Capture what I set" }).getAttribute("href"))
      .toBe("/capture");
    expect(screen.getByRole("link", { name: "See your eleven" }).getAttribute("href"))
      .toBe("#the-eleven");
  });

  it("disables Set on FPL and says why when offline", () => {
    setOnline(false);
    render(<CallCard {...BASE} />);
    const button = screen.getByRole("button", { name: /Set on FPL/ });
    expect(button).toBeDisabled();
    expect(button.textContent).toContain("needs a connection");
    expect(screen.queryByRole("link", { name: /Set on FPL/ })).toBeNull();
  });
});
