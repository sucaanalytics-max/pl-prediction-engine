"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";
import type { FplTransferRecommendation } from "@/lib/fpl-live";
import type { Position } from "@/lib/fpl-portal";
import { usePlayerWatchlist } from "@/lib/use-player-watchlist";

const POSITIONS: Array<"ALL" | Position> = ["ALL", "GKP", "DEF", "MID", "FWD"];

function MoveCard({
  move,
  horizon,
  watched,
  toggleWatch,
}: {
  move: FplTransferRecommendation;
  horizon: 4 | 6;
  watched: number[];
  toggleWatch: (elementId: number) => void;
}) {
  const uplift = horizon === 4 ? move.delta4 : move.delta6;
  const isWatched = watched.includes(move.playerIn.elementId);

  return (
    <article className="transfer-recommendation">
      <div className="transfer-rank">#{move.rank}</div>
      <div className="move-player move-out">
        <span><ArrowDownLeft size={13} /> Sell</span>
        <strong>{move.playerOut.name}</strong>
        <small>{move.playerOut.team} · {move.playerOut.position} · £{move.playerOut.price.toFixed(1)}m</small>
      </div>
      <div className="move-arrow">
        <ArrowRight size={18} />
        <strong>+{uplift.toFixed(1)}</strong>
        <small>{horizon} GW pts</small>
      </div>
      <div className="move-player move-in">
        <span><ArrowUpRight size={13} /> Buy</span>
        <strong>{move.playerIn.name}</strong>
        <small>{move.playerIn.team} · {move.playerIn.position} · £{move.playerIn.price.toFixed(1)}m</small>
      </div>
      <div className="move-meta">
        <span>{move.confidence}% confidence</span>
        <strong>£{move.bankAfter.toFixed(1)}m ITB</strong>
      </div>
      <button
        className={isWatched ? "watch-button active" : "watch-button"}
        onClick={() => toggleWatch(move.playerIn.elementId)}
        aria-label={`${isWatched ? "Remove" : "Add"} ${move.playerIn.name} ${isWatched ? "from" : "to"} watchlist`}
      >
        {isWatched ? <CheckCircle2 size={16} /> : <Bookmark size={16} />}
      </button>
      <div className="move-reasons">
        {move.rationale.slice(0, 2).map((reason) => <span key={reason}>{reason}</span>)}
      </div>
    </article>
  );
}

export default function TransfersPage() {
  const { state, loading, error, refresh } = useFplLive();
  const [horizon, setHorizon] = useState<4 | 6>(6);
  const [position, setPosition] = useState<"ALL" | Position>("ALL");
  const { watched, toggle } = usePlayerWatchlist();
  const moves = useMemo(() => {
    const source =
      horizon === 4
        ? state?.recommendations?.transfers4 ?? []
        : state?.recommendations?.transfers6 ?? [];
    return source.filter(
      (move) => position === "ALL" || move.playerIn.position === position
    );
  }, [horizon, position, state]);
  const topMove = moves[0];

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header transfer-page-header">
        <div>
          <div className="eyebrow"><Route size={13} /> Squad-aware decision engine</div>
          <h1>Transfer recommendations</h1>
          <p>
            Legal, affordable upgrades ranked against your current team over the next
            four or six gameweeks.
          </p>
        </div>
        <div className="segmented" aria-label="Projection horizon">
          {[4, 6].map((value) => (
            <button
              key={value}
              className={horizon === value ? "active" : ""}
              onClick={() => setHorizon(value as 4 | 6)}
            >
              {value} GW
            </button>
          ))}
        </div>
      </header>

      <section className="model-caveat">
        <Sparkles size={16} />
        <div>
          <strong>Preseason planning model</strong>
          <span>
            Official prices, ownership, availability and fixtures are live. Point
            projections are provisional until 2026/27 minutes and form stabilise.
          </span>
        </div>
        <button onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Sync
        </button>
      </section>

      {error ? (
        <section className="decision-card warning-card">
          <CircleAlert size={18} />
          <p>{error}. Recommendations will return after the official feed reconnects.</p>
        </section>
      ) : null}

      {topMove ? (
        <section className="top-move">
          <div>
            <span className="kicker">Best available move · {horizon} gameweeks</span>
            <div className="top-move-names">
              <span>{topMove.playerOut.name}</span>
              <ArrowRight size={22} />
              <strong>{topMove.playerIn.name}</strong>
            </div>
            <p>{topMove.rationale.join(" ")}</p>
            <div className="top-move-tags">
              {topMove.flags.map((flag) => <span key={flag}>{flag}</span>)}
              <span>{topMove.playerIn.fixtures[0]?.label ?? "TBC"} next</span>
            </div>
          </div>
          <div className="top-move-score">
            <span>Projected uplift</span>
            <strong>+{(horizon === 4 ? topMove.delta4 : topMove.delta6).toFixed(1)}</strong>
            <small>points · {topMove.confidence}% confidence</small>
          </div>
        </section>
      ) : (
        <section className="decision-card empty-recommendations">
          <ShieldCheck size={28} />
          <strong>{loading ? "Building recommendations…" : "No clear upgrade found"}</strong>
          <p>
            {loading
              ? "Syncing your squad with official prices and fixtures."
              : "Your current filters contain no affordable positive-upside move."}
          </p>
        </section>
      )}

      <section className="metric-rail" aria-label="Recommendation summary">
        <div><span><Route size={15} /> Legal upgrades</span><strong>{moves.length}</strong><small>positive model uplift</small></div>
        <div><span><WalletCards size={15} /> Current bank</span><strong>£{(state?.squad.bank ?? 0).toFixed(1)}m</strong><small>live affordability applied</small></div>
        <div><span><ShieldCheck size={15} /> Club limit</span><strong>3 max</strong><small>validated after every move</small></div>
        <div><span><Bookmark size={15} /> Watchlist</span><strong>{watched.length}</strong><small>saved on this device</small></div>
      </section>

      <section className="decision-card">
        <div className="section-title-row recommendation-toolbar">
          <div><span className="kicker">Ranked shortlist</span><h2>Top transfer moves</h2></div>
          <div className="filter-row">
            {POSITIONS.map((value) => (
              <button
                key={value}
                className={position === value ? "active" : ""}
                onClick={() => setPosition(value)}
              >
                {value === "ALL" ? "All positions" : value}
              </button>
            ))}
          </div>
        </div>
        <div className="transfer-recommendation-list">
          {moves.map((move) => (
            <MoveCard
              key={`${move.playerOut.elementId}-${move.playerIn.elementId}`}
              move={move}
              horizon={horizon}
              watched={watched}
              toggleWatch={toggle}
            />
          ))}
        </div>
      </section>

      <section className="decision-card methodology-card">
        <div>
          <span className="kicker">Why these moves</span>
          <h2>Recommendation guardrails</h2>
        </div>
        <div className="methodology-grid">
          {(state?.recommendations?.methodology ?? [
            "Live official FPL player data.",
            "Four- and six-gameweek fixture horizon.",
            "Squad legality and affordability checks.",
          ]).map((item, index) => (
            <div key={item}><span>0{index + 1}</span><p>{item}</p></div>
          ))}
        </div>
        <Link href="/rankings" className="text-link">Compare the full Top 10 lists <ArrowRight size={14} /></Link>
      </section>

      <p className="data-disclaimer">
        Decision support, not certainty. Confirm late injuries, expected minutes and
        press-conference news before making a transfer in FPL.
      </p>
    </div>
  );
}
