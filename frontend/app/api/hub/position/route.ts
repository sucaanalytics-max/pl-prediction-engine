import { NextResponse } from "next/server";

import { OWNER_ENTRY } from "@/lib/entry";
import { saveOwnerCapture, type OwnerCapture } from "@/lib/hub-position-store";

/**
 * Capture a position the owner has actually put into FPL.
 *
 * ## Why this exists at all
 *
 * This project has no database, so a capture goes where every other fact goes: a
 * committed file, written through GitHub's Contents API and read by the agent out
 * of its own checkout. The cost is that a capture reaches the NEXT agent tick
 * rather than one already in flight — every thirty minutes inside a Friday seal
 * window — which did not justify a second store and a second secret.
 *
 * ## One entry, and it is the owner's
 *
 * The allowlist is {@link OWNER_ENTRY}, which mirrors `pipeline/config.py`
 * `FPL_ENTRIES` — the one entry the agent solves for. It is not derived from a
 * team list here: this route once built its allowlist from the deleted control
 * room's three-team model, which meant it accepted the two bot entries that had
 * detached to their own project and refused the only entry a capture can reach.
 * A capture for anything else is a file `_read_entry` never opens.
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
  if (!isWholeNumber(entryId) || entryId !== OWNER_ENTRY) {
    return {
      error:
        `entryId must be ${OWNER_ENTRY}, the one entry this repo decides for. ` +
        `The two bot entries moved to their own project on 2026-08-24, and a ` +
        `capture for any other entry is a file the agent never reads.`,
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
  const { status, commit } = await saveOwnerCapture(parsed.capture, capturedAt);

  if (status === "unconfigured") {
    return NextResponse.json(
      {
        error:
          "GITHUB_DISPATCH_TOKEN is not set for this deployment, so the capture " +
          "could not be committed. Nothing was saved.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (status === "conflict") {
    return NextResponse.json(
      {
        error:
          "Another capture for this entry landed first, so this one was refused " +
          "rather than overwriting it. Reload to see the stored position, then " +
          "capture again if it is still wrong.",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (status === "unavailable") {
    return NextResponse.json(
      { error: "The capture could not be committed. Nothing was saved; try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      status,
      capturedAt,
      // The commit is the receipt. A capture is only real once it is in the
      // record, so the screen quotes the sha rather than saying "saved".
      commit,
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
