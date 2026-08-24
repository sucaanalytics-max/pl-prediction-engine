/**
 * The tab manifest.
 *
 * Small tests, and the point of them is the invariant rather than the data: a
 * blocked tab must SAY what is missing, and a live tab must name the artifact it
 * reads. Both halves are how the screen avoids the two failure modes it was
 * designed against — a column of blanks with no explanation, and a column filled
 * with something that resembles the real measure.
 */
import { describe, expect, it } from "vitest";

import {
  STAT_TABS, blockedTabs, livedTabs, tabByKey,
} from "@/lib/projections/stat-tabs";

describe("the manifest", () => {
  it("gives every tab a unique key", () => {
    const keys = STAT_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every tab a note, so no column is unexplained", () => {
    for (const tab of STAT_TABS) {
      expect(tab.note.length, tab.key).toBeGreaterThan(40);
    }
  });

  it("makes every blocked tab say what is missing", () => {
    // The invariant. A struck-through tab with no reason is worse than no tab:
    // it tells the reader a column is unavailable and nothing about why.
    for (const tab of blockedTabs()) {
      expect(tab.blockedBy, `${tab.key} is blocked and does not say why`)
        .toBeTruthy();
    }
  });

  it("never marks a live tab as blocked", () => {
    for (const tab of livedTabs()) {
      expect(tab.blockedBy, tab.key).toBeUndefined();
    }
  });

  it("has something to show, and something it admits it cannot", () => {
    // Guards the guard: an empty live list would make the screen vacuous and an
    // empty blocked list would mean the honesty above is never exercised.
    expect(livedTabs().length).toBeGreaterThan(0);
    expect(blockedTabs().length).toBeGreaterThan(0);
  });

  it("opens on a tab that can actually be filled", () => {
    expect(STAT_TABS[0].source).not.toBeNull();
  });

  it("falls back to the first tab rather than throwing on an unknown key", () => {
    expect(tabByKey("nonsense")).toBe(STAT_TABS[0]);
    expect(tabByKey("expected").key).toBe("expected");
  });
});
