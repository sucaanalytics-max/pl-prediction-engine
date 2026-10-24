"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Share2, X } from "lucide-react";
import { SANS, SIGNAL } from "@/lib/margin/tokens";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

/** How often a long-lived tab asks the browser whether `/sw.js` has changed. */
export const UPDATE_CHECK_MS = 30 * 60_000;

export default function PwaManager() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  // A worker that has installed and is waiting for the page's word to take over.
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Set only by a tap on "Reload". `controllerchange` also fires when a FIRST
  // install claims the page, and reloading then would be a pointless flash; and
  // a flag that is spent once is what keeps a controller flip-flop from looping.
  const reloadRequested = useRef(false);

  useEffect(() => {
    /**
     * Production only — and in development, actively torn down.
     *
     * `sw.js` caches `/_next/static/` first and never revalidates it, which is
     * correct for a production build because those URLs are content-hashed. A dev
     * server reuses chunk names across builds, so the worker serves yesterday's
     * chunks against today's HTML: React reports a hydration mismatch, the page
     * renders the PREVIOUS design, and the error points at the component being
     * edited rather than at the cache.
     *
     * That cost real time twice during the Signal redesign, both times looking
     * exactly like a bug in the work in progress. The unregister is the half that
     * matters — anyone who has already run this app on localhost is carrying the
     * worker now, and telling them to clear it by hand is not a fix.
     */
    if (process.env.NODE_ENV !== "production") {
      void (async () => {
        if (!("serviceWorker" in navigator)) return;
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
          await registration.unregister();
        }
        if ("caches" in window) {
          for (const key of await caches.keys()) await caches.delete(key);
        }
      })();
      return;
    }
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let reloaded = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    const container = navigator.serviceWorker;

    /* A waiting worker only counts as an UPDATE when something already controls
       the page. With no controller this is the first install, which the worker
       activates by itself, and an "update available" bar would be noise. */
    const watch = (worker: ServiceWorker) => {
      const consider = () => {
        if (worker.state === "installed" && container.controller) setWaiting(worker);
      };
      worker.addEventListener("statechange", consider);
      consider();
    };
    const onUpdateFound = () => {
      if (registration?.installing) watch(registration.installing);
    };
    const onControllerChange = () => {
      if (!reloadRequested.current || reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    const check = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => {});
    };

    container.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker.register("/sw.js").then((reg) => {
      if (cancelled) return;
      registration = reg;
      if (reg.waiting && container.controller) setWaiting(reg.waiting);
      if (reg.installing) watch(reg.installing);
      reg.addEventListener("updatefound", onUpdateFound);
      document.addEventListener("visibilitychange", check);
      interval = setInterval(check, UPDATE_CHECK_MS);
    }).catch(() => {
      // A registration that fails leaves the app working without a worker.
    });
    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
      registration?.removeEventListener("updatefound", onUpdateFound);
      document.removeEventListener("visibilitychange", check);
      if (interval) clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (isStandalone() || localStorage.getItem("suca-pwa-dismissed") === "1") {
      return;
    }

    setDismissed(false);
    setShowIosHint(isIos());
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onInstallPrompt);
  }, []);

  function applyUpdate() {
    if (!waiting) return;
    reloadRequested.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
  }

  function dismiss() {
    localStorage.setItem("suca-pwa-dismissed", "1");
    setDismissed(true);
  }

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") setDismissed(true);
    setPrompt(null);
  }

  const updateBar = waiting ? (
    <>
      {/* Above the mobile bottom nav, which is fixed and 99px plus the
          safe-area inset tall at 767px and below; a media query cannot live in
          an inline style, so the offset is a scoped rule. */}
      <style>{`
        .sw-update-bar { bottom: 16px; }
        @media (max-width: 767px) {
          .sw-update-bar { bottom: calc(99px + env(safe-area-inset-bottom) + 8px); }
        }
      `}</style>
      <div
        className="sw-update-bar"
        role="status"
        aria-live="polite"
        style={{
          position: "fixed", left: 16, right: 16, margin: "0 auto", maxWidth: 420,
          zIndex: 70, display: "flex", alignItems: "center", gap: 12,
          padding: "10px 12px", background: SIGNAL.ink, color: SIGNAL.shell,
          fontFamily: SANS, fontSize: 13, fontWeight: 600,
          boxShadow: "0 2px 12px rgba(20,23,28,.25)",
        }}
      >
        <RefreshCw size={15} aria-hidden="true" />
        <span style={{ flex: 1 }}>Update available</span>
        <button
          type="button"
          onClick={applyUpdate}
          style={{
            background: SIGNAL.shell, color: SIGNAL.ink, border: 0, cursor: "pointer",
            padding: "6px 12px", fontFamily: SANS, fontSize: 13, fontWeight: 700,
          }}
        >
          Reload
        </button>
      </div>
    </>
  ) : null;

  if (dismissed || (!prompt && !showIosHint)) return updateBar;

  return (
    <>
    {updateBar}
    <aside className="pwa-install-card" aria-label="Install Suca FPL app">
      <span className="pwa-install-icon"><Download size={17} /></span>
      <div>
        <strong>Install Suca FPL</strong>
        <span>
          {showIosHint
            ? "Tap Share, then Add to Home Screen."
            : "Add the decision portal to your home screen."}
        </span>
      </div>
      {prompt ? (
        <button className="pwa-install-action" onClick={() => void install()}>
          Install
        </button>
      ) : (
        <Share2 className="pwa-share-icon" size={16} />
      )}
      <button className="pwa-dismiss" onClick={dismiss} aria-label="Dismiss install prompt">
        <X size={14} />
      </button>
    </aside>
    </>
  );
}
