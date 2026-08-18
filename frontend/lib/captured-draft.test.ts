/**
 * The captured squad, checked against FPL's own rules and its own bootstrap.
 *
 * ## Why a hand-edited list needs a test
 *
 * `CAPTURED_DRAFT` is fifteen element ids typed from a screenshot, and it is the
 * squad every number on the home page is derived from. The previous capture was 28
 * July, and by 13 August the real team had diverged so far that only two of fifteen
 * players still matched — so the board, the transfer suggestion and the captaincy
 * line were all confidently about a team the manager no longer had. The only tell
 * was a date in a tooltip.
 *
 * A typo in an id is the same failure with no tell at all: element 426 is
 * B.Fernandes and 427 is Mbeumo, so a single transposed digit silently swaps one
 * midfielder for a much cheaper one and every downstream number shifts. These
 * assertions are what make that a test failure instead of a wrong recommendation.
 *
 * The strongest check here is the squad VALUE. Prices come from the bootstrap
 * rather than from the screenshot, so if any id is wrong the total stops matching
 * — one number validating all fifteen rows at once, however they were transcribed.
 *
 * ## Every money figure below is derived, not typed
 *
 * `REPORTED_VALUE` is the one place the figure the FPL UI displayed is written
 * down, and every message that has to print money builds it from that constant or
 * from the bootstrap. Three comments in this file went on quoting an earlier
 * capture's value after the constant was updated — the exact stale-prose defect
 * the file exists to catch, in the file that exists to catch it. Prose cannot be
 * trusted to be re-read, so it no longer carries the numbers, and the last test
 * below enforces that mechanically.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAPTURED_BANK, CAPTURED_DRAFT, CAPTURED_DRAFT_AT,
} from "@/lib/fpl-live-server";

interface Element {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
}

/**
 * The real cache when it is there, a committed minimum when it is not.
 *
 * `data/raw/` is gitignored, so the pipeline's bootstrap cache never reaches CI
 * — and this file read it unconditionally, so the frontend suite failed on EVERY
 * run for at least eight commits while passing locally. A gate that cannot pass
 * is not a gate, and "green locally" was not evidence of anything.
 *
 * Preferring the real cache keeps a local or post-pipeline run checking against
 * live prices; the fixture keeps the check alive in CI, which matters because
 * this is the test that caught a squad value transcribed from the wrong capture.
 */
const BOOTSTRAP_PATHS = [
  "../data/raw/fpl/bootstrap_static.json",
  "test/fixtures/bootstrap-min.json",
];

function loadBootstrap() {
  for (const path of BOOTSTRAP_PATHS) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
  }
  throw new Error(
    `no bootstrap available; tried ${BOOTSTRAP_PATHS.join(" then ")}`,
  );
}

const BOOTSTRAP = loadBootstrap() as {
  elements: Element[];
  teams: Array<{ id: number; short_name: string }>;
};

const BY_ID = new Map(BOOTSTRAP.elements.map((e) => [e.id, e]));
const CLUB = new Map(BOOTSTRAP.teams.map((t) => [t.id, t.short_name]));
const POSITION: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

/** What the FPL UI displayed alongside this squad, to the penny it reports. */
const REPORTED_VALUE = 99.5;

/** FPL's starting budget. Every squad begins with exactly this to spend. */
const FULL_BUDGET = 100.0;

/** One player's price in millions, from the bootstrap rather than from a comment. */
const price = (id: number) => BY_ID.get(id)!.now_cost / 10;

/** The squad's committed value, which is the check that covers all fifteen rows. */
const squadValue = () =>
  CAPTURED_DRAFT.reduce((sum, p) => sum + price(p.elementId), 0);

/** Money for a failure message. The only place this file writes a £ sign. */
const money = (millions: number) => `£${millions.toFixed(1)}m`;

describe("the squad is a legal FPL squad", () => {
  it("has fifteen players", () => {
    expect(CAPTURED_DRAFT).toHaveLength(15);
  });

  it("names each player once", () => {
    // A duplicated id is a squad of fourteen wearing a mask.
    const ids = CAPTURED_DRAFT.map((p) => p.elementId);
    expect(new Set(ids).size).toBe(15);
  });

  it("fills slots 1 to 15 exactly once each", () => {
    // FPL's `position` is the slot, and the bench ORDER is carried by it — 13 comes
    // on before 14. A repeated slot makes the autosub order arbitrary.
    const slots = CAPTURED_DRAFT.map((p) => p.position).sort((a, b) => a - b);
    expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("starts eleven and benches four", () => {
    expect(CAPTURED_DRAFT.filter((p) => !p.bench)).toHaveLength(11);
    expect(CAPTURED_DRAFT.filter((p) => p.bench)).toHaveLength(4);
  });

  it("benches exactly slots 12 to 15", () => {
    const benched = CAPTURED_DRAFT.filter((p) => p.bench).map((p) => p.position);
    expect(benched.sort((a, b) => a - b)).toEqual([12, 13, 14, 15]);
  });

  it("has one captain and one vice", () => {
    expect(CAPTURED_DRAFT.filter((p) => p.status === "captain")).toHaveLength(1);
    expect(CAPTURED_DRAFT.filter((p) => p.status === "vice")).toHaveLength(1);
  });

  it("does not bench the captain or the vice", () => {
    // A benched captain scores nothing on the armband, so this is a rule and not a
    // preference.
    for (const pick of CAPTURED_DRAFT) {
      if (pick.status) expect(pick.bench, `${pick.status} is benched`).toBe(false);
    }
  });

  it("fields a legal formation", () => {
    // Exactly one keeper, at least three defenders, at least one forward.
    const xi = CAPTURED_DRAFT.filter((p) => !p.bench)
      .map((p) => POSITION[BY_ID.get(p.elementId)!.element_type]);
    expect(xi.filter((p) => p === "GKP")).toHaveLength(1);
    expect(xi.filter((p) => p === "DEF").length).toBeGreaterThanOrEqual(3);
    expect(xi.filter((p) => p === "FWD").length).toBeGreaterThanOrEqual(1);
  });

  it("carries two keepers in the fifteen", () => {
    const keepers = CAPTURED_DRAFT
      .filter((p) => BY_ID.get(p.elementId)!.element_type === 1);
    expect(keepers).toHaveLength(2);
  });

  it("respects the three-per-club limit", () => {
    const counts = new Map<string, number>();
    for (const pick of CAPTURED_DRAFT) {
      const club = CLUB.get(BY_ID.get(pick.elementId)!.team) ?? "?";
      counts.set(club, (counts.get(club) ?? 0) + 1);
    }
    for (const [club, n] of counts) {
      expect(n, `${n} players from ${club}, the limit is 3`).toBeLessThanOrEqual(3);
    }
  });
});

describe("every id resolves to a real player", () => {
  it("finds all fifteen in the bootstrap", () => {
    for (const pick of CAPTURED_DRAFT) {
      expect(BY_ID.has(pick.elementId), `element ${pick.elementId} does not exist`)
        .toBe(true);
    }
  });

  it("totals the squad value the FPL UI reported", () => {
    /**
     * The check that validates all fifteen rows at once.
     *
     * Prices come from the bootstrap, not the screenshot, so a transposed id
     * shifts the total — 426 (B.Fernandes) against 427 (Mbeumo) is the worked
     * example, and the failure message prices both from the bootstrap instead of
     * repeating a figure here. Matching `REPORTED_VALUE` to the penny is strong
     * evidence the transcription is right.
     */
    const total = squadValue();
    expect(
      total,
      `${money(total)} from the bootstrap against the ${money(REPORTED_VALUE)} the `
      + `UI reported. A transposed id is the usual cause — 426 is ${money(price(426))} `
      + `and 427 is ${money(price(427))}, a gap of `
      + `${money(Math.abs(price(426) - price(427)))}.`,
    ).toBeCloseTo(REPORTED_VALUE, 1);
  });

  it("names the captain the UI showed", () => {
    // Pinned by name rather than id, so the assertion still reads correctly to a
    // human checking it against the screenshot.
    const captain = CAPTURED_DRAFT.find((p) => p.status === "captain")!;
    expect(BY_ID.get(captain.elementId)!.web_name).toBe("B.Fernandes");
  });

  it("names the vice the UI showed", () => {
    const vice = CAPTURED_DRAFT.find((p) => p.status === "vice")!;
    expect(BY_ID.get(vice.elementId)!.web_name).toBe("Mbeumo");
  });
});

describe("the capture is dated and self-consistent", () => {
  it("is stamped with a parseable instant", () => {
    // The date is the only signal a reader gets that this is not live, so it has to
    // be real rather than decorative.
    expect(Number.isNaN(Date.parse(CAPTURED_DRAFT_AT))).toBe(false);
  });

  it("is not older than the squad it claims to describe", () => {
    // The 28 July capture went 16 days stale unnoticed. This will not fail on its
    // own, but it makes the staleness legible at the point someone edits the file.
    const ageDays =
      (Date.parse("2026-08-21T22:00:00Z") - Date.parse(CAPTURED_DRAFT_AT))
      / 86_400_000;
    expect(ageDays, "the capture predates the GW1 deadline by more than 3 weeks")
      .toBeLessThan(21);
  });

  it("captures a bank rather than inventing one", () => {
    /**
     * Distinct from the null-to-zero coercion this file used to do.
     *
     * FPL reports `last_deadline_bank: null` before the first deadline, so there is
     * no API route to the bank at all — and a budget of zero silently limits every
     * transfer suggestion to a like-for-like swap. This records what the UI
     * displayed, next to the squad it was displayed with. It must be a plausible
     * bank, not a placeholder.
     */
    expect(CAPTURED_BANK).toBeGreaterThan(0);
    expect(CAPTURED_BANK).toBeLessThan(20);
  });

  it("adds up to a full budget with the bank", () => {
    // Value plus bank is the budget every FPL squad starts from (`FULL_BUDGET`),
    // and it is the arithmetic check that the two captured numbers came from one
    // observation rather than two different days.
    const total = squadValue();
    expect(
      total + CAPTURED_BANK,
      `${money(total)} committed plus ${money(CAPTURED_BANK)} banked, against a `
      + `${money(FULL_BUDGET)} budget`,
    ).toBeCloseTo(FULL_BUDGET, 1);
  });
});

describe("this file states its money once, in a constant", () => {
  it("writes no £ figure into its own prose", () => {
    /**
     * The tripwire for the defect this file exists to catch, aimed at itself.
     *
     * Three comments here quoted an earlier capture's squad value while
     * `REPORTED_VALUE` carried the current one, and nothing failed — a comment
     * cannot be asserted on, so it rots in a file whose whole subject is rot.
     *
     * The rule is therefore mechanical rather than a habit: a money figure in this
     * file comes from a constant or from the bootstrap, never from a keystroke. The
     * only `£` that survives is the one inside `money()`, which is followed by a
     * template substitution rather than by a digit.
     */
    const source = readFileSync("lib/captured-draft.test.ts", "utf8");
    const typed = [...source.matchAll(/£\s*\d[\d.]*m?/g)].map((m) => m[0]);
    expect(typed, "money typed into prose — derive it from a constant instead")
      .toEqual([]);
  });
});
