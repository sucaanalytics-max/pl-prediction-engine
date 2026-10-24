"use client";

/**
 * Players at phone width — one compact list, ranked by this week's xP.
 *
 * ## What this is, and what it is not
 *
 * The wide grid and the sixteen-column research table answer "who scores most over
 * eight weeks" and "how wide is the spread on him". On a 390px screen neither fits,
 * and a table scrolled sideways inside a page that also scrolls is how a phone user
 * loses their place. This is the third reading, built for a thumb: who, against whom,
 * what the simulation expects, and how often it expects a haul.
 *
 * Every figure is from `xp_public_gw{NN}.json` — `xp` and `p_ge_10` — which is the
 * same file the desktop grid and `ResearchView` read, through the same loader. The
 * fixture comes from the live fixture list, joined by `buildGridRows`, which is the
 * grid's own join. Nothing is computed here that those two do not already publish.
 *
 * ## Tags
 *
 * OWNED is a fact about the squad on file (`useHeuristics`). PLANNED is a fact about
 * the agent's proposal: the player is a transfer IN somewhere in the decision's
 * planned weeks and is not already owned. If either source cannot be read the tag
 * is simply absent — never guessed — and the source line says nothing about it, the
 * same way the desktop grid renders without its fixture labels.
 */

import { useDeferredValue, useMemo, useState } from "react";

import { PhoneHeader } from "@/components/phone/PhoneHeader";
import { proven } from "@/lib/data/artifact";
import { decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { utcStamp } from "@/lib/phone";
import { SANS, SIGNAL } from "@/lib/margin/tokens";
import { buildGridRows, type GridRow } from "@/lib/projections/grid";

const S = SIGNAL;

const POSITIONS = ["All", "GKP", "DEF", "MID", "FWD"] as const;
type Position = (typeof POSITIONS)[number];
type Show = "all" | "mine";
type Sort = "xp" | "p10";

/** Rows drawn before the reader asks for the rest — and the count is printed. */
const PAGE = 100;

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function segment(on: boolean): React.CSSProperties {
  return {
    flex: 1, minHeight: 44, border: `1px solid ${on ? S.ink : S.rule}`,
    background: on ? S.ink : S.bar, color: on ? S.bar : S.ink,
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
}

function Tag({ children, planned }: { children: string; planned: boolean }) {
  const colour = planned ? S.agree : S.ink2;
  return (
    <span
      data-testid={planned ? "tag-planned" : "tag-owned"}
      style={{
        padding: "1px 5px", fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
        border: `1px solid ${colour}`, color: colour, lineHeight: 1.3,
      }}
    >
      {children}
    </span>
  );
}

export function PlayersPhone({ gameweek }: { gameweek: number }) {
  const { artifact } = useArtifact(projectionsDescriptor(gameweek));
  const { artifact: liveArtifact } = useHeuristics();
  const { artifact: decisionArtifact } = useArtifact(decisionDescriptor(gameweek));
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [position, setPosition] = useState<Position>("All");
  const [show, setShow] = useState<Show>("all");
  const [sort, setSort] = useState<Sort>("xp");
  const [showAll, setShowAll] = useState(false);

  const file = proven(artifact);
  const live = proven(liveArtifact);
  const decision = proven(decisionArtifact);
  const fixtures = live?.fixtureMatrix;
  const squadPlayers = live?.squad?.players;
  const week = file?.gameweek ?? gameweek;

  const ownedIds = useMemo(
    () => new Set((squadPlayers ?? [])
      .map((player) => player.elementId)
      .filter((id): id is number => typeof id === "number")),
    [squadPlayers],
  );

  const plannedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const w of decision?.horizon?.weeks ?? []) {
      if (!w.planned) continue;
      for (const id of w.transfers_in) ids.add(id);
    }
    return ids;
  }, [decision]);

  const rows = useMemo<GridRow[]>(() => file === null ? [] : buildGridRows({
    players: file.players, horizon: null, currentGameweek: week,
    fixtures: fixtures ?? [], ownedIds, span: 2,
  }), [file, week, fixtures, ownedIds]);

  const blankById = useMemo(
    () => new Map((file?.players ?? []).map((p) => [p.elementId, p])),
    [file],
  );

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const key = (row: GridRow): number | null =>
      sort === "xp" ? row.cells[0]?.xp ?? null : row.pGe10;
    return rows
      .filter((row) =>
        (position === "All" || row.position === position)
        && (show === "all" || row.owned)
        && (q === "" || row.name.toLowerCase().includes(q)
            || row.team.toLowerCase().includes(q)))
      .sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        // Nulls last: no projection is not the worst projection.
        if (x === null && y === null) return a.elementId - b.elementId;
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x || a.elementId - b.elementId;
      });
  }, [rows, deferredQuery, position, show, sort]);

  const shown = showAll ? visible : visible.slice(0, PAGE);

  const run = utcStamp(file?.generatedAt);
  const draws = file?.nDraws ? `${file.nDraws.toLocaleString("en-GB")} draws` : "draw count unstated";

  return (
    <div
      data-testid="players-phone"
      style={{ fontFamily: SANS, color: S.ink, paddingBottom: 16 }}
    >
      <PhoneHeader title="Players" aside={`GW${week} projection`}>
        <label
          style={{
            display: "flex", alignItems: "center", gap: 8, minHeight: 44,
            padding: "0 12px", background: S.shell, border: `1px solid ${S.rule}`,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={S.ink3}
            strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" />
          </svg>
          <span className="sr-only">Search players</span>
          <input
            type="search"
            name="players-phone-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${rows.length} players`}
            style={{
              flex: 1, minWidth: 0, border: 0, background: "transparent",
              fontFamily: "inherit", fontSize: 16, color: S.ink, minHeight: 44,
              outlineOffset: 4,
            }}
          />
        </label>
        <div role="group" aria-label="Position" style={{ display: "flex", gap: 6 }}>
          {POSITIONS.map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={position === label}
              onClick={() => { setPosition(label); setShowAll(false); }}
              style={segment(position === label)}
            >
              {label}
            </button>
          ))}
        </div>
      </PhoneHeader>

      {file === null ? (
        <p style={{ margin: "16px 0 0", fontSize: 12, color: S.ink2 }}>
          No list for GW{gameweek}: {artifact.reason ?? "the projection could not be read."}
        </p>
      ) : (
        <>
          <div role="group" aria-label="Show" style={{ display: "flex", gap: 6, marginTop: 12 }}>
            {([["all", "Everyone"], ["mine", "My squad"]] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={show === key}
                onClick={() => { setShow(key); setShowAll(false); }}
                style={segment(show === key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "grid", gridTemplateColumns: "minmax(0, 1fr) 64px 64px", gap: 8,
              alignItems: "center", padding: "4px 10px 0", fontSize: 11, fontWeight: 600,
              letterSpacing: ".06em", textTransform: "uppercase", color: S.ink3,
            }}
          >
            <span>Player · fixture</span>
            {([["xp", "xP"], ["p10", "10+ pts"]] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={sort === key}
                aria-label={`Sort by ${label}`}
                onClick={() => { setSort(key); setShowAll(false); }}
                style={{
                  minHeight: 44, border: 0, background: "transparent", fontFamily: "inherit",
                  letterSpacing: "inherit", textTransform: "inherit", textAlign: "right",
                  color: sort === key ? S.ink : S.ink3, cursor: "pointer",
                  textDecoration: sort === key ? "underline" : "none",
                  textUnderlineOffset: 3,
                }}
              >
                {label}{sort === key ? " ↓" : ""}
              </button>
            ))}
          </div>

          <ul
            aria-label="Players by expected points"
            style={{
              margin: 0, padding: 0, listStyle: "none", display: "flex",
              flexDirection: "column", gap: 1,
            }}
          >
            {shown.map((row) => {
              const projection = blankById.get(row.elementId);
              const cell = row.cells[0];
              const fixture = projection?.blank
                ? "blank"
                : cell?.fixture ?? (fixtures && fixtures.length > 0 ? "no fixture" : null);
              const planned = plannedIds.has(row.elementId) && !row.owned;
              return (
                <li
                  key={row.elementId}
                  data-testid="players-phone-row"
                  style={{
                    display: "grid", gridTemplateColumns: "minmax(0, 1fr) 64px 64px",
                    gap: 8, alignItems: "center", minHeight: 52, padding: "6px 10px",
                    background: S.bar,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{
                        fontSize: 15, fontWeight: 600, whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {row.name}
                      </span>
                      {row.owned ? <Tag planned={false}>OWNED</Tag> : null}
                      {planned ? <Tag planned>PLANNED</Tag> : null}
                    </span>
                    <span style={{ fontSize: 12, color: S.ink3 }}>
                      {[row.position, row.team, fixture].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <span style={{ textAlign: "right", fontSize: 17, fontWeight: 600 }}>
                    {cell?.xp == null ? "—" : cell.xp.toFixed(2)}
                  </span>
                  <span style={{ textAlign: "right", fontSize: 13, color: S.ink2 }}>
                    {pct(row.pGe10)}
                  </span>
                </li>
              );
            })}
          </ul>

          {visible.length === 0 ? (
            <p style={{ margin: "12px 0 0", fontSize: 12, color: S.ink2 }}>
              Nothing matches. The filter is what is empty, not the projection.
            </p>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <span data-testid="players-phone-count" style={{ fontSize: 11, color: S.ink3 }}>
              showing {shown.length} of {visible.length}
              {visible.length !== rows.length ? ` · ${rows.length} in the file` : ""}
            </span>
            {visible.length > shown.length ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                style={{
                  minHeight: 44, padding: "0 12px", border: `1px solid ${S.rule}`,
                  background: S.bar, color: S.ink, fontFamily: "inherit", fontSize: 13,
                  fontWeight: 600, cursor: "pointer",
                }}
              >
                Show the other {visible.length - shown.length}
              </button>
            ) : null}
          </div>

          <p
            data-testid="players-phone-source"
            style={{ margin: "8px 0 0", fontSize: 11, fontStyle: "italic", color: S.ink3 }}
          >
            Our simulation · {draws} · {run ? `run ${run}` : "run time unstated"}
          </p>
        </>
      )}
    </div>
  );
}
