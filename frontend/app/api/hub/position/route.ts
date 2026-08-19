import { NextResponse } from "next/server";

import { TEAMS } from "@/lib/control-room/model";
import { saveOwnerCapture, type OwnerCapture } from "@/lib/hub-position-store";

/**
 * Capture a position the owner has actually put into FPL.
 *
 * ## Why this exists at all
 *
 * The agent's `work` job checks out the repo, installs dependencies, and only
 * then runs — so a position committed to git cannot reach the run already in
 * flight. This route writes to Supabase instead, and `pipeline/fpl/hub_state.py`
 * reads it over the network at decision time.
 *
 * ## Two entries, not three
 *
 * The allowlist is derived from `TEAMS` rather than written out, so it cannot
 * drift from the model: only entries with `kind: "bot"` are accepted, because
 * only those reach `_decide_for_entries`. The owner's own team (20945) is a
 * display entity — a capture for it would have no consumer, and accepting one
 * would imply a proposal that never arrives.
 *
 * ## No auth layer here, deliberately
 *
 * Vercel Deployment Protection already gates this deployment on the owner's
 * Vercel account, enforced at the edge before a request reaches this function. A
 * password or passkey on top would be a second, weaker secret guarding something
 * already guarded — the kind of over-build that makes a system feel secured
 * rather than be secured.
 */
export const dynamic = "force-dynamic";

const SQUAD_SIZE = 15;
const FIRST_GAMEWEEK = 1;
const LAST_GAMEWEEK = 38;

const DECIDED_FOR = new Set(
  TEAMS.filter((team) => team.kind === "bot").map((team) => team.entryId)
);

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate the body into a capture, or return why it was refused.
 *
 * Every field is checked rather than trusted. This is the boundary between a
 * browser form and an optimiser: a squad of fourteen would read downstream as a
 * free slot and the bank would be spent on it, and a price attached to a player
 * who is not in the squad would be silently ignored while looking like it had
 * been supplied.
 */
function parse(body: unknown): { capture: OwnerCapture } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Expected a JSON object." };
  }
  const raw = body as Record<string, unknown>;

  const entryId = raw.entryId;
  if (!isWholeNumber(entryId) || !DECIDED_FOR.has(entryId)) {
    return {
      error:
        `entryId must be one of the entries the agent decides for ` +
        `(${[...DECIDED_FOR].join(", ")}). The owner's own team is advisory only.`,
    };
  }

  const gameweek = raw.gameweek;
  if (
    !isWholeNumber(gameweek) ||
    gameweek < FIRST_GAMEWEEK ||
    gameweek > LAST_GAMEWEEK
  ) {
    return { error: `gameweek must be between ${FIRST_GAMEWEEK} and ${LAST_GAMEWEEK}.` };
  }

  const squad = raw.squad;
  if (
    !Array.isArray(squad) ||
    squad.length !== SQUAD_SIZE ||
    !squad.every((element) => isWholeNumber(element) && element > 0)
  ) {
    return { error: `squad must be ${SQUAD_SIZE} positive element ids.` };
  }
  if (new Set(squad).size !== SQUAD_SIZE) {
    return { error: `squad must be ${SQUAD_SIZE} DISTINCT element ids.` };
  }

  const bank = raw.bank;
  if (!isWholeNumber(bank)) {
    return { error: "bank must be a whole number of tenths of a million (35 for £3.5m)." };
  }

  const freeTransfers = raw.freeTransfers;
  if (!isWholeNumber(freeTransfers)) {
    return { error: "freeTransfers must be a whole number." };
  }

  const squadValue = raw.squadValue;
  if (typeof squadValue !== "number" || !Number.isFinite(squadValue) || squadValue < 0) {
    return { error: "squadValue must be a non-negative number of millions." };
  }

  // Optional. Absent prices are not an error: hub_state routes every unpriced
  // player into EntryState's `untraced`, so the decision path flags the selling
  // prices as uncertain instead of quietly pricing them at now_cost.
  const purchasePrices: Record<number, number> = {};
  const supplied = raw.purchasePrices;
  if (supplied !== undefined) {
    if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) {
      return { error: "purchasePrices must be an object keyed by element id." };
    }
    const held = new Set(squad as number[]);
    for (const [key, price] of Object.entries(supplied)) {
      const element = Number(key);
      if (!Number.isInteger(element) || !held.has(element)) {
        return { error: `purchasePrices names ${key}, which is not in the squad.` };
      }
      if (!isWholeNumber(price) || price <= 0) {
        return { error: `purchasePrices[${key}] must be positive tenths of a million.` };
      }
      purchasePrices[element] = price;
    }
  }

  return {
    capture: {
      entryId,
      gameweek,
      squad: squad as number[],
      bank,
      freeTransfers,
      purchasePrices,
      squadValue,
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body was not valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const parsed = parse(body);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Stamped by the server, not the client. `captured_at` is what the agent's
  // staleness check compares against FPL's price-change boundary, so a clock the
  // caller controls could make an expired capture look fresh.
  const capturedAt = new Date().toISOString();
  const status = await saveOwnerCapture(parsed.capture, capturedAt);

  if (status === "unconfigured") {
    return NextResponse.json(
      {
        error:
          "Supabase is not configured for this deployment, so the capture was " +
          "not stored. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (status === "unavailable") {
    return NextResponse.json(
      { error: "The capture could not be stored. Nothing was saved; try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      status,
      capturedAt,
      // Echoed so the screen can say what was recorded rather than implying it.
      recorded: {
        entryId: parsed.capture.entryId,
        gameweek: parsed.capture.gameweek,
        players: parsed.capture.squad.length,
        pricesSupplied: Object.keys(parsed.capture.purchasePrices).length,
      },
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
