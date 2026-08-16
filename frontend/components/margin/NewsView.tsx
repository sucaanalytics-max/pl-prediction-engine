"use client";

/**
 * News — what was written this week, and which of it is about your fifteen.
 *
 * ## The join happens here, not in the pipeline
 *
 * `news_view.json` publishes `touches_squad` per item, and it is `false` on every
 * one of the ninety. Not a matching bug: `run_news._squad_element_ids()` reads the
 * squad from `predictions/fpl/decision_gw*.json`, the agent is deadline-gated and
 * idle, and so that file does not exist. The poller asked a question with no
 * information and published the answer as `false`, which reads as "checked, and it
 * does not touch your squad" when the truth is "your squad was never known here".
 *
 * Both halves of the join exist in the browser, though, and have all along: the
 * feed resolves an `elementId` for 35 of its 90 items, and `useHeuristics` already
 * holds the live fifteen with their ids because the planner needs them. So the
 * match is done here against the squad actually loaded, and the artifact's own
 * `touchesSquad` is deliberately ignored rather than trusted — a field computed
 * from an empty set is not evidence of anything.
 *
 * When the squad cannot be read the section says so, rather than showing an empty
 * "nothing about your team" that looks like good news.
 *
 * ## Sources are shown because one of them is nearly invisible
 *
 * The feed is capped at 90 items across a 5-day window with no per-source quota,
 * and BBC (33) plus Sky (24) crowd out the sources actually chosen for FPL value:
 * allaboutfpl contributes 1 and robtFPL 5. Until the producer balances that, the
 * filter here is the only way to reach them, so it leads rather than hides in a
 * menu — and it reports each source's real count so the imbalance is visible
 * instead of merely suffered.
 */

import { useMemo, useState } from "react";
import { proven } from "@/lib/data/artifact";
import { NEWS_FEED, type NewsFeed, type NewsItem } from "@/lib/data/news-feed";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { INK, MONO, SANS } from "@/lib/margin/tokens";
import { Eyebrow, MarginState, Nil } from "@/components/margin/Marks";

const S = INK;

/** Sources chosen for FPL value, which the volume feeds bury. */
const PREFERRED = new Set(["allaboutfpl", "x:robtFPL", "fantasyfootballscout", "premierfantasytools"]);

function sourceLabel(source: string): string {
  return source.startsWith("x:") ? `@${source.slice(2)}` : source;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function Item({ item, owned }: { item: NewsItem; owned: ReadonlySet<number> }) {
  const hits = item.players.filter((p) => p.elementId > 0 && owned.has(p.elementId));
  return (
    <li
      data-testid="news-item"
      data-owned={hits.length > 0 ? "yes" : "no"}
      style={{
        display: "flex", flexDirection: "column", gap: 4, padding: "10px 0",
        borderTop: `1px solid ${S.hair}`,
        borderLeft: hits.length ? `2px solid ${S.agree}` : undefined,
        paddingLeft: hits.length ? 10 : undefined,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em",
                       textTransform: "uppercase", color: S.ink, opacity: .55 }}>
          {sourceLabel(item.source)}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink, opacity: .35 }}>
          {ago(item.claimedAt)}
        </span>
        {hits.length ? (
          <span style={{ fontFamily: MONO, fontSize: 10, color: S.agree }}>
            {hits.map((p) => p.name ?? `#${p.elementId}`).join(", ")} — yours
          </span>
        ) : null}
      </div>
      <p style={{ margin: 0, fontFamily: SANS, fontSize: 13.5, lineHeight: 1.45, color: S.ink }}>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer"
             style={{ color: "inherit", textDecorationColor: S.block }}>
            {item.headline}
          </a>
        ) : item.headline}
      </p>
    </li>
  );
}

export function NewsView() {
  const { artifact } = useArtifact<NewsFeed>(NEWS_FEED);
  const { artifact: heuristics } = useHeuristics();
  const [source, setSource] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  const feed = proven(artifact);
  const squad = proven(heuristics)?.squad;

  /**
   * The live fifteen, by element id.
   *
   * `elementId` is optional on a pick — a squad read that could not resolve one
   * still renders — so a squad that resolves none is reported as unknown rather
   * than as a squad that matches nothing.
   */
  const owned = useMemo(() => {
    const ids = (squad?.players ?? [])
      .map((p) => p.elementId)
      .filter((id): id is number => typeof id === "number" && id > 0);
    return new Set(ids);
  }, [squad]);
  const squadKnown = owned.size > 0;

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of feed?.items ?? []) {
      map.set(item.source, (map.get(item.source) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) =>
      // Preferred sources first regardless of count — they are the ones being
      // buried, and sorting by volume is what buries them.
      (PREFERRED.has(b[0]) ? 1 : 0) - (PREFERRED.has(a[0]) ? 1 : 0) || b[1] - a[1]);
  }, [feed]);

  const shown = useMemo(() => {
    let items = feed?.items ?? [];
    if (source) items = items.filter((i) => i.source === source);
    if (onlyMine) {
      items = items.filter((i) =>
        i.players.some((p) => p.elementId > 0 && owned.has(p.elementId)));
    }
    return items;
  }, [feed, source, onlyMine, owned]);

  const mine = useMemo(
    () => (feed?.items ?? []).filter((i) =>
      i.players.some((p) => p.elementId > 0 && owned.has(p.elementId))).length,
    [feed, owned],
  );

  if (!feed) {
    // The testid goes on both branches: the shell's own test walks every view
    // and asserts each one renders something, and an absent feed is still this
    // view rendering — it is the state, not a failure to be this screen.
    return (
      <div data-testid="margin-news" style={{ padding: "16px 0" }}>
        <MarginState of={artifact} what="the week's reading" surface={S} />
      </div>
    );
  }

  return (
    <div
      data-testid="margin-news"
      style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 0" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Eyebrow surface={S}>the week&rsquo;s reading</Eyebrow>
        <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: S.ink, opacity: .55 }}>
          {feed.nShown} of {feed.nArticles} captured
          {feed.windowDays !== null ? ` over ${feed.windowDays} days` : ""}
          {squadKnown
            ? ` · ${mine} about your fifteen`
            : " · your squad is not loaded, so nothing is marked as yours"}
        </p>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          data-testid="news-filter-mine"
          onClick={() => setOnlyMine((v) => !v)}
          disabled={!squadKnown}
          title={squadKnown ? undefined : "the squad could not be read, so there is nothing to match against"}
          style={{
            fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em",
            padding: "3px 8px", cursor: squadKnown ? "pointer" : "not-allowed",
            background: onlyMine ? S.agree : "transparent",
            color: onlyMine ? S.shell : S.ink,
            opacity: squadKnown ? 1 : .35,
            border: `1px solid ${onlyMine ? S.agree : S.hair}`,
          }}
        >
          my fifteen{squadKnown ? ` (${mine})` : ""}
        </button>
        {counts.map(([name, n]) => (
          <button
            key={name}
            type="button"
            data-testid="news-filter-source"
            onClick={() => setSource((current) => (current === name ? null : name))}
            style={{
              fontFamily: MONO, fontSize: 10, padding: "3px 8px", cursor: "pointer",
              background: source === name ? S.ink : "transparent",
              color: source === name ? S.shell : S.ink,
              opacity: source === name ? 1 : PREFERRED.has(name) ? .85 : .5,
              border: `1px solid ${source === name ? S.ink : S.hair}`,
            }}
          >
            {sourceLabel(name)} <span style={{ opacity: .6 }}>{n}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Nil surface={S} size={12} />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.map((item) => (
            <Item key={item.digest} item={item} owned={owned} />
          ))}
        </ul>
      )}

      {feed.basis ? (
        <p style={{ margin: 0, fontFamily: SANS, fontSize: 11.5, lineHeight: 1.5,
                    color: S.ink, opacity: .45, maxWidth: "60ch" }}>
          {feed.basis}
        </p>
      ) : null}
    </div>
  );
}
