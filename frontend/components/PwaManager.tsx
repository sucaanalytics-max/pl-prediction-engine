"use client";

import { useEffect, useState } from "react";
import { Download, Share2, X } from "lucide-react";

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

export default function PwaManager() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

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
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js");
    }
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

  if (dismissed || (!prompt && !showIosHint)) return null;

  return (
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
  );
}
