"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bookmark,
  Check,
  CircleAlert,
  Gauge,
  Route,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { captainPlan, transferScenarios } from "@/lib/fpl-portal";

export default function PlannerPage() {
  const [selectedId, setSelectedId] = useState("captain-core");
  const [horizon, setHorizon] = useState<4 | 6>(6);
  const [risk, setRisk] = useState(42);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote(localStorage.getItem("fpl-decision-note") ?? "");
    setSaved(localStorage.getItem("fpl-saved-scenario") === selectedId);
  }, [selectedId]);

  const scenario = useMemo(
    () => transferScenarios.find((item) => item.id === selectedId) ?? transferScenarios[0],
    [selectedId]
  );

  const adjustedProjection =
    (horizon === 4 ? scenario.projected4 : scenario.projected6) +
    Math.round((risk - 50) * 0.07 * 10) / 10;

  function saveDraft() {
    localStorage.setItem("fpl-saved-scenario", scenario.id);
    localStorage.setItem("fpl-decision-note", note);
    setSaved(true);
  }

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Route size={13} /> Multi-gameweek planning</div>
          <h1>Transfer Lab</h1>
          <p>Compare coherent squad paths—not isolated player swaps—before the deadline.</p>
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

      <section className="scenario-tabs" aria-label="Transfer scenarios">
        {transferScenarios.map((item) => (
          <button
            key={item.id}
            onClick={() => setSelectedId(item.id)}
            className={selectedId === item.id ? "scenario-tab active" : "scenario-tab"}
          >
            <span>{item.label}</span>
            <strong>{item.name}</strong>
            <small>{horizon === 4 ? item.projected4 : item.projected6} projected pts</small>
          </button>
        ))}
      </section>

      <div className="grid xl:grid-cols-[1.35fr_.65fr] gap-6">
        <section className="decision-card p-0 overflow-hidden">
          <div className="planner-summary">
            <div>
              <span className="status-pill recommended"><Sparkles size={12} /> {scenario.label}</span>
              <h2>{scenario.name}</h2>
              <p>{scenario.summary}</p>
            </div>
            <div className="projection-lockup">
              <span>{horizon}-GW projection</span>
              <strong>{adjustedProjection.toFixed(1)}</strong>
              <small>{scenario.floor} floor · {scenario.ceiling} ceiling</small>
            </div>
          </div>

          <div className="transfer-columns">
            <div>
              <div className="transfer-heading out"><ArrowDownLeft size={15} /> Players out</div>
              <div className="transfer-list">
                {scenario.out.map((player) => <span key={player}>{player}</span>)}
              </div>
            </div>
            <div>
              <div className="transfer-heading in"><ArrowUpRight size={15} /> Players in</div>
              <div className="transfer-list">
                {scenario.in.map((player) => <span key={player}>{player}</span>)}
              </div>
            </div>
          </div>

          <div className="planner-controls">
            <div>
              <label htmlFor="risk">Risk appetite <strong>{risk}/100</strong></label>
              <input id="risk" type="range" min="0" max="100" value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
              <div className="range-labels"><span>Protect rank</span><span>Chase upside</span></div>
            </div>
            <div className="model-assumption">
              <Gauge size={18} />
              <div><strong>Projection blend</strong><span>65% model · 25% market · 10% editorial</span></div>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="decision-card">
            <div className="section-title-row">
              <div><span className="kicker">Non-negotiables</span><h2>Squad core</h2></div>
              <ShieldCheck size={20} />
            </div>
            <div className="core-list">
              {scenario.core.map((player) => (
                <div key={player}><span className="check-dot"><Check size={11} /></span>{player}</div>
              ))}
            </div>
          </section>

          <section className="decision-card warning-card">
            <div className="section-title-row">
              <div><span className="kicker">Before locking</span><h2>Assumptions</h2></div>
              <CircleAlert size={20} />
            </div>
            <ul className="watchout-list">
              {scenario.watchouts.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>

          <section className="decision-card">
            <label className="journal-label" htmlFor="decision-note">Decision note</label>
            <textarea
              id="decision-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What would change your mind? Record the evidence, not just the move."
              rows={4}
            />
            <button className="primary-action w-full justify-center" onClick={saveDraft}>
              {saved ? <Check size={16} /> : <Bookmark size={16} />}
              {saved ? "Draft saved on this device" : "Save scenario"}
            </button>
          </section>
        </aside>
      </div>

      <section className="decision-card">
        <div className="section-title-row mb-5">
          <div><span className="kicker">Rotation map</span><h2>Captaincy over the horizon</h2></div>
          <span className="muted-meta">No chip planned</span>
        </div>
        <div className="captain-strip">
          {captainPlan.slice(0, horizon).map((week) => (
            <div className="captain-week" key={week.gw}>
              <span>GW{week.gw}</span>
              <strong>{week.captain}</strong>
              <small>{week.fixture}</small>
              <div className="confidence-bar"><i style={{ width: `${week.confidence}%` }} /></div>
              <em>{week.confidence}% confidence</em>
            </div>
          ))}
        </div>
      </section>

      <p className="data-disclaimer">
        Scenario values are decision-support estimates and remain provisional until preseason roles,
        injuries and the prediction pipeline are refreshed.
      </p>
    </div>
  );
}
