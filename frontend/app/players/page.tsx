"use client";

/**
 * Players — who, and how sure are we.
 *
 * ## The per-90 trap
 *
 * `xg_per_90` is computed upstream as `xg / max(minutes / 90, 0.1)`. That floor
 * means a player with **zero minutes** reads as `xg * 10` — a fabricated rate,
 * rendered in the same column and the same typeface as measured ones. The
 * narrower therefore carries `ratesAreMeaningful` per row, and this screen
 * suppresses the per-90 columns rather than showing a number it cannot stand
 * behind.
 *
 * ## Nulls stay null
 *
 * `fouls_committed` and `fouls_per_90` are **null on all 564 rows** of the
 * committed artifact while `PlayerStat` types both as `number`. Coercing them to
 * zero would report "committed no fouls" for a stat the provider never supplied —
 * 564 rows of confident zero being a far more convincing lie than 564 blanks.
 */

import { useMemo, useState } from "react";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { usePlayerWatchlist } from "@/lib/use-player-watchlist";
import {
  notable, projectionsDescriptor, skew,
  type Projection, type Projections,
} from "@/lib/data/projections";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MIN_MINUTES_FOR_RATES, type MatchesFile, type PlayerRow } from "@/lib/data/narrow";
import { proven } from "@/lib/data/artifact";
import {
  RANKING_CATEGORIES, type HeuristicPlayer, type RankingCategory,
} from "@/lib/data/heuristics";

const PAGE_SIZE = 50;

/** A measured value, or an honest blank. Never a coerced zero. */
function Stat({ value, digits = 0 }: { value: number | null; digits?: number }) {
  return value === null ? (
    <span style={{ color: "var(--text-4)" }} title="not supplied by the provider">
      —
    </span>
  ) : (
    <>{value.toFixed(digits)}</>
  );
}

/**
 * Sort keys, and why the default is what it is.
 *
 * The old default was **minutes descending**, which put twelve goalkeepers with
 * `0` goals and `0.00` xG at the top of the FPL players page — "who played most
 * last season" is not a question anyone opens this page to ask.
 *
 * The obvious replacement, projected points, is **not available in production**:
 * per-player projections come from the FPLReview export, which is licensed and
 * absent from CI (`coveragePercent: 0`, `source: fallback`). Defaulting to a column
 * that is empty on the deployed site would trade one bad first screen for another.
 *
 * So the default is ownership — the one forward-looking number present on 498 of
 * 577 rows, and the honest answer to "where do I start".
 */
const SORTS = [
  { key: "ownership", label: "Owned by", get: (r: PlayerRow) => r.fpl_ownership },
  { key: "price", label: "Price", get: (r: PlayerRow) => r.fpl_price },
  { key: "form", label: "Form", get: (r: PlayerRow) => r.form },
  { key: "goals", label: "Goals", get: (r: PlayerRow) => r.goals },
  { key: "assists", label: "Assists", get: (r: PlayerRow) => r.assists },
  { key: "xg", label: "xG", get: (r: PlayerRow) => r.xg },
  { key: "minutes", label: "Minutes", get: (r: PlayerRow) => r.minutes },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

const POSITIONS = ["GKP", "DEF", "MID", "FWD"] as const;

function PlayersTable({ rows }: { rows: readonly PlayerRow[] }) {
  const [sort, setSort] = useState<SortKey>("ownership");
  const [position, setPosition] = useState<string>("");
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const [fitOnly, setFitOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (position && row.position !== position) return false;
      if (maxPrice !== null && (row.fpl_price ?? Infinity) > maxPrice) return false;
      // `available === null` means the provider did not say. Excluded only when the
      // reader explicitly asks for fit players, never silently.
      if (fitOnly && row.available !== true) return false;
      if (needle && !`${row.name} ${row.team}`.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [rows, position, maxPrice, fitOnly, query]);

  const shown = useMemo(() => {
    const getter = SORTS.find((s) => s.key === sort)?.get ?? SORTS[0].get;
    return [...filtered]
      .sort((a, b) => {
        const left = getter(a);
        const right = getter(b);
        // Nulls last, always. A missing value sorting to the top of a descending
        // list is the same defect as the goalkeeper wall in a different column.
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left;
      })
      .slice(0, PAGE_SIZE);
  }, [filtered, sort]);

  const suppressed = filtered.filter((r) => !r.ratesAreMeaningful).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search player or club"
          aria-label="Search players"
          className="rounded border px-2 py-1 text-xs"
          style={{
            background: "var(--surface-2, #0f172a)",
            borderColor: "var(--border)",
            color: "var(--text-1)",
          }}
        />

        <div role="group" aria-label="Filter by position" className="flex gap-1">
          {["", ...POSITIONS].map((code) => (
            <button
              key={code || "all"}
              type="button"
              onClick={() => setPosition(code)}
              aria-pressed={position === code}
              className="text-[11px] rounded px-2 py-1"
              style={{
                background: position === code ? "var(--accent)" : "transparent",
                color: position === code ? "var(--accent-contrast, #fff)" : "var(--text-3)",
                border: "1px solid var(--border)",
              }}
            >
              {code || "All"}
            </button>
          ))}
        </div>

        <select
          value={maxPrice ?? ""}
          onChange={(e) => setMaxPrice(e.target.value ? Number(e.target.value) : null)}
          aria-label="Maximum price"
          className="rounded border px-2 py-1 text-xs"
          style={{
            background: "var(--surface-2, #0f172a)",
            borderColor: "var(--border)",
            color: "var(--text-1)",
          }}
        >
          <option value="">Any price</option>
          {[4.5, 5.5, 6.5, 7.5, 9, 11, 15].map((p) => (
            <option key={p} value={p}>Up to £{p.toFixed(1)}m</option>
          ))}
        </select>

        <label className="text-[11px] flex items-center gap-1" style={{ color: "var(--text-3)" }}>
          <input
            type="checkbox"
            checked={fitOnly}
            onChange={(event) => setFitOnly(event.target.checked)}
          />
          Available only
        </label>

        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          aria-label="Sort by"
          className="rounded border px-2 py-1 text-xs ml-auto"
          style={{
            background: "var(--surface-2, #0f172a)",
            borderColor: "var(--border)",
            color: "var(--text-1)",
          }}
        >
          {SORTS.map((option) => (
            <option key={option.key} value={option.key}>Sort: {option.label}</option>
          ))}
        </select>
      </div>

      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        Showing {shown.length} of {filtered.length}
        {filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ""}
        {suppressed > 0
          ? ` · per-90 rates hidden for ${suppressed} player${suppressed === 1 ? "" : "s"} under ${MIN_MINUTES_FOR_RATES} minutes`
          : ""}
        {" · goals, assists and xG are last season's actuals, not a projection"}
      </p>

      <div className="glass-panel rounded-2xl overflow-x-auto">
        <table className="data-table" aria-label="Players">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Team</th>
              <th scope="col" className="text-center">Pos</th>
              <th scope="col" className="text-center">Price</th>
              <th scope="col" className="text-center">Owned</th>
              <th scope="col" className="text-center hidden sm:table-cell">Form</th>
              <th scope="col" className="text-center">G</th>
              <th scope="col" className="text-center">A</th>
              <th scope="col" className="text-center hidden md:table-cell">xG</th>
              <th scope="col" className="text-center hidden md:table-cell">xA</th>
              <th scope="col" className="text-center hidden md:table-cell">xG/90</th>
              <th scope="col" className="text-center hidden lg:table-cell">Mins</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.name}-${row.team}`} data-testid="player">
                <td className="text-sm">
                  {row.name}
                  {row.available === false ? (
                    <span
                      className="ml-1 text-[10px]"
                      style={{ color: "var(--warning, #f59e0b)" }}
                      title="FPL lists this player as unavailable"
                    >
                      !
                    </span>
                  ) : null}
                </td>
                <td className="text-sm" style={{ color: "var(--text-3)" }}>{row.team}</td>
                <td className="text-center text-xs" style={{ color: "var(--text-3)" }}>
                  {row.position || "—"}
                </td>
                <td className="text-center font-mono text-sm">
                  {row.fpl_price === null ? "—" : `£${row.fpl_price.toFixed(1)}`}
                </td>
                <td className="text-center font-mono text-sm">
                  {row.fpl_ownership === null ? "—" : `${row.fpl_ownership.toFixed(1)}%`}
                </td>
                <td className="text-center font-mono text-sm hidden sm:table-cell">
                  <Stat value={row.form} digits={1} />
                </td>
                <td className="text-center font-mono text-sm">{row.goals}</td>
                <td className="text-center font-mono text-sm">{row.assists}</td>
                <td className="text-center font-mono text-sm hidden md:table-cell">
                  {row.xg.toFixed(2)}
                </td>
                <td className="text-center font-mono text-sm hidden md:table-cell">
                  {row.xa.toFixed(2)}
                </td>
                <td
                  className="text-center font-mono text-sm hidden md:table-cell"
                  data-rates={row.ratesAreMeaningful ? "shown" : "suppressed"}
                >
                  {/* Suppressed below the minutes floor.
                      `xg_per_90` is `xg / max(minutes / 90, 0.1)`, so a 0-minute
                      player reads as `xg * 10` — a fabricated rate rendered in the
                      same column as measured ones. I deleted this column while
                      rebuilding the table and six tests caught it; they encode a
                      measured trap, not a preference. */}
                  {row.ratesAreMeaningful ? (
                    (row.xg / (row.minutes / 90)).toFixed(2)
                  ) : (
                    <span
                      style={{ color: "var(--text-4)" }}
                      title={`under ${MIN_MINUTES_FOR_RATES} minutes — a per-90 rate here is an artefact of the denominator floor`}
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="text-center font-mono text-sm hidden lg:table-cell">
                  {row.minutes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The model's own projections, led by the distribution rather than the mean.
 *
 * This is the section that distinguishes the app: `xp 6.4` beside `most often
 * 2` beside `P(10+) 15%` is the honest statement of a right-skewed forecast,
 * and seven of eight competitors publish only the first of the three.
 */
function ModelProjections({ gameweek }: { gameweek: number }) {
  const descriptor = useMemo(() => projectionsDescriptor(gameweek), [gameweek]);
  const { artifact } = useArtifact<Projections>(descriptor);
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Section
      title="Projections"
      subtitle="What the simulation expects, and how wide the spread is"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <WhenProven
        of={artifact}
        what={
          `No projection has been published for GW${gameweek}. The agent writes ` +
          `one per gameweek and prunes the rest, so exactly one is current.`
        }
        then={(file) => {
          const rows = notable(file.players);
          return (
            <div className="space-y-2">
              <div className="glass-panel rounded-2xl overflow-x-auto">
                <table className="data-table" aria-label="Player points projections">
                  <thead>
                    <tr>
                      <th scope="col">Player</th>
                      <th scope="col" className="hidden sm:table-cell">Team</th>
                      <th scope="col" className="text-center">Mean</th>
                      <th scope="col" className="text-center">Most often</th>
                      <th scope="col" className="text-center">P(10+)</th>
                      <th scope="col" className="text-center hidden md:table-cell">
                        10–90%
                      </th>
                      <th scope="col" className="w-8" aria-label="Breakdown" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((player) => (
                      <ProjectionRow
                        key={player.elementId}
                        player={player}
                        open={expanded === player.elementId}
                        onToggle={() =>
                          setExpanded(
                            expanded === player.elementId ? null : player.elementId,
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
                Ranked by the chance of a hauling week, not by the mean — a
                weekly-win entry is buying the right tail.
                {file.nDraws !== null
                  ? ` Tail probabilities from ${file.nDraws.toLocaleString()} simulated draws.`
                  : ""}
              </p>
            </div>
          );
        }}
      />
    </Section>
  );
}

function ProjectionRow({
  player, open, onToggle,
}: {
  player: Projection;
  open: boolean;
  onToggle: () => void;
}) {
  const gap = skew(player);
  return (
    <>
      <tr data-testid="projection">
        <td className="text-sm">{player.name ?? `#${player.elementId}`}</td>
        <td className="text-sm hidden sm:table-cell" style={{ color: "var(--text-3)" }}>
          {player.team ?? "—"}
        </td>
        <td className="text-center font-mono text-sm">
          {player.xp !== null ? player.xp.toFixed(1) : "—"}
        </td>
        <td className="text-center font-mono text-sm" data-testid="mode">
          {/* The number that stops the mean being read as a forecast. */}
          {player.mode !== null ? player.mode : "—"}
          {gap !== null && gap >= 2 ? (
            <span
              className="ml-1 text-[9px]"
              style={{ color: "var(--warning, #f59e0b)" }}
              title={`The mean sits ${gap.toFixed(1)} points above the most likely return, so it is carried by the tail rather than by a typical week.`}
            >
              skew
            </span>
          ) : null}
        </td>
        <td className="text-center font-mono text-sm">
          {player.pGe10 !== null ? `${(player.pGe10 * 100).toFixed(0)}%` : "—"}
        </td>
        <td className="text-center font-mono text-xs hidden md:table-cell">
          {player.q10 !== null && player.q90 !== null
            ? `${player.q10.toFixed(0)}–${player.q90.toFixed(0)}`
            : "—"}
        </td>
        <td className="text-center">
          {player.decomposition ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} points breakdown for ${player.name ?? player.elementId}`}
              className="text-xs"
              style={{ color: "var(--accent)" }}
            >
              {open ? "−" : "+"}
            </button>
          ) : null}
        </td>
      </tr>
      {open && player.decomposition ? (
        <tr data-testid="breakdown">
          <td colSpan={7} className="text-xs" style={{ color: "var(--text-3)" }}>
            {/* Where the mean comes from. 6.4 built from appearance points and
                a clean sheet is a different holding from 6.4 built from a
                one-in-six chance of a haul. */}
            <div className="glass-inset p-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
              {([
                ["Appearance", player.decomposition.appearance],
                ["Goals", player.decomposition.goals],
                ["Assists", player.decomposition.assists],
                ["Clean sheet", player.decomposition.cleanSheets],
                ["Other", player.decomposition.other],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <p className="stat-label">{label}</p>
                  <p className="font-mono">{value.toFixed(2)}</p>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The eight ranked lists, ported off `/rankings` and `/projections`.
 *
 * They are the heuristic engine's output, not a projection — see
 * `lib/data/heuristics.ts` for why that distinction is load-bearing. The badge
 * sits on the section rather than on each number, because a per-cell caveat is
 * one nobody reads.
 */
function HeuristicRankings() {
  const { artifact } = useHeuristics();
  const [category, setCategory] = useState<RankingCategory>("overall");
  const [query, setQuery] = useState("");
  // Carried over from /transfers and /rankings, which both had it. It is the
  // user's own data in localStorage, so dropping it in the move would delete
  // something they created rather than something we generated.
  const { watched, toggle, persisted } = usePlayerWatchlist();

  return (
    <Section
      title="Ranked players"
      subtitle="From the heuristic engine, until a gameweek seals"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="badge-amber text-[9px]">HEURISTIC — NOT A MODEL</span>
          {persisted ? null : (
            <span className="text-xs" role="status" style={{ color: "var(--warning, #f59e0b)" }}>
              Starring works, but this browser is not storing it — it will be
              gone on reload.
            </span>
          )}
        </div>

        <WhenProven
          of={artifact}
          what="The engine produced no ranked lists. It needs live FPL fields, which are unavailable before the season opens."
          then={(view) => {
            const all = view.rankings[category];
            const needle = query.trim().toLowerCase();
            const rows = needle
              ? all.filter(
                  (p) =>
                    p.name.toLowerCase().includes(needle) ||
                    p.team.toLowerCase().includes(needle),
                )
              : all;
            // The widest horizon any player carries, so the per-gameweek columns
            // match the data rather than a hardcoded ten that renders as dashes.
            const horizon = Math.min(
              6, rows.reduce((max, p) => Math.max(max, p.gameweeks.length), 0),
            );
            return (
              <div className="space-y-2">
                {/* Tabs are driven by the declared categories, so a list the
                    engine stops emitting is a missing tab rather than silence. */}
                <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Ranking category">
                  {RANKING_CATEGORIES.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={category === key}
                      onClick={() => setCategory(key)}
                      className="text-xs px-2 py-1 rounded"
                      style={
                        category === key
                          ? { background: "var(--accent)", color: "#fff" }
                          : { color: "var(--text-3)" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search player or team"
                    aria-label="Search ranked players"
                    className="text-xs px-2 py-1 rounded glass-inset"
                    style={{ color: "var(--text-2)" }}
                  />
                  <span className="text-xs" style={{ color: "var(--text-3)" }}>
                    {rows.length} of {all.length}
                  </span>
                </div>

                {rows.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--text-3)" }}>
                    {all.length === 0
                      ? "No players in this category."
                      : "No player matches that search."}
                  </p>
                ) : (
                  <div className="glass-panel rounded-2xl overflow-x-auto">
                    <table className="data-table" aria-label={`Ranked players — ${category}`}>
                      <thead>
                        <tr>
                          <th scope="col" className="w-8 text-center">#</th>
                          <th scope="col">Player</th>
                          <th scope="col" className="hidden sm:table-cell">Team</th>
                          <th scope="col" className="text-center">£</th>
                          <th scope="col" className="text-center hidden md:table-cell">Own%</th>
                          <th scope="col" className="text-center hidden md:table-cell">xMins</th>
                          {Array.from({ length: horizon }, (_, i) => (
                            <th key={i} scope="col" className="text-center hidden xl:table-cell">
                              +{i + 1}
                            </th>
                          ))}
                          <th scope="col" className="text-center">4GW</th>
                          <th scope="col" className="text-center hidden sm:table-cell">6GW</th>
                          <th scope="col" className="w-8" aria-label="Watchlist" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((player, index) => (
                          <RankedRow
                            key={player.elementId}
                            player={player}
                            index={index}
                            horizon={horizon}
                            watched={watched.includes(player.elementId)}
                            onToggle={() => toggle(player.elementId)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
                  Projection source: {view.projectionSourceLabel}.
                </p>
              </div>
            );
          }}
        />
      </div>
    </Section>
  );
}

function RankedRow({
  player, index, horizon, watched, onToggle,
}: {
  player: HeuristicPlayer;
  index: number;
  horizon: number;
  watched: boolean;
  onToggle: () => void;
}) {
  // `status` is FPL's own availability letter; anything but "a" is worth seeing
  // next to the name rather than buried in a tooltip.
  const doubtful = player.status !== "a";
  return (
    <tr data-testid="ranked-player" data-watched={watched ? "yes" : "no"}>
      <td className="text-center font-mono text-xs">{index + 1}</td>
      <td className="text-sm">
        {player.name}
        {doubtful ? (
          <span
            className="ml-1 text-[9px] uppercase"
            style={{ color: "var(--warning, #f59e0b)" }}
            title={player.news || "flagged by FPL"}
          >
            flagged
          </span>
        ) : null}
      </td>
      <td className="text-sm hidden sm:table-cell" style={{ color: "var(--text-3)" }}>
        {player.team}
      </td>
      <td className="text-center font-mono text-sm">{player.price.toFixed(1)}</td>
      <td className="text-center font-mono text-sm hidden md:table-cell">
        {player.ownership.toFixed(1)}
      </td>
      <td className="text-center font-mono text-sm hidden md:table-cell">
        {player.expectedMinutes.toFixed(0)}
      </td>
      {Array.from({ length: horizon }, (_, i) => {
        const week = player.gameweeks[i];
        return (
          <td
            key={i}
            className="text-center font-mono text-xs hidden xl:table-cell"
            title={week?.fixture ?? "no projection for this gameweek"}
          >
            {/* A dash rather than 0.0: no projection is not a projection of
                zero, and the two would sort identically if coerced. */}
            {week ? week.projectedPoints.toFixed(1) : "—"}
          </td>
        );
      })}
      <td className="text-center font-mono text-sm">{player.projected4.toFixed(1)}</td>
      <td className="text-center font-mono text-sm hidden sm:table-cell">
        {player.projected6.toFixed(1)}
      </td>
      <td className="text-center">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={watched}
          aria-label={`${watched ? "Remove" : "Add"} ${player.name} ${watched ? "from" : "to"} watchlist`}
          className="text-xs"
          style={{ color: watched ? "var(--warning, #f59e0b)" : "var(--text-4)" }}
        >
          {watched ? "★" : "☆"}
        </button>
      </td>
    </tr>
  );
}

export default function PlayersPage() {
  const { artifact } = useArtifact<readonly PlayerRow[]>(REGISTRY.playerStats);
  // The projection is filed per gameweek, so the fixtures artifact has to be
  // readable before one can be located. Its own absence is a section-level
  // state, not a page-level gate.
  const { artifact: matches } = useArtifact<MatchesFile>(REGISTRY.matches);
  const gameweek = proven(matches)?.gameweek ?? null;

  return (
    <ErrorBoundary pageName="Players">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Players
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Season actuals. A dash means the provider supplied nothing, not zero.
          </p>
        </header>

        <Section title="Season statistics" aside={<ProvenanceStrip of={artifact} />}>
          <WhenProven
            of={artifact}
            what="No player has played a minute yet, so there are no season statistics to show."
            then={(rows) => <PlayersTable rows={rows} />}
          />
        </Section>

        {gameweek === null ? (
          <div className="card p-4" role="status">
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              The current gameweek is unknown, so no projection can be located.
            </p>
          </div>
        ) : (
          <ModelProjections gameweek={gameweek} />
        )}

        <HeuristicRankings />
      </div>
    </ErrorBoundary>
  );
}
