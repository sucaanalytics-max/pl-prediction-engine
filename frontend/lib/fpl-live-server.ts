import "server-only";

import {
  FPL_API_BASE,
  FPL_ENTRY_ID,
  type FplFixtureMatrixRow,
  type FplFixtureView,
  type FplLivePlayer,
  type FplLiveState,
  positionFromFpl,
} from "./fpl-live";
import {
  buildTopTenRankings,
  buildCaptaincyPlan,
  buildMultiTransferPlans,
  recommendTransfers,
  scoreFplPlayers,
} from "./fpl-ranking-engine";
import {
  getFplReviewProjection,
  getFplReviewSnapshot,
} from "./fplreview-projections";

interface BootstrapEvent {
  id: number;
  name: string;
  deadline_time: string;
  is_current: boolean;
  is_next: boolean;
  finished: boolean;
}

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

interface BootstrapElementType {
  id: number;
  singular_name_short: string;
}

interface BootstrapElement {
  id: number;
  first_name: string;
  second_name: string;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  selected_by_percent: string;
  status: string;
  chance_of_playing_next_round: number | null;
  news: string;
  ep_next: string;
  form: string;
  points_per_game: string;
  total_points: number;
  minutes: number;
  ict_index: string;
  news_added: string | null;
}

interface BootstrapPayload {
  events: BootstrapEvent[];
  teams: BootstrapTeam[];
  element_types: BootstrapElementType[];
  elements: BootstrapElement[];
}

interface FixturePayload {
  event: number | null;
  kickoff_time: string | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  finished: boolean;
}

interface EntryPayload {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  years_active: number;
  favourite_team: number | null;
  summary_overall_points: number | null;
  summary_overall_rank: number | null;
  last_deadline_bank: number | null;
}

interface HistoryPayload {
  past: Array<{ season_name: string; rank: number }>;
}

export interface PicksPayload {
  picks: Array<{
    element: number;
    position: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
  entry_history: {
    value: number;
    bank: number;
  };
}

export interface DraftPick {
  elementId: number;
  position: number;
  bench: boolean;
  status?: "captain" | "vice";
}

// Captured from the authenticated FPL UI (entry 20945) on 13 August 2026. The
// public picks endpoint is intentionally unavailable before the GW1 deadline, so
// this is explicitly labelled as a captured draft and enriched from live official
// player data.
//
// ## Why this was replaced, and why the date matters
//
// The previous capture was 28 July, and by 13 August the real squad had diverged
// almost completely: of these fifteen only Szoboszlai and Thiago appeared in the
// old list. So every number this app derived — the squad board, the transfer
// suggestion, the captaincy line — was about a team the manager no longer had.
// That is worse than showing nothing, because it is specific and wrong, and the
// only tell was a `capturedAt` date in a tooltip.
//
// Verified rather than transcribed: each row was resolved from the bootstrap by
// (surname, club, position) with a refusal on any ambiguous match, and the resulting
// prices sum to exactly the squad value the FPL UI reported, leaving exactly the
// bank below. `captured-draft.test.ts` asserts that against `REPORTED_VALUE` — the
// figure is not repeated here, because the last three times it was, the prose kept
// the old capture's total while the constants moved on.
//
// This will go stale the same way. It is only reachable while FPL keeps GW1 picks
// private; the moment the deadline passes, `picks` is served and this is unused.
export const CAPTURED_DRAFT_AT = "2026-08-18T00:00:00.000Z";

/**
 * The bank, from the same capture.
 *
 * Captured because it is unobtainable otherwise: FPL's entry endpoint reports
 * `last_deadline_bank: null` until a deadline has passed, so before GW1 there is no
 * API route to it at all. Without it every transfer suggestion is evaluated against
 * a budget of zero and silently limited to like-for-like swaps.
 *
 * This is NOT the null-to-zero coercion fixed earlier in this file. That invented a
 * measurement the API had not made; this records one the FPL UI displayed, next to
 * the squad it was displayed with, dated. When the deadline passes, `picks` carries
 * the real bank and this is unused.
 */
export const CAPTURED_BANK = 0.5;
export const CAPTURED_DRAFT: DraftPick[] = [
  // Recaptured 2026-08-18 from the FPL squad screen, before the GW1 deadline.
  // Element ids were resolved against live bootstrap-static by web_name + club,
  // not hand-typed: ten of the fifteen match the previous capture independently,
  // and the fifteen now_cost values sum to £99.5m, which leaves exactly the
  // £0.5m bank the UI showed. A squad that does not sum to £100.0m against its
  // bank has been mistranscribed.
  { elementId: 109, position: 1, bench: false },                     // Verbruggen
  { elementId: 152, position: 2, bench: false },                     // Palestra
  { elementId: 4, position: 3, bench: false },                       // Gabriel
  { elementId: 418, position: 4, bench: false },                     // Maguire
  { elementId: 426, position: 5, bench: false, status: "captain" },   // B.Fernandes
  { elementId: 94, position: 6, bench: false },                      // Schade
  { elementId: 427, position: 7, bench: false, status: "vice" },      // Mbeumo
  { elementId: 542, position: 8, bench: false },                     // E.Le Fée
  { elementId: 379, position: 9, bench: false },                     // Isak
  { elementId: 165, position: 10, bench: false },                     // João Pedro
  { elementId: 106, position: 11, bench: false },                     // Thiago
  { elementId: 496, position: 12, bench: true },                      // Kinsky
  { elementId: 368, position: 13, bench: true },                      // Szoboszlai
  { elementId: 113, position: 14, bench: true },                      // F.Kadıoğlu
  { elementId: 173, position: 15, bench: true },                      // Thomas
];

async function getOfficialJson<T>(path: string, allowNotFound = false): Promise<T | null> {
  const response = await fetch(`${FPL_API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    next: { revalidate: 900 },
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Official FPL API ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function activeEvent(events: BootstrapEvent[]) {
  return (
    events.find((event) => event.is_current) ??
    events.find((event) => event.is_next) ??
    events.find((event) => !event.finished) ??
    events[events.length - 1]
  );
}

/**
 * The gameweek a manager can still act on, which is not always the current one.
 *
 * FPL keeps an event `is_current` from its own deadline until the NEXT one, so for
 * the days between a gameweek's last match and the following deadline,
 * `activeEvent` names a week already played. `activeEvent` is right about FPL and
 * stays as it is — the picks endpoint and the reported event both want the real
 * current week. What must not use it is anything forward-looking.
 *
 * Measured in production on 2026-08-26, five days after GW1's last match and two
 * before GW2's deadline: Raya's fixture list began
 * `{gameweek: 1, label: "COV (H)", difficulty: 2}` — a match already played — while
 * his real next fixture was `{gameweek: 2, label: "AVL (A)", difficulty: 4}`. The
 * call screen therefore paired GW2 projections with GW1 opponents, and because the
 * chip is tinted by difficulty, it painted a hard away trip in the green reserved
 * for a kind fixture. The one place this app lets colour carry a verdict was
 * saying the opposite of the truth, for every club whose two weeks differ.
 *
 * Same root cause as the fix in lib/data/gameweek.ts, on the path that fix did not
 * reach: that one corrects which ARTIFACT is read, this one corrects which FIXTURE
 * is called next.
 */
export function planningEventId(events: BootstrapEvent[], now: Date): number {
  const active = activeEvent(events);
  if (!active) return 1;
  const deadline = Date.parse(active.deadline_time ?? "");
  // An unparseable or absent deadline is not a passed one: without it there is no
  // evidence the week has closed, and rolling forward on no evidence would point
  // every fixture chip at a week that may not be next.
  if (Number.isNaN(deadline) || deadline > now.getTime()) return active.id;
  const next = events.find((event) => event.id === active.id + 1);
  return next ? next.id : active.id;
}

/** Gameweeks of fixtures the matrix covers. Eight is what `fixture_xg` carries. */
const FIXTURE_HORIZON = 8;

function fixtureViews(
  teamId: number,
  eventId: number,
  fixtures: FixturePayload[],
  teams: Map<number, BootstrapTeam>
): FplFixtureView[] {
  return fixtures
    .filter(
      (fixture) =>
        fixture.event !== null &&
        fixture.event >= eventId &&
        fixture.event < eventId + 10 &&
        (fixture.team_h === teamId || fixture.team_a === teamId)
    )
    .sort((left, right) => {
      if (left.event !== right.event) return (left.event ?? 0) - (right.event ?? 0);
      return (left.kickoff_time ?? "").localeCompare(right.kickoff_time ?? "");
    })
    .map((fixture) => {
      const isHome = fixture.team_h === teamId;
      const opponentId = isHome ? fixture.team_a : fixture.team_h;
      const opponent = teams.get(opponentId)?.short_name ?? `T${opponentId}`;
      const difficulty = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty;
      return {
        gameweek: fixture.event as number,
        label: `${opponent} (${isHome ? "H" : "A"})`,
        difficulty: Math.min(5, Math.max(1, difficulty)) as 1 | 2 | 3 | 4 | 5,
        kickoffTime: fixture.kickoff_time,
      };
    });
}

/**
 * Every club's next fixtures, with FPL's official difficulty.
 *
 * ## Why this is a first-class part of the payload
 *
 * The fixture matrix is the screen Solio and FPL Review both put front and centre,
 * and the question a manager actually asks when drafting: who has the kindest
 * opening run. We had the data on every request — `/fixtures/` carries
 * `team_h_difficulty` and `team_a_difficulty` — and exposed it only nested inside
 * individual players, so no screen could show the league.
 *
 * `fixtureViews` already does the per-team work, including the home/away
 * orientation that decides whether a difficulty belongs to this club or its
 * opponent. Reused rather than reimplemented: that orientation is the single
 * easiest thing to invert, and an inversion produces a perfectly plausible grid.
 */
function fixtureMatrix(
  eventId: number,
  fixtures: FixturePayload[],
  teams: Map<number, BootstrapTeam>,
  horizon: number,
): FplFixtureMatrixRow[] {
  const rows: FplFixtureMatrixRow[] = [];

  for (const [teamId, team] of teams) {
    const upcoming = fixtureViews(teamId, eventId, fixtures, teams)
      .filter((view) => view.gameweek < eventId + horizon);
    if (upcoming.length === 0) continue;

    // Summed over the horizon, so the table can sort by "kindest run first".
    // A blank gameweek contributes nothing rather than a neutral 3, because a
    // fixture that does not exist is not an average-difficulty fixture.
    const total = upcoming.reduce((sum, view) => sum + view.difficulty, 0);

    rows.push({
      teamId,
      team: team.name,
      shortName: team.short_name,
      fixtures: upcoming,
      totalDifficulty: total,
      // The mean over fixtures that exist, which is what makes clubs with a blank
      // comparable to clubs without one.
      meanDifficulty: Math.round((total / upcoming.length) * 100) / 100,
      played: upcoming.length,
    });
  }

  return rows.sort((left, right) => left.meanDifficulty - right.meanDifficulty);
}

function formation(players: FplLivePlayer[]) {
  const starters = players.filter((player) => !player.bench);
  return (["DEF", "MID", "FWD"] as const)
    .map((position) => starters.filter((player) => player.position === position).length)
    .join("-");
}

function historySummary(history: HistoryPayload) {
  const ranked = history.past.filter((season) => Number.isFinite(season.rank));
  const best = [...ranked].sort((left, right) => left.rank - right.rank)[0] ?? null;
  const latest = ranked[ranked.length - 1] ?? null;
  return {
    bestRank: best?.rank ?? null,
    bestSeason: best?.season_name ?? null,
    latestRank: latest?.rank ?? null,
    latestSeason: latest?.season_name ?? null,
  };
}

/** FPL's squad size. A picks payload with any other count is not a squad. */
const SQUAD_SIZE = 15;

/**
 * FPL's picks payload, but only when it is actually a squad.
 *
 * The switch from the captured draft to live picks was `picks ? … : CAPTURED_DRAFT`, so
 * the only shape that fell back safely was an exact 404. A 200 carrying `picks: []` —
 * which is what an endpoint that is up but has not yet materialised a team returns —
 * produced an EMPTY squad labelled `official_public`, and a payload missing the key threw
 * inside `.map` and took the whole route down. Both land on Friday, when this path is
 * exercised for the first time this season and the API is under its heaviest load of the
 * week.
 *
 * Nine separate decisions read this value — the squad, the bank, the value, the source,
 * the notices, the source label, `capturedAt`, `isOfficial` and `freshness.squad` — so it
 * is validated once, here, rather than at any of them. A partial trust would label a
 * captured squad "official", which is worse than either honest answer.
 *
 * An unusable payload falls back to the captured draft rather than to nothing: the draft
 * carries its own date and says on screen that it is a capture, which is Rule 1 exactly —
 * the last known answer with its age, never a blank.
 */
export function usableSquad(payload: PicksPayload | null): PicksPayload | null {
  if (!payload || !Array.isArray(payload.picks)) return null;
  if (payload.picks.length !== SQUAD_SIZE) return null;

  const history = payload.entry_history as PicksPayload["entry_history"] | undefined;
  if (!history || typeof history !== "object") return null;
  if (!Number.isFinite(history.bank) || !Number.isFinite(history.value)) return null;

  for (const pick of payload.picks) {
    if (!Number.isFinite(pick.element) || !Number.isFinite(pick.position)) return null;
  }
  return payload;
}

export async function buildFplLiveState(): Promise<FplLiveState> {
  const [bootstrap, fixtures, entry, history] = await Promise.all([
    getOfficialJson<BootstrapPayload>("/bootstrap-static/"),
    getOfficialJson<FixturePayload[]>("/fixtures/"),
    getOfficialJson<EntryPayload>(`/entry/${FPL_ENTRY_ID}/`),
    getOfficialJson<HistoryPayload>(`/entry/${FPL_ENTRY_ID}/history/`),
  ]);

  if (!bootstrap || !fixtures || !entry || !history) {
    throw new Error("Official FPL core data is incomplete");
  }

  const event = activeEvent(bootstrap.events);
  // Forward-looking reads use this; `event` stays FPL's own current week.
  const planningId = planningEventId(bootstrap.events, new Date());
  if (!event) throw new Error("Official FPL API returned no gameweeks");

  const picksResponse = await getOfficialJson<PicksPayload>(
    `/entry/${FPL_ENTRY_ID}/event/${event.id}/picks/`,
    true
  );
  // Validated at the boundary, so every downstream decision reads one answer.
  const picks = usableSquad(picksResponse);
  /*
   * Served, but not a squad. Distinct from "not served", because the two mean opposite
   * things: before the deadline FPL withholds picks by design and the capture is the
   * right answer; after it, a payload that is not a squad means something is wrong at
   * FPL and the capture may be out of date. The reader is told which they are looking at.
   */
  const picksRejected = picksResponse !== null && picks === null;
  const teamById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const positionById = new Map(
    bootstrap.element_types.map((position) => [position.id, position.singular_name_short])
  );
  const elementById = new Map(bootstrap.elements.map((element) => [element.id, element]));

  const selected: DraftPick[] = picks
    ? picks.picks.map((pick) => ({
        elementId: pick.element,
        position: pick.position,
        bench: pick.position > 11,
        status: pick.is_captain ? "captain" : pick.is_vice_captain ? "vice" : undefined,
      }))
    : CAPTURED_DRAFT;

  const players = selected.map<FplLivePlayer>((pick) => {
    const element = elementById.get(pick.elementId);
    if (!element) {
      throw new Error(`FPL element ${pick.elementId} is missing from bootstrap-static`);
    }
    const team = teamById.get(element.team);
    const playerFixtures = fixtureViews(element.team, planningId, fixtures, teamById);
    const nextFixture = playerFixtures[0] ?? {
      gameweek: event.id,
      label: "TBC",
      difficulty: 3 as const,
      kickoffTime: null,
    };
    const rawPosition = positionById.get(element.element_type) ?? "UNK";

    return {
      elementId: element.id,
      pickPosition: pick.position,
      name: element.first_name === "Alisson" ? "Alisson" : element.web_name,
      team: team?.short_name ?? `T${element.team}`,
      position: positionFromFpl(rawPosition),
      price: element.now_cost / 10,
      ownership: Number.parseFloat(element.selected_by_percent) || 0,
      fixture: nextFixture.label,
      difficulty: nextFixture.difficulty,
      fixtures: playerFixtures,
      status:
        pick.status ??
        (element.status !== "a" || element.news ? "monitor" : undefined),
      bench: pick.bench,
      chanceOfPlaying: element.chance_of_playing_next_round,
      news: element.news ?? "",
    };
  });

  // Resolved once, above the loop. `null` whenever no FPLReview export is on
  // disk, which is the normal case off this machine — the projection is then
  // omitted per player rather than the request failing.
  const projectionSnapshot = getFplReviewSnapshot();

  const rankedPlayers = scoreFplPlayers(
    bootstrap.elements.map((element) => {
      const team = teamById.get(element.team);
      const rawPosition = positionById.get(element.element_type) ?? "UNK";
      const review = getFplReviewProjection(element.id);
      return {
        elementId: element.id,
        name: element.first_name === "Alisson" ? "Alisson" : element.web_name,
        team: team?.short_name ?? `T${element.team}`,
        position: positionFromFpl(rawPosition),
        price: element.now_cost / 10,
        ownership: Number.parseFloat(element.selected_by_percent) || 0,
        status: element.status,
        chanceOfPlaying: element.chance_of_playing_next_round,
        news: element.news ?? "",
        fixtures: fixtureViews(element.team, planningId, fixtures, teamById),
        epNext: Number.parseFloat(element.ep_next) || 0,
        form: Number.parseFloat(element.form) || 0,
        pointsPerGame: Number.parseFloat(element.points_per_game) || 0,
        totalPoints: element.total_points || 0,
        minutes: element.minutes || 0,
        ictIndex: Number.parseFloat(element.ict_index) || 0,
        newsUpdatedAt: element.news_added,
        reviewProjection:
          review && projectionSnapshot
            ? {
                exportedAt: projectionSnapshot.exportedAt,
                eliteOwnership: review.eliteOwnership,
                buyValue: review.buyValue,
                sellValue: review.sellValue,
                gameweeks: review.projectedPoints.map((projectedPoints, index) => ({
                  gameweek: projectionSnapshot.gameweeks[index],
                  expectedMinutes: review.expectedMinutes[index],
                  projectedPoints,
                })),
              }
            : null,
      };
    })
  );
  const rankedById = new Map(
    rankedPlayers.map((player) => [player.elementId, player])
  );
  const matchedPlayers = bootstrap.elements.filter((element) =>
    Boolean(getFplReviewProjection(element.id))
  ).length;
  const rankedSquad = selected
    .map((pick) => rankedById.get(pick.elementId))
    .filter((player): player is NonNullable<typeof player> => Boolean(player));
  // Unknown is null, never 0.
  //
  // FPL reports `last_deadline_bank: null` before a squad's first deadline — it
  // is the API saying "no deadline has passed", not "no money". Coercing it to 0
  // rendered "£0.0m in the bank" on the squad board: a specific, wrong,
  // decision-relevant number that looks like a measurement. £0.0m and "unknown"
  // lead to opposite transfer decisions, and the consumer type
  // (`fpl-live.ts:188`) has always been `number | null`, so the null had a place
  // to go the whole time.
  // Order matters: the API first, then the capture, then null. A captured value
  // must never shadow a live one — the moment `picks` exists it is authoritative,
  // and `CAPTURED_BANK` is only reachable on the same pre-deadline path that
  // reaches `CAPTURED_DRAFT`, so the squad and its bank always come from the same
  // observation rather than from two different days.
  const bank = picks
    ? picks.entry_history.bank / 10
    : entry.last_deadline_bank !== null
      ? entry.last_deadline_bank / 10
      : CAPTURED_BANK;

  // What the transfer recommenders get, which is a different question.
  //
  // They do arithmetic against a budget, so they need a number. Zero is the
  // right number for "unknown" *here* and the wrong one for the display: an
  // under-stated budget recommends a transfer you can definitely afford, while
  // an over-stated one recommends a move you cannot make. Same asymmetry as
  // under- versus over-staking. The two uses are separated so neither has to
  // compromise for the other.
  const spendableBank = bank ?? 0;
  const now = new Date().toISOString();
  // The per-player availability evidence block used to be built here and is
  // gone: `/evidence` reads `evidence_view.json`, which carries the claim
  // tree and every losing claim, and this duplicate carried neither. It was
  // a scan of every flagged element per request for a block no page read.

  const phase = bootstrap.events.every((candidate) => candidate.finished)
    ? "finished"
    : event.is_current
      ? "live"
      : "preseason";
  const value = picks?.entry_history.value
    ? picks.entry_history.value / 10
    : players.reduce((total, player) => total + player.price, 0);
  const source = picks ? "official_public" : "captured_authenticated_draft";
  // `en-GB`/`UTC` explicitly: the default locale of whatever machine renders this
  // would otherwise decide the format, and the default zone could roll the date
  // back a day for a westward reader — a provenance line that disagrees with the
  // `capturedAt` beside it by a day is worse than no date.
  const capturedOn = new Date(CAPTURED_DRAFT_AT).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
  const notices = picks
    ? ["Squad synced from the official public gameweek picks endpoint."]
    : picksRejected
    ? [
        "FPL answered for this entry but did not return a fifteen-player squad, so the "
          + `captured draft of ${capturedOn} is shown instead. If the deadline has passed, `
          + "this squad may no longer be the one that is set.",
        "Official prices, clubs, availability flags and the next ten fixtures are refreshed from FPL.",
      ]
    : [
        // Derived from `CAPTURED_DRAFT_AT` rather than written out again. This
        // line said "28 Jul" across the entire life of the 13 Aug capture that
        // replaced it — a stale provenance note on the exact panel whose job is
        // to say how stale the squad is, which is the failure it warns about.
        `GW1 picks remain private before the deadline; the squad is the authenticated draft captured on ${capturedOn}.`,
        "Official prices, clubs, availability flags and the next ten fixtures are refreshed from FPL.",
        // Derived from `projectionSnapshot`, never written out. The line above
        // records why: a hardcoded provenance date went stale and misdescribed
        // the very panel whose job is to say how stale things are. This line
        // committed the same fault in a worse place: it named the premium
        // snapshot, and a fixed August date, unconditionally,
        // while the export is gitignored (`.gitignore:68`) and therefore absent
        // from every deployment. So production asserted a premium source it did
        // not have, for a projection that had silently fallen back to a fixture
        // heuristic, with a date that was wrong even locally.
        projectionSnapshot
          ? `Player EV and expected minutes use the private FPLReview snapshot exported on ${new Date(
              projectionSnapshot.exportedAt,
            ).toLocaleDateString("en-GB", {
              day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
            })}.`
          : "No FPLReview export is available here, so player EV and expected minutes are a fixture-difficulty estimate from official FPL fields — not a premium projection.",
      ];

  return {
    schemaVersion: 4,
    generatedAt: now,
    season: "2026/27",
    entry: {
      id: entry.id,
      teamName: entry.name,
      managerName: `${entry.player_first_name} ${entry.player_last_name}`.trim(),
      yearsActive: entry.years_active,
      overallPoints: entry.summary_overall_points,
      overallRank: entry.summary_overall_rank,
      favouriteTeam: entry.favourite_team
        ? teamById.get(entry.favourite_team)?.name ?? null
        : null,
    },
    event: {
      id: event.id,
      name: event.name,
      deadlineTime: event.deadline_time,
      phase,
    },
    fixtureMatrix: fixtureMatrix(planningId, fixtures, teamById, FIXTURE_HORIZON),
    squad: {
      source,
      sourceLabel: picks ? "Official public GW picks" : "Captured authenticated preseason draft",
      capturedAt: picks ? now : CAPTURED_DRAFT_AT,
      isOfficial: Boolean(picks),
      players,
      value: Math.round(value * 10) / 10,
      bank,
      formation: formation(players),
    },
    freshness: {
      catalog: "live",
      fixtures: "live",
      manager: "live",
      squad: picks ? "live" : "captured",
      persistence: "unconfigured",
    },
    history: historySummary(history),
    projections: {
      // `fallback` was declared in `FplLiveState` from the start and nothing
      // could ever produce it, because the snapshot was a static import: if the
      // export was missing the build failed rather than the branch being taken.
      // Reading it at runtime is what finally makes the absent case reachable.
      source: projectionSnapshot ? "fplreview_csv_snapshot" : "fallback",
      sourceLabel: projectionSnapshot
        ? "FPLReview premium CSV snapshot"
        : "No FPLReview export available — official FPL fields only",
      exportedAt: projectionSnapshot?.exportedAt ?? null,
      horizonGameweeks: projectionSnapshot?.gameweeks.length ?? 0,
      matchedPlayers,
      officialPlayers: bootstrap.elements.length,
      coveragePercent: Math.round(
        (matchedPlayers / Math.max(1, bootstrap.elements.length)) * 1000
      ) / 10,
      // `players` used to duplicate every ranked player here. Nothing read it:
      // the ranked lists come from `rankings`, and the projections block is
      // consumed only for its provenance. ~600 rows serialised per request for
      // no consumer.
      caveats: [
        "Projection values are a dated private snapshot, not a live FPLReview API connection.",
        "Official FPL remains authoritative for current price, club, fixtures and player availability.",
        "A newer official injury flag reduces the first-week projection until the next FPLReview import.",
      ],
    },
    rankings: buildTopTenRankings(rankedPlayers),
    recommendations: {
      transfers4: recommendTransfers({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank: spendableBank,
        horizon: 4,
      }),
      multiTransferPlans4: buildMultiTransferPlans({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank: spendableBank,
        horizon: 4,
      }),
      captaincyPlan: buildCaptaincyPlan(rankedSquad, planningId),
      // Names what actually produced these numbers. Without the export they
      // come from the heuristic engine alone, and saying `fplreview-...`
      // anyway would credit a source that contributed nothing.
      modelVersion: projectionSnapshot
        ? `fplreview-${projectionSnapshot.exportedAt.slice(0, 10)}`
        : "heuristic-only",
      provisional: true,
      methodology: [
        "FPLReview premium expected minutes and points across the next ten Gameweeks.",
        "Official FPL prices, ownership, availability and fixtures refreshed every 15 minutes.",
        "Official player news newer than the projection export overlays first-week availability.",
        "Legal single-player moves only: same position, affordable and no more than three per club.",
      ],
    },
    notices,
  };
}
