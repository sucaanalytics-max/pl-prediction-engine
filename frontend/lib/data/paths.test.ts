/**
 * Rule 3: **a fetched path that nothing publishes is a failing test.**
 *
 * This walks the registry and checks each path against what the workflows
 * actually publish, by parsing the workflow files. It exists because the repo has
 * already shipped the failure it prevents, twice over:
 *
 * - `/decisions` fetched `decision_latest.json`. **Nothing has ever written that
 *   file.** Both workflows named it too — one staging it, one excluding it — so
 *   it looked deliberate in three places and did nothing in all three. The page
 *   could never render, and the private decisions were written to the runner and
 *   discarded every run.
 * - `frontend/public/predictions/fpl/` is an empty directory that five pipeline
 *   subsystems were supposed to fill.
 *
 * A unit test on either side passes in both cases. Only the agreement is wrong,
 * so only a test that reads both sides can catch it.
 *
 * ## Why parse YAML rather than list files
 *
 * Listing `frontend/public/predictions/` would tell us what a *previous* run left
 * on disk, which is how a phantom path survives: the file is absent because it
 * was never written, and "absent" is indistinguishable from "not written yet" by
 * inspection. The workflow is the declaration of intent, so the workflow is what
 * gets checked.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ALL_DESCRIPTORS } from "@/lib/data/narrow";

const REPO = join(__dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const pipelineYml = readFileSync(join(WORKFLOWS, "pipeline.yml"), "utf8");
const agentYml = readFileSync(join(WORKFLOWS, "fpl_agent.yml"), "utf8");

/**
 * The daily job's publish list, read out of the shell loop rather than hardcoded.
 *
 * `pipeline.yml` deliberately uses an explicit `for f in ...` list rather than a
 * glob, and states why: a glob silently publishes every new artifact the pipeline
 * learns to write, including `forecast_ledger.json`, which grows all season. This
 * parses that list so the test tracks the real declaration.
 */
function dailyPublishList(): string[] {
  // EVERY `for f in ...` loop, not just the first. The step has two: a REQUIRED
  // list whose absence should fail the run, and an OPTIONAL one copied only when
  // present — because `fixture_xg`'s export is wrapped in a try/except that logs
  // "FPL agent will use fallback rates", and `cp` under `set -e` would turn that
  // deliberately non-fatal absence into a hard pipeline failure.
  //
  // Matching only the first loop made this test blind to anything in the second,
  // which is precisely the silent gap it exists to prevent.
  const files: string[] = [];
  for (const match of pipelineYml.matchAll(/for f in ([^;]+); do/g)) {
    files.push(...match[1].trim().split(/\s+/));
  }
  return files;
}

/** Artifacts the daily job copies only if they exist. */
function optionalPublishList(): string[] {
  const loops = [...pipelineYml.matchAll(/for f in ([^;]+); do([\s\S]*?)done/g)];
  const optional = loops.filter(([, , body]) => body.includes("if [ -f"));
  return optional.flatMap(([, list]) => list.trim().split(/\s+/));
}

/** Paths the agent publishes, as directory prefixes under the public root. */
function agentPublishPrefixes(): string[] {
  const prefixes: string[] = [];
  if (agentYml.includes("frontend/public/predictions/fpl")) prefixes.push("fpl/");
  return prefixes;
}

const DAILY = dailyPublishList();
const OPTIONAL = optionalPublishList();
const AGENT_PREFIXES = agentPublishPrefixes();

/** Paths the NEWS workflow stages under the public root. */
function newsPublishedPaths(): string[] {
  const newsYml = readFileSync(join(WORKFLOWS, "news.yml"), "utf8");
  return [...newsYml.matchAll(
    /frontend\/public\/predictions\/(\S+)/g,
  )].map((m) => m[1]);
}

const NEWS = newsPublishedPaths();

/**
 * Whether any Python module actually emits this filename.
 *
 * **This is the check that catches a phantom.** The agent stages
 * `frontend/public/predictions/fpl` as a *directory*, so every file that appears
 * there gets committed — which means "the directory is staged" says nothing about
 * whether a writer exists. `decision_latest.json` sat in the staging list of one
 * workflow and the exclude list of another, and was written by nothing.
 *
 * Greps the pipeline source rather than listing files on disk: a file is absent
 * both when no writer exists and when the writer has simply not run yet, and only
 * the source distinguishes those.
 */
function hasPythonWriter(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  // Strip a gameweek placeholder: xp_gw07.json is written as an f-string.
  const stem = filename.replace(/\d+/g, "");
  const candidates = [filename, stem, stem.replace(/\.json$|\.jsonl$/, "")];
  for (const candidate of candidates) {
    if (candidate.length < 4) continue;
    const found = execFileSync(
      "grep",
      ["-rl", "--include=*.py", "-F", candidate, join(REPO, "pipeline")],
      { encoding: "utf8" },
    ).trim();
    const writers = found
      .split("\n")
      .filter((f) => f && !f.includes("/tests/"));
    if (writers.length > 0) return true;
  }
  return false;
}

function isPublished(path: string): boolean {
  if (DAILY.includes(path)) return true;
  if (NEWS.includes(path)) return hasPythonWriter(path);
  const staged = AGENT_PREFIXES.some((prefix) => path.startsWith(prefix));
  // Staged directory AND a real writer. Either alone is a phantom.
  return staged && hasPythonWriter(path);
}

describe("the workflow declarations parse", () => {
  it("finds the daily publish list", () => {
    // If this breaks, the loop was refactored and every assertion below is
    // vacuous — so it is asserted rather than assumed.
    expect(DAILY.length).toBeGreaterThan(0);
    expect(DAILY).toContain("latest.json");
  });

  it("finds the agent's public directory", () => {
    expect(AGENT_PREFIXES).toContain("fpl/");
  });

  it("finds both publish loops, required and optional", () => {
    // Two loops. Reading only the first is a silent blind spot.
    expect(DAILY).toContain("latest.json");
    expect(DAILY).toContain("fixture_xg.json");
    expect(OPTIONAL).toEqual(["fixture_xg.json", "market_blend_weight.json"]);
  });

  it("finds what the news workflow publishes", () => {
    expect(NEWS).toContain("fpl/deltas.jsonl");
  });
});

describe("optional artifacts cannot fail the pipeline by being absent", () => {
  /**
   * `fixture_xg`'s export is wrapped in a try/except that logs "FPL agent will
   * use fallback rates", and `market_blend_weight` is written only by
   * `fit_market_blend.py`, which nothing in the pipeline may import. Copying
   * either with a bare `cp` under `set -euo pipefail` would convert a
   * deliberately non-fatal absence into a red daily run.
   */
  it("guards every optional copy with an existence check", () => {
    for (const file of OPTIONAL) {
      expect(pipelineYml).toContain("if [ -f");
      expect(OPTIONAL).toContain(file);
    }
    expect(OPTIONAL.length).toBeGreaterThan(0);
  });

  it("does not guard the required ones, whose absence IS a failure", () => {
    const required = DAILY.filter((f) => !OPTIONAL.includes(f));
    expect(required).toContain("latest.json");
    expect(required).toContain("health.json");
    expect(required).not.toContain("fixture_xg.json");
  });
});

describe("Rule 3 — every registry path is published", () => {
  for (const descriptor of ALL_DESCRIPTORS) {
    const label = `${descriptor.key} -> ${descriptor.path}`;

    if (descriptor.unpublished) {
      it.fails(`${label} is a known gap: ${descriptor.unpublishedReason}`, () => {
        // Recorded as an expected failure so the gap is visible in the test
        // output and disappears from it the moment a writer starts publishing.
        expect(isPublished(descriptor.path)).toBe(true);
      });
      continue;
    }

    it(label, () => {
      expect(
        isPublished(descriptor.path),
        `${descriptor.path} is fetched by the app but no workflow publishes it. ` +
        `Either add it to pipeline.yml's publish list / the agent's public dir, ` +
        `or mark the descriptor { unpublished: true } with a reason.`,
      ).toBe(true);
    });
  }
});

describe("the phantom filename cannot come back", () => {
  it("no descriptor points at decision_latest.json", () => {
    const phantom = ALL_DESCRIPTORS.filter((d) =>
      d.path.includes("decision_latest"),
    );
    expect(phantom).toEqual([]);
  });

  it("no workflow mentions decision_latest.json", () => {
    expect(pipelineYml).not.toContain("decision_latest.json");
    expect(agentYml).not.toContain("decision_latest.json");
  });
});

describe("path ownership stays disjoint", () => {
  /**
   * Two writers push to `main` on different schedules. Git rebases at file
   * granularity, so writers that never touch the same file cannot conflict — but
   * that guarantee is a property of the path split, not of the retry logic.
   */
  it("the daily job publishes no fpl/ artifact", () => {
    const daily = ALL_DESCRIPTORS.filter((d) => d.owner === "daily");
    for (const descriptor of daily) {
      expect(
        descriptor.path.startsWith("fpl/"),
        `${descriptor.key} is owned by the daily job but lives under fpl/, ` +
        `which the agent owns`,
      ).toBe(false);
    }
  });

  it("every agent-owned artifact lives under fpl/", () => {
    const agent = ALL_DESCRIPTORS.filter((d) => d.owner === "agent");
    for (const descriptor of agent) {
      expect(descriptor.path.startsWith("fpl/")).toBe(true);
    }
  });

  it("assigns every descriptor an owner", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(descriptor.owner).toBeTruthy();
    }
  });
});

describe("registry hygiene", () => {
  it("has no duplicate keys", () => {
    const keys = ALL_DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no duplicate paths", () => {
    const paths = ALL_DESCRIPTORS.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gives every descriptor a narrower — Rule 4 has no exceptions", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(typeof descriptor.narrow).toBe("function");
    }
  });

  it("gives every descriptor a human description for its state card", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(descriptor.describes.length).toBeGreaterThan(0);
    }
  });

  it("uses relative paths, never absolute or parent-relative", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(descriptor.path.startsWith("/")).toBe(false);
      expect(descriptor.path).not.toContain("..");
    }
  });
});
