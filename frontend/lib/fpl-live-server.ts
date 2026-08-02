import "server-only";

import {
  FPL_API_BASE,
  FPL_ENTRY_ID,
  type FplEvidenceItem,
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

interface PicksPayload {
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

interface DraftPick {
  elementId: number;
  position: number;
  bench: boolean;
  status?: "captain" | "vice";
}

// Captured from the authenticated FPL UI on 28 July 2026. The public picks
// endpoint is intentionally unavailable before GW1, so this is explicitly
// labelled as a captured draft and is enriched from live official player data.
const CAPTURED_DRAFT_AT = "2026-07-28T00:00:00.000Z";
const CAPTURED_DRAFT: DraftPick[] = [
  { elementId: 350, position: 1, bench: false, status: "vice" },
  { elementId: 387, position: 2, bench: false },
  { elementId: 229, position: 3, bench: false },
  { elementId: 388, position: 4, bench: false },
  { elementId: 200, position: 5, bench: false },
  { elementId: 13, position: 6, bench: false },
  { elementId: 40, position: 7, bench: false },
  { elementId: 452, position: 8, bench: false },
  { elementId: 155, position: 9, bench: false },
  { elementId: 379, position: 10, bench: false },
  { elementId: 106, position: 11, bench: false, status: "captain" },
  { elementId: 251, position: 12, bench: true },
  { elementId: 61, position: 13, bench: true },
  { elementId: 368, position: 14, bench: true },
  { elementId: 25, position: 15, bench: true },
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
        fixture.event < eventId + 6 &&
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
  if (!event) throw new Error("Official FPL API returned no gameweeks");

  const picks = await getOfficialJson<PicksPayload>(
    `/entry/${FPL_ENTRY_ID}/event/${event.id}/picks/`,
    true
  );
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
    const playerFixtures = fixtureViews(element.team, event.id, fixtures, teamById);
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

  const rankedPlayers = scoreFplPlayers(
    bootstrap.elements.map((element) => {
      const team = teamById.get(element.team);
      const rawPosition = positionById.get(element.element_type) ?? "UNK";
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
        fixtures: fixtureViews(element.team, event.id, fixtures, teamById),
        epNext: Number.parseFloat(element.ep_next) || 0,
        form: Number.parseFloat(element.form) || 0,
        pointsPerGame: Number.parseFloat(element.points_per_game) || 0,
        totalPoints: element.total_points || 0,
        minutes: element.minutes || 0,
        ictIndex: Number.parseFloat(element.ict_index) || 0,
      };
    })
  );
  const rankedById = new Map(
    rankedPlayers.map((player) => [player.elementId, player])
  );
  const rankedSquad = selected
    .map((pick) => rankedById.get(pick.elementId))
    .filter((player): player is NonNullable<typeof player> => Boolean(player));
  const bank = picks
    ? picks.entry_history.bank / 10
    : entry.last_deadline_bank === null
      ? 0
      : entry.last_deadline_bank / 10;
  const now = new Date().toISOString();
  const targetIds = new Set(
    buildTopTenRankings(rankedPlayers).overall.map((player) => player.elementId)
  );
  const squadIds = new Set(selected.map((pick) => pick.elementId));
  const evidenceItems = bootstrap.elements
    .filter(
      (element) =>
        element.status !== "a" ||
        Boolean(element.news) ||
        element.chance_of_playing_next_round !== null
    )
    .map<FplEvidenceItem>((element) => {
      const ranked = rankedById.get(element.id);
      const team = teamById.get(element.team);
      const rawPosition = positionById.get(element.element_type) ?? "UNK";
      const chance = element.chance_of_playing_next_round;
      const severity =
        element.status === "i" ||
        element.status === "s" ||
        element.status === "u" ||
        chance === 0
          ? "critical"
          : chance !== null && chance <= 50
            ? "warning"
            : "monitor";
      const playerName =
        element.first_name === "Alisson" ? "Alisson" : element.web_name;
      const query = encodeURIComponent(playerName);
      return {
        elementId: element.id,
        player: playerName,
        team: team?.short_name ?? `T${element.team}`,
        position: positionFromFpl(rawPosition),
        price: element.now_cost / 10,
        ownership:
          ranked?.ownership ??
          (Number.parseFloat(element.selected_by_percent) || 0),
        status: element.status,
        chanceOfPlaying: chance,
        headline:
          element.news ||
          (element.status === "s"
            ? "Suspended or otherwise unavailable."
            : "Availability is being monitored by FPL."),
        observedAt: now,
        sourceUpdatedAt: element.news_added,
        severity,
        scope: squadIds.has(element.id)
          ? "squad"
          : targetIds.has(element.id)
            ? "target"
            : "league",
        sources: [
          {
            label: "Official FPL player news",
            url: "https://fantasy.premierleague.com/the-scout/player-news",
            role: "primary",
          },
          {
            label: "Premier Injuries",
            url: "https://www.premierinjuries.com/injury-table.php",
            role: "cross-check",
          },
          {
            label: "Fantasy Football Scout search",
            url: `https://www.fantasyfootballscout.co.uk/?s=${query}`,
            role: "cross-check",
          },
          {
            label: "AllAboutFPL search",
            url: `https://allaboutfpl.com/?s=${query}`,
            role: "cross-check",
          },
        ],
      };
    })
    .sort((left, right) => {
      const scopeOrder = { squad: 0, target: 1, league: 2 };
      const severityOrder = { critical: 0, warning: 1, monitor: 2 };
      return (
        scopeOrder[left.scope] - scopeOrder[right.scope] ||
        severityOrder[left.severity] - severityOrder[right.severity] ||
        right.ownership - left.ownership
      );
    });

  const phase = bootstrap.events.every((candidate) => candidate.finished)
    ? "finished"
    : event.is_current
      ? "live"
      : "preseason";
  const value = picks?.entry_history.value
    ? picks.entry_history.value / 10
    : players.reduce((total, player) => total + player.price, 0);
  const source = picks ? "official_public" : "captured_authenticated_draft";
  const notices = picks
    ? ["Squad synced from the official public gameweek picks endpoint."]
    : [
        "GW1 picks remain private before the deadline; the squad is the authenticated draft captured on 28 Jul.",
        "Official prices, clubs, availability flags and the next six fixtures are refreshed from FPL.",
      ];

  return {
    schemaVersion: 3,
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
    rankings: buildTopTenRankings(rankedPlayers),
    recommendations: {
      transfers4: recommendTransfers({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank,
        horizon: 4,
      }),
      transfers6: recommendTransfers({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank,
        horizon: 6,
      }),
      multiTransferPlans4: buildMultiTransferPlans({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank,
        horizon: 4,
      }),
      multiTransferPlans6: buildMultiTransferPlans({
        squad: rankedSquad,
        allPlayers: rankedPlayers,
        bank,
        horizon: 6,
      }),
      captaincyPlan: buildCaptaincyPlan(rankedSquad, event.id),
      captaincyPool: [...rankedSquad].sort(
        (left, right) => right.captainScore - left.captainScore
      ),
      modelVersion: "preseason-v1",
      provisional: true,
      methodology: [
        "Official FPL prices, ownership, availability and the next six fixtures.",
        "Position and price baselines blended with official expected points when available.",
        "Legal single-player moves only: same position, affordable and no more than three per club.",
      ],
    },
    evidence: {
      generatedAt: now,
      officialRefreshMinutes: 15,
      items: evidenceItems,
      caveats: [
        "Official FPL availability is automated; external sources are supplied as independent verification links.",
        "A return date or percentage is not a confirmed start. Recheck press conferences before the deadline.",
        "Source timestamps describe when FPL updated the note; observed time describes this portal refresh.",
      ],
    },
    notices,
  };
}
