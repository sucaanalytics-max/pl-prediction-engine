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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface Bootstrap {
  elements: Element[];
  teams: Array<{ id: number; short_name: string }>;
  /** Written by scripts/regenerate-bootstrap-fixture.mjs. Absent on the live cache. */
  _prices_captured_at?: string;
}

/** The pipeline's real cache. Gitignored, so present locally and never in CI. */
const LIVE_CACHE = "../data/raw/fpl/bootstrap_static.json";
/** The committed projection of it. Present everywhere, by construction. */
const COMMITTED_FIXTURE = "test/fixtures/bootstrap-min.json";

/**
 * Read a bootstrap, or fail saying which file and why.
 *
 * Nothing is caught here. The previous loader walked a preference list inside
 * `try { … } catch { continue; }`, which caught a JSON parse failure exactly as it
 * caught a missing file — so a half-written real cache degraded silently to the
 * frozen fixture and reported green. This file's own docstring says a gate that
 * cannot pass is not a gate; a gate that passes on a substituted input is worse,
 * because it also claims to have checked.
 */
function readBootstrap(path: string): Bootstrap {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (caught) {
    throw new Error(`${path} could not be read: ${String(caught)}`);
  }
  // Deliberately outside the try: a file that exists and does not parse is
  // corrupt, and corruption must be loud rather than fall through to a fallback.
  return JSON.parse(text) as Bootstrap;
}

/** The same, for a path whose ABSENCE — and only absence — is expected. */
function readBootstrapIfPresent(path: string): Bootstrap | null {
  return existsSync(path) ? readBootstrap(path) : null;
}

/**
 * Two sources, and what each one is allowed to gate.
 *
 * Both used to feed the SAME assertions through a preference chain, and that was
 * the wrong shape. FPL moves `now_cost` nightly in-season, so one price rise turned
 * a local run red on something that is not a defect while CI stayed green on the
 * frozen copy — two environments reaching two verdicts from one tolerance.
 *
 * So they are split by what cannot drift:
 *
 *  - Everything price-dependent — the squad value, the budget arithmetic — reads
 *    the FIXTURE. `REPORTED_VALUE` is what the UI displayed AT capture time, so
 *    capture-time prices are the honest thing to check it against. Checking it
 *    against tonight's prices conflates a transcription error with a price
 *    movement, and only the first is a defect. The gate is now identical in CI and
 *    locally, which is the property this fixture was introduced to get.
 *  - The live cache, when present, gates IDENTITY: every captured id must resolve
 *    to the same player, club and position in both. No price move can fail that;
 *    an id FPL re-pointed, or a fixture that has drifted, will.
 *
 * The cost, stated plainly: a divergence in `now_cost` alone between the fixture
 * and today is tolerated and nothing here notices it. Two things bound that —
 * `_prices_captured_at` records when the fixture's prices were taken, and the last
 * assertion in this file refuses a fixture that has aged away from the capture it
 * is being used to validate.
 */
const FIXTURE = readBootstrap(COMMITTED_FIXTURE);
const LIVE = readBootstrapIfPresent(LIVE_CACHE);

const BY_ID = new Map(FIXTURE.elements.map((e) => [e.id, e]));
const CLUB = new Map(FIXTURE.teams.map((t) => [t.id, t.short_name]));
const POSITION: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

/** What the FPL UI displayed alongside this squad, to the penny it reports. */
const REPORTED_VALUE = 99.5;

/** FPL's starting budget. Every squad begins with exactly this to spend. */
const FULL_BUDGET = 100.0;

/**
 * One captured id's row, or a failure that says what to do about it.
 *
 * A bare `BY_ID.get(id)!` threw `undefined.element_type` from whichever assertion
 * ran first, which says nothing. The fixture is frozen, so the reachable cause is
 * a player FPL added after it was captured.
 */
function element(id: number): Element {
  const found = BY_ID.get(id);
  if (found) return found;
  throw new Error(
    `element ${id} is in CAPTURED_DRAFT but not in ${COMMITTED_FIXTURE}, whose `
    + `prices were captured ${FIXTURE._prices_captured_at ?? "at an unknown time"}. `
    + `If FPL added the player after that, regenerate the fixture: `
    + `node scripts/regenerate-bootstrap-fixture.mjs`,
  );
}

/** One player's price in millions, from the bootstrap rather than from a comment. */
const price = (id: number) => element(id).now_cost / 10;

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
      .map((p) => POSITION[element(p.elementId).element_type]);
    expect(xi.filter((p) => p === "GKP")).toHaveLength(1);
    expect(xi.filter((p) => p === "DEF").length).toBeGreaterThanOrEqual(3);
    expect(xi.filter((p) => p === "FWD").length).toBeGreaterThanOrEqual(1);
  });

  it("carries two keepers in the fifteen", () => {
    const keepers = CAPTURED_DRAFT
      .filter((p) => element(p.elementId).element_type === 1);
    expect(keepers).toHaveLength(2);
  });

  it("respects the three-per-club limit", () => {
    const counts = new Map<string, number>();
    for (const pick of CAPTURED_DRAFT) {
      const club = CLUB.get(element(pick.elementId).team) ?? "?";
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
    expect(element(captain.elementId).web_name).toBe("B.Fernandes");
  });

  it("names the vice the UI showed", () => {
    const vice = CAPTURED_DRAFT.find((p) => p.status === "vice")!;
    expect(element(vice.elementId).web_name).toBe("Mbeumo");
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

/**
 * The bootstrap this file reads, and the loader that reads it.
 *
 * See the block comment above `FIXTURE` for which source gates what and why. These
 * assertions pin the two properties that decision rests on: the committed fixture
 * is present and dated, and it has not aged away from the capture whose value it is
 * used to check.
 */
describe("the bootstrap the value checks are made against", () => {
  it("is the committed fixture, in every environment", () => {
    // Not "whichever of two files happened to be readable". The same file, the
    // same prices and the same verdict in CI and locally.
    expect(FIXTURE.elements.length).toBeGreaterThan(500);
    expect(FIXTURE.teams).toHaveLength(20);
  });

  it("says when its prices were captured", () => {
    /**
     * The stamp was `_generated_from: "2026-08-21T17:30:00Z"` — GW1's deadline,
     * copied out of `events[0]`, three days after the commit that added it. A
     * future-dated stamp is worse than none: it is the only clue to how stale the
     * frozen prices are.
     */
    const stamp = FIXTURE._prices_captured_at;
    expect(stamp, `${COMMITTED_FIXTURE} must carry _prices_captured_at`)
      .toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(stamp!))).toBe(false);
    expect(
      Date.parse(stamp!),
      "the fixture claims its prices were captured in the future",
    ).toBeLessThan(Date.now());
  });

  it("holds prices from around the capture it validates", () => {
    /**
     * What bounds the tolerated price divergence.
     *
     * `REPORTED_VALUE` is what the UI displayed at `CAPTURED_DRAFT_AT`, and it is
     * checked against the fixture's frozen prices — which is only meaningful while
     * the two come from the same period. Recapture the squad without regenerating
     * the fixture and this is the assertion that says so. Same 21-day budget the
     * capture itself gets.
     */
    const gapDays = Math.abs(
      Date.parse(CAPTURED_DRAFT_AT) - Date.parse(FIXTURE._prices_captured_at!),
    ) / 86_400_000;
    expect(
      gapDays,
      `the fixture's prices and CAPTURED_DRAFT_AT are ${gapDays.toFixed(1)} days `
      + `apart, so the value check is comparing a reported total against another `
      + `period's prices. Regenerate: node scripts/regenerate-bootstrap-fixture.mjs`,
    ).toBeLessThan(21);
  });

  it("refuses a corrupt file instead of falling back to the fixture", () => {
    /**
     * The defect: `catch { continue; }` caught a JSON parse failure exactly as it
     * caught ENOENT, so a half-written real cache silently became the frozen
     * fixture and the suite reported green having checked the wrong input.
     */
    const corrupt = join(tmpdir(), `bootstrap-corrupt-${process.pid}.json`);
    writeFileSync(corrupt, '{"elements": [{"id": 1,');
    try {
      expect(() => readBootstrap(corrupt)).toThrow();
      // And the optional reader does not launder it either: the file EXISTS, so
      // absence is not the explanation and it is not allowed to be treated as one.
      expect(() => readBootstrapIfPresent(corrupt)).toThrow();
    } finally {
      rmSync(corrupt, { force: true });
    }
  });

  it("treats only a genuine absence as absence", () => {
    const missing = join(tmpdir(), `bootstrap-missing-${process.pid}.json`);
    rmSync(missing, { force: true });
    expect(readBootstrapIfPresent(missing)).toBeNull();
    // A required path that is missing still fails, naming the path.
    expect(() => readBootstrap(missing)).toThrow(missing);
  });
});

/**
 * The live cache, when it is there, gates what a price move cannot break.
 *
 * Skipped in CI rather than quietly passing: `data/raw/` is gitignored, so there is
 * nothing to compare against and saying so is more honest than a green tick. What
 * it checks is identity — every captured id resolving to the same player, club and
 * position in both files. `now_cost` is deliberately NOT compared; FPL moves it
 * nightly and comparing it is what made a local run red while CI stayed green.
 */
describe.skipIf(LIVE === null)("the fixture is still the same bootstrap", () => {
  const live = LIVE!;

  it("resolves every captured id to the same player in both files", () => {
    const byId = new Map(live.elements.map((e) => [e.id, e]));
    for (const pick of CAPTURED_DRAFT) {
      const there = byId.get(pick.elementId);
      const here = element(pick.elementId);
      expect(there, `element ${pick.elementId} is absent from ${LIVE_CACHE}`)
        .toBeDefined();
      expect(
        { name: there!.web_name, team: there!.team, type: there!.element_type },
        `element ${pick.elementId} is a different player in ${LIVE_CACHE} than in `
        + `${COMMITTED_FIXTURE} — regenerate the fixture`,
      ).toEqual({ name: here.web_name, team: here.team, type: here.element_type });
    }
  });

  it("carries the same clubs", () => {
    // A renumbered team id would silently move players between clubs and break the
    // three-per-club check in a way no price comparison would catch.
    expect(new Map(live.teams.map((t) => [t.id, t.short_name])))
      .toEqual(CLUB);
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

  it("lets no figure in the source file disagree with the constants", () => {
    /**
     * The same tripwire, aimed where the defect actually recurred.
     *
     * Banning the sign outright in `fpl-live-server.ts` would delete accurate prose,
     * so the rule is agreement rather than absence: every money figure written there
     * must be one the capture can produce — the squad value, the bank, the budget
     * they sum to, or zero, which appears only as the wrong number a fixed bug used
     * to display.
     *
     * This is what caught a fourth stale squad value surviving the first three
     * fixes: the original tripwire read only its own source, so it could never see
     * a figure in the file it was written to protect.
     */
    const legitimate = new Set(
      [REPORTED_VALUE, CAPTURED_BANK, REPORTED_VALUE + CAPTURED_BANK, 0].map(
        (m) => m.toFixed(1),
      ),
    );
    const source = readFileSync("lib/fpl-live-server.ts", "utf8");
    const disagreeing = [...source.matchAll(/£\s*(\d[\d.]*)m/g)]
      .map((m) => m[1])
      .filter((figure) => !legitimate.has(figure));
    expect(
      disagreeing,
      `money in fpl-live-server.ts that the capture cannot produce — the constants `
        + `say ${[...legitimate].join(", ")}`,
    ).toEqual([]);
  });
});
