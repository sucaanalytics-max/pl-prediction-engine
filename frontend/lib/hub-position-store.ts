import "server-only";

/**
 * Commit a position the owner captured by hand.
 *
 * ## Why a commit and not a database row
 *
 * This project has no database. Truth is committed JSON served from the CDN, and
 * the artifact layer's five states do the work a query layer would. A capture is
 * the same kind of fact, so it goes to the same place: one file per entry under
 * `predictions/fpl/hub/capture/`, read by the agent out of its own checkout.
 *
 * The cost is latency — a commit reaches the NEXT agent tick, not one already in
 * flight, because the `work` job checks out before it runs. Inside a Friday seal
 * window `fpl_agent.yml` ticks every thirty minutes, so that is a half-hour wait
 * hours before a deadline, which did not justify a second store and a second
 * secret. What it buys is that `git log` on this path shows every position the
 * owner has ever claimed, timestamped outside our control — a row overwritten in
 * place leaves no trace of what it replaced.
 *
 * ## The Contents API, not a workflow dispatch
 *
 * `x-scan` dispatches a workflow and passes NO inputs, precisely so that nothing
 * from an HTTP request reaches a shell. Here the request body IS the payload, so a
 * dispatch would have to carry it as an input and would reintroduce exactly that
 * hazard. The Contents API is a data API: the base64 blob is never interpolated
 * into a command, so the danger is avoided by construction rather than by
 * discipline. It is also compare-and-swap on the blob `sha`, which is a stronger
 * guarantee than the retry loop a committing workflow would need.
 */

/** Integer tenths of a million, matching `pipeline.fpl.entry_api.EntryState`. */
export interface OwnerCapture {
  entryId: number;
  gameweek: number;
  squad: number[];
  bank: number;
  freeTransfers: number;
  purchasePrices: Record<number, number>;
  /** Millions, as the owner reads it off FPL. Recorded, never used for maths. */
  squadValue: number;
}

export type CaptureStatus = "saved" | "unconfigured" | "unavailable" | "conflict";

/** Matches `OWNER_CAPTURED` in `pipeline/fpl/hub_state.py`. */
const OWNER_CAPTURED = "owner_captured";

/** Same repo and branch resolution as `x-scan`, so one env configures both. */
const REPO = process.env.X_SCAN_REPO ?? "sucaanalytics-max/pl-prediction-engine";
const BRANCH = process.env.X_SCAN_REF ?? "main";

/**
 * Declared in the other workflows' FORBID_PATHS, not merely disjoint from them.
 * `pipeline.yml` stages `predictions` wholesale, so "nothing else happens to write
 * here" would be a coincidence rather than a guarantee.
 */
function capturePath(entryId: number): string {
  return `predictions/fpl/hub/capture/${entryId}.json`;
}

/** The same PAT `x-scan` uses. A second token would be a second thing to rotate. */
function token(): string | null {
  return process.env.GITHUB_DISPATCH_TOKEN ?? null;
}

function headers(secret: string) {
  return {
    Authorization: `Bearer ${secret}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * The blob sha of the file we are about to replace, or null if there is none.
 *
 * Required by the Contents API to overwrite: passing no sha against an existing
 * path returns 422, which is how the API refuses to clobber blindly.
 */
async function currentSha(secret: string, path: string): Promise<string | null> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: headers(secret), cache: "no-store" }
  );
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = (await response.json()) as { sha?: string };
  return body.sha ?? null;
}

export async function saveOwnerCapture(
  capture: OwnerCapture,
  capturedAt: string
): Promise<{ status: CaptureStatus; commit: string | null }> {
  const secret = token();
  if (!secret) return { status: "unconfigured", commit: null };

  const path = capturePath(capture.entryId);

  // Written in the shape hub_state.py reads, tenths and all, so the agent does no
  // conversion on the way into a decision.
  const payload = {
    source: OWNER_CAPTURED,
    entry_id: capture.entryId,
    gameweek: capture.gameweek,
    captured_at: capturedAt,
    squad: capture.squad,
    bank: capture.bank,
    free_transfers: capture.freeTransfers,
    purchase_prices: capture.purchasePrices,
    squad_value: capture.squadValue,
  };

  try {
    const sha = await currentSha(secret, path);
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: headers(secret),
        body: JSON.stringify({
          message: `Capture position — entry ${capture.entryId} GW${capture.gameweek}`,
          content: Buffer.from(JSON.stringify(payload, null, 2) + "\n").toString("base64"),
          branch: BRANCH,
          ...(sha ? { sha } : {}),
        }),
      }
    );

    // 409 is the compare-and-swap losing: someone else wrote between our read and
    // our write. Reported rather than retried, because a silent retry would
    // overwrite a capture the owner may have just made from another tab.
    if (response.status === 409 || response.status === 422) {
      return { status: "conflict", commit: null };
    }
    if (!response.ok) return { status: "unavailable", commit: null };

    const body = (await response.json()) as { commit?: { sha?: string } };
    return { status: "saved", commit: body.commit?.sha ?? null };
  } catch {
    return { status: "unavailable", commit: null };
  }
}
