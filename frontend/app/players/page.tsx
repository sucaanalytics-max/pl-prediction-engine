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
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MIN_MINUTES_FOR_RATES, type PlayerRow } from "@/lib/data/narrow";
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

function PlayersTable({ rows }: { rows: readonly PlayerRow[] }) {
  const [sortByRate, setSortByRate] = useState(false);

  const shown = useMemo(() => {
    const sorted = [...rows].sort((a, b) =>
      sortByRate
        // Rows whose rates are meaningless sort last rather than topping the
        // table on a denominator artefact.
        ? Number(b.ratesAreMeaningful) - Number(a.ratesAreMeaningful)
          || b.xg / Math.max(b.minutes / 90, 1) - a.xg / Math.max(a.minutes / 90, 1)
        : b.minutes - a.minutes,
    );
    return sorted.slice(0, PAGE_SIZE);
  }, [rows, sortByRate]);

  const suppressed = rows.filter((r) => !r.ratesAreMeaningful).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          Showing {shown.length} of {rows.length}
          {suppressed > 0
            ? ` · per-90 rates hidden for ${suppressed} player${suppressed === 1 ? "" : "s"} under ${MIN_MINUTES_FOR_RATES} minutes`
            : ""}
        </p>
        <button
          type="button"
          className="text-xs underline"
          style={{ color: "var(--accent)" }}
          onClick={() => setSortByRate((v) => !v)}
        >
          Sort by {sortByRate ? "minutes" : "xG per 90"}
        </button>
      </div>

      <div className="glass-panel rounded-2xl overflow-x-auto">
        <table className="data-table" aria-label="Player season statistics">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Team</th>
              <th scope="col" className="text-center">Mins</th>
              <th scope="col" className="text-center">G</th>
              <th scope="col" className="text-center">A</th>
              <th scope="col" className="text-center">xG</th>
              <th scope="col" className="text-center hidden sm:table-cell">xA</th>
              <th scope="col" className="text-center hidden md:table-cell">xG/90</th>
              <th scope="col" className="text-center hidden lg:table-cell">Fouls</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.name}-${row.team}`} data-testid="player">
                <td className="text-sm">{row.name}</td>
                <td className="text-sm" style={{ color: "var(--text-3)" }}>
                  {row.team}
                </td>
                <td className="text-center font-mono text-sm">{row.minutes}</td>
                <td className="text-center font-mono text-sm">{row.goals}</td>
                <td className="text-center font-mono text-sm">{row.assists}</td>
                <td className="text-center font-mono text-sm">{row.xg.toFixed(2)}</td>
                <td className="text-center font-mono text-sm hidden sm:table-cell">
                  {row.xa.toFixed(2)}
                </td>
                <td
                  className="text-center font-mono text-sm hidden md:table-cell"
                  data-rates={row.ratesAreMeaningful ? "shown" : "suppressed"}
                >
                  {/* Suppressed below the minutes floor: the denominator clamp
                      turns a 0-minute player's xG into xG x 10. */}
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
                  <Stat value={row.fouls_committed} />
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

        <HeuristicRankings />
      </div>
    </ErrorBoundary>
  );
}
