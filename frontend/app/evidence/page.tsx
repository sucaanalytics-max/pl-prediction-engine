"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CircleAlert,
  Clock3,
  RefreshCw,
  Search,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { useFplLive } from "@/lib/FplLiveContext";
import type { FplEvidenceItem } from "@/lib/fpl-live";

type ScopeFilter = "squad" | "target" | "all";

function evidenceAge(value: string | null, referenceTime: string) {
  if (!value) return "Timestamp unavailable";
  const hours = Math.max(
    0,
    Math.floor(
      (new Date(referenceTime).getTime() - new Date(value).getTime()) / 3_600_000
    )
  );
  if (hours < 1) return "Updated within 1h";
  if (hours < 48) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function EvidenceCard({
  item,
  referenceTime,
}: {
  item: FplEvidenceItem;
  referenceTime: string;
}) {
  return (
    <article className={`evidence-card severity-${item.severity}`}>
      <div className="evidence-severity">
        {item.severity === "critical" ? <CircleAlert size={18} /> : <AlertTriangle size={18} />}
      </div>
      <div className="evidence-copy">
        <div className="evidence-meta">
          <span>{item.scope === "squad" ? "Your squad" : item.scope === "target" ? "Top target" : "League watch"}</span>
          <i>·</i>
          <span>{item.team} · {item.position} · £{item.price.toFixed(1)}m</span>
          <i>·</i>
          <span><Clock3 size={11} /> {evidenceAge(item.sourceUpdatedAt, referenceTime)}</span>
        </div>
        <h2>{item.player}</h2>
        <p>{item.headline}</p>
        <div className="availability-bar">
          <i style={{ width: `${item.chanceOfPlaying ?? (item.status === "a" ? 100 : 20)}%` }} />
        </div>
        <small>
          {item.chanceOfPlaying !== null
            ? `${item.chanceOfPlaying}% FPL chance of playing`
            : "No numerical chance supplied by FPL"}
        </small>
      </div>
      <div className="evidence-sources">
        {item.sources.map((source) => (
          <a href={source.url} target="_blank" rel="noreferrer" key={source.label}>
            <span>{source.role}</span>
            {source.label}
            <ArrowUpRight size={12} />
          </a>
        ))}
      </div>
    </article>
  );
}

export default function EvidencePage() {
  const { state, loading, refresh } = useFplLive();
  const [scope, setScope] = useState<ScopeFilter>("squad");
  const [query, setQuery] = useState("");
  const [criticalOnly, setCriticalOnly] = useState(false);
  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (state?.evidence?.items ?? []).filter((item) => {
      const scopeMatches =
        scope === "all" ||
        item.scope === scope ||
        (scope === "target" && item.scope === "squad");
      const queryMatches =
        !normalized ||
        item.player.toLowerCase().includes(normalized) ||
        item.team.toLowerCase().includes(normalized);
      return scopeMatches && queryMatches && (!criticalOnly || item.severity === "critical");
    });
  }, [criticalOnly, query, scope, state]);

  return (
    <div className="portal-page space-y-6 animate-slide-up">
      <header className="portal-header">
        <div>
          <div className="eyebrow"><Stethoscope size={13} /> Automated availability monitor</div>
          <h1>Injury & news evidence</h1>
          <p>
            Official FPL flags update automatically; independent sources remain one
            click away for deadline-day verification.
          </p>
        </div>
        <button className="primary-action" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          Refresh evidence
        </button>
      </header>

      <section className="evidence-source-rail">
        <div><span className="live-dot" /><strong>Official FPL</strong><small>Automated every {state?.evidence?.officialRefreshMinutes ?? 15} min</small></div>
        <div><span className="manual-dot" /><strong>Premier Injuries</strong><small>Independent cross-check</small></div>
        <div><span className="manual-dot" /><strong>FFScout</strong><small>Press conference context</small></div>
        <div><span className="manual-dot" /><strong>AllAboutFPL</strong><small>FPL editorial context</small></div>
      </section>

      <section className="intelligence-toolbar">
        <div className="filter-row">
          {([
            ["squad", "My squad"],
            ["target", "Squad + targets"],
            ["all", "All flagged"],
          ] as const).map(([value, label]) => (
            <button key={value} className={scope === value ? "active" : ""} onClick={() => setScope(value)}>
              {label}
            </button>
          ))}
          <button className={criticalOnly ? "active" : ""} onClick={() => setCriticalOnly((current) => !current)}>
            Ruled out only
          </button>
        </div>
        <label className="research-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or club" />
        </label>
      </section>

      <section className="evidence-list">
        {items.map((item) => (
          <EvidenceCard
            item={item}
            referenceTime={state?.evidence?.generatedAt ?? item.observedAt}
            key={item.elementId}
          />
        ))}
      </section>

      {!items.length ? (
        <section className="decision-card evidence-clear">
          <ShieldCheck size={30} />
          <strong>{loading ? "Checking official availability…" : "No active flags in this view"}</strong>
          <p>A clear list means no current FPL flag, not guaranteed selection.</p>
        </section>
      ) : null}

      <section className="decision-card evidence-policy">
        <ShieldCheck size={18} />
        <div>
          <span className="kicker">Evidence policy</span>
          <h2>Primary signal, independent confirmation</h2>
          <p>
            The portal automates official FPL status and timestamps. It does not scrape,
            republish or silently merge third-party injury claims. Cross-check links preserve
            provenance and prevent an old article from overriding a newer club update.
          </p>
        </div>
      </section>

      <p className="data-disclaimer">
        Availability percentages and return dates are estimates. Club medical teams and
        press conferences remain the final decision inputs.
      </p>
    </div>
  );
}
