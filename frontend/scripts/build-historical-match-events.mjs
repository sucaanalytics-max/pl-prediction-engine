import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SEASONS = ["2023-24", "2024-25", "2025-26"];
const CACHE_DIR = process.argv.includes("--cache-dir")
  ? process.argv[process.argv.indexOf("--cache-dir") + 1]
  : null;
const H2H_PATH = resolve(process.cwd(), "public/predictions/h2h.json");

function canonicalTeam(value) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = {
    manchesterunited: "manutd",
    manunited: "manutd",
    manutd: "manutd",
    manchestercity: "mancity",
    nottinghamforest: "nottmforest",
    sheffieldunited: "sheffieldutd",
    tottenhamhotspur: "spurs",
    tottenham: "spurs",
    wolverhamptonwanderers: "wolves",
  };
  return aliases[compact] ?? compact;
}

const h2hRecords = JSON.parse(await readFile(H2H_PATH, "utf8"));
const wantedKeys = new Set(
  h2hRecords.flatMap((record) =>
    record.matches.map((match) => {
      const homeTeam = match.home_team ?? record.home_team;
      const awayTeam = match.away_team ?? record.away_team;
      return [
        match.season,
        match.date.slice(0, 10),
        canonicalTeam(homeTeam),
        canonicalTeam(awayTeam),
      ].join("|");
    })
  )
);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...values] = rows;
  return values.map((value) =>
    Object.fromEntries(header.map((column, index) => [column, value[index] ?? ""]))
  );
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statPlayers(rows, column, minimum = 0) {
  return rows
    .filter((row) => number(row[column]) > minimum)
    .map((row) => ({
      name: row.name.replaceAll("_", " "),
      team: row.team,
      value: number(row[column]),
    }))
    .sort((left, right) => right.value - left.value);
}

function topPerformers(rows) {
  return [...rows]
    .filter((row) => number(row.minutes) > 0)
    .sort((left, right) => {
      return (
        number(right.total_points) - number(left.total_points) ||
        number(right.bps) - number(left.bps)
      );
    })
    .slice(0, 5)
    .map((row) => ({
      name: row.name.replaceAll("_", " "),
      team: row.team,
      points: number(row.total_points),
      bonus: number(row.bonus),
      bps: number(row.bps),
      xg: number(row.expected_goals),
      xa: number(row.expected_assists),
      minutes: number(row.minutes),
    }));
}

async function loadSeason(season) {
  if (CACHE_DIR) {
    return readFile(resolve(CACHE_DIR, `fpl-${season}-gws.csv`), "utf8");
  }
  const url =
    `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/` +
    `master/data/${season}/gws/merged_gw.csv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${season} returned ${response.status}`);
  return response.text();
}

const records = {};
for (const season of SEASONS) {
  const rows = parseCsv(await loadSeason(season));
  const fixtures = new Map();
  for (const row of rows) {
    const fixtureRows = fixtures.get(row.fixture) ?? [];
    fixtureRows.push(row);
    fixtures.set(row.fixture, fixtureRows);
  }

  for (const [fixtureId, rawFixtureRows] of fixtures) {
    const fixtureRows = [
      ...rawFixtureRows
        .reduce((deduplicated, row) => {
          const existing = deduplicated.get(row.element);
          if (
            !existing ||
            number(row.minutes) > number(existing.minutes) ||
            number(row.total_points) > number(existing.total_points)
          ) {
            deduplicated.set(row.element, row);
          }
          return deduplicated;
        }, new Map())
        .values(),
    ];
    const homeRow = fixtureRows.find((row) => row.was_home === "True");
    const awayRow = fixtureRows.find((row) => row.was_home === "False");
    if (!homeRow || !awayRow || !homeRow.kickoff_time) continue;
    const date = homeRow.kickoff_time.slice(0, 10);
    const compactSeason = season.replace("-", "").slice(2);
    const key = [
      compactSeason,
      date,
      canonicalTeam(homeRow.team),
      canonicalTeam(awayRow.team),
    ].join("|");
    if (!wantedKeys.has(key)) continue;

    records[key] = {
      fixtureId: Number(fixtureId),
      season: compactSeason,
      date,
      kickoffTime: homeRow.kickoff_time,
      homeTeam: homeRow.team,
      awayTeam: awayRow.team,
      homeGoals: number(homeRow.team_h_score),
      awayGoals: number(homeRow.team_a_score),
      scorers: statPlayers(fixtureRows, "goals_scored"),
      assists: statPlayers(fixtureRows, "assists"),
      ownGoals: statPlayers(fixtureRows, "own_goals"),
      yellowCards: statPlayers(fixtureRows, "yellow_cards"),
      redCards: statPlayers(fixtureRows, "red_cards"),
      saves: statPlayers(fixtureRows, "saves"),
      penaltiesSaved: statPlayers(fixtureRows, "penalties_saved"),
      penaltiesMissed: statPlayers(fixtureRows, "penalties_missed"),
      bonus: statPlayers(fixtureRows, "bonus"),
      xgLeaders: statPlayers(fixtureRows, "expected_goals", 0.01).slice(0, 5),
      xaLeaders: statPlayers(fixtureRows, "expected_assists", 0.01).slice(0, 5),
      topPerformers: topPerformers(fixtureRows),
      source: {
        label: "Historical FPL gameweek archive",
        url:
          `https://github.com/vaastav/Fantasy-Premier-League/tree/master/` +
          `data/${season}/gws`,
        attribution:
          "Player-match statistics derived from the official FPL gameweek feed.",
      },
    };
  }
}

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  seasons: SEASONS,
  coverage: {
    matchedFixtures: Object.keys(records).length,
    requestedFixtures: wantedKeys.size,
  },
  caveats: [
    "Assists follow FPL scoring and can differ from Premier League or Opta assists.",
    "The archive provides player-match totals, not a goal-by-goal assist pairing or event minute.",
    "Own goals and missed or saved penalties are shown separately to avoid misattribution.",
  ],
};

for (const record of Object.values(records)) {
  const attributedGoals =
    record.scorers.reduce((total, player) => total + player.value, 0) +
    record.ownGoals.reduce((total, player) => total + player.value, 0);
  const scorelineGoals = record.homeGoals + record.awayGoals;
  if (attributedGoals !== scorelineGoals) {
    throw new Error(
      `Goal attribution mismatch for ${record.date} ${record.homeTeam} ` +
        `${record.homeGoals}-${record.awayGoals} ${record.awayTeam}: ` +
        `${attributedGoals} attributed`
    );
  }
}

const outputDirectory = resolve(
  process.cwd(),
  "public/predictions/h2h-events"
);
await rm(
  resolve(process.cwd(), "public/predictions/h2h-events.json"),
  { force: true }
);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const pairs = new Map();
for (const [key, record] of Object.entries(records)) {
  const pairSlug = [canonicalTeam(record.homeTeam), canonicalTeam(record.awayTeam)]
    .sort()
    .join("--");
  const pairRecords = pairs.get(pairSlug) ?? {};
  pairRecords[key] = record;
  pairs.set(pairSlug, pairRecords);
}
for (const [pairSlug, pairRecords] of pairs) {
  await writeFile(
    resolve(outputDirectory, `${pairSlug}.json`),
    `${JSON.stringify({ ...metadata, records: pairRecords }, null, 2)}\n`
  );
}
await writeFile(
  resolve(outputDirectory, "index.json"),
  `${JSON.stringify(
    { ...metadata, pairFiles: pairs.size, recordCount: Object.keys(records).length },
    null,
    2
  )}\n`
);
console.log(
  `Wrote ${Object.keys(records).length} fixtures across ${pairs.size} pair files`
);
