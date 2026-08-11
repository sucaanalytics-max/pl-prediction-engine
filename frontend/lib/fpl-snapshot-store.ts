import "server-only";

import type { FplLiveState } from "./fpl-live";

type PersistenceStatus = "saved" | "unconfigured" | "unavailable";

function configuration() {
  const url = process.env.SUPABASE_URL;
  const secret =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null;
}

function headers(secret: string) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

export async function saveFplSnapshot(
  state: FplLiveState
): Promise<PersistenceStatus> {
  const config = configuration();
  if (!config) return "unconfigured";

  const fifteenMinuteBucket = Math.floor(
    new Date(state.generatedAt).getTime() / (15 * 60 * 1000)
  );
  const snapshotKey = [
    state.entry.id,
    state.event.id,
    state.squad.source,
    fifteenMinuteBucket,
  ].join(":");

  try {
    const response = await fetch(
      `${config.url}/rest/v1/fpl_manager_snapshots?on_conflict=snapshot_key`,
      {
        method: "POST",
        headers: {
          ...headers(config.secret),
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          snapshot_key: snapshotKey,
          entry_id: state.entry.id,
          event_id: state.event.id,
          source: state.squad.source,
          captured_at: state.generatedAt,
          squad_value: state.squad.value,
          bank: state.squad.bank,
          payload: state,
        }),
      }
    );
    return response.ok ? "saved" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function loadLatestFplSnapshot(
  entryId: number
): Promise<FplLiveState | null> {
  const config = configuration();
  if (!config) return null;

  try {
    const query = new URLSearchParams({
      entry_id: `eq.${entryId}`,
      select: "payload",
      order: "captured_at.desc",
      limit: "1",
    });
    const response = await fetch(
      `${config.url}/rest/v1/fpl_manager_snapshots?${query}`,
      {
        headers: headers(config.secret),
        cache: "no-store",
      }
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<{ payload: FplLiveState }>;
    return rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}
