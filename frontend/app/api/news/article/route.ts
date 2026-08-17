/**
 * The body of an article the reading list already links.
 *
 * ## Why this route exists rather than a bigger artifact
 *
 * `news_view.json` carries ninety items and a 400-character teaser each, and
 * every visitor fetches it. The full bodies are 14KB of text apiece — roughly a
 * megabyte across the list, to serve a reader who opens two. So the artifact
 * keeps the teaser and the body is fetched when someone asks.
 *
 * ## Why it takes a source key and not just a URL
 *
 * This never fetches the URL it is given. A route that fetches a caller-supplied
 * URL is a request-forgery primitive aimed at whatever the deployment can reach
 * — cloud metadata endpoints included — and no amount of URL validation is a
 * reliable defence.
 *
 * Instead the caller names a `source`, which must be a key of `ARTICLE_FEEDS`;
 * that feed is fetched, and the URL is looked up *inside the result*. An unknown
 * source is a miss, and a URL the feed does not contain is a miss. The set of
 * hosts this server will contact is fixed at build time.
 *
 * ## Why the response is plain text
 *
 * No sanitiser is installed and nothing in this app renders third-party markup.
 * The paragraphs are extracted server-side and rendered in Margin's own type, so
 * there is no XSS surface, no tracking pixel and no layout shift — and the
 * reader gets the sentences, which is the part with the value in it.
 */

import { NextResponse } from "next/server";

import {
  ARTICLE_FEEDS, findEntry, parseFeed, toBody,
} from "@/lib/news/article";

export const dynamic = "force-dynamic";

/** Long enough that a feed read is not repeated per reader, short enough to stay current. */
const EDGE_SECONDS = 900;

/** A feed that will not answer must not hold a request open. */
const TIMEOUT_MS = 8000;

interface ArticleBody {
  readonly title: string;
  readonly url: string;
  readonly paragraphs: readonly string[];
  /** True when the cap cut the article short, so the reader can be told. */
  readonly truncated: boolean;
}

function fail(reason: string, status: number) {
  // `{ error }` rather than a bare status, matching `/api/fpl/state`: the client
  // separates success from failure on the `data` key, not on `response.ok`.
  return NextResponse.json(
    { error: reason },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  // Named `query`, not `params`: this is the query string, not Next's dynamic
  // route params, and the two read identically at a glance.
  const query = new URL(request.url).searchParams;
  const source = query.get("source") ?? "";
  const url = query.get("url") ?? "";

  const feedUrl = Object.prototype.hasOwnProperty.call(ARTICLE_FEEDS, source)
    ? ARTICLE_FEEDS[source]
    : null;
  if (!feedUrl) {
    // Named rather than silently empty: the reader tapped a source this app does
    // not read in full, and that is a fact about the source, not a failure.
    return fail(`No full text is available for ${source || "that source"}.`, 404);
  }
  if (!url) return fail("No article was named.", 400);

  let xml: string;
  try {
    const response = await fetch(feedUrl, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return fail(`The ${source} feed answered ${response.status}.`, 502);
    xml = await response.text();
  } catch {
    return fail(`The ${source} feed did not answer.`, 504);
  }

  const entry = findEntry(parseFeed(xml), url);
  if (!entry) {
    /**
     * A real and common state, not an error to hide.
     *
     * The feed carries only the most recent ten items, while the reading list
     * spans five days — so an article can be in the artifact and out of the feed
     * within a day. The reader is told that plainly and still has the link.
     */
    return fail("That article has scrolled out of the feed; open it at the source.", 404);
  }

  const body = toBody(entry.body);
  if (body.paragraphs.length === 0) {
    // A feed running WordPress in Summary mode publishes an excerpt and no
    // `content:encoded`. There is no article to give and the teaser is already
    // on screen, so say that rather than returning it again as though it were
    // the piece.
    return fail("That source publishes only a summary in its feed.", 404);
  }

  return NextResponse.json<{ data: ArticleBody }>(
    {
      data: {
        title: entry.title, url: entry.link,
        paragraphs: body.paragraphs, truncated: body.truncated,
      },
    },
    {
      headers: {
        // The publisher's own feed changes on their schedule, not ours, and the
        // body of a published article does not change at all.
        "Cache-Control": `public, max-age=0, s-maxage=${EDGE_SECONDS}, stale-while-revalidate=86400`,
      },
    },
  );
}
