"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Whether the browser reports a connection.
 *
 * `true` on the server and on the hydrating render, so markup agrees and the
 * store corrects it straight after; reading `navigator` during render would
 * mismatch. It is the browser's claim only, which is the same signal
 * `OfflineBanner` leads with. A captive portal can still read as online, and the
 * banner's service-worker notice covers that case; nothing gated on this hook
 * does anything irreversible.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
