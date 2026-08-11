import { NextResponse } from "next/server";

/**
 * Trigger the X scan, and report the last run.
 *
 * ## Why this dispatches CI rather than scanning here
 *
 * The scan needs a real browser: `curl` on a logged-out X profile returns 204KB of
 * JavaScript app shell with no post text. It also has to commit its result, since
 * the committed inbox is what the 15-minute poller reads.
 *
 * Both of those belong in CI, and CI turned out to work — measured, because it was
 * genuinely uncertain: X serves datacenter ranges differently, and the scan had
 * only ever run from a residential IP. A GitHub runner read all five posts on the
 * first attempt (run 31477309851).
 *
 * So this route is thin on purpose: verify the caller, ask GitHub to run the
 * workflow, and get out of the way.
 *
 * ## Why it is guarded
 *
 * This app has no auth by design — it is a private tool. But the deployment is
 * reachable by URL, and an unauthenticated endpoint that starts a CI job is a way
 * for a stranger to spend someone else's runner minutes and push commits to `main`.
 *
 * Two guards, and neither is a substitute for platform-level protection:
 *
 *  1. A shared secret, compared in constant time, that never appears in a
 *     `NEXT_PUBLIC_` variable.
 *  2. A cooldown read from GitHub's own run history, so even a caller holding the
 *     secret cannot queue runs back to back.
 *
 * **The real answer is Vercel Deployment Protection.** A secret typed into a
 * browser is a secret in a browser. The guards here bound the damage; they do not
 * make the endpoint public-safe.
 */

export const dynamic = "force-dynamic";

/** Owner/repo of the workflow to dispatch. */
const REPO = process.env.X_SCAN_REPO ?? "sucaanalytics-max/pl-prediction-engine";

/** Filename, not display name: the dispatch API keys on the file. */
const WORKFLOW = "x_scan.yml";

const BRANCH = process.env.X_SCAN_REF ?? "main";

/**
 * Minimum gap between runs, in minutes.
 *
 * The logged-out profile shows only the five most recent posts and `merge_inbox`
 * deduplicates, so two scans a minute apart return the same rows and cost a runner
 * for nothing.
 */
const COOLDOWN_MINUTES = Number(process.env.X_SCAN_COOLDOWN_MINUTES ?? 10);

/** Constant-time comparison, so a wrong secret cannot be found byte by byte. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

interface RunSummary {
  readonly id: number;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly url: string | null;
}

async function latestRun(token: string): Promise<RunSummary | null> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );
  if (!response.ok) return null;

  const body: unknown = await response.json();
  const runs =
    body && typeof body === "object" && Array.isArray((body as { workflow_runs?: unknown[] }).workflow_runs)
      ? (body as { workflow_runs: Array<Record<string, unknown>> }).workflow_runs
      : [];
  const run = runs[0];
  if (!run) return null;

  return {
    id: typeof run.id === "number" ? run.id : 0,
    status: typeof run.status === "string" ? run.status : null,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    started_at: typeof run.created_at === "string" ? run.created_at : null,
    url: typeof run.html_url === "string" ? run.html_url : null,
  };
}

/** What the page needs to render the control honestly, with no secret required. */
export async function GET() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    // Absence is a state, not an error: the button renders disabled and says why,
    // rather than offering an action that cannot work.
    return NextResponse.json({
      configured: false,
      reason:
        "GITHUB_DISPATCH_TOKEN is not set, so the scan cannot be triggered from here. " +
        "Run ./scripts/x_scan.sh locally instead.",
      lastRun: null,
    });
  }

  const run = await latestRun(token);
  return NextResponse.json({
    configured: true,
    requiresSecret: Boolean(process.env.X_SCAN_TRIGGER_SECRET),
    cooldownMinutes: COOLDOWN_MINUTES,
    lastRun: run,
  });
}

export async function POST(request: Request) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const expected = process.env.X_SCAN_TRIGGER_SECRET;

  if (!token) {
    return NextResponse.json(
      { ok: false, reason: "GITHUB_DISPATCH_TOKEN is not configured" },
      { status: 501 },
    );
  }

  // Refuse rather than run unguarded. An endpoint that starts CI and pushes to
  // `main` must not be open because a variable was forgotten — failing closed is
  // the only safe default here.
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "X_SCAN_TRIGGER_SECRET is not configured. Refusing to expose an " +
          "unauthenticated trigger that starts CI and pushes to main.",
      },
      { status: 501 },
    );
  }

  const given = request.headers.get("x-scan-secret") ?? "";
  if (!secretMatches(given, expected)) {
    return NextResponse.json({ ok: false, reason: "unauthorised" }, { status: 401 });
  }

  // Cooldown from GitHub's own history rather than in-process state: serverless
  // instances are not shared, so an in-memory timestamp would reset on every cold
  // start and bound nothing.
  const previous = await latestRun(token);
  if (previous?.started_at) {
    const ageMinutes = (Date.now() - Date.parse(previous.started_at)) / 60000;
    if (Number.isFinite(ageMinutes) && ageMinutes < COOLDOWN_MINUTES) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            `a scan ran ${Math.round(ageMinutes)} minute(s) ago; the cooldown is ` +
            `${COOLDOWN_MINUTES}. X shows only the five most recent posts, so a ` +
            `scan now would re-read the same rows.`,
          lastRun: previous,
        },
        { status: 429 },
      );
    }
  }

  const dispatch = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      // No inputs. The workflow accepts none, so nothing from this request reaches
      // a shell — see the comment at the top of x_scan.yml.
      body: JSON.stringify({ ref: BRANCH }),
      cache: "no-store",
    },
  );

  if (!dispatch.ok) {
    const detail = await dispatch.text();
    return NextResponse.json(
      {
        ok: false,
        // GitHub's message names the actual cause: a token missing `actions:write`,
        // a workflow not on the default branch, a bad ref.
        reason: `GitHub refused the dispatch (${dispatch.status}): ${detail.slice(0, 300)}`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    // The run does not exist yet when dispatch returns 204, so the caller polls GET
    // rather than being handed an id that would be wrong.
    reason: "scan queued",
  });
}
