import "server-only";

/**
 * Write a position the owner captured by hand.
 *
 * Deliberately a sibling of `fpl-snapshot-store.ts` rather than a change to it.
 * That file persists what the OFFICIAL endpoint said, on every read of
 * `/api/fpl/state`; this one persists a claim the owner made. They share a table
 * because the table is a log of positions with a provenance column, and they
 * share its house style — raw PostgREST, no supabase-js — but conflating the two
 * writers would mean one function whose meaning depended on its caller.
 */

/** Integer tenths of a million, matching `pipeline.fpl.entry_api.EntryState`. */
export interface OwnerCapture {
  entryId: number;
  gameweek: number;
  squad: number[];
  bank: number;
  freeTransfers: number;
  purchasePrices: Record<number, number>;
  /** Millions, for the table's own column. The payload stays in tenths. */
  squadValue: number;
}

export type CaptureStatus = "saved" | "unconfigured" | "unavailable";

/**
 * The provenance value, matching `pipeline/fpl/hub_state.py` and the CHECK
 * constraint in `supabase/migrations/202608190001_add_owner_captured_source.sql`.
 * Not `captured_authenticated_draft`, which means "official picks were
 * unavailable" and is already rendered as "captured draft, not live".
 */
const OWNER_CAPTURED = "owner_captured";

function configuration() {
  const url = process.env.SUPABASE_URL;
  const secret =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null;
}

export async function saveOwnerCapture(
  capture: OwnerCapture,
  capturedAt: string
): Promise<CaptureStatus> {
  const config = configuration();
  if (!config) return "unconfigured";

  // Unique per capture, unlike the 15-minute bucket `saveFplSnapshot` uses. That
  // bucket is right for a poller writing the same official state repeatedly, and
  // wrong here: two deliberate captures minutes apart are two different claims,
  // and the second is usually a correction to the first. Keeping both leaves the
  // history readable; `read_capture` takes the newest, so a correction still wins.
  const snapshotKey = [
    capture.entryId,
    capture.gameweek,
    OWNER_CAPTURED,
    capturedAt,
  ].join(":");

  try {
    const response = await fetch(
      `${config.url}/rest/v1/fpl_manager_snapshots`,
      {
        method: "POST",
        headers: {
          apikey: config.secret,
          Authorization: `Bearer ${config.secret}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          snapshot_key: snapshotKey,
          entry_id: capture.entryId,
          event_id: capture.gameweek,
          source: OWNER_CAPTURED,
          captured_at: capturedAt,
          squad_value: capture.squadValue,
          // Millions here, tenths in the payload — the column exists to be read
          // in SQL, the payload to be read by the optimiser.
          bank: capture.bank / 10,
          payload: {
            squad: capture.squad,
            bank: capture.bank,
            free_transfers: capture.freeTransfers,
            purchase_prices: capture.purchasePrices,
          },
        }),
      }
    );
    return response.ok ? "saved" : "unavailable";
  } catch {
    return "unavailable";
  }
}
