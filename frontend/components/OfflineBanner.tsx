"use client";

import { useEffect, useState } from "react";
import { CloudOff } from "lucide-react";
import { SANS, SIGNAL } from "@/lib/margin/tokens";
import {
  getCachedAt, narrowServedCached, noteCachedAt, resetCachedAt, subscribeCachedAt,
} from "@/lib/sw-cache-age";

/** How long a "the worker answered from its cache" notice outlives its message. */
export const NOTICE_TTL_MS = 60_000;

/** "14:05" in the reader's own clock. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * Says when the device is not looking at the live feed.
 *
 * Two triggers, one label. The browser reports offline (`navigator.onLine` is
 * false) — or the browser believes it is online while the service worker has just
 * had to answer from its stored copy because the request failed, which is what a
 * dead captive-portal or half-connected phone looks like. Either way the figures
 * on screen are a stored copy, and this banner is the line that stops them being
 * read as live.
 *
 * "As of" is the OLDEST stamp among the stored copies on screen, so the time is
 * true of every number rather than of the freshest one. With no stamp known it
 * says only "Offline", not a time it cannot back.
 *
 * It sits in the page flow under the masthead rather than fixed to the bottom:
 * the mobile bottom nav is fixed (`--bottom-nav-h` tall), and a second fixed
 * element there would have to know that number.
 */
export default function OfflineBanner() {
  // `true` on the first render regardless of the browser, so server and client
  // agree and the effect below corrects it; reading `navigator` here would
  // mismatch on hydration.
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(getCachedAt);

  useEffect(() => {
    setOnline(navigator.onLine);
    setCachedAt(getCachedAt());
    const unsubscribe = subscribeCachedAt(() => setCachedAt(getCachedAt()));

    const goOnline = () => {
      setOnline(true);
      setNotice(false);
      // Every stamp so far described a copy that a live fetch is about to replace.
      resetCachedAt();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    const onMessage = (event: MessageEvent) => {
      const served = narrowServedCached(event.data);
      if (served === null) return;
      noteCachedAt(served.cachedAt);
      setNotice(true);
    };
    const container = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    container?.addEventListener("message", onMessage);

    return () => {
      unsubscribe();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      container?.removeEventListener("message", onMessage);
    };
  }, []);

  // A notice is a claim about a moment. Without a renewal it lapses, so a
  // connection that recovered silently does not leave the banner up.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(false), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const visible = !online || notice;
  const lead = online ? "Connection lost" : "Offline";
  const text = cachedAt
    ? `${lead} · showing data as of ${formatClock(cachedAt)}`
    : lead;

  // The live region is always in the DOM and only its content comes and goes:
  // a region inserted already populated is announced unreliably.
  //
  // A warm band under the masthead, as drawn: an icon, the claim in one line, and
  // under it what the claim means for the figures. The second line only appears
  // with a time to be true about: "since then" needs a "then".
  return (
    <div role="status" aria-live="polite" data-testid="offline-banner">
      {visible && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            background: "var(--warm)",
            borderBottom: `1px solid ${SIGNAL.rule}`,
            color: SIGNAL.ink,
            fontFamily: SANS,
          }}
        >
          <CloudOff size={18} aria-hidden="true" style={{ flex: "none" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{text}</span>
            {cachedAt ? (
              <span style={{ fontSize: 12, color: SIGNAL.ink2 }}>
                Nothing below has refreshed since then
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
