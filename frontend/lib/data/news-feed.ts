/**
 * What the feeds are saying — the captured headlines.
 *
 * ## Why this screen exists
 *
 * The poller reads six feeds every fifteen minutes and links every item it can
 * to a player. After one live run that was 59 items from BBC, Sky,
 * FantasyFootballScout and Hayters — and **nothing rendered any of them**.
 * `evidence_view.json` carries resolved availability claim trees, and every one
 * of these is `unparsed_news`: text the parser deliberately refused to turn
 * into an availability value, because RSS prose cannot meet the
 * zero-false-positive bar R4 demands.
 *
 * So the most-requested sources were being collected into a file with no
 * reader. This is the route out.
 *
 * ## The claim it must never make
 *
 * **None of this has moved a projection.** It is a reading list, and the
 * artifact says so in its own `basis` field, which the page renders verbatim
 * rather than paraphrasing. Presenting unparsed headlines as evidence the model
 * acted on would be the same failure as the hand-typed captaincy confidence
 * this project deleted.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, optNumber, optString, Problems, reqArray, reqRecord,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface NewsPlayer {
  readonly elementId: number;
  readonly name: string | null;
  readonly club: string | null;
  readonly held: boolean;
}

export interface NewsItem {
  readonly digest: string;
  readonly headline: string;
  /**
   * The feed's own teaser, when it published one.
   *
   * Null rather than "" for a headline with no summary, so a card can omit the
   * body instead of rendering an empty one.
   */
  readonly summary: string | null;
  readonly source: string;
  readonly tier: number | null;
  readonly url: string | null;
  readonly claimedAt: string | null;
  readonly players: readonly NewsPlayer[];
  readonly touchesSquad: boolean;
}

export interface NewsFeed {
  readonly generatedAt: string | null;
  readonly windowDays: number | null;
  readonly nArticles: number;
  readonly nShown: number;
  /** Rendered verbatim. The artifact states its own standing. */
  readonly basis: string | null;
  readonly items: readonly NewsItem[];
}

function narrowPlayer(raw: unknown): NewsPlayer | null {
  if (!isRecord(raw)) return null;
  const elementId = optNumber(raw.element_id);
  if (elementId === null) return null;
  return {
    elementId,
    name: optString(raw.name),
    club: optString(raw.club),
    held: raw.held === true,
  };
}

function narrowItem(raw: unknown): NewsItem | null {
  if (!isRecord(raw)) return null;
  const headline = optString(raw.headline);
  const source = optString(raw.source);
  // An item with no headline is nothing to read, and one with no source cannot
  // be weighed. Either missing makes the row worthless rather than partial.
  if (!headline || !source) return null;
  return {
    digest: optString(raw.digest) ?? headline,
    headline,
    summary: optString(raw.summary),
    source,
    tier: optNumber(raw.tier),
    url: optString(raw.url),
    claimedAt: optString(raw.claimed_at),
    players: (Array.isArray(raw.players) ? raw.players : [])
      .map(narrowPlayer)
      .filter((p): p is NewsPlayer => p !== null),
    touchesSquad: raw.touches_squad === true,
  };
}

export function narrowNewsFeed(raw: unknown): NarrowResult<NewsFeed> {
  const problems = new Problems();
  const file = reqRecord(raw, "news_view", problems);
  if (!file) return malformed(problems.all);

  const items = reqArray(file.items, "items", problems);
  if (!items) return malformed(problems.all);

  return narrowed({
    generatedAt: optString(file.generated_at),
    windowDays: optNumber(file.window_days),
    nArticles: optNumber(file.n_articles) ?? 0,
    nShown: optNumber(file.n_shown) ?? 0,
    basis: optString(file.basis),
    items: items.map(narrowItem).filter((i): i is NewsItem => i !== null),
  });
}

/** The poller ran and found nothing worth reading in the window. */
export function newsFeedIsEmpty(value: NewsFeed): boolean {
  return value.items.length === 0;
}

export const NEWS_FEED: Descriptor<NewsFeed> = {
  key: "newsFeed",
  path: "fpl/news_view.json",
  owner: "news",
  describes: "headlines captured from the configured feeds",
  // Republished every 15 minutes, so a day-old copy means the poller has stopped.
  freshnessBudgetMs: DAY,
  narrow: narrowNewsFeed,
  producedAtOf: (v) => v.generatedAt,
  isEmpty: newsFeedIsEmpty,
};
