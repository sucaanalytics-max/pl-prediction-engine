import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEAD = ["Pos", "ID", "Name", "BV", "SV", "Team"];
const POSITIONS = new Set(["GKP", "DEF", "MID", "FWD"]);
/** FPLReview exports the next ten gameweeks. Ten is the count, not the range. */
const HORIZON = 10;
const LAST_GAMEWEEK = 38;

/**
 * Which gameweeks this export covers, read off the headers.
 *
 * The window used to be hardcoded as 1..10, which is only right in pre-season. FPLReview
 * exports the next ten gameweeks from wherever the season currently is, so the moment GW2
 * was played the columns became `3_xMins`..`12_Pts` and the importer refused the file
 * outright — `Unexpected FPLReview columns`. The export was not malformed; the assumption
 * was.
 *
 * Requires the ten pairs to be CONSECUTIVE and in order, because that is what makes an
 * array index meaningful downstream: `projectedPoints[0]` is `gameweeks[0]`, and a gap
 * would silently shift every later week by one.
 */
function gameweeksFromHeaders(headers) {
  const lead = headers.slice(0, LEAD.length);
  if (JSON.stringify(lead) !== JSON.stringify(LEAD)) {
    throw new Error(`Unexpected leading FPLReview columns: ${lead.join(", ")}`);
  }
  if (headers[headers.length - 1] !== "Elite%") {
    throw new Error(`Expected Elite% last, found: ${headers[headers.length - 1]}`);
  }
  const middle = headers.slice(LEAD.length, -1);
  if (middle.length !== HORIZON * 2) {
    throw new Error(
      `Expected ${HORIZON * 2} gameweek columns, found ${middle.length}: ${middle.join(", ")}`,
    );
  }
  const first = Number(/^(\d+)_xMins$/.exec(middle[0])?.[1]);
  if (!Number.isInteger(first) || first < 1 || first + HORIZON - 1 > LAST_GAMEWEEK) {
    throw new Error(`Cannot read a first gameweek from: ${middle[0]}`);
  }
  const gameweeks = Array.from({ length: HORIZON }, (_, index) => first + index);
  const expected = gameweeks.flatMap((gw) => [`${gw}_xMins`, `${gw}_Pts`]);
  if (JSON.stringify(middle) !== JSON.stringify(expected)) {
    throw new Error(
      `FPLReview gameweek columns are not consecutive from GW${first}: ${middle.join(", ")}`,
    );
  }
  return gameweeks;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim()));
}

function number(value, label) {
  const parsed = Number.parseFloat(String(value).replace("%", ""));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function exportedAtFromName(fileName, fallback) {
  const epoch = /_(\d{10})\.csv$/i.exec(fileName)?.[1];
  return epoch ? new Date(Number(epoch) * 1000).toISOString() : fallback;
}

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node scripts/import-fplreview-projections.mjs /path/to/fplreview.csv");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "data", "fplreview-projections.json");
const [csvText, inputStat] = await Promise.all([
  fs.readFile(inputPath, "utf8"),
  fs.stat(inputPath),
]);
const csvRows = parseCsv(csvText);
const headers = csvRows[0].map((value) => value.replace(/^\uFEFF/, ""));
const gameweeks = gameweeksFromHeaders(headers);

const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));
const seen = new Set();
let excludedSyntheticRows = 0;
const players = [];

for (const row of csvRows.slice(1)) {
  if (row.length !== headers.length) {
    throw new Error(`Expected ${headers.length} columns for ${row[2] ?? "unknown player"}, received ${row.length}`);
  }
  const elementId = number(row[headerIndex.ID], "element ID");
  if (elementId >= 10_000) {
    excludedSyntheticRows += 1;
    continue;
  }
  if (!Number.isInteger(elementId) || elementId <= 0 || seen.has(elementId)) {
    throw new Error(`Invalid or duplicate official element ID: ${elementId}`);
  }
  seen.add(elementId);

  const position = row[headerIndex.Pos];
  if (!POSITIONS.has(position)) throw new Error(`Unsupported position: ${position}`);
  const expectedMinutes = [];
  const projectedPoints = [];
  for (const gameweek of gameweeks) {
    const minutes = number(row[headerIndex[`${gameweek}_xMins`]], `GW${gameweek} expected minutes`);
    const points = number(row[headerIndex[`${gameweek}_Pts`]], `GW${gameweek} projected points`);
    if (minutes < 0 || minutes > 180 || points < 0 || points > 30) {
      throw new Error(`Projection outside guardrails for ${row[headerIndex.Name]} in GW${gameweek}`);
    }
    expectedMinutes.push(minutes);
    projectedPoints.push(points);
  }

  players.push({
    elementId,
    name: row[headerIndex.Name],
    team: row[headerIndex.Team],
    position,
    buyValue: number(row[headerIndex.BV], "buy value"),
    sellValue: number(row[headerIndex.SV], "sell value"),
    eliteOwnership: number(row[headerIndex["Elite%"]], "elite ownership"),
    expectedMinutes,
    projectedPoints,
  });
}

const fileName = path.basename(inputPath);
const output = {
  schemaVersion: 1,
  source: "FPLReview premium CSV export",
  sourceFile: fileName,
  exportedAt: exportedAtFromName(fileName, inputStat.mtime.toISOString()),
  checksum: crypto.createHash("sha256").update(csvText).digest("hex"),
  gameweeks,
  rawRecordCount: csvRows.length - 1,
  recordCount: players.length,
  excludedSyntheticRows,
  players,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(
  `Imported ${players.length} official-ID projections for GW${gameweeks[0]}-GW${gameweeks[gameweeks.length - 1]}; `
  + `excluded ${excludedSyntheticRows} synthetic catalogue rows.`,
);
