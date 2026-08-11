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
