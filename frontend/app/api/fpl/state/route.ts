import { NextResponse } from "next/server";

import { FPL_ENTRY_ID, type FplLiveResponse } from "@/lib/fpl-live";
import { buildFplLiveState } from "@/lib/fpl-live-server";
import {
  loadLatestFplSnapshot,
  saveFplSnapshot,
} from "@/lib/fpl-snapshot-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await buildFplLiveState();
    const persistence = await saveFplSnapshot(state);
    state.freshness.persistence = persistence;

    return NextResponse.json<FplLiveResponse>(
      { data: state, persistence },
      {
        headers: {
          // `private` would forbid shared-cache storage and so silently void
          // the s-maxage/stale-while-revalidate directives below. This payload
          // is identical for every requester (the entry id comes from the
          // environment, not the request), so the CDN copy is the intended
          // behaviour: browsers always revalidate, the edge holds it 15 minutes.
          "Cache-Control": "public, max-age=0, s-maxage=900, stale-while-revalidate=3600",
        },
      }
    );
  } catch (error) {
    const snapshot = await loadLatestFplSnapshot(FPL_ENTRY_ID);
    if (snapshot) {
      snapshot.freshness.squad = "stored";
      snapshot.freshness.persistence = "saved";
      snapshot.notices = [
        "The official FPL API is temporarily unavailable; showing the latest private snapshot.",
        ...snapshot.notices,
      ];
      return NextResponse.json<FplLiveResponse>(
        { data: snapshot, persistence: "saved" },
        {
          headers: {
            "Cache-Control": "private, no-store",
            Warning: '110 - "Response is stale"',
          },
        }
      );
    }

    // Logged server-side only. Upstream fetch failures embed internal URLs and
    // hostnames in their messages, so the detail must not reach the client.
    console.error("FPL live state unavailable and no snapshot to fall back on:", error);

    return NextResponse.json(
      { error: "FPL live data is temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
