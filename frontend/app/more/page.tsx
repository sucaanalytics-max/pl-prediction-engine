"use client";

/**
 * More — the things that are not a tab.
 *
 * The phone nav has five slots, so the destinations that are reached rather than
 * visited live here: the three "record" screens (`/capture`, `/evidence`,
 * `/review`), what the app is reading and how old it is, and the install prompt.
 * `/more` is the active tab for those three routes as well; see
 * `components/MobileBottomNav.tsx`.
 *
 * ## Data freshness is the registry's, not a list kept here
 *
 * Each row is a descriptor the app really loads, with the file's own timestamp.
 * See `components/more/FreshnessList.tsx`.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Download } from "lucide-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { FreshnessList } from "@/components/more/FreshnessList";
import { INSTALL_SHEET_EVENT } from "@/components/PwaManager";
import { SIGNAL } from "@/lib/margin/tokens";

/** One line each on what the screen does, in the words of the design. */
const RECORD: readonly { href: string; title: string; sub: string }[] = [
  { href: "/capture", title: "Capture", sub: "Record the squad you actually submitted" },
  { href: "/evidence", title: "Evidence", sub: "Team-news claims, conflicts and accuracy" },
  { href: "/review", title: "Review", sub: "What last gameweek cost, decision by decision" },
];

const HEADING = {
  margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
  textTransform: "uppercase" as const, color: SIGNAL.ink2,
};

const ROW = {
  display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "0 14px",
  background: SIGNAL.bar, color: SIGNAL.ink, textAlign: "left" as const,
  width: "100%", border: 0, font: "inherit",
};

function isStandalone(): boolean {
  return (
    Boolean(window.matchMedia?.("(display-mode: standalone)").matches) ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function InstallRow() {
  // Unknown until mounted: the display mode is a browser fact, not a server one.
  const [installed, setInstalled] = useState(false);
  useEffect(() => { setInstalled(isStandalone()); }, []);

  const body = (
    <>
      <Download size={20} aria-hidden="true" />
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {installed ? "Installed" : "Add to home screen"}
        </span>
        <span style={{ fontSize: 12, color: SIGNAL.ink3 }}>
          {installed
            ? "You are using the installed app"
            : "Full screen, and the last call kept offline"}
        </span>
      </span>
    </>
  );
  if (installed) return <div style={ROW}>{body}</div>;
  return (
    <button
      type="button"
      style={{ ...ROW, cursor: "pointer" }}
      onClick={() => window.dispatchEvent(new Event(INSTALL_SHEET_EVENT))}
    >
      {body}
    </button>
  );
}

export default function MorePage() {
  return (
    <ErrorBoundary pageName="More">
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h1 className="sr-only">More</h1>

        <section aria-labelledby="more-record" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 id="more-record" style={HEADING}>Record</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, background: SIGNAL.hair, border: `1px solid ${SIGNAL.hair}` }}>
            {RECORD.map((item) => (
              <Link key={item.href} href={item.href} style={{ ...ROW, textDecoration: "none" }}>
                <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</span>
                  <span style={{ fontSize: 12, color: SIGNAL.ink3 }}>{item.sub}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" color={SIGNAL.ink3} />
              </Link>
            ))}
          </div>
        </section>

        <section aria-labelledby="more-fresh" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <h2 id="more-fresh" style={HEADING}>Data freshness</h2>
            <span style={{ fontSize: 11, color: SIGNAL.ink3 }}>times in UTC</span>
          </div>
          <FreshnessList />
        </section>

        <section aria-labelledby="more-app" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 id="more-app" style={HEADING}>App</h2>
          <div style={{ border: `1px solid ${SIGNAL.hair}` }}>
            <InstallRow />
          </div>
        </section>
      </div>
    </ErrorBoundary>
  );
}
