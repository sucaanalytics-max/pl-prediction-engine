"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarRange,
  Crown,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";

export default function CaptaincyPage() {
  const { state, loading } = useFplLive();
  const weeks = state?.recommendations?.captaincyPlan ?? [];
  const [selectedGameweek, setSelectedGameweek] = useState<number | null>(null);
  const selected = weeks.find(
    (week) => week.gameweek === (selectedGameweek ?? weeks[0]?.gameweek)
  );
  const shortlist = useMemo(() => {
    if (!selected) return [];
    return (state?.recommendations?.captaincyPool ?? [])
      .map((player) => {
        const projection = player.gameweekProjections.find(
          (item) => item.gameweek === selected.gameweek
        );
        return { player, projection };
      })
      .filter((item) => item.projection)
      .sort(
        (left, right) =>
          (right.projection?.projectedPoints ?? 0) -
          (left.projection?.projectedPoints ?? 0)
      )
      .slice(0, 5);
  }, [selected, state]);
  const flaggedCaptain = selected
    ? state?.evidence?.items.find(
        (item) => item.elementId === selected.captain.elementId
      )
    : null;

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Crown size={13} /> Six-week armband rotation</div>
          <h1>Captaincy planner</h1>
          <p>
            Map captain and vice-captain coverage across your planning horizon,
            with availability warnings and fixture-specific projections.
          </p>
        </div>
        <div className="ranking-trust">
          <ShieldCheck size={18} />
          <div><strong>Vice-captain hedge</strong><span>Different club where possible</span></div>
        </div>
      </header>

      <section className="captaincy-timeline">
        {weeks.map((week) => {
          const active = selected?.gameweek === week.gameweek;
          return (
            <button
              key={week.gameweek}
              className={active ? "active" : ""}
              onClick={() => setSelectedGameweek(week.gameweek)}
            >
              <span>GW{week.gameweek}</span>
              <strong>{week.captain.name}</strong>
              <small>{week.captainFixture}</small>
              <div><Crown size={12} /> {week.projectedCaptainPoints.toFixed(1)} captain pts</div>
            </button>
          );
        })}
      </section>

      {selected ? (
        <div className="grid xl:grid-cols-[1.15fr_.85fr] gap-6">
          <section className="captaincy-focus">
            <div>
              <span className="kicker"><Sparkles size={12} /> GW{selected.gameweek} recommendation</span>
              <h2>{selected.captain.name}</h2>
              <p>{selected.captain.team} · {selected.captainFixture} · £{selected.captain.price.toFixed(1)}m</p>
              <div className="captaincy-focus-metrics">
                <span><strong>{selected.projectedCaptainPoints.toFixed(1)}</strong> doubled points</span>
                <span><strong>{selected.confidence}%</strong> confidence</span>
                <span><strong>{selected.captain.ownership.toFixed(1)}%</strong> ownership</span>
              </div>
            </div>
            <div className="vice-captain">
              <span>Vice-captain</span>
              <strong>{selected.viceCaptain.name}</strong>
              <small>{selected.viceCaptain.team} · {selected.viceFixture}</small>
            </div>
          </section>

          <section className="decision-card">
            <div className="section-title-row">
              <div><span className="kicker">Same-week alternatives</span><h2>Captain shortlist</h2></div>
              <TrendingUp size={18} />
            </div>
            <div className="captain-shortlist">
              {shortlist.map((item, index) => (
                <div key={item.player.elementId}>
                  <span>{index + 1}</span>
                  <div><strong>{item.player.name}</strong><small>{item.player.team} · {item.projection?.fixture}</small></div>
                  <b>{((item.projection?.projectedPoints ?? 0) * 2).toFixed(1)}</b>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section className="decision-card empty-recommendations">
          <CalendarRange size={27} />
          <strong>{loading ? "Building captain rotation…" : "No captain plan available"}</strong>
        </section>
      )}

      {flaggedCaptain ? (
        <section className={`captain-warning severity-${flaggedCaptain.severity}`}>
          <AlertTriangle size={18} />
          <div>
            <strong>{flaggedCaptain.player} has an active availability flag</strong>
            <span>{flaggedCaptain.headline}</span>
          </div>
          <a href="/evidence">Review evidence</a>
        </section>
      ) : null}

      <section className="decision-card">
        <div className="section-title-row">
          <div><span className="kicker">Rotation logic</span><h2>What the planner protects against</h2></div>
        </div>
        <div className="captaincy-rules">
          <div><span>01</span><p>Fixture-specific projections instead of a single six-week average.</p></div>
          <div><span>02</span><p>Vice-captain selected from another club when possible to reduce postponement and rotation correlation.</p></div>
          <div><span>03</span><p>Availability evidence remains visible; the model never silently treats a flagged premium as fully safe.</p></div>
        </div>
      </section>

      <p className="data-disclaimer">
        Captain EV uses the private FPLReview snapshot with newer official injury
        flags overlaid. Confirm starts and team news close to the deadline.
      </p>
    </div>
  );
}
