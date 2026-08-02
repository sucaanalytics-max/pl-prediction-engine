"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpenCheck,
  Check,
  CircleDashed,
  Clock3,
  Newspaper,
  Radio,
  Search,
  ShieldAlert,
} from "lucide-react";
import { intelligenceItems, weeklyChecklist } from "@/lib/fpl-portal";

const filters = ["All", "Analysis", "Team news", "Model", "Injury", "Odds"];

export default function IntelligencePage() {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem("fpl-weekly-checklist");
    if (stored) setChecked(JSON.parse(stored));
  }, []);

  const filtered = useMemo(
    () => intelligenceItems.filter((item) => {
      const matchesFilter = filter === "All" || item.type === filter;
      const haystack =
        `${item.title} ${item.source} ${item.type} ${item.impact} ${item.summary} ${item.players.join(" ")}`.toLowerCase();
      return matchesFilter && haystack.includes(query.toLowerCase());
    }),
    [filter, query]
  );

  function toggleCheck(id: string) {
    const next = checked.includes(id) ? checked.filter((item) => item !== id) : [...checked, id];
    setChecked(next);
    localStorage.setItem("fpl-weekly-checklist", JSON.stringify(next));
  }

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Radio size={13} /> Evidence inbox</div>
          <h1>Intelligence</h1>
          <p>One queue for articles, team news, injuries, projections and market signals.</p>
        </div>
        <div className="source-health"><span /><strong>4 sources ready</strong><small>Market feed pending</small></div>
      </header>

      <div className="grid xl:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-4">
          <section className="intelligence-toolbar">
            <div className="filter-row">
              {filters.map((item) => (
                <button key={item} onClick={() => setFilter(item)} className={filter === item ? "active" : ""}>
                  {item}
                </button>
              ))}
            </div>
            <label className="research-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search source, player or topic" />
            </label>
          </section>

          <div className="intelligence-list">
            {filtered.length === 0 && (
              <div className="intelligence-empty">
                <Search size={19} />
                <strong>No intelligence matches</strong>
                <p>Try another player, source or topic, or reset the active filter.</p>
                <button onClick={() => { setFilter("All"); setQuery(""); }}>Reset search</button>
              </div>
            )}
            {filtered.map((item) => {
              const external = item.url.startsWith("http");
              return (
                <article className="intelligence-card" key={item.id}>
                  <div className={`source-icon source-${item.type.toLowerCase().replace(" ", "-")}`}>
                    {item.type === "Injury" ? <ShieldAlert size={19} /> : item.type === "Model" ? <CircleDashed size={19} /> : <Newspaper size={19} />}
                  </div>
                  <div className="intelligence-copy">
                    <div className="intelligence-meta">
                      <span>{item.source}</span><i>•</i><span>{item.type}</span><i>•</i><span><Clock3 size={11} />{item.age}</span>
                    </div>
                    <h2>{item.title}</h2>
                    <p>{item.summary}</p>
                    <div className="intelligence-tags">
                      <span className="impact-tag">{item.impact} impact</span>
                      <span>{item.confidence}</span>
                      {item.players.map((player) => <span key={player}>{player}</span>)}
                    </div>
                  </div>
                  {external ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="open-source" aria-label={`Open ${item.source}`}>
                      <ArrowUpRight size={17} />
                    </a>
                  ) : (
                    <Link href={item.url} className="open-source" aria-label={`Open ${item.source}`}><ArrowUpRight size={17} /></Link>
                  )}
                </article>
              );
            })}
          </div>
        </div>

        <aside className="space-y-4">
          <section className="decision-card">
            <div className="section-title-row">
              <div><span className="kicker">GW1 routine</span><h2>Deadline checklist</h2></div>
              <span className="check-count">{checked.length}/{weeklyChecklist.length}</span>
            </div>
            <div className="checklist-progress"><i style={{ width: `${(checked.length / weeklyChecklist.length) * 100}%` }} /></div>
            <div className="weekly-checklist">
              {weeklyChecklist.map((item) => {
                const isChecked = checked.includes(item.id);
                return (
                  <button key={item.id} onClick={() => toggleCheck(item.id)} className={isChecked ? "checked" : ""}>
                    <span className="check-box">{isChecked && <Check size={12} />}</span>
                    <span><strong>{item.label}</strong><small>{item.source}</small></span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="decision-card evidence-rule">
            <BookOpenCheck size={21} />
            <div>
              <span className="kicker">Decision rule</span>
              <h2>Require two signals</h2>
              <p>A transfer is “ready” when projection value and at least one independent contextual source agree.</p>
            </div>
          </section>

          <section className="decision-card">
            <span className="kicker">Source posture</span>
            <div className="source-status-list">
              <div><span className="live-dot" />Official FPL API <strong>Live</strong></div>
              <div><span className="manual-dot" />Editorial research <strong>Review</strong></div>
              <div><span className="manual-dot" />Injury verification <strong>Review</strong></div>
              <div><span className="pending-dot" />Odds & projections <strong>Pending</strong></div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
