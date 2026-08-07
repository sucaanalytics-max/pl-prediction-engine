"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, Clock3, Database, Search, ShieldCheck } from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";
import { istDateTime } from "@/lib/formats";
import type { FplProjectionPlayer } from "@/lib/fpl-live";

type Horizon = 4 | 6 | 10;
type PositionFilter = "ALL" | "GKP" | "DEF" | "MID" | "FWD";
type SortKey = "points" | "value" | "minutes" | "elite";
const PAGE_SIZE = 50;

function horizonPoints(player: FplProjectionPlayer, horizon: Horizon) {
  if (horizon === 4) return player.projected4;
  if (horizon === 6) return player.projected6;
  return player.projected10;
}

export default function ProjectionsPage() {
  const { state, loading, error, refresh } = useFplLive();
  const [horizon, setHorizon] = useState<Horizon>(6);
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [sort, setSort] = useState<SortKey>("points");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [horizon, position, sort, query]);

  const players = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...(state?.projections.players ?? [])]
      .filter((player) => position === "ALL" || player.position === position)
      .filter((player) => !normalized || player.name.toLowerCase().includes(normalized) || player.team.toLowerCase().includes(normalized))
      .sort((left, right) => {
        if (sort === "value") return right.valueScore - left.valueScore;
        if (sort === "minutes") return right.expectedMinutes - left.expectedMinutes;
        if (sort === "elite") return (right.eliteOwnership ?? -1) - (left.eliteOwnership ?? -1);
        return horizonPoints(right, horizon) - horizonPoints(left, horizon);
      });
  }, [horizon, position, query, sort, state]);

  const pageCount = Math.max(1, Math.ceil(players.length / PAGE_SIZE));
  const visiblePlayers = players.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const source = state?.projections;

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><BarChart3 size={13} /> Private premium model</div>
          <h1>Player projections</h1>
          <p>Expected minutes, weekly EV and 4/6/10-Gameweek totals from your FPLReview export, reconciled to live official FPL players and prices.</p>
        </div>
        <div className="ranking-trust"><ShieldCheck size={18} /><div><strong>FPLReview snapshot</strong><span>Official live safety overlay</span></div></div>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="decision-card p-4">
          <span className="kicker flex items-center gap-2"><Database size={13} /> Coverage</span>
          <strong className="mt-2 block text-xl" style={{ color: "var(--text-1)" }}>{source ? `${source.matchedPlayers}/${source.officialPlayers}` : "—"}</strong>
          <span className="text-xs" style={{ color: "var(--text-3)" }}>{source ? `${source.coveragePercent}% of official catalogue` : "Loading catalogue"}</span>
        </div>
        <div className="decision-card p-4 sm:col-span-2">
          <span className="kicker flex items-center gap-2"><Clock3 size={13} /> Projection freshness</span>
          <strong className="mt-2 block text-sm" style={{ color: "var(--text-1)" }}>{source?.exportedAt ? istDateTime(source.exportedAt) : "Loading snapshot…"}</strong>
          <span className="text-xs" style={{ color: "var(--text-3)" }}>Manual premium CSV snapshot · all dates, deadlines and kickoffs display in IST</span>
        </div>
      </section>

      <section className="decision-card p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="ranking-category-tabs" aria-label="Projection horizon">
            {([4, 6, 10] as Horizon[]).map((value) => <button key={value} className={horizon === value ? "active" : ""} onClick={() => setHorizon(value)}>{value} GW</button>)}
          </div>
          <div className="ranking-category-tabs" aria-label="Player position">
            {(["ALL", "GKP", "DEF", "MID", "FWD"] as PositionFilter[]).map((value) => <button key={value} className={position === value ? "active" : ""} onClick={() => setPosition(value)}>{value}</button>)}
          </div>
          <label className="ranking-search ml-auto"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or club" aria-label="Search player or club" /></label>
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-3)" }}>Sort
            <select className="form-select !w-auto !py-2" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="points">Projected points</option><option value="value">Value</option><option value="minutes">Next xMins</option><option value="elite">Elite ownership</option>
            </select>
          </label>
        </div>

        {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">Projection feed unavailable. <button className="underline" onClick={() => void refresh()}>Retry</button></div> : null}

        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--border)" }}>
          <table className="data-table min-w-[1050px] w-full">
            <thead><tr><th className="text-left">Player</th><th>Price</th><th>Next xMins</th>{Array.from({ length: horizon }, (_, index) => <th key={index}>GW{index + 1}</th>)}<th>{horizon} GW</th><th>Value</th><th>Elite</th><th>Overall</th></tr></thead>
            <tbody>
              {visiblePlayers.map((player) => (
                <tr key={player.elementId}>
                  <td><div className="flex items-center gap-3"><span className={`position-badge position-${player.position.toLowerCase()}`}>{player.position}</span><span><strong className="block" style={{ color: "var(--text-1)" }}>{player.name}</strong><small style={{ color: "var(--text-3)" }}>{player.team}</small></span></div></td>
                  <td className="text-center">£{player.price.toFixed(1)}</td><td className="text-center font-semibold">{player.expectedMinutes}&apos;</td>
                  {Array.from({ length: horizon }, (_, index) => { const week = player.gameweekProjections[index]; return <td className="text-center" key={index} title={week?.fixture ?? "No projection"}>{week ? week.projectedPoints.toFixed(1) : "—"}</td>; })}
                  <td className="text-center font-bold" style={{ color: "var(--accent)" }}>{horizonPoints(player, horizon).toFixed(1)}</td><td className="text-center">{player.valueScore.toFixed(2)}</td><td className="text-center">{player.eliteOwnership === null ? "—" : `${player.eliteOwnership.toFixed(1)}%`}</td><td className="text-center">{player.ownership.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visiblePlayers.length && !loading ? <p className="p-8 text-center text-sm" style={{ color: "var(--text-3)" }}>No players match these filters.</p> : null}
        </div>

        <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-3)" }}><span>{players.length} players · page {page + 1} of {pageCount}</span><div className="flex gap-2"><button className="secondary-action" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button><button className="secondary-action" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</button></div></div>
      </section>

      <p className="data-disclaimer">FPLReview points and expected minutes are private dated model inputs. Live FPL prices, clubs, fixtures and flags remain authoritative; re-import the CSV after meaningful projection changes.</p>
    </div>
  );
}
