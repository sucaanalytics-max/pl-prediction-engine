/**
 * No tracked module may statically import an untracked file.
 *
 * ## Why this file exists
 *
 * `lib/fpl-live-server.ts` (tracked) imported `lib/fplreview-projections.ts`
 * (untracked), which imported `data/fplreview-projections.json` (untracked,
 * 128KB, a paid competitor's export that has never been in git history). On
 * this machine everything built and every test passed. Anywhere else — CI, a
 * fresh clone, a Vercel checkout — the build died at compile time:
 *
 *     Module not found: Can't resolve '@/data/fplreview-projections.json'
 *
 * Nothing caught it. `tsc` sees the file on disk. vitest sees it on disk. lint
 * sees it on disk. Every local signal was green while the repository was
 * unbuildable for everyone else, and it took counting HTTP 404s in production
 * to notice.
 *
 * The Python side has had `test_module_reachability.py` for exactly this shape
 * of problem. This is its counterpart: it asks git what is actually in the
 * repository rather than asking the filesystem what happens to be on this
 * laptop.
 *
 * A failure here is not a style complaint. It means the branch does not build
 * from a clean checkout.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FRONTEND = resolve(__dirname, "..");
const REPO = resolve(FRONTEND, "..");

/** Everything git knows about, as absolute paths. */
function trackedFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(
    out.split("\0").filter(Boolean).map((p) => join(REPO, p))
  );
}

const TRACKED = trackedFiles();

/** Tracked TypeScript sources under the directories that ship. */
function sourcesToCheck(): string[] {
  const roots = ["frontend/app/", "frontend/lib/", "frontend/components/"];
  return [...TRACKED]
    .map((abs) => relative(REPO, abs))
    .filter(
      (rel) =>
        roots.some((r) => rel.startsWith(r)) &&
        /\.tsx?$/.test(rel) &&
        !/\.test\.tsx?$/.test(rel)
    )
    .map((rel) => join(REPO, rel))
    .sort();
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersIn(text: string): string[] {
  const found: string[] = [];
  // Reset because the regex is module-level and stateful with /g.
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(text)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec) found.push(spec);
  }
  return found;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".json", ".js", ".jsx", ".mjs"];

/**
 * Resolve a specifier the way the bundler would, or `null` for a package.
 *
 * Only first-party specifiers are resolvable here — `@/…` and relative paths.
 * A bare specifier is a node_modules package and is somebody else's problem.
 */
function resolveFirstParty(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(FRONTEND, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const index of ["index.ts", "index.tsx", "index.js"]) {
    const candidate = join(base, index);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("every statically imported first-party file is in git", () => {
  it("finds sources to check at all", () => {
    // Guards the guard: a broken glob would make this suite vacuously pass,
    // which is the failure mode that let the original bug through.
    expect(sourcesToCheck().length).toBeGreaterThan(20);
  });

  it("no tracked module imports a file git does not have", () => {
    const offences: string[] = [];

    for (const file of sourcesToCheck()) {
      const text = readFileSync(file, "utf8");
      for (const spec of specifiersIn(text)) {
        const target = resolveFirstParty(spec, file);
        if (target === null) continue;
        if (!TRACKED.has(target)) {
          offences.push(
            `${relative(REPO, file)} imports "${spec}" → ` +
              `${relative(REPO, target)} (untracked)`
          );
        }
      }
    }

    expect(
      offences,
      offences.length
        ? "These imports resolve to files that are not in git, so the build " +
            "succeeds here and fails from a clean checkout:\n  " +
            offences.join("\n  ")
        : undefined
    ).toEqual([]);
  });
});

describe("the paid FPLReview export is not a build input", () => {
  it("no source statically imports the CSV-derived JSON", () => {
    // It is a licensed competitor product. It must be read at runtime and be
    // absent-tolerant, never bundled — see lib/fplreview-projections.ts.
    const offenders = sourcesToCheck().filter((file) =>
      specifiersIn(readFileSync(file, "utf8")).some((s) =>
        s.includes("data/fplreview-projections")
      )
    );
    expect(offenders.map((f) => relative(REPO, f))).toEqual([]);
  });

  it("and it is ignored, so it cannot be committed by accident", () => {
    const status = execFileSync(
      "git",
      ["check-ignore", "frontend/data/fplreview-projections.json"],
      { cwd: REPO, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    expect(status).toBe("frontend/data/fplreview-projections.json");
  });
});
