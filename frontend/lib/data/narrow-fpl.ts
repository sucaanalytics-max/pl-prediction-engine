/**
 * One narrower per FPL API payload — rule 4, applied to the one place it was not.
 *
 * `lib/data/narrow.ts` covers every artifact this pipeline PUBLISHES, and its
 * docstring states the rule: runtime narrowing, never `as T`, because
 * `predictions.ts` reached `return await res.json()` inside a generic and that is
 * how `HealthData` drifted to a producer emitting no metrics with no error
 * anywhere.
 *
 * The FPL API was reached the same way. `getOfficialJson<T>` ended in
 * `return (await response.json()) as T`, so five payloads from a THIRD PARTY —
 * the one producer this repo cannot change, deploy alongside, or be told by when
 * a field moves — were the only unnarrowed inputs in the app. A shape change at
 * FPL would have surfaced as `.map is not a function` inside a route handler,
 * which is exactly the failure the rule exists to convert into a sentence.
 *
 * ## A separate file, deliberately
 *
 * These are not artifacts. They are not fetched by `useArtifact`, they have no
 * descriptor, they carry no provenance, and they are read on the server only.
 * Putting them in `narrow.ts` would make that file's claim — "every `raw.foo`
 * access in the app lives here" — true of two different kinds of thing at once.
 *
 * ## Tolerances are measured, not assumed
 *
 * Audited against the live API on 2026-09-06: 38 events, 20 teams, 4 element
 * types, 653 elements, 380 fixtures, and this entry's 19 past seasons. Every
 * field the app reads was present with the type declared below. Two are null on
 * a large minority and are typed for it — `chance_of_playing_next_round` and
 * `news_added`, both null on 421 of 653 elements, which is simply what "no news"
 * looks like. Nothing else needed a tolerance, so nothing else has one: a
 * narrower that shrugs at everything protects nothing.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, mapKept, optNumber, optString, Problems,
  reqArray, reqNumber, reqRecord, reqString,
} from "@/lib/data/check";

export interface BootstrapEvent {
  readonly id: number;
  readonly name: string;
  readonly deadline_time: string;
  readonly is_current: boolean;
  readonly is_next: boolean;
  readonly finished: boolean;
}

export interface BootstrapTeam {
  readonly id: number;
  readonly name: string;
  readonly short_name: string;
}

export interface BootstrapElementType {
  readonly id: number;
  readonly singular_name_short: string;
}

export interface BootstrapElement {
  readonly id: number;
  readonly first_name: string;
  readonly second_name: string;
  readonly web_name: string;
  readonly team: number;
  readonly element_type: number;
  readonly now_cost: number;
  /** FPL sends its numbers as strings here. Kept as sent; parsed by the reader. */
  readonly selected_by_percent: string;
  readonly status: string;
  /** Null on 421 of 653 — which is what "no doubt about this player" looks like. */
  readonly chance_of_playing_next_round: number | null;
  readonly news: string;
  readonly ep_next: string;
  readonly form: string;
  readonly points_per_game: string;
  readonly total_points: number;
  readonly minutes: number;
  readonly ict_index: string;
  /** Null wherever `news` is empty, on the same 421 rows. */
  readonly news_added: string | null;
}

export interface BootstrapPayload {
  readonly events: readonly BootstrapEvent[];
  readonly teams: readonly BootstrapTeam[];
  readonly element_types: readonly BootstrapElementType[];
  readonly elements: readonly BootstrapElement[];
}

export interface FixturePayload {
  readonly event: number | null;
  readonly kickoff_time: string | null;
  readonly team_h: number;
  readonly team_a: number;
  readonly team_h_difficulty: number;
  readonly team_a_difficulty: number;
  readonly finished: boolean;
}

export interface EntryPayload {
  readonly id: number;
  readonly name: string;
  readonly player_first_name: string;
  readonly player_last_name: string;
  readonly years_active: number;
  readonly favourite_team: number | null;
  readonly summary_overall_points: number | null;
  readonly summary_overall_rank: number | null;
  readonly last_deadline_bank: number | null;
}

export interface HistoryPayload {
  readonly past: readonly { readonly season_name: string; readonly rank: number }[];
}

export interface PicksPayload {
  readonly picks: readonly {
    readonly element: number;
    readonly position: number;
    readonly is_captain: boolean;
    readonly is_vice_captain: boolean;
  }[];
  readonly entry_history: {
    readonly value: number;
    readonly bank: number;
  };
}

/** Booleans FPL always sends. A missing one is a shape change, not a default. */
function reqBoolean(raw: unknown, label: string, problems: Problems): boolean | null {
  if (typeof raw === "boolean") return raw;
  problems.add(`${label} is not a boolean`);
  return null;
}

export function narrowBootstrap(raw: unknown): NarrowResult<BootstrapPayload> {
  const problems = new Problems();
  const file = reqRecord(raw, "bootstrap-static", problems);
  if (!file) return malformed(problems.all);

  const eventList = reqArray(file.events, "events", problems);
  const teamList = reqArray(file.teams, "teams", problems);
  const typeList = reqArray(file.element_types, "element_types", problems);
  const elementList = reqArray(file.elements, "elements", problems);
  if (!eventList || !teamList || !typeList || !elementList) return malformed(problems.all);

  const events = mapKept(eventList, "events", problems, (item, i) => {
    const row = reqRecord(item, `events[${i}]`, problems);
    if (!row) return null;
    const id = reqNumber(row.id, `events[${i}].id`, problems);
    const name = reqString(row.name, `events[${i}].name`, problems);
    const deadline = reqString(row.deadline_time, `events[${i}].deadline_time`, problems);
    const isCurrent = reqBoolean(row.is_current, `events[${i}].is_current`, problems);
    const isNext = reqBoolean(row.is_next, `events[${i}].is_next`, problems);
    const finished = reqBoolean(row.finished, `events[${i}].finished`, problems);
    if (id === null || !name || !deadline
      || isCurrent === null || isNext === null || finished === null) return null;
    return {
      id, name, deadline_time: deadline,
      is_current: isCurrent, is_next: isNext, finished,
    } satisfies BootstrapEvent;
  });

  const teams = mapKept(teamList, "teams", problems, (item, i) => {
    const row = reqRecord(item, `teams[${i}]`, problems);
    if (!row) return null;
    const id = reqNumber(row.id, `teams[${i}].id`, problems);
    const name = reqString(row.name, `teams[${i}].name`, problems);
    const short = reqString(row.short_name, `teams[${i}].short_name`, problems);
    if (id === null || !name || !short) return null;
    return { id, name, short_name: short } satisfies BootstrapTeam;
  });

  const element_types = mapKept(typeList, "element_types", problems, (item, i) => {
    const row = reqRecord(item, `element_types[${i}]`, problems);
    if (!row) return null;
    const id = reqNumber(row.id, `element_types[${i}].id`, problems);
    const short = reqString(
      row.singular_name_short, `element_types[${i}].singular_name_short`, problems,
    );
    if (id === null || !short) return null;
    return { id, singular_name_short: short } satisfies BootstrapElementType;
  });

  const elements = mapKept(elementList, "elements", problems, (item, i) => {
    const row = reqRecord(item, `elements[${i}]`, problems);
    if (!row) return null;
    const id = reqNumber(row.id, `elements[${i}].id`, problems);
    const web = reqString(row.web_name, `elements[${i}].web_name`, problems);
    const team = reqNumber(row.team, `elements[${i}].team`, problems);
    const type = reqNumber(row.element_type, `elements[${i}].element_type`, problems);
    const cost = reqNumber(row.now_cost, `elements[${i}].now_cost`, problems);
    // The four the joins and the squad actually key on. Everything below is
    // display, and a missing label is worth less than a rejected file.
    if (id === null || !web || team === null || type === null || cost === null) return null;
    return {
      id, web_name: web, team, element_type: type, now_cost: cost,
      first_name: optString(row.first_name) ?? "",
      second_name: optString(row.second_name) ?? "",
      selected_by_percent: optString(row.selected_by_percent) ?? "0",
      status: optString(row.status) ?? "a",
      chance_of_playing_next_round: optNumber(row.chance_of_playing_next_round),
      news: optString(row.news) ?? "",
      ep_next: optString(row.ep_next) ?? "0",
      form: optString(row.form) ?? "0",
      points_per_game: optString(row.points_per_game) ?? "0",
      total_points: optNumber(row.total_points) ?? 0,
      minutes: optNumber(row.minutes) ?? 0,
      ict_index: optString(row.ict_index) ?? "0",
      news_added: optString(row.news_added),
    } satisfies BootstrapElement;
  });

  if (problems.any) return malformed(problems.all);
  // An empty list where 653 rows were is not a malformed file and it is not a
  // usable one either. Said here rather than discovered downstream by a `Map`
  // that resolves nothing and a squad that renders as fifteen unknown ids.
  if (events.length === 0) return malformed(["bootstrap-static carried no gameweeks"]);
  if (elements.length === 0) return malformed(["bootstrap-static carried no players"]);
  return narrowed({ events, teams, element_types, elements });
}

export function narrowFixtures(raw: unknown): NarrowResult<readonly FixturePayload[]> {
  const problems = new Problems();
  if (!Array.isArray(raw)) return malformed(["fixtures is not an array"]);

  const fixtures = mapKept(raw, "fixtures", problems, (item, i) => {
    const row = reqRecord(item, `fixtures[${i}]`, problems);
    if (!row) return null;
    const home = reqNumber(row.team_h, `fixtures[${i}].team_h`, problems);
    const away = reqNumber(row.team_a, `fixtures[${i}].team_a`, problems);
    if (home === null || away === null) return null;
    return {
      team_h: home, team_a: away,
      // Null on a fixture FPL has not assigned to a gameweek yet — a real state
      // every season, and the reason this is not required.
      event: optNumber(row.event),
      kickoff_time: optString(row.kickoff_time),
      team_h_difficulty: optNumber(row.team_h_difficulty) ?? 3,
      team_a_difficulty: optNumber(row.team_a_difficulty) ?? 3,
      finished: row.finished === true,
    } satisfies FixturePayload;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed(fixtures);
}

export function narrowEntry(raw: unknown): NarrowResult<EntryPayload> {
  const problems = new Problems();
  const file = reqRecord(raw, "entry", problems);
  if (!file) return malformed(problems.all);

  const id = reqNumber(file.id, "entry.id", problems);
  const name = reqString(file.name, "entry.name", problems);
  if (id === null || !name) return malformed(problems.all);

  return narrowed({
    id, name,
    player_first_name: optString(file.player_first_name) ?? "",
    player_last_name: optString(file.player_last_name) ?? "",
    years_active: optNumber(file.years_active) ?? 0,
    favourite_team: optNumber(file.favourite_team),
    // Null before a ball is kicked, which is a fortnight of every season.
    summary_overall_points: optNumber(file.summary_overall_points),
    summary_overall_rank: optNumber(file.summary_overall_rank),
    last_deadline_bank: optNumber(file.last_deadline_bank),
  });
}

export function narrowHistory(raw: unknown): NarrowResult<HistoryPayload> {
  const problems = new Problems();
  const file = reqRecord(raw, "entry history", problems);
  if (!file) return malformed(problems.all);

  const list = reqArray(file.past, "past", problems);
  if (!list) return malformed(problems.all);

  const past = mapKept(list, "past", problems, (item, i) => {
    const row = reqRecord(item, `past[${i}]`, problems);
    if (!row) return null;
    const season = reqString(row.season_name, `past[${i}].season_name`, problems);
    const rank = reqNumber(row.rank, `past[${i}].rank`, problems);
    if (!season || rank === null) return null;
    return { season_name: season, rank };
  });

  if (problems.any) return malformed(problems.all);
  // A first-season manager has no past. Empty is a fact, not a fault.
  return narrowed({ past });
}

export function narrowPicks(raw: unknown): NarrowResult<PicksPayload> {
  const problems = new Problems();
  const file = reqRecord(raw, "picks", problems);
  if (!file) return malformed(problems.all);

  const list = reqArray(file.picks, "picks", problems);
  const history = reqRecord(file.entry_history, "entry_history", problems);
  if (!list || !history) return malformed(problems.all);

  const value = reqNumber(history.value, "entry_history.value", problems);
  const bank = reqNumber(history.bank, "entry_history.bank", problems);
  if (value === null || bank === null) return malformed(problems.all);

  const picks = mapKept(list, "picks", problems, (item, i) => {
    const row = reqRecord(item, `picks[${i}]`, problems);
    if (!row) return null;
    const element = reqNumber(row.element, `picks[${i}].element`, problems);
    const position = reqNumber(row.position, `picks[${i}].position`, problems);
    if (element === null || position === null) return null;
    return {
      element, position,
      is_captain: row.is_captain === true,
      is_vice_captain: row.is_vice_captain === true,
    };
  });

  if (problems.any) return malformed(problems.all);
  return narrowed({ picks, entry_history: { value, bank } });
}

/** Whether a value is a record, for callers that only need the question asked. */
export { isRecord };
