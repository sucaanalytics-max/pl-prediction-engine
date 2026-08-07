"use client";

import { useMemo, useState } from "react";
import {
  Bookmark,
  CheckCircle2,
  Crown,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
} from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";
import type { FplRankedPlayer, FplTopTenRankings } from "@/lib/fpl-live";
import { usePlayerWatchlist } from "@/lib/use-player-watchlist";

type RankingKey = keyof FplTopTenRankings;

const CATEGORIES: Array<{ key: RankingKey; label: string }> = [
  { key: "overall", label: "Overall" },
  { key: "captaincy", label: "Captaincy" },
  { key: "value", label: "Value" },
  { key: "differentials", label: "Differentials" },
  { key: "goalkeepers", label: "GKP" },
  { key: "defenders", label: "DEF" },
  { key: "midfielders", label: "MID" },
  { key: "forwards", label: "FWD" },
];

function scoreFor(player: FplRankedPlayer, category: RankingKey) {
  if (category === "captaincy") return player.captainScore;
  if (category === "value") return player.valueScore;
  if (category === "differentials") return player.differentialScore;
  return player.projected6;
}

function scoreLabel(category: RankingKey) {
  if (category === "captaincy") return "Captain score";
  if (category === "value") return "Pts / £m";
  if (category === "differentials") return "Diff score";
  return "6 GW EV";
}

export default function RankingsPage() {
  const { state, loading } = useFplLive();
  const [category, setCategory] = useState<RankingKey>("overall");
  const [query, setQuery] = useState("");
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const { watched, toggle } = usePlayerWatchlist();
  const players = useMemo(() => {
    const categoryPlayers = state?.rankings?.[category] ?? [];
    const normalized = query.trim().toLowerCase();
    return categoryPlayers.filter((player) => {
      const matchesQuery =
        !normalized ||
        player.name.toLowerCase().includes(normalized) ||
        player.team.toLowerCase().includes(normalized);
      return matchesQuery && (!watchlistOnly || watched.includes(player.elementId));
    });
  }, [category, query, state, watched, watchlistOnly]);

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Crown size={13} /> Live player shortlists</div>
          <h1>Top 10 rankings</h1>
          <p>
            One consistent four-to-six-week model for targets, captains, value picks
            and low-owned differentials.
          </p>
        </div>
        <div className="ranking-trust">
          <ShieldCheck size={18} />
          <div><strong>FPLReview EV</strong><span>Official live prices & flags</span></div>
        </div>
      </header>

      <section className="ranking-category-tabs" aria-label="Ranking categories">
        {CATEGORIES.map((item) => (
          <button
            key={item.key}
            className={category === item.key ? "active" : ""}
            onClick={() => setCategory(item.key)}
          >
            {item.label}
          </button>
        ))}
      </section>

      <section className="decision-card rankings-shell">
        <div className="rankings-toolbar">
          <div>
            <span className="kicker">{CATEGORIES.find((item) => item.key === category)?.label}</span>
            <h2>{category === "captaincy" ? "Captain candidates" : "Player rankings"}</h2>
          </div>
          <label className="ranking-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search player or club"
              aria-label="Search player or club"
            />
          </label>
          <button
            className={watchlistOnly ? "watchlist-filter active" : "watchlist-filter"}
            onClick={() => setWatchlistOnly((current) => !current)}
          >
            <Star size={14} /> Watchlist {watched.length > 0 ? `(${watched.length})` : ""}
          </button>
        </div>

        <div className="ranking-list">
          {players.map((player, index) => {
            const isWatched = watched.includes(player.elementId);
            return (
              <article className="ranking-row" key={player.elementId}>
                <span className={index < 3 ? "ranking-number podium" : "ranking-number"}>
                  {index + 1}
                </span>
                <span className={`position-badge position-${player.position.toLowerCase()}`}>
                  {player.position}
                </span>
                <div className="ranking-player">
                  <strong>{player.name}</strong>
                  <span>{player.team} · £{player.price.toFixed(1)}m</span>
                </div>
                <div className="ranking-fixtures">
                  {player.fixtures.slice(0, 4).map((fixture) => (
                    <span className={`fdr-cell-${fixture.difficulty}`} key={`${fixture.gameweek}-${fixture.label}`}>
                      {fixture.label}
                    </span>
                  ))}
                </div>
                <div className="ranking-stat">
                  <span>4 GW</span><strong>{player.projected4.toFixed(1)}</strong>
                </div>
                <div className="ranking-stat primary">
                  <span>{scoreLabel(category)}</span><strong>{scoreFor(player, category).toFixed(1)}</strong>
                </div>
                <div className="ranking-stat">
                  <span>Owned</span><strong>{player.ownership.toFixed(1)}%</strong>
                </div>
                <div className="ranking-stat">
                  <span>xMins</span><strong>{player.expectedMinutes}&apos;</strong>
                </div>
                <button
                  className={isWatched ? "watch-button active" : "watch-button"}
                  onClick={() => toggle(player.elementId)}
                  aria-label={`${isWatched ? "Remove" : "Add"} ${player.name} ${isWatched ? "from" : "to"} watchlist`}
                >
                  {isWatched ? <CheckCircle2 size={16} /> : <Bookmark size={16} />}
                </button>
              </article>
            );
          })}
        </div>

        {!players.length ? (
          <div className="empty-rankings">
            <Sparkles size={24} />
            <strong>{loading ? "Building the Top 10…" : "No players match this view"}</strong>
            <span>{watchlistOnly ? "Save players first or turn off the watchlist filter." : "Try a different search."}</span>
          </div>
        ) : null}
      </section>

      <section className="ranking-explainers">
        <div><TrendingUp size={16} /><strong>Overall</strong><span>Six-week points outlook with fixture and availability adjustments.</span></div>
        <div><Crown size={16} /><strong>Captaincy</strong><span>Four-week projection plus premium ceiling and favourable-fixture weighting.</span></div>
        <div><Star size={16} /><strong>Differentials</strong><span>Upside among players at 10% ownership or lower.</span></div>
      </section>

      <p className="data-disclaimer">
        Rankings use the private 4 Aug FPLReview snapshot. Official FPL prices,
        ownership, fixtures and availability refresh independently.
      </p>
    </div>
  );
}
