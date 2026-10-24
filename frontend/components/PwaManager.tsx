"use client";

import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
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

/**
 * Dispatched on `window` by `/more` ("Add to home screen") to open the install
 * sheet on demand, including after it was dismissed. A DOM event rather than a
 * shared store: the sender needs nothing back, and PwaManager stays the only
 * owner of the browser's install prompt.
 */
export const INSTALL_SHEET_EVENT = "suca:install-sheet";

/** How often a long-lived tab asks the browser whether `/sw.js` has changed. */
export const UPDATE_CHECK_MS = 30 * 60_000;

export default function PwaManager() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  // Asked for from `/more`, which shows the sheet whether or not it was dismissed.
  const [requested, setRequested] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
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
    const onRequest = () => {
      setShowIosHint(isIos());
      setRequested(true);
    };
    window.addEventListener(INSTALL_SHEET_EVENT, onRequest);
    return () => window.removeEventListener(INSTALL_SHEET_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    // Captured even after a dismissal or inside the installed app's own tab, so
    // `/more` can still offer the native install; only the AUTOMATIC sheet
    // respects the dismissal.
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    if (!isStandalone() && localStorage.getItem("suca-pwa-dismissed") !== "1") {
      setDismissed(false);
      setShowIosHint(isIos());
    }
    return () => window.removeEventListener("beforeinstallprompt", onInstallPrompt);
  }, []);

  function applyUpdate() {
    if (!waiting) return;
    reloadRequested.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
  }

  function dismiss() {
    try { localStorage.setItem("suca-pwa-dismissed", "1"); } catch { /* storage blocked */ }
    setDismissed(true);
    setRequested(false);
  }

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") { setDismissed(true); setRequested(false); }
    setPrompt(null);
  }

  const updateBar = waiting ? (
    <>
      {/* Above the mobile bottom nav, whose height (inset included) is
          `--bottom-nav-h`, defined once in globals.css and zero off a phone; a
          media query cannot live in an inline style, so this is a scoped rule. */}
      <style>{`
        .sw-update-bar { bottom: calc(var(--bottom-nav-h) + 16px); }
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

  const open = requested || (!dismissed && (prompt !== null || showIosHint));
  if (!open) return updateBar;

  return (
    <>
      {updateBar}
      <InstallSheet
        sheetRef={sheetRef}
        canPrompt={prompt !== null}
        ios={showIosHint}
        onInstall={() => void install()}
        onDismiss={dismiss}
      />
    </>
  );
}

const SELLING_POINTS = [
  "Opens full screen, straight to this week's call",
  "Keeps the last call readable offline, marked with its age",
  "Long-press the icon for Players, Fixtures and Capture",
];

/**
 * The install prompt as a modal bottom sheet.
 *
 * Dialog semantics are real: `aria-modal`, a label, focus moved in on open and
 * held there with Tab, Escape to leave, and focus handed back on close. "Not now"
 * and Escape both persist the dismissal, as the old card's X did. Where the
 * browser gave no install event (iOS Safari, most desktop browsers) there is
 * nothing for a button to call, so the primary action becomes "Got it" and the
 * hint line says how to do it by hand.
 */
function InstallSheet({
  sheetRef, canPrompt, ios, onInstall, onDismiss,
}: {
  sheetRef: React.MutableRefObject<HTMLElement | null>;
  canPrompt: boolean;
  ios: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = sheetRef.current?.querySelector<HTMLElement>("button");
    first?.focus();
    return () => before?.focus?.();
  }, [sheetRef]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const items = sheetRef.current?.querySelectorAll<HTMLElement>("button");
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="pwa-install-scrim" aria-hidden="true" />
      <section
        ref={sheetRef}
        className="pwa-install-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-title"
        onKeyDown={onKeyDown}
      >
        <div className="pwa-sheet-grip" aria-hidden="true" />
        <div className="pwa-sheet-head">
          <div className="pwa-sheet-icon" aria-hidden="true">SU</div>
          <div>
            <h2 id="install-title" className="pwa-sheet-title">Put Suca on your home screen</h2>
            <span className="pwa-sheet-host">{typeof location === "undefined" ? "" : location.host}</span>
          </div>
        </div>
        <ul className="pwa-sheet-list">
          {SELLING_POINTS.map((text) => (
            <li key={text}><Check size={18} aria-hidden="true" />{text}</li>
          ))}
        </ul>
        <div className="pwa-sheet-actions">
          {canPrompt ? (
            <>
              <button type="button" className="pwa-sheet-btn" onClick={onDismiss}>Not now</button>
              <button type="button" className="pwa-sheet-btn primary" onClick={onInstall}>Install</button>
            </>
          ) : (
            <button type="button" className="pwa-sheet-btn primary" onClick={onDismiss}>Got it</button>
          )}
        </div>
        <span className="pwa-sheet-hint">
          {ios || canPrompt
            ? "On iPhone: tap Share in Safari, then Add to Home Screen."
            : "In your browser's menu, choose Install app or Add to Home Screen."}
        </span>
      </section>
    </>
  );
}
