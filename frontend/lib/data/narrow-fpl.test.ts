/**
 * The FPL API is the one producer this repo cannot change, and these are the
 * assertions that say so out loud.
 *
 * Every other input to this app is published by its own pipeline: if a field
 * moves, the same commit moves the narrower. FPL ships when FPL ships. So the
 * question each test below asks is not "does this parse the file we have" — it is
 * "when a third party renames something, does the app say which field, or does it
 * throw `.map is not a function` inside a route handler".
 *
 * Shapes audited against the live API on 2026-09-06: 38 events, 20 teams, 4
 * element types, 653 elements, 380 fixtures, 19 past seasons.
 */
import { describe, expect, it } from "vitest";

import {
  narrowBootstrap, narrowEntry, narrowFixtures, narrowHistory,
} from "@/lib/data/narrow-fpl";

const event = (over: Record<string, unknown> = {}) => ({
  id: 4, name: "Gameweek 4", deadline_time: "2026-09-12T17:30:00Z",
  is_current: false, is_next: true, finished: false, ...over,
});
const element = (over: Record<string, unknown> = {}) => ({
  id: 411, first_name: "Erling", second_name: "Haaland", web_name: "Haaland",
  team: 13, element_type: 4, now_cost: 155, selected_by_percent: "71.2",
  status: "a", chance_of_playing_next_round: null, news: "", ep_next: "5.3",
  form: "5.0", points_per_game: "6.1", total_points: 24, minutes: 180,
  ict_index: "40.2", news_added: null, ...over,
});
const bootstrap = (over: Record<string, unknown> = {}) => ({
  events: [event()],
  teams: [{ id: 13, name: "Man City", short_name: "MCI" }],
  element_types: [{ id: 4, singular_name_short: "FWD" }],
  elements: [element()],
  ...over,
});

describe("bootstrap-static", () => {
  it("accepts the live shape", () => {
    const result = narrowBootstrap(bootstrap());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.elements[0].web_name).toBe("Haaland");
      expect(result.value.teams[0].short_name).toBe("MCI");
    }
  });

  it("keeps the two fields that are null on most of the league", () => {
    /* `chance_of_playing_next_round` and `news_added` are null on 421 of 653
       rows, which is what "nothing to report about this player" looks like.
       A narrower that rejected them would reject every healthy squad. */
    const result = narrowBootstrap(bootstrap());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.elements[0].chance_of_playing_next_round).toBeNull();
      expect(result.value.elements[0].news_added).toBeNull();
    }
  });

  it("names the field when a top-level list goes missing", () => {
    const result = narrowBootstrap({ ...bootstrap(), elements: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("elements");
  });

  it("refuses a file with no gameweeks rather than passing an empty list on", () => {
    /* Downstream, no events means `activeEvent` returns undefined and the route
       throws "returned no gameweeks" — a sentence about a symptom. Said here it
       is a sentence about the file. */
    const result = narrowBootstrap({ ...bootstrap(), events: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("no gameweeks");
  });

  it("refuses a file with no players, which resolves every squad id to nothing", () => {
    const result = narrowBootstrap({ ...bootstrap(), elements: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("no players");
  });

  it("names the row and the field when one element is wrong", () => {
    const result = narrowBootstrap({
      ...bootstrap(), elements: [element({ web_name: 42 })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("elements[0].web_name");
  });

  it("rejects a string id, which is how a renamed field usually arrives", () => {
    const result = narrowBootstrap({ ...bootstrap(), teams: [{ id: "13", name: "x", short_name: "MCI" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects HTML, which is what FPL serves under load", () => {
    expect(narrowBootstrap("<!doctype html>").ok).toBe(false);
    expect(narrowBootstrap(null).ok).toBe(false);
  });
});

describe("fixtures", () => {
  const fixture = (over: Record<string, unknown> = {}) => ({
    event: 4, kickoff_time: "2026-09-13T14:00:00Z", team_h: 13, team_a: 1,
    team_h_difficulty: 2, team_a_difficulty: 4, finished: false, ...over,
  });

  it("accepts the live shape", () => {
    const result = narrowFixtures([fixture()]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0].team_h_difficulty).toBe(2);
  });

  it("allows a fixture FPL has not assigned to a gameweek", () => {
    // A real state every season, and the reason `event` is not required.
    const result = narrowFixtures([fixture({ event: null, kickoff_time: null })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0].event).toBeNull();
  });

  it("defaults a missing difficulty to the middle rather than to zero", () => {
    /* Zero is not a difficulty FPL publishes — the scale is 1 to 5 — so a zero
       would colour a fixture at an end of the ramp it never earned. */
    const result = narrowFixtures([fixture({ team_h_difficulty: undefined })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0].team_h_difficulty).toBe(3);
  });

  it("names the row when a team id is missing", () => {
    const result = narrowFixtures([fixture({ team_a: undefined })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("fixtures[0].team_a");
  });

  it("rejects an object where an array belongs", () => {
    expect(narrowFixtures({ fixtures: [] }).ok).toBe(false);
  });
});

describe("entry and history", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 20945, name: "Jay's Team", player_first_name: "Jay",
    player_last_name: "Bansal", years_active: 15, favourite_team: 16,
    summary_overall_points: 173, summary_overall_rank: 3779095,
    last_deadline_bank: 0, ...over,
  });

  it("accepts the live shape", () => {
    const result = narrowEntry(entry());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Jay's Team");
  });

  it("allows the nulls that precede a ball being kicked", () => {
    // Points and rank are null for the first fortnight of every season.
    const result = narrowEntry(entry({
      summary_overall_points: null, summary_overall_rank: null,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary_overall_rank).toBeNull();
  });

  it("requires the two fields the app identifies an entry by", () => {
    expect(narrowEntry(entry({ id: undefined })).ok).toBe(false);
    expect(narrowEntry(entry({ name: null })).ok).toBe(false);
  });

  it("accepts a first-season manager with no past", () => {
    // Empty is a fact about the manager, not a fault in the file.
    const result = narrowHistory({ past: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.past).toHaveLength(0);
  });

  it("keeps the past seasons it can read and names the one it cannot", () => {
    const result = narrowHistory({
      past: [{ season_name: "2024/25", rank: 120000 }, { season_name: "2025/26" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("past[1].rank");
  });

  it("rejects a history that is not a record", () => {
    expect(narrowHistory([]).ok).toBe(false);
  });
});
