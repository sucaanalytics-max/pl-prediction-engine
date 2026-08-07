"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Lightbulb,
  MoveRight,
  Newspaper,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import { FplPlayerChip } from "@/components/FplPlayerChip";
import { useFplLive } from "@/lib/FplLiveContext";
import { asSquadPlayers, FPL_ENTRY_ID } from "@/lib/fpl-live";
import {
  currentSquad,
  fixtureRuns,
  intelligenceItems,
  radarPlayers,
  transferScenarios,
} from "@/lib/fpl-portal";

const scenario = transferScenarios[0];

const fixtureTone: Record<number, string> = {
  1: "fdr-cell-1",
  2: "fdr-cell-2",
  3: "fdr-cell-3",
  4: "fdr-cell-4",
  5: "fdr-cell-5",
};

function PositionBadge({ position }: { position: string }) {
  return <span className={`position-badge position-${position.toLowerCase()}`}>{position}</span>;
}

function deadlineParts(deadlineTime?: string) {
  if (!deadlineTime) return { date: "Fri 21 Aug", time: "23:00 IST" };
  const date = new Date(deadlineTime);
  return {
    date: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(date),
    time: `${new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date)} IST`,
  };
}

export default function DecisionHubPage() {
  const { state: liveState, loading: liveLoading, error: liveError, refresh } =
    useFplLive();
  const squad = liveState ? asSquadPlayers(liveState.squad.players) : currentSquad;
  const starters = squad.filter((player) => !player.bench);
  const bench = squad.filter((player) => player.bench);
  const lines = [
    starters.filter((player) => player.position === "GKP"),
    starters.filter((player) => player.position === "DEF"),
    starters.filter((player) => player.position === "MID"),
    starters.filter((player) => player.position === "FWD"),
  ];
  const defenceSpend = squad
    .filter((player) => player.position === "DEF")
    .reduce((total, player) => total + player.price, 0);
  const deadline = deadlineParts(liveState?.event.deadlineTime);
  const sourceLabel = liveState?.squad.isOfficial
    ? "Official public squad"
    : "Captured draft · live prices";
  const pulseScore = liveState ? (liveState.squad.isOfficial ? 88 : 76) : 68;

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="decision-hero">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={13} /> Personal decision room · Team {liveState?.entry.id ?? FPL_ENTRY_ID}</div>
          <h1>Build the right GW{liveState?.event.id ?? 1} team.<br /><span>Know why it is right.</span></h1>
          <p>
            Your squad, projections, fixtures, injuries and trusted weekly research—
            reduced to the decisions that can actually change your rank.
          </p>
          <div className="hero-actions">
            <Link href="/transfers" className="primary-action">See transfer recommendations <ArrowRight size={16} /></Link>
            <Link href="/intelligence" className="secondary-action">Review intelligence <Newspaper size={16} /></Link>
          </div>
        </div>
        <div className="deadline-panel">
          <div className="deadline-top"><CalendarClock size={17} /><span>GW{liveState?.event.id ?? 1} deadline</span></div>
          <strong>{deadline.date}</strong>
          <span className="deadline-time">{deadline.time}</span>
          <div className="deadline-rule"><i style={{ width: "32%" }} /></div>
          <small>{liveState?.event.phase === "preseason" ? "Preseason · unlimited changes" : "Official gameweek data"}</small>
        </div>
      </header>

      <section className={`live-source-banner ${liveError ? "has-error" : ""}`}>
        <span className={liveState?.squad.isOfficial ? "live-dot" : "manual-dot"} />
        <div>
          <strong>{liveError ? "Official FPL sync unavailable" : sourceLabel}</strong>
          <small>
            {liveError
              ? `${liveError}. Showing the last captured portal squad.`
              : liveState?.notices[0] ??
                "Connecting your team to official 2026/27 prices and fixtures."}
          </small>
        </div>
        <button onClick={() => void refresh()} disabled={liveLoading}>
          <RefreshCw size={13} className={liveLoading ? "animate-spin" : ""} />
          {liveLoading ? "Syncing" : "Sync now"}
        </button>
      </section>

      <section className="metric-rail" aria-label="Team summary">
        <div><span><WalletCards size={15} /> Squad value</span><strong>£{(liveState?.squad.value ?? 100).toFixed(1)}m</strong><small>£{(liveState?.squad.bank ?? 0).toFixed(1)}m in bank</small></div>
        <div><span><Users size={15} /> Structure</span><strong>{defenceSpend.toFixed(1)}m</strong><small>budget in defence · {liveState?.squad.formation ?? "4-4-2"}</small></div>
        <div><span><TrendingUp size={15} /> Best transfer uplift</span><strong>+{(liveState?.recommendations?.transfers4?.[0]?.delta4 ?? 0).toFixed(1)}</strong><small>provisional pts · 4 GW</small></div>
        <div className="metric-alert"><span><CircleAlert size={15} /> Action queue</span><strong>3</strong><small>1 urgent · 2 monitor</small></div>
      </section>

      <div className="grid xl:grid-cols-[1.32fr_.68fr] gap-6">
        <section className="decision-brief">
          <div className="brief-number">01</div>
          <div className="brief-content">
            <div className="eyebrow">Highest-leverage decision</div>
            <h2>
              {liveState?.recommendations?.transfers6?.[0]
                ? `${liveState.recommendations.transfers6[0].playerOut.name} → ${liveState.recommendations.transfers6[0].playerIn.name} leads the six-week shortlist.`
                : "Move from distributed value to a reliable captaincy spine."}
            </h2>
            <p>
              {liveState?.recommendations?.transfers6?.[0]?.rationale.join(" ") ??
                "The current squad spends premium money across defence and mid-price slots, but needs a stronger captaincy spine."}
            </p>
            <div className="brief-moves">
              <div><span>Build around</span><strong>Haaland · Bruno · Gabriel</strong></div>
              <MoveRight size={20} />
              <div><span>Keep value</span><strong>Rogers · Gyökeres</strong></div>
            </div>
            <Link href="/transfers">Open ranked recommendations <ArrowRight size={15} /></Link>
          </div>
          <div className="confidence-dial">
            <div><strong>82</strong><span>%</span></div>
            <small>decision confidence</small>
          </div>
        </section>

        <section className="decision-card action-queue">
          <div className="section-title-row">
            <div><span className="kicker">Triage first</span><h2>Action queue</h2></div>
            <span className="status-pill">GW1</span>
          </div>
          <div className="queue-item urgent">
            <span className="queue-priority">Now</span>
            <div><strong>Start Gyökeres</strong><p>Home to Coventry; currently third on your bench.</p></div>
            <ChevronRight size={16} />
          </div>
          <div className="queue-item">
            <span className="queue-priority">Plan</span>
            <div><strong>Add a premium captain</strong><p>Haaland covers three standout fixtures in six.</p></div>
            <ChevronRight size={16} />
          </div>
          <div className="queue-item">
            <span className="queue-priority">Watch</span>
            <div><strong>Verify Kinsky minutes</strong><p>Goalkeeper value depends on preseason hierarchy.</p></div>
            <ChevronRight size={16} />
          </div>
        </section>
      </div>

      <div className="grid xl:grid-cols-[.9fr_1.1fr] gap-6">
        <section className="squad-section decision-card p-0 overflow-hidden">
          <div className="section-title-row squad-heading">
            <div>
              <span className="kicker">{sourceLabel}</span>
              <h2>Your GW{liveState?.event.id ?? 1} squad</h2>
            </div>
            <a href={`https://fantasy.premierleague.com/en/entry/${liveState?.entry.id ?? FPL_ENTRY_ID}/history`} target="_blank" rel="noreferrer" className="icon-link" aria-label="Open official FPL team">
              <ExternalLink size={16} />
            </a>
          </div>
          <div className="mini-pitch">
            {lines.map((line, index) => (
              <div className={`pitch-line pitch-line-${index}`} key={index}>
                {line.map((player) => <FplPlayerChip player={player} key={player.name} />)}
              </div>
            ))}
          </div>
          <div className="bench-strip">
            <span className="bench-label">Bench</span>
            {bench.map((player) => <FplPlayerChip player={player} key={player.name} />)}
          </div>
          <div className="squad-warning"><CircleAlert size={14} /> Gyökeres has the easiest fixture in your squad but is benched.</div>
        </section>

        <section className="decision-card fixture-horizon">
          <div className="section-title-row">
            <div><span className="kicker">Next six</span><h2>Captaincy & fixture runway</h2></div>
            <Link href="/planner" className="text-link">Plan moves <ArrowRight size={14} /></Link>
          </div>
          <div className="fixture-grid" role="table" aria-label="Six gameweek fixture difficulty">
            <div className="fixture-row fixture-header" role="row">
              <span>Target</span>
              {[1, 2, 3, 4, 5, 6].map((gw) => <span key={gw}>GW{gw}</span>)}
            </div>
            {fixtureRuns.map((row) => (
              <div className="fixture-row" role="row" key={row.team}>
                <span><b>{row.player}</b><small>{row.team}</small></span>
                {row.fixtures.map((fixture, index) => (
                  <span className={fixtureTone[row.scores[index]]} key={fixture}>{fixture}</span>
                ))}
              </div>
            ))}
          </div>
          <div className="fixture-legend">
            <span><i className="fdr-cell-1" /> Target</span>
            <span><i className="fdr-cell-3" /> Neutral</span>
            <span><i className="fdr-cell-5" /> Avoid</span>
          </div>
        </section>
      </div>

      <section className="decision-card">
        <div className="section-title-row mb-5">
          <div><span className="kicker">Shortlist</span><h2>Player radar</h2></div>
          <Link href="/rankings" className="text-link">Open all Top 10 lists <ArrowRight size={14} /></Link>
        </div>
        <div className="radar-table-wrap">
          <table className="radar-table">
            <thead><tr><th>Player</th><th>Next</th><th>Price</th><th>4 GW EV</th><th>6 GW EV</th><th>xMins</th><th>Ownership</th><th>Read</th></tr></thead>
            <tbody>
              {(liveState?.rankings?.overall ?? []).slice(0, 6).map((player) => (
                <tr key={player.elementId}>
                  <td><PositionBadge position={player.position} /><span><strong>{player.name}</strong><small>{player.team}</small></span></td>
                  <td><span className="fixture-pill">{player.fixtures[0]?.label ?? "TBC"}</span></td>
                  <td>£{player.price.toFixed(1)}</td>
                  <td><strong>{player.projected4.toFixed(1)}</strong></td>
                  <td><strong>{player.projected6.toFixed(1)}</strong></td>
                  <td>{player.expectedMinutes}&apos;</td>
                  <td>{player.ownership.toFixed(1)}%</td>
                  <td><span className="trend trend-rising"><TrendingUp size={12} />ranked</span></td>
                </tr>
              ))}
              {!liveState?.rankings?.overall?.length
                ? radarPlayers.map((player) => (
                    <tr key={player.name}>
                      <td><PositionBadge position={player.position} /><span><strong>{player.name}</strong><small>{player.team}</small></span></td>
                      <td><span className="fixture-pill">{player.next}</span></td>
                      <td>£{player.price.toFixed(1)}</td>
                      <td><strong>{player.ev4.toFixed(1)}</strong></td>
                      <td><strong>{player.ev6.toFixed(1)}</strong></td>
                      <td>{player.xMins}&apos;</td>
                      <td>{player.ownership.toFixed(1)}%</td>
                      <td><span className={`trend trend-${player.trend}`}><TrendingUp size={12} />{player.trend}</span></td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        <section className="decision-card">
          <div className="section-title-row mb-4">
            <div><span className="kicker">Research brief</span><h2>What deserves your attention</h2></div>
            <Link href="/intelligence" className="text-link">View all <ArrowRight size={14} /></Link>
          </div>
          <div className="research-brief-list">
            {intelligenceItems.slice(0, 4).map((item) => (
              <a href={item.url} target={item.url.startsWith("http") ? "_blank" : undefined} rel="noreferrer" key={item.id}>
                <span className="research-source">{item.source.slice(0, 2).toUpperCase()}</span>
                <div><strong>{item.title}</strong><p>{item.summary}</p></div>
                <span className="research-age"><Clock3 size={11} />{item.age}</span>
              </a>
            ))}
          </div>
        </section>

        <aside className="decision-card system-pulse">
          <div className="section-title-row">
            <div><span className="kicker">Trust layer</span><h2>Data pulse</h2></div>
            <Activity size={20} />
          </div>
          <div className="pulse-score"><strong>{pulseScore}</strong><span>/100</span></div>
          <p>
            {liveState?.squad.isOfficial
              ? "Official squad, prices and fixtures are aligned."
              : "Live catalogue and fixtures are aligned; your draft remains private until the deadline."}
          </p>
          <div className="pulse-list">
            <div><ShieldCheck size={14} /><span>Official prices & fixtures</span><strong>{liveState ? "Live" : "Connecting"}</strong></div>
            <div><Users size={14} /><span>Squad source</span><strong>{liveState?.freshness.squad === "live" ? "Official" : "Captured"}</strong></div>
            <div><RefreshCw size={14} /><span>Player projections</span><strong>Preview</strong></div>
            <div><Lightbulb size={14} /><span>Editorial context</span><strong>Review</strong></div>
          </div>
          <Link href="/health">Inspect model health <ArrowRight size={14} /></Link>
        </aside>
      </div>

      <section className="recommendation-footer">
        <div>
          <span className="kicker">Current recommendation</span>
          <strong>
            {liveState?.recommendations?.transfers6?.[0]
              ? `${liveState.recommendations.transfers6[0].playerOut.name} → ${liveState.recommendations.transfers6[0].playerIn.name}`
              : scenario.name}
          </strong>
          <p>
            {liveState?.recommendations?.transfers6?.[0]?.rationale[0] ?? scenario.summary}
          </p>
        </div>
        <div className="rec-projection"><span>6-GW uplift</span><strong>+{(liveState?.recommendations?.transfers6?.[0]?.delta6 ?? 0).toFixed(1)}</strong><small>provisional points</small></div>
        <Link href="/transfers" className="primary-action">Review the evidence <ArrowRight size={16} /></Link>
      </section>

      <p className="data-disclaimer">
        Built for decisions, not certainty. Official FPL catalogue data is live; projections remain
        provisional until the 2026/27 model is regenerated and late preseason team news is incorporated.
      </p>
    </div>
  );
}
