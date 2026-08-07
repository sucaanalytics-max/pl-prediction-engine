import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_HEADERS = [
  "Pos", "ID", "Name", "BV", "SV", "Team",
  ...Array.from({ length: 10 }, (_, index) => [
    `${index + 1}_xMins`,
    `${index + 1}_Pts`,
  ]).flat(),
  "Elite%",
];
const POSITIONS = new Set(["GKP", "DEF", "MID", "FWD"]);

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
if (JSON.stringify(headers) !== JSON.stringify(EXPECTED_HEADERS)) {
  throw new Error(`Unexpected FPLReview columns: ${headers.join(", ")}`);
}

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
  for (let gameweek = 1; gameweek <= 10; gameweek += 1) {
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
  gameweeks: Array.from({ length: 10 }, (_, index) => index + 1),
  rawRecordCount: csvRows.length - 1,
  recordCount: players.length,
  excludedSyntheticRows,
  players,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(`Imported ${players.length} official-ID projections; excluded ${excludedSyntheticRows} synthetic catalogue rows.`);
