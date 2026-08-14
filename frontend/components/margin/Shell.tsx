"use client";

/**
 * The bar across the top of Margin: identity, the four views, mode, clock.
 *
 * ## The tabs are state, not routes
 *
 * Four URLs would be more idiomatic for this app and worse for this screen. The
 * views are one workspace read in a loop — you check the call, drop into the
 * research table to argue with a number, and come back — and a route change
 * unmounts the research table's search, sort and selection every time. Keeping
 * them mounted-in-place is what makes `1`–`4` worth binding.
 *
 * ## The clock re-renders alone
 *
 * `Clock` owns its own tick. Hoisting the second hand into the page would
 * re-render the 581-row research table once a second, which is a real cost for a
 * counter that only earns its seconds in the last day before a deadline — so it
 * ticks per second inside a day and per minute outside one.
 */

import { useEffect, useState } from "react";
import { proven, type Artifact } from "@/lib/data/artifact";
import type { AgentStatus } from "@/lib/data/agent-status";
import {
  clockLabel, countdown, modeOf, remainingMs, type MarginMode,
} from "@/lib/margin/mode";
import { INK, MONO, type MarginSurface } from "@/lib/margin/tokens";

export const VIEWS = ["decide", "score", "research", "watch"] as const;
export type MarginView = (typeof VIEWS)[number];

/** `1`–`4`, in the order the tabs are read. */
const KEYS: Record<string, MarginView> = {
  "1": "decide", "2": "score", "3": "research", "4": "watch",
};

export function useViewKeys(setView: (view: MarginView) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A number typed into the research search box is a search, not a tab
      // change. Without this the table's own filter is unusable.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const next = KEYS[event.key];
      if (next) setView(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);
}

function Tab(
  { name, active, surface, onSelect }: {
    name: MarginView;
    active: boolean;
    surface: MarginSurface;
    onSelect: (view: MarginView) => void;
  },
) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(name)}
      style={{
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        padding: "6px 11px",
        cursor: "pointer",
        border: 0,
        color: active ? surface.shell : surface.ink2,
        background: active ? surface.ink : "transparent",
      }}
    >
      {name}
    </button>
  );
}

/**
 * Which state the engine is in, said in the bar rather than inferred from the
 * emptiness of the screen below it.
 *
 * `unknown` is drawn in the conflict hue and the other three are not: idle is
 * the engine behaving correctly, and colouring it as a fault would train the
 * reader to ignore the one state that is one.
 */
function ModeChip(
  { mode, status, surface }: {
    mode: MarginMode; status: AgentStatus | null; surface: MarginSurface;
  },
) {
  const tone =
    mode === "deadline" ? surface.agree
      : mode === "unknown" ? surface.conflict
        : surface.ink3;

  const label =
    mode === "deadline" ? "Deadline mode · engine has run"
      : mode === "idle" ? "Idle · engine gated"
        : mode === "locked" ? "Locked · gameweek settled"
          : "Phase unknown";

  return (
    <span
      title={status?.reason ?? undefined}
      data-testid="margin-mode"
      data-mode={mode}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
        textTransform: "uppercase", padding: "4px 9px",
        border: `1px solid ${mode === "deadline" ? tone : surface.hair}`,
        color: tone,
      }}
    >
      <span
        style={{
          width: 5, height: 5, borderRadius: "50%",
          background: mode === "deadline" ? tone : surface.ink3,
        }}
      />
      {label}
    </span>
  );
}

function Clock(
  { deadline, mode, surface }: {
    deadline: string | null; mode: MarginMode; surface: MarginSurface;
  },
) {
  const [now, setNow] = useState<Date | null>(null);

  // Null until mounted, so the server-rendered markup and the first client
  // render agree. A `new Date()` initialiser would differ between the two and
  // hydrate with a mismatch on a value that changes every second.
  useEffect(() => {
    setNow(new Date());
    const left = remainingMs(deadline, new Date());
    const period = left !== null && left > 0 && left < 86_400_000 ? 1000 : 60_000;
    const id = setInterval(() => setNow(new Date()), period);
    return () => clearInterval(id);
  }, [deadline]);

  const left = now ? remainingMs(deadline, now) : null;

  return (
    <div style={{ textAlign: "right" }}>
      <div
        style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: ".1em",
          textTransform: "uppercase", color: surface.ink3,
        }}
      >
        {clockLabel(mode)}
      </div>
      <div
        data-testid="margin-clock"
        style={{
          fontFamily: MONO, fontSize: 15, fontWeight: 600,
          color: surface.ink, letterSpacing: "-.02em",
        }}
      >
        {now === null ? "—" : countdown(left)}
      </div>
    </div>
  );
}

export function Shell(
  { view, onView, status, children }: {
    view: MarginView;
    onView: (view: MarginView) => void;
    status: Artifact<AgentStatus>;
    children: React.ReactNode;
  },
) {
  const value = proven(status);
  const mode = modeOf(value);
  // The bar is always ink. It is the one element common to all four views, and a
  // bar that inverted with the surface would read as a different application.
  const surface = INK;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "0 20px", height: 52, flexWrap: "wrap",
          borderBottom: `1px solid ${surface.hair}`,
          background: surface.bar, position: "sticky", top: 0, zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span
            style={{
              fontFamily: MONO, fontSize: 12.5, fontWeight: 600,
              letterSpacing: ".16em", color: surface.ink,
            }}
          >
            MARGIN
          </span>
          <span style={{ width: 1, height: 16, background: surface.hair }} />
          <div style={{ display: "flex", gap: 2 }} role="tablist" aria-label="Margin views">
            {VIEWS.map((name) => (
              <Tab
                key={name}
                name={name}
                active={view === name}
                surface={surface}
                onSelect={onView}
              />
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ModeChip mode={mode} status={value} surface={surface} />
          <Clock deadline={value?.deadline ?? null} mode={mode} surface={surface} />
        </div>
      </div>
      {children}
    </div>
  );
}
