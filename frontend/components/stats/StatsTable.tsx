"use client";

/**
 * The stats sheet — a question, its columns, and who measured each of them.
 *
 * ## What changed, and what the change costs
 *
 * Tabs used to be one per published artifact, so two sources could never be read
 * against each other. That rule stopped bad comparisons and also stopped every
 * good one: a question like "is his finishing sustainable" needs FPL's goals,
 * Understat's non-penalty xG and the simulation's odds, and those were three tabs.
 *
 * A tab is now a QUESTION and the warranty moved into the header. Every run of
 * columns is a BAND that names its source and states how much football that source
 * has seen — see `lib/projections/stat-coverage.ts`, which found the defect this
 * whole structure is built around: FPL three matches deep, Understat one, and
 * nothing on screen saying so.
 *
 * The cost is that FPL's xG and Understat's npxG now sit on one row. The band rail
 * and the coverage strip are the defence; there is no longer a structural
 * impossibility, only a marked one. The one thing kept structural is that a
 * DERIVED column may not read across a band — `stat-questions.test.ts` enforces it,
 * because subtracting a one-match figure from a three-match one is arithmetic on
 * two different denominators.
 *
 * ## Selection is the third act
 *
 * Ticking rows opens a transposed comparison of the same four bands. It is a MODE
 * rather than a page: reached from the sheet, it gives up nothing, because the
 * question tab is what found the names.
 */

import { useDeferredValue, useMemo, useState } from "react";

import { isStale, proven } from "@/lib/data/artifact";
import { ageLine } from "@/lib/formats";
import { PLAYER_EVENTS } from "@/lib/data/player-events";
import { projectionsDescriptor } from "@/lib/data/projections";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { SIGNAL, SANS } from "@/lib/margin/tokens";
import { Label } from "@/lib/margin/type";
import {
  BLOCKED_FEEDS, STAT_QUESTIONS, columnsOf, questionByKey,
  type StatColumn, type StatRow, type StatSource,
} from "@/lib/projections/stat-questions";
import { coverageDiffers, coverageFor } from "@/lib/projections/stat-coverage";

const S = SIGNAL;

type Show = "all" | "mine" | "theirs";

/** The most players a comparison can hold before it stops being a comparison. */
const COMPARE_LIMIT = 4;

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "5px 11px", fontSize: 11, fontWeight: on ? 600 : 400,
    background: on ? "rgba(20,23,28,.10)" : "transparent",
    color: on ? S.ink : S.ink3, borderRight: `1px solid ${S.rule}`, cursor: "pointer",
  };
}

function format(column: StatColumn, value: number | null): string {
  if (value === null) return "∅";
  const text = value.toFixed(column.decimals ?? 0);
  return column.signed && value > 0 ? `+${text}` : text;
}

/**
 * The figure to mark when players are set beside each other, or null.
 *
 * Three ways to get null, and each was a defect before it was a rule. A column
 * with no better end — a price, an ownership — must mark nothing, or the rule
 * lands under the more expensive player and reads as praise. A column where every
 * player carries the same figure must mark nothing, because marking all of them
 * is the same as marking none and costs a reader a second look. And a lone figure
 * has nothing to be best against.
 */
function bestOf(column: StatColumn, values: readonly number[]): number | null {
  const direction = column.signed ? null : column.better ?? null;
  if (direction === null) return null;
  if (values.length < 2) return null;
  const extreme = direction === "low" ? Math.min(...values) : Math.max(...values);
  if (values.every((value) => value === extreme)) return null;
  return extreme;
}

/**
 * Which way a column opens on its first click.
 *
 * `better` already says which end of a column is the good one, and the good end
 * is what a reader wants first: `±` is spread, so the steadiest player belongs on
 * top, while every other measured column wants its largest figure there. A column
 * with no better end — a price, an ownership, an over-performance — opens
 * descending, which is what the sheet has always done.
 */
/** What the header says it will do, for the tooltip and the accessible name. */
function sortLabel(column: StatColumn, live: boolean, ascending: boolean): string {
  if (!live) return `Sort by ${column.label}`;
  return `${column.label}, sorted ${ascending ? "lowest" : "highest"} first`
    + " — activate to reverse";
}

function opensAscending(column: StatColumn | undefined): boolean {
  return column?.better === "low";
}

/** Sign is the reading on a signed column; everything else takes plain ink. */
function figureColour(column: StatColumn, value: number | null): string {
  if (value === null) return S.ink4;
  if (!column.signed) return S.ink;
  if (value >= 0.5) return S.agree;
  if (value <= -0.5) return S.conflict;
  return S.ink2;
}

export function StatsTable({
  gameweek, ownedIds,
}: {
  /**
   * The gameweek, or null when no resolver could name one.
   *
   * Two bands need it — the simulation, which is keyed by week, and FPL's record,
   * whose coverage is stated from it. Neither is a reason to withhold the sheet:
   * the bands that do not need it still render, and the two that do say what is
   * missing where the reader would otherwise guess.
   */
  readonly gameweek: number | null;
  readonly ownedIds: ReadonlySet<number>;
}) {
  const [questionKey, setQuestionKey] = useState(STAT_QUESTIONS[0].key);
  const [show, setShow] = useState<Show>("all");
  /* A key alone cannot express an order, which is why re-clicking the live
     column did nothing: `setSortKey(column.key)` set the value it already held
     and React bailed out of the render. The direction has to be state too. */
  const [sort, setSort] = useState<{ key: string; ascending: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<readonly number[]>([]);
  const [comparing, setComparing] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const question = questionByKey(questionKey);
  const columns = columnsOf(question);

  /* The live sort, with the question's own default standing in until a header is
     clicked. Derived rather than seeded into state, because the default moves
     when the question does and a copy would go stale behind it. */
  const activeKey = sort?.key ?? question.sortKey;
  const ascending = sort?.ascending
    ?? opensAscending(columns.find((c) => c.key === question.sortKey));

  /** Same column reverses; a new column opens at its own useful end. */
  const sortBy = (key: string) =>
    setSort((current) =>
      current?.key === key
        ? { key, ascending: !current.ascending }
        : { key, ascending: opensAscending(columns.find((c) => c.key === key)) });

  const { artifact: statsArtifact } = useArtifact(REGISTRY.playerStats);
  /* Hooks cannot be called conditionally, so the descriptor is still built when
     the gameweek is unknown — `enabled` stops the request going out. Fetching
     `xp_public_gw00.json` would 404 on every render, and a guaranteed console
     error is how a real one gets missed. */
  const weekUnknown = gameweek === null;
  const { artifact: projArtifact } = useArtifact(
    projectionsDescriptor(gameweek ?? 0), { enabled: !weekUnknown },
  );
  const { artifact: eventArtifact } = useArtifact(PLAYER_EVENTS);

  const stats = proven(statsArtifact);
  const projections = proven(projArtifact);
  const events = proven(eventArtifact);

  const rows = useMemo<StatRow[]>(() => {
    const byId = new Map<number, StatRow>();
    const put = (id: number, patch: Partial<StatRow>, base: Omit<StatRow, "elementId">) => {
      const existing = byId.get(id);
      byId.set(id, existing ? { ...existing, ...patch } : { elementId: id, ...base, ...patch });
    };
    for (const row of stats ?? []) {
      if (row.elementId === null) continue;
      put(row.elementId, { stats: row }, {
        name: row.name, team: row.team, position: row.position,
        owned: ownedIds.has(row.elementId), stats: row, projection: null, event: null,
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

  /* One coverage reading per band on THIS question, so the strip says only what
     the sheet in front of the reader actually depends on. */
  const covers = useMemo(
    () => question.bands.map((band) =>
      coverageFor(band.source, {
        gameweek, events: events?.players ?? null, stats: stats ?? null,
      })),
    [question, gameweek, events, stats],
  );

  /**
   * How OLD each band's source is, which is a different question from how much
   * it covers and the strip needs both.
   *
   * Understat's feed sat at one match for a fortnight while FPL's record grew to
   * three. "1 match" was true the whole time and told a reader nothing: it reads
   * as a young season rather than as a feed that stopped, and those call for
   * opposite reactions. The descriptor already carries a two-day budget and the
   * artifact layer already computes the age; nothing on this screen asked.
   */
  const freshness = useMemo(() => {
    /* One reading per source, taken while each artifact still has its own type.
       Collapsing them into a lookup first produced a union `isStale` could not be
       called on, and the tempting fix was a cast — which is the thing the FPL
       boundary was just cleaned of. */
    const read = <T,>(artifact: Parameters<typeof isStale<T>>[0]) => ({
      stale: isStale(artifact),
      age: ageLine(artifact.provenance.producedAt),
    });
    const bySource = {
      playerStats: read(statsArtifact),
      playerEvents: read(eventArtifact),
      projections: read(projArtifact),
      // The market has no file of its own — it rides on the record's.
      market: read(statsArtifact),
    };
    return new Map(question.bands.map((band) => [band.source, bySource[band.source]]));
  }, [question, statsArtifact, eventArtifact, projArtifact]);
  const differs = coverageDiffers(covers);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    /* A row that answers none of this question's columns is not shown: an all-∅
       row is noise in a sheet whose whole job is comparison. */
    const answersSomething = (row: StatRow) =>
      columns.some((column) => column.of(row) !== null);

    const filtered = rows.filter((row) =>
      answersSomething(row)
      && (show === "all" || (show === "mine" ? row.owned : !row.owned))
      && (q === "" || row.name.toLowerCase().includes(q)
          || row.team.toLowerCase().includes(q)));

    const column = columns.find((c) => c.key === activeKey) ?? columns[0];
    if (column === undefined) return filtered;
    return filtered.slice().sort((a, b) => {
      const [x, y] = [column.of(a), column.of(b)];
      /* ∅ sinks in BOTH directions. It means "nobody measured this", not a small
         number, so reversing the order must not float the blanks to the top —
         which is what a single `ascending ? -1 : 1` over the whole comparator
         would have done. The direction applies to the figures only. */
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return ascending ? x - y : y - x;
    });
  }, [rows, deferredQuery, show, activeKey, ascending, columns]);

  const chosen = useMemo(
    () => picked
      .map((id) => rows.find((row) => row.elementId === id))
      .filter((row): row is StatRow => row !== undefined),
    [picked, rows],
  );

  const toggle = (id: number) => setPicked((current) =>
    current.includes(id)
      ? current.filter((x) => x !== id)
      : current.length >= COMPARE_LIMIT ? current : [...current, id]);

  const reasonFor = (source: StatSource): string | null =>
    source === "playerStats" ? statsArtifact.reason
    : source === "playerEvents" ? eventArtifact.reason
    : source === "projections"
      ? (weekUnknown
          ? "Neither the agent's status nor FPL's own state could be read, so the "
            + "gameweek is unknown. Guessing one would read another week's projection."
          : projArtifact.reason)
      : null;

  const template = `34px 220px repeat(${columns.length}, minmax(64px, 1fr))`;

  return (
    <section style={{ fontFamily: SANS, color: S.ink, fontSize: 13 }}>

      {/* ── the question picks the columns ─────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "stretch",
        background: S.inset, border: `1px solid ${S.hair}`,
        borderBottom: `1px solid ${S.rule}`, padding: "0 18px",
      }}>
        {STAT_QUESTIONS.map((entry) => {
          const on = entry.key === questionKey;
          return (
            <button
              key={entry.key}
              onClick={() => {
                setQuestionKey(entry.key);
                setSort(null);
                setComparing(false);
              }}
              title={entry.note}
              aria-pressed={on}
              style={{
                padding: "0 14px", height: 42, display: "flex", alignItems: "center",
                fontSize: 12.5, fontWeight: on ? 600 : 400,
                color: on ? S.ink : S.ink2, cursor: "pointer",
                boxShadow: on ? `inset 0 -3px 0 ${S.brand}` : "none",
                background: "none", border: 0,
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* ── what each source on this question has seen ─────────────────── */}
      <div
        data-testid="coverage-strip"
        style={{
          display: "flex", flexWrap: "wrap", alignItems: "center",
          background: S.bar, border: `1px solid ${S.hair}`, borderTop: "none",
          padding: "0 18px",
        }}
      >
        <span style={{ padding: "9px 14px 9px 0" }}><Label>Coverage</Label></span>
        {covers.map((cover, index) => {
          const age = freshness.get(cover.source);
          return (
            <span
              key={cover.source}
              title={cover.unknownBecause ?? age?.age ?? undefined}
              style={{
                display: "flex", alignItems: "center", gap: 7, padding: "9px 16px",
                borderLeft: index === 0 ? "none" : `1px solid ${S.hair}`,
              }}
            >
              <span style={{ fontSize: 11.5, color: S.ink2 }}>
                {question.bands[index].name}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "1px 6px",
                background: "rgba(20,23,28,.07)",
                color: cover.reach === null ? S.ink3 : S.ink,
              }}>
                {cover.reach ?? "∅"}
              </span>
              {age?.stale ? (
                /* Only when stale. A fresh file's age is noise on a strip whose
                   job is to be read at a glance; a stale one changes what the
                   figures beside it are worth. */
                <span
                  data-testid="coverage-stale"
                  style={{
                    fontSize: 11, fontWeight: 600, padding: "1px 6px",
                    color: S.noise, border: `1px solid ${S.noise}`,
                  }}
                >
                  {age.age ?? "stale"}
                </span>
              ) : null}
            </span>
          );
        })}
        {differs ? (
          <span style={{
            flexGrow: 1, minWidth: 260, textAlign: "right", padding: "9px 0",
            fontSize: 11, lineHeight: 1.45, color: S.ink3,
          }}>
            Two records of different depth on one sheet. Where their figures differ, that is
            the reason — not a disagreement between models.
          </span>
        ) : null}
      </div>

      {/* ── filters ────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "11px 18px", background: S.bar,
        border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <input
          name="stats-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="name or club"
          aria-label="Filter by player name or club"
          style={{
            width: 168, padding: "6px 9px", fontSize: 12, color: S.ink,
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
        <span data-testid="stats-count" style={{ fontSize: 11, color: S.ink3 }}>
          {visible.length} players
        </span>
      </div>

      {comparing && chosen.length > 0
        ? <Comparison
            rows={chosen} question={question} covers={covers}
            onBack={() => setComparing(false)}
          />
        : visible.length === 0
        ? (
          <p style={{
            padding: "18px 14px", fontSize: 12, color: S.ink2, margin: 0,
            border: `1px solid ${S.hair}`, borderTop: "none",
          }}>
            {question.bands.map((band) => reasonFor(band.source)).find((r) => r !== null)
              ?? "Nothing matches. The filter is what is empty, not the data."}
          </p>
        ) : (
          <div style={{ overflowX: "auto", border: `1px solid ${S.hair}`, borderTop: "none" }}>
            <div style={{ minWidth: 254 + columns.length * 74 }}>

              {/* Band row: the warranty, and how much football it has seen. */}
              <div style={{
                display: "grid", gridTemplateColumns: template, background: S.bar,
              }}>
                <div /><div />
                {question.bands.map((band) => (
                  <div
                    key={band.source}
                    style={{
                      gridColumn: `span ${band.columns.length}`,
                      padding: "10px 0 6px 8px", borderTop: `2px solid ${S.ink}`,
                      marginLeft: 4,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".13em",
                      textTransform: "uppercase" }}>
                      {band.name}
                    </div>
                    <div style={{ fontSize: 11, color: S.ink3 }}>
                      {covers.find((c) => c.source === band.source)?.reach ?? "coverage unknown"}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{
                display: "grid", gridTemplateColumns: template, background: S.bar,
                borderBottom: `1px solid ${S.rule}`,
              }}>
                <div />
                <div style={{ padding: "0 8px", height: 30, display: "flex", alignItems: "center" }}>
                  <Label>Player</Label>
                </div>
                {columns.map((column) => {
                  const live = activeKey === column.key;
                  return (
                    <button
                      key={column.key}
                      onClick={() => sortBy(column.key)}
                      /* The direction belongs in the accessible NAME, not in
                         `aria-sort`. This header is a button in a CSS grid, not a
                         `columnheader` in a table, and `aria-sort` is only defined
                         on the header roles — jsx-a11y rejects it here and it is
                         right to. `aria-pressed` alone says a toggle is on and
                         nothing about which way the rows run, which is the one
                         thing a reader of a sorted sheet needs. */
                      aria-pressed={live}
                      aria-label={sortLabel(column, live, ascending)}
                      title={sortLabel(column, live, ascending)}
                      style={{
                        height: 30, display: "flex", alignItems: "center",
                        justifyContent: "flex-end", paddingRight: 10, gap: 3,
                        background: live ? "rgba(20,23,28,.06)" : "none",
                        border: 0, cursor: "pointer",
                      }}
                    >
                      <Label color={column.derived ? S.ink : undefined}>{column.label}</Label>
                      {/* The direction has to be visible. Half of "clicking again
                          does nothing" was that nothing on screen ever said which
                          way the column ran. `aria-hidden` because `aria-sort`
                          already carries this for a screen reader. */}
                      <span
                        aria-hidden
                        style={{
                          /* 11, not 8. `legibility.test.ts` ratchets every
                             meaningful glyph to the 11px floor and allows no
                             exceptions, and a sort caret carries meaning. The
                             triangle draws well inside its em box anyway. */
                          fontSize: 11, lineHeight: 1, color: S.ink3,
                          visibility: live ? "visible" : "hidden",
                        }}
                      >
                        {ascending ? "\u25B2" : "\u25BC"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {visible.slice(0, 200).map((row) => {
                const on = picked.includes(row.elementId);
                return (
                  <div
                    key={row.elementId}
                    data-testid="stats-row"
                    className="dense-row"
                    data-owned={row.owned ? "yes" : undefined}
                    style={{
                      display: "grid", gridTemplateColumns: template,
                      borderBottom: `1px solid ${S.hair}`,
                      boxShadow: on ? `inset 3px 0 0 ${S.ink}` : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", paddingLeft: 10 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(row.elementId)}
                        aria-label={`Compare ${row.name}`}
                        disabled={!on && picked.length >= COMPARE_LIMIT}
                        style={{ width: 14, height: 14, accentColor: S.ink, cursor: "pointer" }}
                      />
                    </div>
                    <div style={{
                      padding: "0 8px", height: 36, display: "flex", alignItems: "center",
                      gap: 7, minWidth: 0,
                    }}>
                      <span style={{
                        fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {row.name}
                      </span>
                      <span style={{ fontSize: 11, color: S.ink3 }}>{row.team}</span>
                    </div>
                    {columns.map((column) => {
                      const value = column.of(row);
                      return (
                        <div key={column.key} style={{
                          display: "flex", alignItems: "center", justifyContent: "flex-end",
                          paddingRight: 10, fontSize: column.derived ? 13 : 12,
                          fontWeight: column.derived ? 600 : 400,
                          color: figureColour(column, value),
                        }}>
                          {format(column, value)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {visible.length > 200 ? (
                <p style={{ padding: "10px 14px", margin: 0, fontSize: 11, color: S.ink3 }}>
                  Showing the first 200 of {visible.length}. Narrow with the search or the
                  ownership filter — a longer table is not a better answer.
                </p>
              ) : null}
            </div>
          </div>
        )}

      {/* ── selection docks here and opens the comparison ──────────────── */}
      {picked.length > 0 && !comparing ? (
        <div
          data-testid="compare-tray"
          style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
            padding: "11px 18px", background: S.ink, color: S.shell,
          }}
        >
          <Label color="rgba(243,240,255,.55)">Selected</Label>
          {chosen.map((row) => (
            <button
              key={row.elementId}
              onClick={() => toggle(row.elementId)}
              style={{
                display: "flex", alignItems: "center", gap: 8, fontSize: 12.5,
                padding: "5px 11px", border: "1px solid rgba(243,240,255,.28)",
                background: "none", color: S.shell, cursor: "pointer",
              }}
            >
              {row.name} <span style={{ color: "rgba(243,240,255,.4)" }}>×</span>
            </button>
          ))}
          <div style={{ flexGrow: 1 }} />
          <span style={{ fontSize: 11.5, color: "rgba(243,240,255,.55)" }}>
            {picked.length >= COMPARE_LIMIT
              ? `${COMPARE_LIMIT} is the limit — more columns stop being a comparison`
              : "Every band on this sheet, transposed"}
          </span>
          <button
            onClick={() => setComparing(true)}
            style={{
              fontSize: 12, fontWeight: 600, letterSpacing: ".06em", padding: "7px 15px",
              background: S.shell, color: S.ink, border: 0, cursor: "pointer",
            }}
          >
            Compare {picked.length} →
          </button>
        </div>
      ) : null}

      {/* ── the notes ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 34, padding: "14px 18px",
        background: S.bar, border: `1px solid ${S.hair}`, borderTop: "none",
      }}>
        <div style={{ maxWidth: 470 }}>
          <div style={{ marginBottom: 7 }}><Label>{question.label}</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            {question.note}
          </p>
        </div>
        <div style={{ maxWidth: 300 }}>
          <div style={{ marginBottom: 7 }}><Label color={S.noise}>The ∅ mark</Label></div>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: 0 }}>
            Withheld, not zero. A per-90 over eight minutes, a figure a feed does not carry,
            and a coverage nobody stated are all shown this way, because a zero in any of
            them would be a claim nobody made.
          </p>
        </div>
        <div style={{ maxWidth: 440, borderLeft: `1px solid ${S.hair}`, paddingLeft: 22 }}>
          <div style={{ marginBottom: 7 }}>
            <Label color={S.conflict}>Feeds we do not carry</Label>
          </div>
          {BLOCKED_FEEDS.map((blocked) => (
            <p key={blocked.key} style={{
              fontSize: 11.5, lineHeight: 1.55, color: S.ink2, margin: "0 0 6px",
            }}>
              <strong style={{ color: S.ink }}>{blocked.label}</strong>
              {" "}({blocked.note}) {blocked.blockedBy}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The same bands, transposed — stats down, players across.
 *
 * A mode rather than a page. Its band grouping is what makes the transpose safe:
 * two providers' expected goals land several rows apart under different headers,
 * so a column can be read top to bottom without either figure being taken for a
 * correction of the other.
 */
function Comparison({
  rows, question, covers, onBack,
}: {
  readonly rows: readonly StatRow[];
  readonly question: ReturnType<typeof questionByKey>;
  readonly covers: readonly { readonly source: StatSource; readonly reach: string | null }[];
  readonly onBack: () => void;
}) {
  const template = `168px repeat(${rows.length}, minmax(0, 1fr))`;
  return (
    <div
      data-testid="comparison"
      style={{ border: `1px solid ${S.hair}`, borderTop: "none", padding: "0 18px 16px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 0" }}>
        <button
          onClick={onBack}
          /* Named, because "← Is he playing?" is the same accessible name as the
             question tab it returns to — two controls, one name, and a screen
             reader with no way to tell which is which. */
          aria-label="Back to the sheet"
          style={{
            fontSize: 11.5, fontWeight: 600, padding: "4px 10px", color: S.ink,
            border: `1px solid ${S.rule}`, background: S.bar, cursor: "pointer",
          }}
        >
          ← {question.label}
        </button>
        <span style={{ fontSize: 11.5, color: S.ink3 }}>
          {rows.length} beside each other
        </span>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: template, alignItems: "end",
        borderBottom: `2px solid ${S.ink}`, gap: 14,
      }}>
        <div />
        {rows.map((row) => (
          <div key={row.elementId} style={{ padding: "10px 0 8px" }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{row.name}</div>
            <div style={{ fontSize: 11, color: S.ink3 }}>
              {row.team}
              {row.owned ? " · owned" : ""}
            </div>
          </div>
        ))}
      </div>

      {question.bands.map((band) => (
        <div key={band.source}>
          <div style={{
            display: "flex", alignItems: "baseline", justifyContent: "space-between",
            gap: 10, padding: "13px 0 6px",
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".13em",
              textTransform: "uppercase" }}>
              {band.name}
            </span>
            <span style={{ fontSize: 11, color: S.ink3 }}>
              {covers.find((c) => c.source === band.source)?.reach ?? "coverage unknown"}
            </span>
          </div>
          {band.columns.map((column) => {
            const values = rows.map((row) => column.of(row));
            const real = values.filter((v): v is number => v !== null);
            const best = bestOf(column, real);
            return (
              <div key={column.key} style={{
                display: "grid", gridTemplateColumns: template, gap: 14,
                alignItems: "center", height: 32, borderBottom: `1px solid ${S.hair}`,
              }}>
                <span style={{ fontSize: 12, color: S.ink2 }}>{column.label}</span>
                {values.map((value, index) => (
                  <span
                    key={rows[index].elementId}
                    style={{
                      fontSize: 13.5,
                      fontWeight: best !== null && value === best ? 600 : 400,
                      color: figureColour(column, value),
                      /* `justifySelf` matters: a grid item stretches to its track,
                         so the best-in-row rule drew itself across the whole
                         column instead of under the figure it marks. */
                      justifySelf: "start",
                      boxShadow: best !== null && value === best
                        ? `inset 0 -2px 0 ${S.ink}` : "none",
                    }}
                  >
                    {format(column, value)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
