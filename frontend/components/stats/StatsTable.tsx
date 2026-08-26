"use client";

/**
 * The stats screen — detailed numbers on players owned and not owned.
 *
 * Three tabs read a published artifact; three name a feed this pipeline does not
 * carry yet and are struck through with the reason. The manifest in
 * `lib/projections/stat-tabs.ts` decides which is which, so "can we build a
 * Defending tab" has one answer and it is a fact about a file.
 *
 * ## Ownership is the filter, because that is the question
 *
 * "Owned and not owned" was the ask, and the two need different columns of
 * attention rather than different screens: the same table, filtered, is what lets
 * a comparison happen at all. `not owned` is the transfer shortlist and `my squad`
 * is the sell list, and they share every column.
 *
 * ## Per-90 columns are gated, not computed
 *
 * `player_stats.json` carries `ratesAreMeaningful`, derived where the trap lives:
 * its per-90 arithmetic is `xg / max(minutes / 90, 0.1)`, so a player with no
 * minutes reads as `xg * 10`. Understat's rows withhold the rate outright below
 * ninety minutes. Both are respected here — a withheld rate renders as ∅, which is
 * a different mark from a zero, because a zero is a claim.
 */

import { useDeferredValue, useMemo, useState } from "react";

import { proven } from "@/lib/data/artifact";
import { PLAYER_EVENTS, type PlayerEvent } from "@/lib/data/player-events";
import { projectionsDescriptor, type Projection } from "@/lib/data/projections";
import { REGISTRY, type PlayerRow } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";
import { STAT_TABS, blockedTabs, tabByKey } from "@/lib/projections/stat-tabs";

const S = FLOODLIT;

type Show = "all" | "mine" | "theirs";

interface Column {
  readonly key: string;
  readonly label: string;
  /** null renders as ∅ — withheld, which is not a zero. */
  readonly of: (row: StatRow) => number | string | null;
  readonly decimals?: number;
}

/** One player, whichever tab is open. Only the open tab's fields are filled. */
interface StatRow {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
  readonly position: string;
  readonly owned: boolean;
  readonly stats: PlayerRow | null;
  readonly projection: Projection | null;
  readonly event: PlayerEvent | null;
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const COLUMNS: Record<string, readonly Column[]> = {
  season: [
    { key: "minutes", label: "Mins", of: (r) => num(r.stats?.minutes) },
    { key: "goals", label: "G", of: (r) => num(r.stats?.goals) },
    { key: "assists", label: "A", of: (r) => num(r.stats?.assists) },
    { key: "xg", label: "xG", of: (r) => num(r.stats?.xg), decimals: 2 },
    { key: "xa", label: "xA", of: (r) => num(r.stats?.xa), decimals: 2 },
    {
      key: "xg90", label: "xG/90", decimals: 2,
      // Gated on the producer's own flag, never recomputed: the rate is a trap
      // below the minutes floor and this column is where it would show.
      of: (r) => r.stats?.ratesAreMeaningful && r.stats.minutes > 0
        ? (num(r.stats.xg) ?? 0) / (r.stats.minutes / 90)
        : null,
    },
    { key: "form", label: "Form", of: (r) => num(r.stats?.form), decimals: 1 },
    { key: "price", label: "£", of: (r) => num(r.stats?.fpl_price), decimals: 1 },
    { key: "own", label: "Own%", of: (r) => num(r.stats?.fpl_ownership), decimals: 1 },
  ],
  expected: [
    { key: "xp", label: "xP", of: (r) => num(r.projection?.xp), decimals: 2 },
    { key: "sd", label: "±", of: (r) => num(r.projection?.xpSd), decimals: 2 },
    { key: "mode", label: "Mode", of: (r) => num(r.projection?.mode) },
    { key: "p60", label: "P(60)", of: (r) => pct(r.projection?.p60) },
    { key: "mins", label: "E[min]", of: (r) => num(r.projection?.eMinutes), decimals: 0 },
    { key: "pgoal", label: "P(goal)", of: (r) => pct(r.projection?.pGoal) },
    { key: "pcs", label: "P(CS)", of: (r) => pct(r.projection?.pCleanSheet) },
    { key: "p10", label: "P(10+)", of: (r) => pct(r.projection?.pGe10) },
    { key: "q90", label: "q90", of: (r) => num(r.projection?.q90) },
  ],
  shots: [
    { key: "mins", label: "Mins", of: (r) => num(r.event?.minutes) },
    { key: "shots", label: "Shots", of: (r) => num(r.event?.shots) },
    { key: "kp", label: "KP", of: (r) => num(r.event?.keyPasses) },
    { key: "xg", label: "xG", of: (r) => num(r.event?.xg), decimals: 2 },
    { key: "npxg", label: "npxG", of: (r) => num(r.event?.npXg), decimals: 2 },
    { key: "xa", label: "xA", of: (r) => num(r.event?.xa), decimals: 2 },
    { key: "chain", label: "xGChain", of: (r) => num(r.event?.xgChain), decimals: 2 },
    { key: "s90", label: "Sh/90", of: (r) => num(r.event?.shotsPer90), decimals: 2 },
    { key: "xg90", label: "xG/90", of: (r) => num(r.event?.xgPer90), decimals: 2 },
  ],
};

function pct(value: number | null | undefined): number | null {
  const n = num(value);
  return n === null ? null : n * 100;
}

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "5px 9px", fontSize: 10.5, fontWeight: on ? 600 : 400,
    background: on ? "rgba(233,238,245,.10)" : "transparent",
    color: on ? S.ink : S.ink3, borderRight: `1px solid ${S.rule}`, cursor: "pointer",
  };
}

// Eyebrow labels are set in the BODY face (Archivo) at weight 600, not in Mono —
// Mono is for figures in columns, and an eyebrow is a label, not a figure.
function Label({ children, color = S.ink3 }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      fontFamily: SANS, fontSize: 9, letterSpacing: ".15em",
      textTransform: "uppercase", color, fontWeight: 600,
    }}>
      {children}
    </span>
  );
}

export function StatsTable({
  gameweek, ownedIds,
}: {
  /**
   * The gameweek, or null when no resolver could name one.
   *
   * Nullable because only ONE tab needs it. Season reads `player_stats.json` and
   * Shots reads `player_events.json`, and neither is keyed by week — so a page
   * that hid this whole table when the gameweek was unknown was refusing to show
   * two tabs' worth of data over a number they never use. Expected is the tab
   * that reads `xp_public_gw{NN}.json`, and it is the one that says so.
   */
  readonly gameweek: number | null;
  readonly ownedIds: ReadonlySet<number>;
}) {
  const [tabKey, setTabKey] = useState(STAT_TABS[0].key);
  const [show, setShow] = useState<Show>("all");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const tab = tabByKey(tabKey);
  const columns = COLUMNS[tab.key] ?? [];

  const { artifact: statsArtifact } = useArtifact(REGISTRY.playerStats);
  /* Hooks cannot be called conditionally, so the descriptor is still built when
     the gameweek is unknown — but `enabled` stops the request going out. Fetching
     `xp_public_gw00.json` instead would 404 on every render for as long as the
     gameweek stays unreadable, and a guaranteed console error is how a real one
     gets missed. */
  const expectedNeedsWeek = gameweek === null;
  const { artifact: projArtifact } = useArtifact(
    projectionsDescriptor(gameweek ?? 0),
    { enabled: !expectedNeedsWeek },
  );
  const { artifact: eventArtifact } = useArtifact(PLAYER_EVENTS);

  const stats = proven(statsArtifact);
  const projections = proven(projArtifact);
  const events = proven(eventArtifact);

  const rows = useMemo<StatRow[]>(() => {
    const byId = new Map<number, StatRow>();
    const put = (id: number, patch: Partial<StatRow>, base: Omit<StatRow, "elementId">) => {
      const existing = byId.get(id);
      byId.set(id, existing
        ? { ...existing, ...patch }
        : { elementId: id, ...base, ...patch });
    };

    for (const row of stats ?? []) {
      if (row.elementId === null) continue;
      put(row.elementId, { stats: row }, {
        name: row.name, team: row.team, position: row.position,
        owned: ownedIds.has(row.elementId),
        stats: row, projection: null, event: null,
      });
    }
    for (const row of projections?.players ?? []) {
      put(row.elementId, { projection: row }, {
        name: row.name ?? `#${row.elementId}`, team: row.team ?? "—",
        position: row.position ?? "—", owned: ownedIds.has(row.elementId),
        stats: null, projection: row, event: null,
      });
    }
    for (const row of events?.players ?? []) {
      put(row.elementId, { event: row }, {
        name: row.name ?? `#${row.elementId}`, team: row.team ?? "—",
        position: "—", owned: ownedIds.has(row.elementId),
        stats: null, projection: null, event: row,
      });
    }
    return [...byId.values()];
  }, [stats, projections, events, ownedIds]);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    // A row with nothing in the open tab is not shown: an all-∅ row is noise in a
    // table whose whole job is comparison.
    const hasThisTab = (row: StatRow) =>
      tab.source === "playerStats" ? row.stats !== null
      : tab.source === "projections" ? row.projection !== null
      : row.event !== null;

    const filtered = rows.filter((row) =>
      hasThisTab(row)
      && (show === "all" || (show === "mine" ? row.owned : !row.owned))
      && (q === "" || row.name.toLowerCase().includes(q)
          || row.team.toLowerCase().includes(q)));

    const column = columns.find((c) => c.key === sortKey) ?? columns[0];
    if (column === undefined) return filtered;
    return filtered.slice().sort((a, b) => {
      const [x, y] = [column.of(a), column.of(b)];
      const nx = typeof x === "number" ? x : null;
      const ny = typeof y === "number" ? y : null;
      if (nx === null && ny === null) return 0;
      if (nx === null) return 1;
      if (ny === null) return -1;
      return ny - nx;
    });
  }, [rows, deferredQuery, show, sortKey, columns, tab.source]);

  // 218px name column, then one flexible column per stat — the artboard's
  // template exactly, not a minmax approximation of it.
  const template = `218px repeat(${columns.length}, 1fr)`;
  const missing = tab.source === "projections" && expectedNeedsWeek
    ? "Neither the agent's status nor FPL's own state could be read, so the "
      + "gameweek is unknown. Guessing one would read another week's projection."
    : tab.source === null
    ? null
    : tab.source === "playerStats" ? statsArtifact.reason
    : tab.source === "projections" ? projArtifact.reason
    : eventArtifact.reason;

  return (
    <section style={{ fontFamily: SANS, color: S.ink, fontSize: 13 }}>
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "stretch",
        background: S.inset, border: `1px solid ${S.hair}`,
        borderBottom: `1px solid ${S.rule}`, padding: "0 18px",
      }}>
        {STAT_TABS.map((entry) => {
          const on = entry.key === tabKey;
          // Blocked for want of a feed, or — for Expected alone — for want of a
          // gameweek to point at.
          const blocked = entry.source === null
            || (entry.source === "projections" && expectedNeedsWeek);
          return (
            <button
              key={entry.key}
              onClick={() => { if (!blocked) { setTabKey(entry.key); setSortKey(null); } }}
              disabled={blocked}
              title={
                entry.source === "projections" && expectedNeedsWeek
                  ? "Neither the agent's status nor FPL's own state could be read, so "
                    + "there is no gameweek to point a projection at."
                  : blocked ? entry.blockedBy : entry.note
              }
              aria-pressed={on}
              style={{
                padding: "0 13px", height: 40, display: "flex", alignItems: "center",
                fontSize: 12, fontWeight: on ? 600 : 400,
                color: blocked ? S.ink3 : on ? S.ink : S.ink2,
                textDecoration: blocked ? "line-through" : "none",
                cursor: blocked ? "not-allowed" : "pointer",
                boxShadow: on ? `inset 0 -2px 0 ${S.brand}` : "none",
                background: "none", border: 0,
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "11px 18px", background: S.bar,
        border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="name or club"
          aria-label="Filter by player name or club"
          style={{
            width: 160, padding: "6px 9px", fontSize: 12, color: S.ink,
            border: `1px solid ${S.rule}`, background: S.shell, fontFamily: SANS,
          }}
        />
        <div style={{ display: "flex", border: `1px solid ${S.rule}` }}>
          {([["all", "everyone"], ["mine", "my squad"], ["theirs", "not owned"]] as const)
            .map(([key, label]) => (
              <button key={key} onClick={() => setShow(key)} style={chip(show === key)}
                aria-pressed={show === key}>
                {label}
              </button>
            ))}
        </div>
        <div style={{ flexGrow: 1 }} />
        <span data-testid="stats-count" style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          {visible.length} players
        </span>
      </div>

      {visible.length === 0 ? (
        <p style={{
          padding: "18px 14px", fontSize: 12, color: S.ink2, margin: 0,
          border: `1px solid ${S.hair}`, borderTop: "none",
        }}>
          {missing ?? "Nothing matches. The filter is what is empty, not the data."}
        </p>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${S.hair}`, borderTop: "none" }}>
          <div style={{ minWidth: 218 + columns.length * 70 }}>
            <div style={{
              display: "grid", gridTemplateColumns: template,
              background: S.bar, borderBottom: `1px solid ${S.rule}`,
            }}>
              <div style={{ padding: "0 12px", height: 32, display: "flex", alignItems: "center" }}>
                <Label>Player</Label>
              </div>
              {columns.map((column) => (
                <button
                  key={column.key}
                  onClick={() => setSortKey(column.key)}
                  aria-pressed={(sortKey ?? columns[0]?.key) === column.key}
                  style={{
                    height: 32, display: "flex", alignItems: "center",
                    justifyContent: "flex-end", paddingRight: 10,
                    background: (sortKey ?? columns[0]?.key) === column.key
                      ? "rgba(233,238,245,.06)" : "none",
                    border: 0, cursor: "pointer",
                  }}
                >
                  <Label>{column.label}</Label>
                </button>
              ))}
            </div>

            {visible.slice(0, 200).map((row) => (
              <div
                key={row.elementId}
                data-testid="stats-row"
                  className="dense-row"
                data-owned={row.owned ? "yes" : undefined}
                style={{
                  display: "grid", gridTemplateColumns: template,
                  borderBottom: `1px solid ${S.hair}`,
                  // The owned tint is CSS, keyed on `data-owned`. Inline, it beat
                  // `.dense-row:hover` and the hover painted nothing.
                }}
              >
                <div style={{
                  padding: "0 12px", height: 36, display: "flex", alignItems: "center",
                  gap: 7, minWidth: 0,
                }}>
                  <span style={{
                    fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {row.name}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: S.ink3 }}>
                    {row.team}
                  </span>
                </div>
                {columns.map((column) => {
                  const value = column.of(row);
                  return (
                    <div key={column.key} style={{
                      display: "flex", alignItems: "center", justifyContent: "flex-end",
                      paddingRight: 10, fontFamily: MONO, fontSize: 11.5,
                      color: value === null ? S.ink3 : S.ink2,
                    }}>
                      {value === null
                        ? "∅"
                        : typeof value === "number"
                          ? value.toFixed(column.decimals ?? 0)
                          : value}
                    </div>
                  );
                })}
              </div>
            ))}
            {visible.length > 200 ? (
              <p style={{
                padding: "10px 14px", margin: 0, fontFamily: MONO, fontSize: 10,
                color: S.ink3,
              }}>
                Showing the first 200 of {visible.length}. Narrow with the search or the
                ownership filter — a longer table is not a better answer.
              </p>
            ) : null}
          </div>
        </div>
      )}

      <div style={{
        display: "flex", flexWrap: "wrap", gap: 34, padding: "14px 18px",
        background: S.bar, border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <div style={{ maxWidth: 470 }}>
          <div style={{ marginBottom: 7 }}><Label>{tab.label}</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            {tab.note}
          </p>
        </div>
        {/* What this app cannot build, and why — one paragraph per blocked tab, so
            a reader learns the column exists in the game and why it is not here,
            same as the two-tab version of this block on the artboard. There are
            three now: Understat got wired since that was drawn, so Shots & creation
            went live and Defending, Set pieces and Market took its place. */}
        <div style={{
          maxWidth: 440, borderLeft: `1px solid ${S.hair}`, paddingLeft: 22,
        }}>
          <div style={{ marginBottom: 7 }}>
            <Label color={S.conflict}>Tabs we cannot build</Label>
          </div>
          {blockedTabs().map((blocked) => (
            <p key={blocked.key} style={{
              fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: "0 0 6px",
            }}>
              <strong style={{ color: S.ink }}>{blocked.label}</strong>
              {" "}({blocked.note}) {blocked.blockedBy}
            </p>
          ))}
        </div>
        <div style={{ maxWidth: 290 }}>
          <div style={{ marginBottom: 7 }}><Label color={S.noise}>The ∅ mark</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            Withheld, not zero. A per-90 over eight minutes and a figure the feed does
            not carry are both shown this way, because a zero in either place would be
            a claim nobody made.
          </p>
        </div>
        {tab.source === "playerEvents" && events !== null ? (
          <div style={{ maxWidth: 330 }}>
            <div style={{ marginBottom: 7 }}><Label>This feed&apos;s reach</Label></div>
            <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
              The name join matched {events.coverage.matched} of{" "}
              {events.coverage.understatRows} rows Understat offered
              {events.coverage.joinFraction !== null
                ? ` (${Math.round(events.coverage.joinFraction * 100)}%)`
                : ""}. Understat lists players who have played and FPL lists everyone
              who could, so this covers a fraction of the game&apos;s{" "}
              {events.coverage.fplUniverse} players by design.
              {events.notAvailable.length > 0
                ? ` Not carried by this feed: ${events.notAvailable.join(", ").replace(/_/g, " ")}.`
                : ""}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
