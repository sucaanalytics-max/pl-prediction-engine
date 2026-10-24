"use client";

/**
 * The sticky title bar every phone screen opens with.
 *
 * Sits under the masthead (56px, sticky) and bleeds to the screen edge by
 * cancelling the layout's own 16px gutter and 20px top padding, so the bar reads
 * as chrome rather than as a card floating in the page.
 */

import type { ReactNode } from "react";

import { SANS, SIGNAL } from "@/lib/margin/tokens";

const S = SIGNAL;

/**
 * The masthead's rendered height at phone width: 56px, measured in the browser
 * at 390px. `.masthead` declares `min-height: 50px` but its two-line team block
 * makes it 56, and a sticky bar at 50 slid 6px under it.
 */
const MASTHEAD_H = 56;

export function PhoneHeader({
  title, aside, sticky = true, flushBottom = false, children,
}: {
  readonly title: string;
  /** Right-aligned context: the gameweek, a count. */
  readonly aside?: ReactNode;
  readonly sticky?: boolean;
  /** Tabs sit on the bar's bottom rule, so the bar adds no padding under them. */
  readonly flushBottom?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <header
      data-testid="phone-header"
      style={{
        position: sticky ? "sticky" : "static", top: MASTHEAD_H, zIndex: 20,
        margin: "-20px -16px 0",
        padding: flushBottom ? "12px 16px 0" : "12px 16px",
        display: "flex", flexDirection: "column", gap: 10,
        background: S.bar, borderBottom: `1px solid ${S.rule}`,
        fontFamily: SANS, color: S.ink,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>{title}</h1>
        {aside ? <span style={{ fontSize: 12, color: S.ink3 }}>{aside}</span> : null}
      </div>
      {children}
    </header>
  );
}
