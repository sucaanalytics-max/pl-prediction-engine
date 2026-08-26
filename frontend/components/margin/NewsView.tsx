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

/*
 * NO CONTAINER OPACITY ON TEXT IN THIS FILE.
 *
 * Every quiet tone here came from `color: S.ink` plus an invented `opacity` — .85,
 * .6, .55, .5, .45, .4, .35 — which multiplies the composited colour and so sets a
 * contrast nobody measured. Measured in the browser on `/evidence`: 262 text nodes
 * were painted under a container opacity and 95 of them failed WCAG 1.4.3, the
 * worst at 2.45:1 against a 4.5:1 floor for 10px text.
 *
 * The palette has exactly three legible text tiers — ink 16.37:1, ink2 8.73:1,
 * ink3 5.50:1 — and a fourth invented one is how this happened. So: pick a tier.
 * Two levels collapse into ink3 where the file previously had three, which is the
 * right trade: a distinction the reader cannot legibly see is not a distinction.
 *
 * `legibility.test.ts` rule 3 forbids the pattern and scanned only `HeatGrid.tsx`
 * until this pass, which is why it never saw any of this.
 */

import { useMemo, useState } from "react";
import { proven } from "@/lib/data/artifact";
import { NEWS_FEED, type NewsFeed, type NewsItem } from "@/lib/data/news-feed";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { ARTICLE_FEEDS, readArticle } from "@/lib/news/article";
import { FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";
import { Eyebrow, MarginState, Nil } from "@/components/margin/Marks";

const S = FLOODLIT;

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

/**
 * The article's own text, fetched only when someone asks for it.
 *
 * Four states and each is said out loud, because "nothing appeared" is the one
 * outcome that leaves a reader unsure whether to wait: idle, loading, the
 * paragraphs, or the reason there are none. The link out survives all four —
 * every failure here still leaves the reader able to go and read it.
 */
type Body =
  | { readonly at: "idle" }
  | { readonly at: "loading" }
  | {
      readonly at: "read";
      readonly paragraphs: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly at: "refused"; readonly reason: string };

function Item({ item, owned }: { item: NewsItem; owned: ReadonlySet<number> }) {
  const [body, setBody] = useState<Body>({ at: "idle" });
  // Only sources whose feed carries a full body can be read here. For the rest
  // the control is absent rather than present-and-failing.
  const readable = Object.prototype.hasOwnProperty.call(ARTICLE_FEEDS, item.source)
    && item.url !== null;

  async function read() {
    if (body.at === "read") return setBody({ at: "idle" });
    setBody({ at: "loading" });
    // The call and its narrowing live in `lib/news/article`, not here: this
    // surface is forbidden a bare fetch, and the rule is right — the narrowing
    // belongs where every other narrowing in this app lives.
    const result = await readArticle(item.source, item.url ?? "");
    setBody(result.ok
      ? { at: "read", paragraphs: result.paragraphs, truncated: result.truncated }
      : { at: "refused", reason: result.reason });
  }

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
                       textTransform: "uppercase", color: S.ink3 }}>
          {sourceLabel(item.source)}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
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
      {/* The feed's own teaser. allaboutfpl blocks framing (`x-frame-options:
          SAMEORIGIN`), so an embedded article pane renders nothing — but the
          summary was in the store the whole time, which reads better anyway:
          it is this app's type, it works offline, and it loads no third-party
          script. */}
      {readable ? (
        <button
          type="button"
          data-testid="news-read"
          onClick={read}
          style={{
            alignSelf: "flex-start", fontFamily: MONO, fontSize: 10,
            textTransform: "uppercase", letterSpacing: ".08em", cursor: "pointer",
            background: "transparent", color: S.ink3,
            border: `1px solid ${S.hair}`, padding: "2px 7px",
          }}
        >
          {body.at === "loading" ? "reading…" : body.at === "read" ? "collapse" : "read here"}
        </button>
      ) : null}

      {body.at === "read" ? (
        <div data-testid="news-body" style={{ display: "flex", flexDirection: "column", gap: 8,
                    borderLeft: `1px solid ${S.hair}`, paddingLeft: 12, marginTop: 2 }}>
          {body.truncated ? (
            <p data-testid="news-truncated"
               style={{ margin: 0, fontFamily: MONO, fontSize: 10, color: S.noise }}>
              long article — the rest is at the source
            </p>
          ) : null}
          {body.paragraphs.map((paragraph, i) => (
            <p key={i} style={{ margin: 0, fontFamily: SANS, fontSize: 13,
                                lineHeight: 1.6, color: S.ink2,
                                maxWidth: "68ch" }}>
              {paragraph}
            </p>
          ))}
        </div>
      ) : null}

      {body.at === "refused" ? (
        <p data-testid="news-body-refused"
           style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: S.noise }}>
          {body.reason}
        </p>
      ) : null}

      {item.summary && body.at !== "read" ? (
        <p
          data-testid="news-summary"
          style={{
            margin: 0, fontFamily: SANS, fontSize: 12, lineHeight: 1.5,
            color: S.ink3, maxWidth: "68ch",
          }}
        >
          {item.summary}
        </p>
      ) : null}
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
  // The browser's own join is still the one that decides — it has the live
  // fifteen, and the producer only has whatever the last solve wrote. The
  // producer's flag matters for the case where neither knows, so the header can
  // say "not loaded" rather than implying nothing concerns you.
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

  /**
   * `empty` and `stale` are states, and `proven()` returns the payload for both.
   *
   * So `if (!feed)` never fired for either: a published-but-empty feed printed
   * "0 of 0 captured" with a bare ∅ and no label, discarding the artifact's own
   * reason; and a feed from a dead poller rendered identically to a fresh one,
   * because nothing here read `artifact.state`. The only thing that moved was
   * the per-item relative times, and those come from `Date.now()` rather than
   * from the artifact — so a stopped poller looked like a quiet week.
   */
  if (feed && artifact.state === "empty") {
    return (
      <div data-testid="margin-news" data-state="empty" style={{ padding: "16px 0" }}>
        <MarginState of={artifact} what="the week's reading" surface={S} />
      </div>
    );
  }

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
        {/* A stale feed is last week's news wearing this week's layout. Said
            once, at the top, rather than left to the reader to notice. */}
        {artifact.state === "stale" ? (
          <MarginState of={artifact} what="this reading list" surface={S} compact />
        ) : null}
        <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: S.ink3 }}>
          {shown.length === feed.items.length
            ? `${feed.items.length}`
            : `${shown.length} of ${feed.items.length}`}{" "}
          shown, {feed.nArticles} captured
          {feed.windowDays !== null ? ` over ${feed.windowDays} days` : ""}
          {" · "}
          {/* Named in the DOM because it is a state, not a decoration: "0 about
              your fifteen" and "we never knew your fifteen" look identical in
              a feed and mean opposite things. */}
          <span data-testid="news-squad-state" data-known={squadKnown ? "yes" : "no"}>
            {squadKnown
              ? `${mine} about your fifteen`
              : "your squad is not loaded, so nothing is marked as yours"}
          </span>
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
            // Pressed: ink on the agreement fill. Unpressed and unavailable:
            // ink3, which is the "not actionable" tier and is still legible at
            // 5.50:1 — it was `opacity: .35`, which painted 2.91:1.
            color: onlyMine ? S.shell : squadKnown ? S.ink : S.ink3,
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
              // Selected reverses onto the shell; the rest split across the two
              // quiet tiers so a preferred source still reads louder than the
              // others without either dropping under the floor.
              color: source === name
                ? S.shell
                : PREFERRED.has(name) ? S.ink2 : S.ink3,
              border: `1px solid ${source === name ? S.ink : S.hair}`,
            }}
          >
            {sourceLabel(name)} <span style={{ color: S.ink3 }}>{n}</span>
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
                    color: S.ink3, maxWidth: "60ch" }}>
          {feed.basis}
        </p>
      ) : null}
    </div>
  );
}
