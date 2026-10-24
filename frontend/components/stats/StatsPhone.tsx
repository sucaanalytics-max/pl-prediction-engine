"use client";

/**
 * The stats sheet at phone width — three tabs, one per SOURCE.
 *
 * ## Why the phone splits by source when the desktop splits by question
 *
 * The desktop sheet (`StatsTable`) puts a question on every tab and lets a tab
 * carry several sources side by side, defended by a band rail and a coverage
 * strip. That is a lot of apparatus for a 358px column, and on a phone the cost of
 * the shortcut shows: FPL's xG and Understat's npxG would sit three taps apart on
 * one scrolling row, read by a thumb, with the band rail scrolled out of sight.
 *
 * So here the warranty IS the navigation, and nothing crosses a tab boundary:
 *
 *   - FPL record — what happened, FPL's own data.
 *   - Our model  — what our simulation expects for the coming gameweek. Not a record.
 *   - Understat  — a third-party model with its own definitions.
 *
 * Each tab opens with a card that names the source and states how old it is, and
 * the table under it holds only that source's columns. A column is never moved,
 * renamed or recomputed to fit: every one is looked up in `STAT_QUESTIONS` by key,
 * so the figures are the desktop's figures. Where a design column does not exist in
 * the data (Understat per-90s for npxG and xA) it is simply not here.
 *
 * ## What is deliberately not on the phone
 *
 * The side-by-side comparison, the coverage strip and the "feeds we do not carry"
 * notes stay on the desktop sheet. The compare tray needs four columns of width, and
 * the coverage a reader needs is already in each tab's warrant line.
 */

import { useDeferredValue, useMemo, useRef, useState } from "react";

import { PhoneHeader } from "@/components/phone/PhoneHeader";
import { useStatRows } from "@/components/stats/useStatRows";
import { isStale, type Artifact } from "@/lib/data/artifact";
import { utcStamp } from "@/lib/phone";
import { SANS, SIGNAL } from "@/lib/margin/tokens";
import { coverageFor } from "@/lib/projections/stat-coverage";
import {
  STAT_QUESTIONS, type StatColumn, type StatRow, type StatSource,
} from "@/lib/projections/stat-questions";

const S = SIGNAL;

type TabKey = "fpl" | "model" | "understat";
type Show = "all" | "mine" | "theirs";

interface ColumnRef {
  readonly source: StatSource;
  readonly key: string;
}

interface SourceTab {
  readonly key: TabKey;
  readonly label: string;
  readonly title: string;
  readonly columns: readonly ColumnRef[];
  /** The column the tab opens sorted by. */
  readonly sortKey: string;
}

/**
 * Which existing columns each source tab holds.
 *
 * `form` lives in the desktop's Market band, but that band has no file of its own —
 * `stat-coverage.ts` notes it "rides on the record's" — so on this screen it is
 * FPL's record, as the approved design draws it. Price and ownership are the other
 * two Market columns and are not carried here: they are a purchase's terms, not a
 * player's record, and the design does not list them.
 */
export const SOURCE_TABS: readonly SourceTab[] = [
  {
    key: "fpl", label: "FPL record", title: "What FPL has recorded", sortKey: "minutes",
    columns: [
      { source: "playerStats", key: "minutes" },
      { source: "playerStats", key: "goals" },
      { source: "playerStats", key: "assists" },
      { source: "playerStats", key: "xg" },
      { source: "playerStats", key: "xa" },
      { source: "playerStats", key: "overExpected" },
      { source: "market", key: "form" },
    ],
  },
  {
    key: "model", label: "Our model", title: "What our model expects", sortKey: "xp",
    columns: [
      { source: "projections", key: "xp" },
      { source: "projections", key: "sd" },
      { source: "projections", key: "p60" },
      { source: "projections", key: "eMinutes" },
      { source: "projections", key: "pGoal" },
      { source: "projections", key: "p10" },
    ],
  },
  {
    key: "understat", label: "Understat", title: "Understat’s own xG model", sortKey: "npxg",
    columns: [
      { source: "playerEvents", key: "uMinutes" },
      { source: "playerEvents", key: "shots" },
      { source: "playerEvents", key: "shots90" },
      { source: "playerEvents", key: "npxg" },
      { source: "playerEvents", key: "uXa" },
      { source: "playerEvents", key: "keyPasses" },
      { source: "playerEvents", key: "xgChain" },
    ],
  },
];

/** The tab's columns, resolved against the desktop's own definitions. */
export function columnsFor(tab: SourceTab): StatColumn[] {
  const found: StatColumn[] = [];
  for (const ref of tab.columns) {
    for (const question of STAT_QUESTIONS) {
      const hit = question.bands
        .filter((band) => band.source === ref.source)
        .flatMap((band) => band.columns)
        .find((column) => column.key === ref.key);
      if (hit !== undefined) { found.push(hit); break; }
    }
  }
  return found;
}

function format(column: StatColumn, value: number | null): string {
  if (value === null) return "∅";
  const text = value.toFixed(column.decimals ?? 0);
  return column.signed && value > 0 ? `+${text}` : text;
}

/** Sign is the reading on a signed column; everything else takes plain ink. */
function figureColour(column: StatColumn, value: number | null): string {
  if (value === null) return S.ink3;
  if (!column.signed) return S.ink;
  if (value >= 0.5) return S.agree;
  if (value <= -0.5) return S.conflict;
  return S.ink2;
}

function segment(on: boolean): React.CSSProperties {
  return {
    flex: 1, minHeight: 44, border: `1px solid ${on ? S.ink : S.rule}`,
    background: on ? S.ink : S.bar, color: on ? S.bar : S.ink,
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
}

const ROWS_SHOWN = 200;

export function StatsPhone({
  gameweek, ownedIds,
}: {
  readonly gameweek: number | null;
  readonly ownedIds: ReadonlySet<number>;
}) {
  const [tabKey, setTabKey] = useState<TabKey>("fpl");
  const [show, setShow] = useState<Show | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<{ key: string; ascending: boolean } | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const {
    rows, stats, projections, events,
    statsArtifact, projArtifact, eventArtifact, weekUnknown,
  } = useStatRows(gameweek, ownedIds);

  const tab = SOURCE_TABS.find((t) => t.key === tabKey) ?? SOURCE_TABS[0];
  const columns = useMemo(() => columnsFor(tab), [tab]);

  // Until the reader chooses, a known squad opens on the squad — the design's
  // "your eleven". With no squad on file there is nothing to narrow to.
  const effectiveShow: Show = show ?? (ownedIds.size > 0 ? "mine" : "all");

  const activeKey = sort?.key ?? tab.sortKey;
  const activeColumn = columns.find((c) => c.key === activeKey) ?? columns[0];
  const ascending = sort?.ascending ?? activeColumn?.better === "low";

  /** Same column reverses; a new column opens at its own useful end. */
  const sortBy = (key: string) =>
    setSort(key === activeKey
      ? { key, ascending: !ascending }
      : { key, ascending: columns.find((c) => c.key === key)?.better === "low" });

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const filtered = rows.filter((row) =>
      columns.some((column) => column.of(row) !== null)
      && (effectiveShow === "all" || (effectiveShow === "mine" ? row.owned : !row.owned))
      && (q === "" || row.name.toLowerCase().includes(q)
          || row.team.toLowerCase().includes(q)));
    if (activeColumn === undefined) return filtered;
    return filtered.slice().sort((a, b) => {
      const [x, y] = [activeColumn.of(a), activeColumn.of(b)];
      // The blank sinks in BOTH directions: it means nobody measured this.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return ascending ? x - y : y - x;
    });
  }, [rows, columns, effectiveShow, deferredQuery, activeColumn, ascending]);

  const artifactFor = (key: TabKey): Artifact<unknown> =>
    key === "fpl" ? statsArtifact : key === "model" ? projArtifact : eventArtifact;
  const active = artifactFor(tab.key);
  const loaded = tab.key === "fpl" ? stats !== null
    : tab.key === "model" ? projections !== null : events !== null;

  const stamp = utcStamp(
    tab.key === "model" ? projections?.generatedAt ?? active.provenance.producedAt
    : tab.key === "understat" ? events?.generatedAt ?? active.provenance.producedAt
    : active.provenance.producedAt,
  );
  const when = stamp ? `updated ${stamp}` : "update time unstated";

  const coverage = (source: StatSource) => coverageFor(source, {
    gameweek, events: events?.players ?? null, stats: stats ?? null,
  }).reach;
  const warrant =
    tab.key === "fpl"
      ? `Official FPL data${coverage("playerStats") ? ` · ${coverage("playerStats")}` : ""} · ${when}`
    : tab.key === "model"
      ? `Our simulation, not a record · ${
          projections?.nDraws ? `${projections.nDraws.toLocaleString("en-GB")} draws` : "draw count unstated"
        }${gameweek !== null ? ` · GW${gameweek}` : ""} · ${stamp ? `run ${stamp}` : "run time unstated"}`
      : `Third-party model, its own definitions${coverage("playerEvents") ? ` · ${coverage("playerEvents")}` : ""} · ${when}`;

  const missing =
    tab.key === "model" && weekUnknown
      ? "Neither the agent’s status nor FPL’s own state could be read, so the "
        + "gameweek is unknown. Guessing one would read another week’s projection."
      : active.reason ?? "This source could not be read.";

  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const last = SOURCE_TABS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const target = SOURCE_TABS[next];
    switchTab(target.key);
    tabRefs.current[target.key]?.focus();
  };

  const switchTab = (key: TabKey) => { setTabKey(key); setSort(null); };

  return (
    <div data-testid="stats-phone" style={{ fontFamily: SANS, color: S.ink, paddingBottom: 16 }}>
      <PhoneHeader
        title="Stats"
        flushBottom
        aside={effectiveShow === "mine" ? "My squad" : effectiveShow === "theirs" ? "Not owned" : "Everyone"}
      >
        <div
          role="tablist"
          aria-label="Source"
          style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          {SOURCE_TABS.map((entry, index) => {
            const on = entry.key === tab.key;
            return (
              <button
                key={entry.key}
                ref={(el) => { tabRefs.current[entry.key] = el; }}
                type="button"
                role="tab"
                id={`stats-tab-${entry.key}`}
                aria-selected={on}
                aria-controls="stats-phone-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => switchTab(entry.key)}
                onKeyDown={(event) => onTabKey(event, index)}
                style={{
                  minHeight: 44, border: 0, background: "transparent", fontFamily: "inherit",
                  fontSize: 14, fontWeight: on ? 700 : 500, color: on ? S.ink : S.ink3,
                  boxShadow: `inset 0 -2px 0 ${on ? S.ink : "transparent"}`, cursor: "pointer",
                }}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </PhoneHeader>

      <div
        role="tabpanel"
        id="stats-phone-panel"
        aria-labelledby={`stats-tab-${tab.key}`}
        style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12 }}
      >
        <div
          data-testid="stats-source-card"
          style={{
            display: "flex", flexDirection: "column", gap: 2, padding: "10px 12px",
            background: S.bar, border: `1px solid ${S.hair}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>{tab.title}</span>
          <span style={{ fontSize: 12, color: S.ink2 }}>
            {warrant}
            {isStale(active) ? (
              <span
                data-testid="stats-stale"
                style={{
                  marginLeft: 6, padding: "0 5px", fontSize: 11, fontWeight: 600,
                  color: S.noise, border: `1px solid ${S.noise}`,
                }}
              >
                STALE
              </span>
            ) : null}
          </span>
        </div>

        {!loaded ? (
          <p style={{ margin: 0, fontSize: 12, color: S.ink2 }}>{missing}</p>
        ) : (
          <>
            <label style={{
              display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 12px",
              background: S.shell, border: `1px solid ${S.rule}`,
            }}>
              <span className="sr-only">Filter by player name or club</span>
              <input
                type="search"
                name="stats-phone-filter"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or club"
                style={{
                  flex: 1, minWidth: 0, border: 0, background: "transparent", fontFamily: "inherit",
                  fontSize: 16, color: S.ink, minHeight: 44, outlineOffset: 4,
                }}
              />
            </label>
            <div role="group" aria-label="Show" style={{ display: "flex", gap: 6 }}>
              {([["all", "Everyone"], ["mine", "My squad"], ["theirs", "Not owned"]] as const)
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={effectiveShow === key}
                    onClick={() => setShow(key)}
                    style={segment(effectiveShow === key)}
                  >
                    {label}
                  </button>
                ))}
            </div>

            {visible.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: S.ink2 }}>
                Nothing matches. The filter is what is empty, not the data.
              </p>
            ) : (
              <div
                role="region"
                aria-label={`${tab.title}, scrolls sideways`}
                tabIndex={0}
                style={{
                  overflowX: "auto", background: S.bar, border: `1px solid ${S.hair}`,
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <caption className="sr-only">
                    {tab.title}. {warrant}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{
                        position: "sticky", left: 0, background: S.bar, textAlign: "left",
                        padding: "0 10px", fontSize: 11, fontWeight: 600, color: S.ink3,
                        letterSpacing: ".04em", minWidth: 112,
                      }}>
                        Player
                      </th>
                      {columns.map((column) => {
                        const live = activeKey === column.key;
                        return (
                          <th
                            key={column.key}
                            scope="col"
                            aria-sort={live ? (ascending ? "ascending" : "descending") : "none"}
                            style={{ padding: 0, fontWeight: 600, textAlign: "right" }}
                          >
                            <button
                              type="button"
                              onClick={() => sortBy(column.key)}
                              aria-label={`Sort by ${column.label}`}
                              style={{
                                minHeight: 44, minWidth: 52, padding: "0 8px", border: 0,
                                background: live ? "rgba(20,23,28,.06)" : "transparent",
                                fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                                letterSpacing: ".04em", cursor: "pointer",
                                color: live ? S.ink : S.ink3, whiteSpace: "nowrap",
                              }}
                            >
                              {column.label}{live ? (ascending ? " ▲" : " ▼") : ""}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, ROWS_SHOWN).map((row: StatRow) => (
                      <tr
                        key={row.elementId}
                        data-testid="stats-phone-row"
                        style={{ borderTop: `1px solid ${S.hair}`, textAlign: "right" }}
                      >
                        <th
                          scope="row"
                          style={{
                            position: "sticky", left: 0, background: S.bar, textAlign: "left",
                            padding: "4px 10px", height: 44, fontWeight: 600, whiteSpace: "nowrap",
                          }}
                        >
                          {row.name}
                          <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: S.ink3 }}>
                            {row.team}
                          </span>
                        </th>
                        {columns.map((column) => {
                          const value = column.of(row);
                          return (
                            <td
                              key={column.key}
                              style={{
                                padding: "0 8px", color: figureColour(column, value),
                                fontWeight: column.derived ? 600 : 400,
                              }}
                            >
                              {format(column, value)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p data-testid="stats-phone-count" style={{ margin: 0, fontSize: 11, color: S.ink3 }}>
              {visible.length} players
              {visible.length > ROWS_SHOWN
                ? ` · first ${ROWS_SHOWN} shown, narrow with the search or the filter`
                : ""}
              {" · ∅ means withheld, not zero"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
