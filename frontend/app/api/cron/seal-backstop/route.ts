import { NextResponse } from "next/server";

import {
  DISPATCH_BODY,
  busyReason,
  inBand,
  narrowRuns,
  nextDeadline,
  sealBand,
} from "@/lib/seal-backstop";

/**
 * Vercel Cron: dispatch the FPL agent when a seal band is open and nothing sealed.
 *
 * Scheduled every ten minutes by `frontend/vercel.json`. The reasoning, and why a
 * redundant dispatch cannot double-seal, is in `lib/seal-backstop.ts`.
 *
 * ## What each invocation costs
 *
 * Outside a band — almost every invocation — one FPL bootstrap read and nothing
 * else: no GitHub call, no token. Inside a 3.5-hour band: two GitHub reads (is it
 * sealed, is a run in flight) and at most one dispatch.
 *
 * The bootstrap read is `no-store`. It is around 2 MB, at or over the data cache's
 * limit, so a revalidate would log `Failed to set fetch cache` and refetch anyway —
 * the reason `lib/fpl-live-server.ts` names it UNCACHEABLE.
 *
 * ## Refusals
 *
 * Only Vercel's cron may call it: Vercel sends `Authorization: Bearer $CRON_SECRET`
 * and anything else is a 401 — the x-scan trigger's constant-time comparison. It
 * dispatches a job that can commit to main, so an open endpoint would let anyone
 * holding the URL spend runner minutes.
 *
 * Inside a band with no GITHUB_DISPATCH_TOKEN it answers 503, not 200: the one
 * time a missing token matters is the one time it should show as a failure in the
 * cron log. Outside a band its absence is not yet a problem and is reported as a
 * state.
 */
export const dynamic = "force-dynamic";

const REPO = process.env.X_SCAN_REPO ?? "sucaanalytics-max/pl-prediction-engine";
const WORKFLOW = "fpl_agent.yml";
const BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/";

/** Constant-time comparison, as `app/api/x-scan/route.ts` does it. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Answer, and log anything that is not the routine "outside the band".
 *
 * Vercel records every invocation's status already; the body is what says WHY a
 * band passed without a dispatch, and it is only in the runtime log if printed.
 * Failures go to stderr so the log marks them as errors.
 */
function reply(body: { action: string } & Record<string, unknown>, status = 200) {
  const line = `seal-backstop ${JSON.stringify(body)}`;
  if (status >= 500) console.error(line);
  else if (body.action !== "outside-band") console.log(line);
  return NextResponse.json(body, { status });
}

function github(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const given = request.headers.get("authorization") ?? "";
  if (!expected || !secretMatches(given, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  let bootstrap: unknown;
  try {
    const response = await fetch(BOOTSTRAP, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`FPL bootstrap ${response.status}`);
    bootstrap = await response.json();
  } catch (error) {
    return reply(
      { action: "error", reason: `could not read FPL's calendar: ${String(error)}` },
      502,
    );
  }

  const next = nextDeadline(bootstrap, now);
  if (!next) {
    return reply({ action: "no-deadline", reason: "no future deadline in FPL's calendar" });
  }
  const band = sealBand(next.deadline);
  const where = {
    gameweek: next.gameweek,
    deadline: next.deadline.toISOString(),
    band: { opens: band.opens.toISOString(), closes: band.closes.toISOString() },
  };
  if (!inBand(next.deadline, now)) {
    return reply({
      action: "outside-band",
      tokenConfigured: Boolean(process.env.GITHUB_DISPATCH_TOKEN),
      ...where,
    });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return reply(
      {
        action: "no-token",
        reason: "inside the seal band but GITHUB_DISPATCH_TOKEN is not set, so nothing can be dispatched",
        ...where,
      },
      503,
    );
  }

  // A thrown fetch — DNS, a reset — is a 502 with the reason, not an unhandled 500
  // whose body says nothing about which of the three calls failed.
  try {
    const ledger = `predictions/fpl/ledger/gw${String(next.gameweek).padStart(2, "0")}/forecast.jsonl`;
    const sealed = await fetch(`https://api.github.com/repos/${REPO}/contents/${ledger}?ref=main`, {
      method: "HEAD",
      headers: github(token),
      cache: "no-store",
    });
    if (sealed.ok) {
      return reply({ action: "sealed", ...where });
    }
    if (sealed.status !== 404) {
      return reply(
        { action: "error", reason: `could not read the ledger: GitHub ${sealed.status}`, ...where },
        502,
      );
    }

    const runsResponse = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: github(token), cache: "no-store" },
    );
    if (!runsResponse.ok) {
      return reply(
        { action: "error", reason: `could not list agent runs: GitHub ${runsResponse.status}`, ...where },
        502,
      );
    }
    const busy = busyReason(narrowRuns(await runsResponse.json()), now);
    if (busy) {
      return reply({ action: "busy", reason: busy, ...where });
    }

    const dispatch = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: { ...github(token), "Content-Type": "application/json" },
        body: JSON.stringify(DISPATCH_BODY),
        cache: "no-store",
      },
    );
    if (!dispatch.ok) {
      // GitHub's sentence names the fix — "Resource not accessible by personal
      // access token" is a token without Actions: write — so it is relayed.
      const detail = (await dispatch.text()).slice(0, 300);
      return reply(
        { action: "error", reason: `dispatch refused: GitHub ${dispatch.status} ${detail}`.trim(), ...where },
        502,
      );
    }
  } catch (error) {
    return reply({ action: "error", reason: `GitHub unreachable: ${String(error)}`, ...where }, 502);
  }
  return reply({ action: "dispatched", ...where });
}
