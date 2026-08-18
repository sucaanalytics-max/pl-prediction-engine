/**
 * Regenerate `test/fixtures/bootstrap-min.json` from the pipeline's real cache.
 *
 *     node scripts/regenerate-bootstrap-fixture.mjs
 *
 * ## Why the fixture exists
 *
 * `data/raw/` is gitignored, so the pipeline's bootstrap cache never reaches CI,
 * and `lib/captured-draft.test.ts` needs element prices to check the captured
 * squad's value. The fixture is a five-field-per-element projection of that cache,
 * committed so the gate can run anywhere.
 *
 * ## Why it is generated rather than hand-edited
 *
 * The first version carried `_generated_from: "2026-08-21T17:30:00Z"` — the GW1
 * deadline, copied out of `events[0].deadline_time`, three days AFTER the commit
 * that added it. In a data layer whose every freshness judgement rests on the
 * writer's own timestamp, a future-dated stamp is worse than no stamp: it is the
 * only clue to how stale the frozen prices are, and it read as "captured in the
 * future".
 *
 * So the stamp is not typed. `_prices_captured_at` is the mtime of the SOURCE
 * cache, in UTC — when those prices were actually captured from FPL.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_LABEL = "data/raw/fpl/bootstrap_static.json";
const SOURCE = join(FRONTEND, "..", SOURCE_LABEL);
const OUT = join(FRONTEND, "test", "fixtures", "bootstrap-min.json");

const raw = JSON.parse(readFileSync(SOURCE, "utf8"));
const capturedAt = statSync(SOURCE).mtime.toISOString();

const out = {
  _note:
    "Minimal bootstrap for lib/captured-draft.test.ts: only the five element "
    + "fields and two team fields that test reads. Committed because data/raw/ is "
    + "gitignored, so the real cache never reaches CI — which is why the frontend "
    + "suite failed on every run for at least eight commits while passing locally. "
    + "Do not hand-edit: regenerate with frontend/scripts/"
    + "regenerate-bootstrap-fixture.mjs, which restamps _prices_captured_at from "
    + "the source cache's mtime.",
  _source: SOURCE_LABEL,
  _prices_captured_at: capturedAt,
  _prices_captured_at_means:
    "mtime of _source, in UTC: when these prices were captured from FPL. NOT the "
    + "time this fixture was written, and NOT a gameweek deadline. FPL moves "
    + "now_cost nightly in-season, so this is the only clue to how stale the "
    + "frozen prices are — which a future-dated stamp destroys.",
  elements: raw.elements.map((e) => ({
    id: e.id,
    web_name: e.web_name,
    now_cost: e.now_cost,
    element_type: e.element_type,
    team: e.team,
  })),
  teams: raw.teams.map((t) => ({ id: t.id, short_name: t.short_name })),
};

writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`wrote ${OUT}`);
console.log(`  ${out.elements.length} elements, ${out.teams.length} teams`);
console.log(`  _prices_captured_at = ${capturedAt}`);
